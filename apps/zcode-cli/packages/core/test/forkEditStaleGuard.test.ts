/** 局部 Edit 保留当前文件变化，整文件 Write 校验已读版本；真实 Read 链路覆盖哈希与缓存。 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createNodeFileSystemAdapter } from "../../adapters/src/fs/index.js";
import { readHandler } from "../src/tool/handlers/read.js";
import {
  createReadFileStateMetadataFromEntry,
  parseReadFileStateMetadata,
} from "../src/tool/read-file-state-metadata.js";
import test from "node:test";

import {
  EditErrorCode,
  WriteErrorCode,
  type FileSystemPort,
  type FileSystemReadTextResult,
  type FileSystemStatResult,
} from "@zcode/contracts";

import { createReadFileStatePathKey } from "../src/tool/read-file-state.js";
import { resolveStalenessByContentHash } from "../src/fork/edit-stale-guard/hash-staleness.js";
import { editToolEntry } from "../src/tool/handlers/edit.js";
import { writeToolEntry } from "../src/tool/handlers/write.js";
import type {
  ReadFileStateEntry,
  ReadFileStateMap,
  ToolExecutionContext,
} from "../src/tool/types.js";

const WORKSPACE = "/workspace";
const FILE_PATH = join(WORKSPACE, "notes.md");
const RECORDED_MTIME_MS = 1_000;
// 判据契约是「同一份字节同一个字符串」，所以测试自己算一遍 sha256，不复用实现里的 helper：
// 前缀或算法漂移必须在这里露出来。
function contentHashOf(text: string): string {
  return `sha256:${createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex")}`;
}

interface FakeFile {
  content: string;
  lineEndings: "LF" | "CRLF";
  mtimeMs: number;
}

function createFakeFileSystemPort(file: FakeFile): {
  port: FileSystemPort;
  writtenContents: string[];
} {
  const writtenContents: string[] = [];
  const sizeBytes = (): number => Buffer.byteLength(file.content, "utf8");
  const revision = () => ({
    id: `mtime:${Math.trunc(file.mtimeMs)}:size:${sizeBytes()}`,
    mtimeMs: file.mtimeMs,
    sizeBytes: sizeBytes(),
    hash: contentHashOf(file.content),
  });

  const port = {
    stat: async (): Promise<FileSystemStatResult> => ({
      path: FILE_PATH,
      kind: "file",
      sizeBytes: sizeBytes(),
      mtimeMs: file.mtimeMs,
      revision: revision(),
    }),
    readTextFile: async (): Promise<FileSystemReadTextResult> => ({
      path: FILE_PATH,
      // 端口契约：content 已归一成 LF，原始行尾只在 lineEndings 里；假端口必须照此返回，
      // 否则测试会自己造出上游并不存在的「行尾不一致」。
      content: file.content,
      encoding: "utf8",
      lineEndings: file.lineEndings,
      bytesRead: sizeBytes(),
      sizeBytes: sizeBytes(),
      truncated: false,
      revision: revision(),
    }),
    writeTextFile: async (request: { content: string; path: string }) => {
      writtenContents.push(request.content);
      file.content = request.content;
      file.mtimeMs += 1;
      return { path: FILE_PATH, bytesWritten: sizeBytes(), revision: revision() };
    },
  };

  return { port: port as unknown as FileSystemPort, writtenContents };
}

function createReadStateEntry(overrides: Partial<ReadFileStateEntry> = {}): ReadFileStateMap {
  const entry: ReadFileStateEntry = {
    path: FILE_PATH,
    content: "line one\n",
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(RECORDED_MTIME_MS),
    sourceTool: "Read",
    revisionId: `mtime:${RECORDED_MTIME_MS}:size:9`,
    mtimeMs: RECORDED_MTIME_MS,
    sizeBytes: 9,
    contentHash: contentHashOf("line one\n"),
    ...overrides,
  };
  return new Map([[createReadFileStatePathKey(FILE_PATH), entry]]);
}

function createContext(
  port: FileSystemPort,
  readFileState: ReadFileStateMap,
): ToolExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    fileSystemPort: port,
    readFileState,
    toolCallId: "tool-call-1",
    traceId: "trace-1" as ToolExecutionContext["traceId"],
    workingDirectory: WORKSPACE,
    workspaceRoot: WORKSPACE,
  };
}

function editInput(oldString: string, newString: string): unknown {
  return { file_path: FILE_PATH, old_string: oldString, new_string: newString };
}

test("内容哈希判据：一致为 fresh，不一致为 stale，缺任一侧为 unknown", () => {
  assert.equal(
    resolveStalenessByContentHash({ recordedHash: "sha256:a", currentHash: "sha256:a" }),
    "fresh",
  );
  assert.equal(
    resolveStalenessByContentHash({ recordedHash: "sha256:a", currentHash: "sha256:b" }),
    "stale",
  );
  assert.equal(
    resolveStalenessByContentHash({ recordedHash: undefined, currentHash: "sha256:b" }),
    "unknown",
  );
  assert.equal(
    resolveStalenessByContentHash({ recordedHash: "sha256:a", currentHash: undefined }),
    "unknown",
  );
  assert.equal(resolveStalenessByContentHash({}), "unknown");
});

test("Edit 误报：range Read + mtime 前进 + 字节未变 → 放行", async () => {
  const file: FakeFile = {
    // 行尾 CRLF 也是真实的：端口读回按契约归一成 LF，hash 按磁盘原始字节算。
    content: "line one\r\nline two\r\n",
    lineEndings: "CRLF",
    // mtime 已前进（格式化器/IDE 保存/另一会话），但字节与读取时完全相同。
    mtimeMs: RECORDED_MTIME_MS + 5_000,
  };
  const { port, writtenContents } = createFakeFileSystemPort(file);
  const readFileState = createReadStateEntry({
    content: "line one\n",
    offset: 1,
    limit: 1,
    sizeBytes: Buffer.byteLength(file.content, "utf8"),
    contentHash: contentHashOf(file.content),
  });

  const output = (await editToolEntry.handler(
    editInput("line two", "line 2"),
    createContext(port, readFileState),
  )) as { result?: false; errorCode?: number; newString?: string };

  assert.notEqual(output.result, false, `不应报 stale，实际 errorCode=${output.errorCode}`);
  assert.equal(writtenContents.length, 1);
  assert.match(writtenContents[0]!, /line 2/);
});

test("Edit 目标已经变化：返回目标不存在且不写盘", async () => {
  const file: FakeFile = {
    content: "line one\nline three\n",
    lineEndings: "LF",
    mtimeMs: RECORDED_MTIME_MS,
  };
  const { port, writtenContents } = createFakeFileSystemPort(file);
  // `cp -p` / `tar -x`：字节变了，mtime 与 size 都没变（revisionId 因此也相同）。
  // edit.ts 的旧判据只看 mtime 是否严格前进 + size，未前进就直接放行、不比对内容。
  const readFileState = createReadStateEntry({
    content: "line one\nline two\n",
    sizeBytes: Buffer.byteLength(file.content, "utf8"),
    revisionId: `mtime:${RECORDED_MTIME_MS}:size:${Buffer.byteLength(file.content, "utf8")}`,
    contentHash: contentHashOf("line one\nline two\n"),
  });

  const output = (await editToolEntry.handler(
    editInput("line two", "line 2"),
    createContext(port, readFileState),
  )) as { result?: false; errorCode?: number };

  assert.equal(output.result, false);
  assert.equal(output.errorCode, EditErrorCode.OLD_STRING_NOT_FOUND);
  assert.equal(writtenContents.length, 0, "判 stale 时不得写盘");
});

test("Edit 无关位置变化且旧记录缺 hash：基于当前内容编辑", async () => {
  const file: FakeFile = {
    content: "line one\r\nline two\r\n",
    lineEndings: "CRLF",
    mtimeMs: RECORDED_MTIME_MS + 5_000,
  };
  const { port, writtenContents } = createFakeFileSystemPort(file);
  const readFileState = createReadStateEntry({
    content: "line one\n",
    offset: 1,
    limit: 1,
    sizeBytes: Buffer.byteLength(file.content, "utf8"),
    contentHash: undefined,
  });

  const output = (await editToolEntry.handler(
    editInput("line two", "line 2"),
    createContext(port, readFileState),
  )) as { result?: false; errorCode?: number };

  assert.notEqual(output.result, false);
  assert.equal(writtenContents.length, 1);
  assert.match(writtenContents[0]!, /line 2/);
});

test("Edit 无关行变化：保留外部内容并修改唯一目标", async () => {
  const file: FakeFile = { content: "line one\nexternal\n", lineEndings: "LF", mtimeMs: 2_000 };
  const { port, writtenContents } = createFakeFileSystemPort(file);
  const readFileState = createReadStateEntry();

  const output = (await editToolEntry.handler(
    editInput("line one", "line 1"),
    createContext(port, readFileState),
  )) as { result?: false; errorCode?: number };

  assert.notEqual(output.result, false);
  assert.deepEqual(writtenContents, ["line 1\nexternal\n"]);
});

test("Edit 不完整视图仍先拒：partial view 即使 hash 相同也报 FILE_NOT_READ", async () => {
  const file: FakeFile = { content: "line one\n", lineEndings: "LF", mtimeMs: 1_000 };
  const { port, writtenContents } = createFakeFileSystemPort(file);
  const readFileState = createReadStateEntry({
    content: "line on",
    isPartialView: true,
    contentHash: contentHashOf(file.content),
  });

  const output = (await editToolEntry.handler(
    editInput("line one", "line 1"),
    createContext(port, readFileState),
  )) as { result?: false; errorCode?: number };

  assert.equal(output.result, false);
  assert.equal(output.errorCode, EditErrorCode.FILE_NOT_READ);
  assert.equal(writtenContents.length, 0);
});

test("Write 误报：range Read + mtime 前进 + 字节未变 → 放行", async () => {
  const file: FakeFile = {
    content: "line one\r\nline two\r\n",
    lineEndings: "CRLF",
    mtimeMs: RECORDED_MTIME_MS + 5_000,
  };
  const { port, writtenContents } = createFakeFileSystemPort(file);
  const readFileState = createReadStateEntry({
    content: "line one\n",
    offset: 1,
    limit: 1,
    sizeBytes: Buffer.byteLength(file.content, "utf8"),
    contentHash: contentHashOf(file.content),
  });

  const output = (await writeToolEntry.handler(
    { file_path: FILE_PATH, content: "line one\nline 2\n" },
    createContext(port, readFileState),
  )) as { type?: string };

  assert.equal(output.type, "update");
  assert.equal(writtenContents.length, 1);
});

test("Write 漏报：range Read + mtime 与 size 都不变但字节变了 → 报 stale_file", async () => {
  const file: FakeFile = {
    content: "line one\nline three\n",
    lineEndings: "LF",
    mtimeMs: RECORDED_MTIME_MS,
  };
  const { port, writtenContents } = createFakeFileSystemPort(file);
  // `cp -p` / `tar -x`：字节变了，mtime 与 size 都没变（revisionId 因此也相同）。
  // range 视图（offset/limit）拿不到 write.ts 旧判据最后那道整文件内容比对，旧实现直接放行。
  const readFileState = createReadStateEntry({
    content: "line one\n",
    offset: 1,
    limit: 1,
    sizeBytes: Buffer.byteLength(file.content, "utf8"),
    revisionId: `mtime:${RECORDED_MTIME_MS}:size:${Buffer.byteLength(file.content, "utf8")}`,
    contentHash: contentHashOf("line one\nline two\n"),
  });

  const output = (await writeToolEntry.handler(
    { file_path: FILE_PATH, content: "line one\nline 2\n" },
    createContext(port, readFileState),
  )) as { result?: false; errorCode?: number };

  assert.equal(output.result, false);
  assert.equal(output.errorCode, WriteErrorCode.STALE_FILE);
  assert.equal(writtenContents.length, 0, "判 stale 时不得写盘");
});

test("Edit 外部修改引入歧义：拒绝单次替换，replace_all 明确替换全部", async () => {
  const file: FakeFile = { content: "line one\nline one\n", lineEndings: "LF", mtimeMs: 2_000 };
  const { port, writtenContents } = createFakeFileSystemPort(file);
  const context = createContext(port, createReadStateEntry());
  const result = (await editToolEntry.handler(editInput("line one", "line 1"), context)) as {
    errorCode?: number;
  };
  assert.equal(result.errorCode, EditErrorCode.AMBIGUOUS_REPLACE);
  assert.equal(writtenContents.length, 0);
  await editToolEntry.handler(
    { file_path: FILE_PATH, old_string: "line one", new_string: "line 1", replace_all: true },
    context,
  );
  assert.deepEqual(writtenContents, ["line 1\nline 1\n"]);
});

test("真实 Read → 时间戳变化 → Write：内容哈希保留，整文件覆盖成功", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-stale-"));
  try {
    const file = join(root, "sample.txt");
    const context = createContext(createNodeFileSystemAdapter(), new Map());
    await writeFile(file, "alpha\nbeta\n");
    await readHandler({ file_path: file, offset: 1, limit: 1 }, context);
    const entry = context.readFileState!.values().next().value!;
    assert.equal(entry.contentHash, contentHashOf("alpha\nbeta\n"));
    const metadata = createReadFileStateMetadataFromEntry({
      entry,
      completedAt: entry.readAt,
      toolName: "Read",
    });
    assert.equal(
      parseReadFileStateMetadata({ readFileState: metadata })?.contentHash,
      entry.contentHash,
    );
    const info = await stat(file);
    await utimes(file, info.atime, new Date(info.mtimeMs + 2000));
    const repeated = await readHandler({ file_path: file, offset: 1, limit: 1 }, context);
    assert.deepEqual(repeated, { type: "file_unchanged", filePath: file });
    assert.equal(context.readFileState!.values().next().value, entry, "重复视图不改写已读基线");
    await writeToolEntry.handler({ file_path: file, content: "ALPHA\nbeta\n" }, context);
    assert.equal(await readFile(file, "utf8"), "ALPHA\nbeta\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("真实 Read → 同时间戳同大小外部修改 → Write 拒绝 → Read 刷新后可写", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-stale-"));
  try {
    const file = join(root, "sample.txt");
    const context = createContext(createNodeFileSystemAdapter(), new Map());
    await writeFile(file, "alpha\nbeta\n");
    const timestamp = new Date(Date.now() - 10000);
    await utimes(file, timestamp, timestamp);
    await readHandler({ file_path: file }, context);
    await writeFile(file, "alpha\nzeta\n");
    await utimes(file, timestamp, timestamp);
    const staleOutput = (await writeToolEntry.handler(
      { file_path: file, content: "ALPHA\nbeta\n" },
      context,
    )) as { result?: false; errorCode?: number };
    assert.equal(staleOutput.result, false);
    assert.equal(staleOutput.errorCode, WriteErrorCode.STALE_FILE);
    assert.equal(await readFile(file, "utf8"), "alpha\nzeta\n");
    const refreshed = (await readHandler({ file_path: file }, context)) as {
      type: string;
      content?: string;
    };
    assert.equal(refreshed.type, "text");
    assert.equal(refreshed.content, "alpha\nzeta\n");
    await writeToolEntry.handler({ file_path: file, content: "ALPHA\nzeta\n" }, context);
    assert.equal(await readFile(file, "utf8"), "ALPHA\nzeta\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
