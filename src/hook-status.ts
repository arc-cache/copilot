import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { activationPath, arcHome, cacheDir, copilotUserHooksDir } from "./paths.js";
import { currentArcRuntime, type ArcRuntime } from "./runtime.js";

export interface CopilotHookStatus {
  installed: boolean;
  path: string;
  activationPath?: string;
  activated?: boolean;
  repoHookInstalled?: boolean;
  repoHookRuntimePinned?: boolean;
  repoHookShimPath?: string;
  userHookPath?: string;
  userHookInstalled?: boolean;
  userHookRuntimePinned?: boolean;
  userHookShimPath?: string;
  sessionStart: boolean;
  userPromptSubmitted: boolean;
  sessionEnd: boolean;
  renderMode?: string;
  reason?: string;
}

export const COPILOT_HOOK_RENDER_MODE = "context-only: Copilot accepts additionalContext/modifiedPrompt without stopping the agent loop; responseContent renders only with handled=true, which skips the agent loop; sessionEnd output is ignored";

export async function copilotHookStatus(workspace: string): Promise<CopilotHookStatus> {
  const path = join(workspace, ".github", "hooks", "agent-run-cache.json");
  const userHookPath = join(copilotUserHooksDir(), "agent-run-cache.json");
  const repoHookShimPath = join(cacheDir(workspace), "bin", "copilot-hook.mjs");
  const userHookShimPath = join(arcHome(), "bin", "copilot-hook.mjs");
  const activePath = activationPath(workspace);
  const runtime = currentArcRuntime();
  const [repo, user] = await Promise.all([
    readHookFile(path, repoHookShimPath, runtime),
    readHookFile(userHookPath, userHookShimPath, runtime)
  ]);
  const activated = existsSync(activePath);
  const sessionStart = repo.sessionStart || user.sessionStart;
  const userPromptSubmitted = repo.userPromptSubmitted || user.userPromptSubmitted;
  const sessionEnd = repo.sessionEnd || user.sessionEnd;
  const repoHookInstalled = repo.installed;
  const userHookInstalled = user.installed;
  const installed = activated && (repoHookInstalled || userHookInstalled);
  return {
    installed,
    path,
    activationPath: activePath,
    activated,
    repoHookInstalled,
    repoHookRuntimePinned: repo.runtimePinned,
    repoHookShimPath,
    userHookPath,
    userHookInstalled,
    userHookRuntimePinned: user.runtimePinned,
    userHookShimPath,
    sessionStart,
    userPromptSubmitted,
    sessionEnd,
    renderMode: COPILOT_HOOK_RENDER_MODE,
    reason: installed ? undefined : hookReason(activated, repo, user)
  };
}

async function readHookFile(
  path: string,
  shimPath: string,
  runtime: ArcRuntime
): Promise<{ installed: boolean; runtimePinned: boolean; sessionStart: boolean; userPromptSubmitted: boolean; sessionEnd: boolean; reason?: string }> {
  if (!existsSync(path)) {
    return { installed: false, runtimePinned: false, sessionStart: false, userPromptSubmitted: false, sessionEnd: false, reason: "missing hook file" };
  }
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { hooks?: Record<string, unknown> };
    const hooks = raw.hooks ?? {};
    const sessionStart = hookCommandIncludes(hooks.sessionStart, "SessionStart");
    const userPromptSubmitted = hookCommandIncludes(hooks.userPromptSubmitted, "UserPromptSubmit");
    const sessionEnd = hookCommandIncludes(hooks.sessionEnd, "SessionEnd");
    const runtimePinned = await hookRuntimePinned(hooks, shimPath, runtime);
    return {
      installed: sessionStart && userPromptSubmitted && sessionEnd,
      runtimePinned,
      sessionStart,
      userPromptSubmitted,
      sessionEnd,
      reason: sessionStart && userPromptSubmitted && sessionEnd ? undefined : "missing one or more ARC hook events"
    };
  } catch (error) {
    return { installed: false, runtimePinned: false, sessionStart: false, userPromptSubmitted: false, sessionEnd: false, reason: String(error) };
  }
}

function hookReason(
  activated: boolean,
  repo: { installed: boolean; reason?: string },
  user: { installed: boolean; reason?: string }
): string {
  if (!activated) return "workspace not activated yet - install the Copilot plugin with arc plugin install, then launch Copilot normally";
  if (!repo.installed && !user.installed) return `missing hook file (${user.reason ?? repo.reason ?? "unknown"})`;
  return "missing one or more ARC hook events";
}

function hookCommandIncludes(value: unknown, hookName: string): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const command = (entry as Record<string, unknown>).command;
    return typeof command === "string"
      && command.includes(hookName)
      && (command.includes("hook copilot") || command.includes("copilot-hook.mjs") || command.includes("agent-run-cache"));
  });
}

async function hookRuntimePinned(hooks: Record<string, unknown>, shimPath: string, runtime: ArcRuntime): Promise<boolean> {
  const commands = [
    ...hookCommands(hooks.sessionStart),
    ...hookCommands(hooks.userPromptSubmitted),
    ...hookCommands(hooks.sessionEnd)
  ];
  if (!commands.length) return false;
  if (!commands.every((command) => command.includes(runtime.node) && command.includes(shimPath))) return false;
  if (!existsSync(shimPath)) return false;
  const shim = await readFile(shimPath, "utf8");
  return shim.includes(JSON.stringify(runtime.node)) && shim.includes(JSON.stringify(runtime.entrypoint));
}

function hookCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => entry && typeof entry === "object" ? (entry as Record<string, unknown>).command : undefined)
    .filter((command): command is string => typeof command === "string");
}
