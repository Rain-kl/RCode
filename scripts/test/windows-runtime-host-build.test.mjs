import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRuntimeHostBuild, verifyRuntimeHostPe } from "../build-windows-runtime-host.mjs";

test("Windows builds both supported architectures with the matching MSVC target", () => {
  const emptyProbe = { env: {}, probeVswhere: () => "" };
  assert.deepEqual(resolveRuntimeHostBuild("x64", "win32", undefined, emptyProbe).configureArgs, [
    "-G",
    "Visual Studio 17 2022",
    "-A",
    "x64",
  ]);
  assert.deepEqual(resolveRuntimeHostBuild("arm64", "win32", undefined, emptyProbe).configureArgs, [
    "-G",
    "Visual Studio 17 2022",
    "-A",
    "ARM64",
  ]);
  assert.throws(() => resolveRuntimeHostBuild("ia32", "win32"), /architecture/);
});
test("Windows selects installed Visual Studio generator via vswhere and supports safe overrides", () => {
  assert.deepEqual(
    resolveRuntimeHostBuild("x64", "win32", undefined, {
      env: {},
      probeVswhere: () => "18.0.35412.1\r\n",
    }).configureArgs,
    ["-G", "Visual Studio 18 2026", "-A", "x64"],
  );
  assert.deepEqual(
    resolveRuntimeHostBuild("arm64", "win32", undefined, {
      env: {},
      probeVswhere: () => "17.14.36510.44\r\n",
    }).configureArgs,
    ["-G", "Visual Studio 17 2022", "-A", "ARM64"],
  );
  assert.deepEqual(
    resolveRuntimeHostBuild("x64", "win32", undefined, {
      env: { ZCODE_WINDOWS_CMAKE_GENERATOR: "Visual Studio 18 2026" },
      probeVswhere: () => {
        throw new Error("should not probe vswhere when override is set");
      },
    }).configureArgs,
    ["-G", "Visual Studio 18 2026", "-A", "x64"],
  );
  assert.deepEqual(
    resolveRuntimeHostBuild("x64", "win32", undefined, {
      env: { CMAKE_GENERATOR: "Visual Studio 18 2026" },
      probeVswhere: () => "17.14.36510.44\r\n",
    }).configureArgs,
    ["-G", "Visual Studio 18 2026", "-A", "x64"],
  );
  assert.deepEqual(
    resolveRuntimeHostBuild("x64", "win32", undefined, {
      env: { CMAKE_GENERATOR: "Ninja" },
      probeVswhere: () => "18.0.35412.1\r\n",
    }).configureArgs,
    ["-G", "Visual Studio 18 2026", "-A", "x64"],
  );

  const queries = [];
  assert.deepEqual(
    resolveRuntimeHostBuild("x64", "win32", undefined, {
      env: {},
      probeVswhere: (args) => {
        queries.push(args);
        return args.includes("-requires") ? "" : "18.1.0.0\r\n";
      },
    }).configureArgs,
    ["-G", "Visual Studio 18 2026", "-A", "x64"],
  );
  assert.equal(queries.length, 2);
  assert.ok(queries[0].includes("-requires"));
  assert.ok(!queries[1].includes("-requires"));
});
test("cross builds explicitly select a Windows compiler", () => {
  assert.ok(
    resolveRuntimeHostBuild("x64", "linux").configureArgs.includes("-DCMAKE_SYSTEM_NAME=Windows"),
  );
  assert.ok(
    resolveRuntimeHostBuild("arm64", "linux", "example-clang++").configureArgs.includes(
      "-DCMAKE_CXX_COMPILER=example-clang++",
    ),
  );
});
test("packaging rejects wrong-architecture and corrupt PE binaries", () => {
  const bytes = Buffer.alloc(128);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 60);
  bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(0x8664, 68);
  verifyRuntimeHostPe(bytes, "x64");
  assert.throws(() => verifyRuntimeHostPe(bytes, "arm64"), /architecture/);
  assert.throws(() => verifyRuntimeHostPe(Buffer.from("bad"), "x64"), /PE/);
});
