import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export function workspaceRoot(cwd = process.cwd()): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status === 0) return result.stdout.trim();
  return resolve(cwd);
}

export function cacheDir(workspace = workspaceRoot()): string {
  return process.env.AGENT_RUN_CACHE_DIR
    ? resolve(process.env.AGENT_RUN_CACHE_DIR)
    : join(workspace, ".agent-run-cache");
}

export function activationPath(workspace = workspaceRoot()): string {
  return join(cacheDir(workspace), "enabled.json");
}

export function isWorkspaceActivated(workspace = workspaceRoot()): boolean {
  return existsSync(activationPath(workspace));
}

export function copilotHome(): string {
  return process.env.COPILOT_HOME ? resolve(process.env.COPILOT_HOME) : join(homedir(), ".copilot");
}

export function copilotUserHooksDir(): string {
  return join(copilotHome(), "hooks");
}

export function copilotUserExtensionsDir(): string {
  return join(copilotHome(), "extensions");
}

export function arcHome(): string {
  return process.env.AGENT_RUN_CACHE_HOME ? resolve(process.env.AGENT_RUN_CACHE_HOME) : join(homedir(), ".agent-run-cache");
}

export function copilotPluginWorkspacePath(): string {
  return join(arcHome(), "copilot-plugin-workspace.json");
}

// Model weights and the inference runtime are machine-wide, not per-repo: one
// download serves every workspace.
export function modelsDir(): string {
  if (process.env.AGENT_RUN_CACHE_MODELS_DIR) return resolve(process.env.AGENT_RUN_CACHE_MODELS_DIR);
  return join(homedir(), ".agent-run-cache", "models");
}

export function runtimeDir(): string {
  if (process.env.AGENT_RUN_CACHE_RUNTIME_DIR) return resolve(process.env.AGENT_RUN_CACHE_RUNTIME_DIR);
  return join(homedir(), ".agent-run-cache", "runtime");
}

export function ensureCache(workspace = workspaceRoot()): string {
  const dir = cacheDir(workspace);
  mkdirSync(join(dir, "traces"), { recursive: true });
  mkdirSync(join(dir, "debug"), { recursive: true });
  mkdirSync(join(dir, "copilot-logs"), { recursive: true });
  mkdirSync(join(dir, "locks"), { recursive: true });
  return dir;
}

export function memoryPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "memory.jsonl");
}

export function memoryEventsPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "memory-events.jsonl");
}

export function tracePath(sessionId: string, workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "traces", `arc-${safeName(sessionId)}.jsonl`);
}

export function debugPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "debug", "runtime.jsonl");
}

export function observerPath(sessionId: string, workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "debug", `observer-${safeName(sessionId)}.jsonl`);
}

export function reviewedPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "reviewed.jsonl");
}

export function declinedPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "declined.jsonl");
}

export function judgeDecisionsPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "judge-decisions.jsonl");
}

export function retrievalReputationPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "retrieval-reputation.json");
}

export function sidecarPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "debug", "sidecar.jsonl");
}

export function reviewLockPath(sessionId: string, workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "locks", `review-${safeName(sessionId)}.lock`);
}

export function memoryLockPath(workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "locks", "memory-jsonl.lock");
}

export function copilotTranscriptPath(sessionId: string): string {
  const root = process.env.AGENT_RUN_CACHE_COPILOT_STATE_DIR ?? join(homedir(), ".copilot", "session-state");
  return join(root, sessionId, "events.jsonl");
}

export function copilotLogDir(sessionId: string, workspace = workspaceRoot()): string {
  return join(ensureCache(workspace), "copilot-logs", sessionId);
}

export function workspaceKey(workspace = workspaceRoot()): string {
  const remote = gitValue(workspace, ["config", "--get", "remote.origin.url"]);
  if (remote) return `git:${hash(normalizeGitRemote(remote))}`;
  const rootName = basename(workspace) || "workspace";
  return `local:${safeName(rootName)}:${hash(resolve(workspace)).slice(0, 12)}`;
}

export function workspaceGroup(): string {
  return process.env.AGENT_RUN_CACHE_WORKSPACE_GROUP ?? "";
}

function gitValue(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function normalizeGitRemote(value: string): string {
  return value
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/\.git$/, "")
    .toLowerCase();
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function safeName(value: string): string {
  const allowed = new Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-".split(""));
  const name = [...value].map((char) => allowed.has(char) ? char : "_").join("").slice(0, 180);
  return name || "unknown";
}
