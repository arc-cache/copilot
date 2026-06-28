import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { harvestSession } from "./copilot.js";
import { buildCopilotPromptInjection } from "./copilot-injection.js";
import { claimInvocationLock, hasRecentInvocationMarker } from "./invocation-lock.js";
import { debug } from "./store.js";
import { activationPath, copilotPluginWorkspacePath, isWorkspaceActivated, workspaceRoot } from "./paths.js";
import { currentArcRuntime } from "./runtime.js";
import { writeActivation } from "./install.js";

export async function handleCopilotHook(hookName: string): Promise<Record<string, unknown>> {
  let workspaceForError: string | undefined;
  try {
    if (process.env.AGENT_RUN_CACHE_IN_SIDECAR === "1") return {};
    const payload = await readStdinJson();
    const input = (payload.input && typeof payload.input === "object" ? payload.input : payload) as Record<string, unknown>;
    const cwd = typeof input.cwd === "string" ? input.cwd : typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    const workspace = workspaceRoot(cwd);
    workspaceForError = workspace;
    if (isPluginHook()) {
      await rememberCopilotPluginWorkspace(workspace).catch((error) => debug("hook.workspace_marker_failed", { error: String(error) }, workspace));
    }
    if (!isWorkspaceActivated(workspace)) {
      if (isPluginHook()) await writeActivation(workspace, currentArcRuntime(), "copilot-plugin");
      else return {};
    }

    const sessionId = String(input.sessionId ?? payload.sessionId ?? "unknown");
    if (await sdkExtensionPrimary(workspace) || await sdkExtensionSessionActive(workspace, sessionId)) {
      await debug("hook.skipped", { hookName, sessionId, reason: "sdk extension primary" }, workspace);
      return {};
    }

    if (!await claimHookInvocation(workspace, hookName, sessionId, input, payload)) return {};

    if (hookName === "SessionStart") {
      await debug("hook.session_start", { sessionId, context: "clean" }, workspace);
      return {};
    }

    if (hookName === "UserPromptSubmit") {
      const prompt = typeof input.prompt === "string" ? input.prompt : "";
      return (await buildCopilotPromptInjection(prompt, workspace, sessionId, "json-hook")).hookResult;
    }

    if (hookName === "SessionEnd" && sessionId !== "unknown") {
      const deferred = deferSessionHarvest(sessionId, workspace);
      if (deferred.started) {
        await debug("hook.session_end.deferred", { sessionId, pid: deferred.pid }, workspace);
        return {};
      }
      const harvested = await harvestSession(sessionId, workspace).catch(async (error) => {
        await debug("hook.session_end.harvest_failed", { sessionId, error: String(error) }, workspace);
        return false;
      });
      await debug("hook.session_end", { sessionId, harvested }, workspace);
    }
    return {};
  } catch (error) {
    if (workspaceForError && isWorkspaceActivated(workspaceForError)) {
      await debug("hook.failed", { hookName, error: String(error) }, workspaceForError).catch(() => undefined);
    }
    return {};
  }
}

function isPluginHook(): boolean {
  return process.env.AGENT_RUN_CACHE_COPILOT_PLUGIN === "1";
}

async function rememberCopilotPluginWorkspace(workspace: string): Promise<void> {
  const file = copilotPluginWorkspacePath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({
    version: 1,
    workspace,
    updatedAt: new Date().toISOString(),
    pid: process.pid
  }, null, 2)}\n`, "utf8");
}

async function sdkExtensionPrimary(workspace: string): Promise<boolean> {
  if (process.env.AGENT_RUN_CACHE_ALLOW_LEGACY_COPILOT_HOOKS === "1") return false;
  try {
    const activation = JSON.parse(await readFile(activationPath(workspace), "utf8")) as { integration?: string };
    return activation.integration === "sdk-extension";
  } catch {
    return false;
  }
}

function sdkExtensionSessionActive(workspace: string, sessionId: string): Promise<boolean> {
  if (!sessionId || sessionId === "unknown") return Promise.resolve(false);
  return hasRecentInvocationMarker(workspace, "copilot-sdk-active", [sessionId], 60 * 60 * 1000);
}

async function readStdinJson(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function claimHookInvocation(
  workspace: string,
  hookName: string,
  sessionId: string,
  input: Record<string, unknown>,
  payload: Record<string, unknown>
): Promise<boolean> {
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  const timestamp = input.timestamp ?? payload.timestamp ?? "";
  return claimInvocationLock(workspace, "hook", [hookName, sessionId, timestamp, prompt]);
}

function deferSessionHarvest(sessionId: string, workspace: string): { started: boolean; pid?: number } {
  const entrypoint = process.argv[1];
  if (!entrypoint) return { started: false };
  try {
    const child = spawn(process.execPath, [entrypoint, "harvest", sessionId], {
      cwd: workspace,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        AGENT_RUN_CACHE_IN_HOOK_BACKGROUND: "1"
      }
    });
    child.unref();
    return { started: true, pid: child.pid };
  } catch {
    return { started: false };
  }
}
