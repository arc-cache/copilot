import { chmod, mkdir, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { activationPath, arcHome, cacheDir, copilotUserHooksDir, workspaceRoot } from "./paths.js";
import { assertDurableArcRuntime, currentArcRuntime, type ArcRuntime } from "./runtime.js";

function hookShim(runtime: ArcRuntime): string {
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const hookName = process.argv[2] || "Unknown";
const stdin = readFileSync(0, "utf8");
const defaultNode = ${JSON.stringify(runtime.node)};
const defaultArcEntrypoint = ${JSON.stringify(runtime.entrypoint)};
const arcBin = process.env.AGENT_RUN_CACHE_ARC_BIN;
const command = arcBin || process.env.AGENT_RUN_CACHE_NODE || defaultNode;
const args = arcBin
  ? ["hook", "copilot", hookName]
  : [process.env.AGENT_RUN_CACHE_ARC_ENTRYPOINT || defaultArcEntrypoint, "hook", "copilot", hookName];
const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: process.env,
  input: stdin,
  encoding: "utf8",
  stdio: ["pipe", "pipe", "pipe"]
});

if (result.error || result.status !== 0) {
  const detail = result.error ? result.error.message : (result.stderr || "arc hook command failed").trim();
  if (detail) process.stderr.write("[arc] hook skipped: " + detail.slice(0, 500) + "\\n");
  process.stdout.write("{}\\n");
  process.exit(0);
}

process.stdout.write(result.stdout && result.stdout.trim() ? result.stdout : "{}\\n");
if (result.stdout && !result.stdout.endsWith("\\n")) process.stdout.write("\\n");
if (result.stderr) process.stderr.write(result.stderr);
`;
}

export interface CopilotPromptHookInstall {
  activationPath: string;
  repoHookPath: string;
  repoShimPath: string;
  userHookPath: string;
  userShimPath: string;
  runtime: ArcRuntime;
}

export type ArcIntegration = "copilot-plugin" | "sdk-extension" | "json-hooks";

export async function installCopilotPromptHook(workspace = workspaceRoot()): Promise<CopilotPromptHookInstall> {
  const runtime = assertDurableArcRuntime(currentArcRuntime());
  const activation = await writeActivation(workspace, runtime, "json-hooks");
  const repoHookPath = await installRepoHook(workspace, runtime);
  const userHook = await installCopilotUserHook(runtime);
  return {
    activationPath: activation,
    repoHookPath,
    repoShimPath: join(cacheDir(workspace), "bin", "copilot-hook.mjs"),
    userHookPath: userHook.hookPath,
    userShimPath: userHook.shimPath,
    runtime
  };
}

export async function installCopilotUserHook(runtime = assertDurableArcRuntime(currentArcRuntime())): Promise<{ hookPath: string; shimPath: string }> {
  const hookPath = join(copilotUserHooksDir(), "agent-run-cache.json");
  const shim = join(arcHome(), "bin", "copilot-hook.mjs");
  await installHookShim(shim, runtime);
  await writeHookConfig(hookPath, runtime.node, shim);
  return { hookPath, shimPath: shim };
}

async function installRepoHook(workspace: string, runtime: ArcRuntime): Promise<string> {
  const hookPath = join(workspace, ".github", "hooks", "agent-run-cache.json");
  const shim = join(cacheDir(workspace), "bin", "copilot-hook.mjs");
  await installHookShim(shim, runtime);
  await writeHookConfig(hookPath, runtime.node, shim);
  return hookPath;
}

export async function writeActivation(workspace: string, runtime: ArcRuntime, integration: ArcIntegration = "json-hooks"): Promise<string> {
  const file = activationPath(workspace);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({
    version: 1,
    workspace,
    integration,
    runtime: {
      node: runtime.node,
      entrypoint: runtime.entrypoint,
      packageRoot: runtime.packageRoot
    },
    activatedAt: new Date().toISOString()
  }, null, 2)}\n`, "utf8");
  return file;
}

export async function readActivationIntegration(workspace: string): Promise<ArcIntegration | null> {
  try {
    const data = JSON.parse(await readFile(activationPath(workspace), "utf8")) as { integration?: string };
    if (data.integration === "copilot-plugin" || data.integration === "sdk-extension" || data.integration === "json-hooks") {
      return data.integration;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeHookConfig(file: string, node: string, shim: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const hooks = {
    version: 1,
    hooks: {
      sessionStart: [{ type: "command", command: buildHookCommand(node, shim, "SessionStart"), timeoutSec: 20 }],
      userPromptSubmitted: [{ type: "command", command: buildHookCommand(node, shim, "UserPromptSubmit"), timeoutSec: 20 }],
      sessionEnd: [{ type: "command", command: buildHookCommand(node, shim, "SessionEnd"), timeoutSec: 20 }]
    }
  };
  await writeFile(file, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");
}

async function installHookShim(shim: string, runtime: ArcRuntime): Promise<void> {
  await mkdir(dirname(shim), { recursive: true });
  await writeFile(shim, hookShim(runtime), "utf8");
  await chmod(shim, 0o755).catch(() => undefined);
}

export function buildHookCommand(node: string, shim: string, hookName: string): string {
  const platform = looksLikeWindowsPath(node) || looksLikeWindowsPath(shim) ? "win32" : process.platform;
  return [node, shim, hookName].map((part) => quoteHookCommandArg(part, platform)).join(" ");
}

function quoteHookCommandArg(value: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_./:=+@%-]+$/.test(value)) return value;
  if (platform === "win32") return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[A-Za-z]:\\/.test(value) || value.includes("\\");
}
