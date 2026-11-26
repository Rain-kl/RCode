import { describe, expect, it } from "vitest";
import type { SubagentRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import { buildAssistantWorkRenderItems } from "@/v4/conversationAssistantWorkItems.js";

const SHOW_ALL_REASONING = { messageStreamShowReasoning: true } as const;

function buildRenderItems(
  rows: Parameters<typeof buildAssistantWorkRenderItems>[0],
  reasoningVisibility: Parameters<typeof buildAssistantWorkRenderItems>[1] = SHOW_ALL_REASONING,
) {
  return buildAssistantWorkRenderItems(rows, reasoningVisibility);
}

function toolCall(
  rowId: number,
  toolName: string,
  input: unknown,
  overrides: Partial<ToolCallRow> = {},
): ToolCallRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `tool-${rowId}`,
    toolName,
    status: "success",
    input,
    inputText: JSON.stringify(input),
    ...overrides,
  };
}

function subagent(rowId: number, overrides: Partial<SubagentRow> = {}): SubagentRow {
  return {
    rowId,
    turnId: "turn-1",
    createdAt: 1_700_000_000_000 + rowId,
    createdAtSeq: rowId,
    kind: "subagent",
    subagentType: "Explore",
    status: "running",
    summaryText: "正在分析工作区",
    childSessionId: `child-session-${rowId}`,
    ...overrides,
  };
}

describe("buildAssistantWorkRenderItems", () => {
  it("keeps a single Explore, Terminal, or Changes tool ungrouped", () => {
    expect(buildRenderItems([toolCall(1, "Read", { path: "package.json" })])).toMatchObject([
      { kind: "row", row: { rowId: 1 } },
    ]);
    expect(buildRenderItems([toolCall(2, "Bash", { command: "pnpm test" })])).toMatchObject([
      { kind: "row", row: { rowId: 2 } },
    ]);
    expect(
      buildRenderItems([toolCall(3, "Edit", { path: "package.json", newText: "{}" })]),
    ).toMatchObject([{ kind: "row", row: { rowId: 3 } }]);
  });

  it("does not group same-family tools across a visible tool boundary", () => {
    const items = buildRenderItems([
      toolCall(1, "Read", { path: "src/a.ts" }),
      toolCall(2, "Edit", { path: "src/a.ts", newText: "a" }),
      toolCall(3, "Read", { path: "src/b.ts" }),
    ]);

    expect(items.map((item) => item.kind)).toEqual(["row", "row", "row"]);
  });

  it.each(["inputStreaming", "running"] as const)(
    "defers unclassified shell-family tools with status %s",
    (status) => {
      for (const toolName of ["Bash", "execute", "shell"]) {
        const pending = toolCall(
          1,
          toolName,
          {},
          {
            input: undefined,
            inputText: "",
            status,
          },
        );

        expect(buildRenderItems([pending])).toEqual([]);
      }
    },
  );

  it("classifies a deferred shell tool after its command arrives", () => {
    const readonly = toolCall(
      1,
      "Bash",
      { command: "rg test packages/ui" },
      { status: "inputStreaming" },
    );
    const executable = toolCall(2, "Bash", { command: "pnpm test" }, { status: "running" });

    expect(buildRenderItems([readonly])).toMatchObject([{ kind: "row", row: { rowId: 1 } }]);
    expect(buildRenderItems([executable])).toMatchObject([{ kind: "row", row: { rowId: 2 } }]);
  });

  it("keeps an unclassified failed shell tool visible", () => {
    const failed = toolCall(
      1,
      "Bash",
      {},
      {
        error: { message: "Permission denied" },
        input: undefined,
        inputText: "",
        status: "error",
      },
    );

    expect(buildRenderItems([failed])).toMatchObject([
      { kind: "row", row: { rowId: 1, status: "error" } },
    ]);
  });

  it("pairs agent tool calls with subagent rows by parentToolCallId", () => {
    const rows = [
      toolCall(1, "spawn_agent", {
        prompt: "分析当前工作区",
        subagent_type: "Explore",
      }),
      subagent(2, { parentToolCallId: "tool-1" }),
      toolCall(3, "Read", { path: "package.json" }),
    ];

    const items = buildRenderItems(rows);

    expect(items.map((item) => item.kind)).toEqual(["agentToolCall", "row"]);
    const agentItem = items[0];
    expect(agentItem?.kind).toBe("agentToolCall");
    if (agentItem?.kind !== "agentToolCall") {
      throw new Error("expected paired agent item");
    }
    expect(agentItem.row.rowId).toBe(1);
    expect(agentItem.subagentRow.rowId).toBe(2);
    expect(agentItem).not.toHaveProperty("showSubagentOutputPreview");
    expect(items.some((item) => item.kind === "row" && item.row.rowId === 2)).toBe(false);
  });

  it("keeps concurrent agent details bound when subagents spawn in reverse order", () => {
    const rows = [
      toolCall(1, "spawn_agent", { description: "测试 general-purpose agent" }),
      toolCall(2, "spawn_agent", { description: "测试 Explore agent" }),
      toolCall(3, "spawn_agent", { description: "测试 test-hello2 agent" }),
      subagent(4, {
        childSessionId: "child-test-hello2",
        parentToolCallId: "tool-3",
        subagentType: "test-hello2",
      }),
      subagent(5, {
        childSessionId: "child-explore",
        parentToolCallId: "tool-2",
        subagentType: "Explore",
      }),
      subagent(6, {
        childSessionId: "child-general-purpose",
        parentToolCallId: "tool-1",
        subagentType: "general-purpose",
      }),
    ];

    const items = buildRenderItems(rows);
    const pairs = items.flatMap((item) =>
      item.kind === "agentToolCall" ? [[item.row.toolCallId, item.subagentRow.childSessionId]] : [],
    );

    expect(pairs).toEqual([
      ["tool-1", "child-general-purpose"],
      ["tool-2", "child-explore"],
      ["tool-3", "child-test-hello2"],
    ]);
  });

  it("does not guess an unanchored child even when only one spawn remains", () => {
    const onePair = buildRenderItems([
      toolCall(1, "spawn_agent", { description: "旧 Agent" }),
      subagent(2),
    ]);
    expect(onePair.map((item) => item.kind)).toEqual(["row", "row"]);

    const ambiguous = buildRenderItems([
      toolCall(1, "spawn_agent", { description: "旧 Agent A" }),
      toolCall(2, "spawn_agent", { description: "旧 Agent B" }),
      subagent(3),
      subagent(4),
    ]);
    expect(ambiguous.some((item) => item.kind === "agentToolCall")).toBe(false);
    expect(ambiguous.map((item) => item.kind)).toEqual(["row", "row", "row", "row"]);
  });

  it("keeps background subagents paired without requesting an inline output preview", () => {
    const rows = [
      toolCall(1, "spawn_agent", {
        prompt: "后台分析当前工作区",
        run_in_background: true,
        subagent_type: "Explore",
      }),
      subagent(2, { backgrounded: true, parentToolCallId: "tool-1" }),
    ];

    const items = buildRenderItems(rows);

    expect(items).toHaveLength(1);
    const agentItem = items[0];
    expect(agentItem?.kind).toBe("agentToolCall");
    if (agentItem?.kind !== "agentToolCall") {
      throw new Error("expected paired agent item");
    }
    expect(agentItem.subagentRow.backgrounded).toBe(true);
    expect(agentItem).not.toHaveProperty("showSubagentOutputPreview");
  });
});
