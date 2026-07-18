import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { currentArcRuntime, resolveArcOnPath } from "./runtime.js";

export interface CopilotPluginStatus {
  pluginDir: string;
  installed: boolean;
  listOutput: string;
  reason?: string;
}

export function arcPluginDir(): string {
  return join(currentArcRuntime().packageRoot, "plugin");
}

export function copilotPluginStatus(): CopilotPluginStatus {
  const pluginDir = arcPluginDir();
  const result = spawnSync("copilot", ["plugin", "list"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) return { pluginDir, installed: false, listOutput: output, reason: result.error.message };
  const installed = result.status === 0 && /\bagent-run-cache\b/.test(output);
  return { pluginDir, installed, listOutput: output, reason: result.status === 0 ? undefined : output || `copilot plugin list exited ${result.status}` };
}

export function installCopilotPlugin(): CopilotPluginStatus {
  const pluginDir = arcPluginDir();
  if (!existsSync(join(pluginDir, "plugin.json"))) {
    return { pluginDir, installed: false, listOutput: "", reason: `ARC plugin manifest not found at ${pluginDir}` };
  }
  const arcOnPath = resolveArcOnPath();
  if (!arcOnPath.found) {
    return {
      pluginDir,
      installed: false,
      listOutput: "",
      reason: "arc is not on PATH. Use the migration-aware install/upgrade command in the README before installing the Copilot plugin."
    };
  }
  const result = spawnSync("copilot", ["plugin", "install", pluginDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.error) return { pluginDir, installed: false, listOutput: output, reason: result.error.message };
  if (result.status !== 0) return { pluginDir, installed: false, listOutput: output, reason: output || `copilot plugin install exited ${result.status}` };
  return copilotPluginStatus();
}
