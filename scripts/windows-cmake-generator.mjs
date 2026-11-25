import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_WINDOWS_VS_GENERATOR = "Visual Studio 17 2022";

const VISUAL_STUDIO_GENERATORS_BY_MAJOR = new Map([
  [16, "Visual Studio 16 2019"],
  [17, "Visual Studio 17 2022"],
  [18, "Visual Studio 18 2026"],
]);

/**
 * 将 vswhere 输出的 Visual Studio 安装主版本号映射为 CMake 生成器名称。
 *
 * VS 2026 的 catalog_productLineVersion 返回 18 而非 2026，因此只认 installationVersion 主版本号。
 */
export function mapVisualStudioVersionToGenerator(versionOutput) {
  if (typeof versionOutput !== "string") return undefined;
  const firstLine = versionOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return undefined;
  const major = Number(firstLine.split(".", 1)[0]);
  if (!Number.isInteger(major)) return undefined;
  return VISUAL_STUDIO_GENERATORS_BY_MAJOR.get(major);
}

/**
 * 读取显式 Visual Studio CMake 生成器覆盖值。
 *
 * 仅接受 Visual Studio 形态的 CMAKE_GENERATOR，避免 Ninja 等单配置生成器破坏 -A 与 Release 目录契约。
 */
export function readWindowsVisualStudioGeneratorOverride(env = process.env) {
  const explicit = env?.ZCODE_WINDOWS_CMAKE_GENERATOR?.trim();
  if (explicit) return explicit;
  const cmakeGenerator = env?.CMAKE_GENERATOR?.trim();
  if (cmakeGenerator && /^Visual Studio \d+ \d{4}$/.test(cmakeGenerator)) {
    return cmakeGenerator;
  }
  return undefined;
}

function getVswherePath(env = process.env) {
  return join(
    env?.["ProgramFiles(x86)"] ?? "C:/Program Files (x86)",
    "Microsoft Visual Studio/Installer/vswhere.exe",
  );
}

function buildVswhereQueries(arch) {
  const normalizedArch = String(arch ?? "x64").toLowerCase();
  const requirements =
    normalizedArch === "arm64"
      ? [
          "Microsoft.VisualStudio.Component.VC.Tools.ARM64",
          "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
          null,
        ]
      : ["Microsoft.VisualStudio.Component.VC.Tools.x86.x64", null];
  return requirements.map((requirement) => [
    "-latest",
    "-products",
    "*",
    ...(requirement ? ["-requires", requirement] : []),
    "-property",
    "installationVersion",
  ]);
}

function formatVswhereError(vswhere, error) {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`Failed to query Visual Studio installation via ${vswhere}: ${detail}`, {
    cause: error,
  });
}

function extractStdout(output) {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && typeof output.stdout === "string") {
    return output.stdout;
  }
  return "";
}

/**
 * 同步解析 Windows 宿主上的 Visual Studio CMake 生成器名称。
 */
export function resolveWindowsVisualStudioGenerator({
  arch = "x64",
  hostPlatform = process.platform,
  runtimePlatform = process.platform,
  env = process.env,
  probeVswhere,
} = {}) {
  const override = readWindowsVisualStudioGeneratorOverride(env);
  if (override) return override;
  if (hostPlatform !== "win32") return DEFAULT_WINDOWS_VS_GENERATOR;
  if (!probeVswhere && runtimePlatform !== "win32") return DEFAULT_WINDOWS_VS_GENERATOR;

  const vswhere = getVswherePath(env);
  const runProbe =
    probeVswhere ??
    ((args) => execFileSync(vswhere, args, { encoding: "utf8", timeout: 5000, windowsHide: true }));

  for (const args of buildVswhereQueries(arch)) {
    let output;
    try {
      output = runProbe(args);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return DEFAULT_WINDOWS_VS_GENERATOR;
      }
      throw formatVswhereError(vswhere, error);
    }
    const generator = mapVisualStudioVersionToGenerator(extractStdout(output));
    if (generator) return generator;
  }

  return DEFAULT_WINDOWS_VS_GENERATOR;
}

/**
 * 异步解析 Windows 宿主上的 Visual Studio CMake 生成器名称。
 */
export async function resolveWindowsVisualStudioGeneratorAsync({
  arch = "x64",
  env = process.env,
  timeoutMs = 5000,
  runtimePlatform = process.platform,
  probeVswhere,
} = {}) {
  const override = readWindowsVisualStudioGeneratorOverride(env);
  if (override) return override;
  if (!probeVswhere && runtimePlatform !== "win32") return DEFAULT_WINDOWS_VS_GENERATOR;

  const vswhere = getVswherePath(env);
  const runProbe =
    probeVswhere ??
    ((args) =>
      execFileAsync(vswhere, args, {
        encoding: "utf8",
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        windowsHide: true,
      }));

  for (const args of buildVswhereQueries(arch)) {
    let output;
    try {
      output = await runProbe(args);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return DEFAULT_WINDOWS_VS_GENERATOR;
      }
      throw formatVswhereError(vswhere, error);
    }
    const generator = mapVisualStudioVersionToGenerator(extractStdout(output));
    if (generator) return generator;
  }

  return DEFAULT_WINDOWS_VS_GENERATOR;
}
