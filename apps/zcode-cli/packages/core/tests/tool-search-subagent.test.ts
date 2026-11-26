import { expect, it, vi } from "vitest";
import { createSessionId, type Model, type ModelRequest } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createTestSessionEventStore } from "./test-event-store.js";

it.each([
  { force: false, childCodingPlan: false, searchAllowed: true, local: true },
  { force: false, childCodingPlan: false, searchAllowed: false, local: true },
  { force: false, childCodingPlan: false, searchAllowed: true },
  { force: false, childCodingPlan: true, searchAllowed: true },
  { force: true, childCodingPlan: false, searchAllowed: true },
  { force: true, childCodingPlan: false, searchAllowed: false },
])(
  "uses the child Model, startup override, independent discovery and allowed scope: %j",
  async ({ force, childCodingPlan, searchAllowed, local = false }) => {
    const childRequests: ModelRequest[] = [];
    const parentRequests: ModelRequest[] = [];
    const childEnabled = (local || force || childCodingPlan) && searchAllowed;
    const target = "TaskOutput";
    const factory = createTestModelFactory({
      async generateText(request, observation) {
        const child = observation.invocationContext?.metadata?.querySource === "subagent";
        const requests = child ? childRequests : parentRequests;
        requests.push(request);
        if (!child && requests.length === 1)
          return {
            text: "",
            usage: {},
            finishReason: "tool-calls",
            toolCalls: [
              {
                id: "spawn",
                name: "spawn_agent",
                input: {
                  task_name: "spawn",
                  fork_turns: "none",
                  message: `Discover ${target}`,
                  agent_type: "researcher",
                },
              },
            ],
          };
        if (child && childEnabled && requests.length === 1)
          return {
            text: "",
            usage: {},
            finishReason: "tool-calls",
            toolCalls: [
              {
                id: "child-search",
                name: local ? "LocalToolSearch" : "ToolSearch",
                input: { query: `select:${target},TodoRead` },
              },
            ],
          };
        return { text: "done", usage: {}, finishReason: "stop" };
      },
    });
    const withCapability = (model: Model): Model => ({
      ...model,
      requestCapabilities: {
        toolSearch: {
          protocolSupported: true,
          defaultEnabled: model.modelId === "child" ? childCodingPlan : true,
        },
      },
      bind: (options) => withCapability(model.bind(options)),
    });
    const runtime = createTestAgentRuntime(
      createSessionId("toolsearch-subagent"),
      {
        mode: "yolo",
        modelStreaming: "off",
        titleGeneration: { enabled: false },
        toolSearch: { mode: local ? "local" : force ? "native" : "auto" },
        modelSelection: { providerId: "test", modelId: "parent" },
        // 这些用例按前台 Agent 写成，关闭「Agent 总在后台」开关（07-subagent.md「ZCode 当前实现」）。
        subagents: {
          alwaysBackground: false,
          profiles: [
            {
              name: "researcher",
              description: "Research",
              source: "user",
              systemPrompt: "Search tools",
              modelSelection: { providerId: "test", modelId: "child" },
              tools: searchAllowed
                ? ["ToolSearch", ...(local ? ["DeferredToolCall"] : []), "TaskOutput"]
                : ["TaskOutput"],
            },
          ],
        },
      },
      {
        eventStore: createTestSessionEventStore(),
        modelFactory: (input) => withCapability(factory(input)),
      },
    );
    try {
      await runtime.executeTurn("Run the researcher.");
      await vi.waitFor(() => expect(childRequests.length).toBe(childEnabled ? 2 : 1));
      expect(childRequests[0]?.toolSearchEnabled).toBe(childEnabled && !local);
      expect(
        childRequests[0]?.tools?.some(
          (tool) => tool.name === (local ? "LocalToolSearch" : "ToolSearch"),
        ),
      ).toBe(childEnabled);
      if (childEnabled) {
        expect(childRequests[0]?.tools?.some((tool) => tool.name === target)).toBe(false);
        if (local) {
          expect(childRequests[1]?.tools).toEqual(childRequests[0]?.tools);
          expect(JSON.stringify(childRequests[1]?.messages)).toContain("<functions>");
          // Local 把发现结果展开成 <functions> 文本，不会出现 "toolName"；按定义名核对，
          // 作用域外的 TodoRead 不能被展开。
          const result = childRequests[1]?.messages.find((message) => message.role === "tool");
          const text = (Array.isArray(result?.content) ? result.content : [])
            .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
            .join("\n");
          const loaded = [...text.matchAll(/<function>(.*?)<\/function>/gu)].map(
            (match) => (JSON.parse(match[1]!) as { name: string }).name,
          );
          expect(loaded).toEqual([target]);
        } else {
          expect(childRequests[1]?.tools?.find((tool) => tool.name === target)?.deferLoading).toBe(
            true,
          );
          expect(
            childRequests[1]?.messages.find((message) => message.role === "tool")?.content,
          ).toEqual([{ type: "tool_reference", toolName: target }]);
        }
      } else expect(childRequests[0]?.tools?.some((tool) => tool.name === target)).toBe(true);
      // 子会话的发现不回流父会话：协作唤醒可能会让父会话多出一轮汇总请求，所有后续请求都必须保持父工具面且不含展开定义。
      expect(parentRequests.length).toBeGreaterThanOrEqual(2);
      for (const laterRequest of parentRequests.slice(1)) {
        expect(laterRequest.tools).toEqual(parentRequests[0]?.tools);
        expect(JSON.stringify(laterRequest.messages)).not.toContain("<functions>");
      }
    } finally {
      await runtime.closeBrowserSession();
    }
  },
);

it("omits LocalToolSearch for built-in Explore when no deferred tools remain after collaboration migration", async () => {
  const childRequests: ModelRequest[] = [];
  const factory = createTestModelFactory({
    async generateText(request, observation) {
      const child = observation.invocationContext?.metadata?.querySource === "subagent";
      if (child) {
        childRequests.push(request);
        return { text: "done", usage: {}, finishReason: "stop" };
      }
      if (!request.messages.some((message) => message.role === "tool")) {
        return {
          text: "",
          usage: {},
          finishReason: "tool-calls",
          toolCalls: [
            {
              id: "spawn-explore",
              name: "spawn_agent",
              input: {
                task_name: "explore",
                fork_turns: "none",
                message: "Explore repository",
                agent_type: "Explore",
              },
            },
          ],
        };
      }
      return { text: "done", usage: {}, finishReason: "stop" };
    },
  });
  const withCapability = (model: Model): Model => ({
    ...model,
    requestCapabilities: {
      toolSearch: { protocolSupported: true, defaultEnabled: false },
    },
    bind: (options) => withCapability(model.bind(options)),
  });
  const runtime = createTestAgentRuntime(
    createSessionId("toolsearch-explore"),
    {
      mode: "yolo",
      modelStreaming: "off",
      titleGeneration: { enabled: false },
      toolSearch: { mode: "local" },
      modelSelection: { providerId: "test", modelId: "parent" },
      subagents: { alwaysBackground: false },
    },
    {
      eventStore: createTestSessionEventStore(),
      modelFactory: (input) => withCapability(factory(input)),
    },
  );
  try {
    await runtime.executeTurn("Run Explore.");
    await vi.waitFor(() => expect(childRequests).toHaveLength(1));
    const childToolNames = new Set(childRequests[0]?.tools?.map((tool) => tool.name) ?? []);
    expect(childToolNames.has("LocalToolSearch")).toBe(false);
    expect(childToolNames.has("RespondToCoordinator")).toBe(false);
    expect(childToolNames.has("Read")).toBe(true);
    expect(childToolNames.has("Bash")).toBe(true);
    expect(childToolNames.has("Glob")).toBe(false);
    expect(childToolNames.has("Grep")).toBe(false);
    expect(childToolNames.has("WebFetch")).toBe(true);
  } finally {
    await runtime.closeBrowserSession();
  }
});
