#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { importCopilotOtel, importCopilotTranscript, launchCopilot, harvestSession } from "./copilot.js";
import { runAcpProxy } from "./acp.js";
import { runAsk } from "./ask.js";
import { loadDeclinedDraftViews, promoteDeclinedDraft } from "./declined.js";
import { loadMemoryEvents } from "./ledger.js";
import { reviewEvents } from "./review.js";
import { writeDebugBundle } from "./bundle.js";
import { buildInjectionPlan } from "./retrieval.js";
import { loadCapsules, saveCapsule, updateCapsuleMetadata } from "./store.js";
import { handleCopilotHook } from "./hooks.js";
import { installCopilotPromptHook, readActivationIntegration } from "./install.js";
import { handleCopilotExtension } from "./copilot-extension-runtime.js";
import { runMcpServer } from "./mcp.js";
import { workspaceRoot, cacheDir, copilotTranscriptPath, debugPath, memoryEventsPath, memoryPath } from "./paths.js";
import { installCopilotSdkExtension, copilotSdkExtensionStatus } from "./copilot-extension.js";
import { arcPluginDir, copilotPluginStatus, installCopilotPlugin } from "./copilot-plugin.js";
import { copilotHookStatus } from "./hook-status.js";
import { runArcUi } from "./ui-runtime.js";
import { copilotTabStatus, installCopilotTab, renderCopilotTabFrame, restoreCopilotTab } from "./copilot-tab.js";
import { arcConfigPath, loadArcConfig, saveArcConfig } from "./config.js";
import { listJudgeModels } from "./judge-models.js";
import { judgeReachability, type JudgeReachability } from "./judge-reachability.js";
import { loadJudgeDecisions, loadRetrievalReputation } from "./retrieval-reputation.js";
import { currentArcRuntime, resolveArcOnPath } from "./runtime.js";
import { loadArcUiViewModel } from "./ui-data.js";
import { buildMetricsReport } from "./telemetry.js";
import type { Capsule } from "./types.js";
import type { MemoryEvent } from "./ledger.js";

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
  } else if (!command) {
    process.exit(await runArcUi([], workspaceRoot()));
  } else if (command === "ui") {
    process.exit(await runArcUi(args, workspaceRoot()));
  } else if (command === "tab") {
    await runTab(args, workspaceRoot());
  } else if (command === "copilot-tab") {
    await runCopilotTab(args);
  } else if (command === "ask") {
    process.exit(await runAsk(args, workspaceRoot()));
  } else if (command === "acp") {
    process.exit(await runAcpProxy(args));
  } else if (command === "status") {
    await runStatus(args, workspaceRoot());
  } else if (command === "capsules") {
    await runCapsules(args, workspaceRoot());
  } else if (command === "events") {
    await runEvents(args, workspaceRoot());
  } else if (command === "metrics") {
    await runMetrics(args, workspaceRoot());
  } else if (command === "replay-eval") {
    await runReplayEval(args, workspaceRoot());
  } else if (command === "probe") {
    await runProbe(args, workspaceRoot());
  } else if (command === "judge") {
    await runJudge(args);
  } else if (command === "mcp") {
    process.exit(await runMcpServer());
  } else if (command === "plugin") {
    await runPlugin(args);
  } else if (command === "json-hooks") {
    await runJsonHooks(args, workspaceRoot());
  } else if (command === "sdk-extension") {
    await runSdkExtension(args, workspaceRoot());
  } else if (command === "copilot") {
    process.exit(await launchCopilot(args));
  } else if (command === "hook") {
    const runner = args[0];
    const hookName = args[1] ?? "Unknown";
    if (runner !== "copilot") throw new Error("Only Copilot hooks are supported in this rewrite.");
    console.log(JSON.stringify(await handleCopilotHook(hookName)));
  } else if (command === "extension") {
    console.log(JSON.stringify(await handleCopilotExtension(args)));
  } else if (command === "consult" || command === "inject") {
    const prompt = args.join(" ");
    console.log(JSON.stringify(await buildInjectionPlan(prompt, workspaceRoot()), null, 2));
  } else if (command === "import-copilot") {
    const path = args[0];
    if (!path) throw new Error("Usage: arc import-copilot <events.jsonl>");
    if (!existsSync(path)) throw new Error(`Input file not found: ${path}`);
    const events = await importCopilotTranscript(path);
    const sessionId = events[0]?.sessionId ?? randomUUID();
    await reviewEvents(events, workspaceRoot(), sessionId);
    console.log(`imported and reviewed ${events.length} events from ${path}`);
  } else if (command === "import-otel") {
    const path = args[0];
    if (!path) throw new Error("Usage: arc import-otel <otel.jsonl>");
    if (!existsSync(path)) throw new Error(`Input file not found: ${path}`);
    const fallbackSessionId = args[1] ?? randomUUID();
    const events = await importCopilotOtel(path, workspaceRoot(), fallbackSessionId);
    const sessionId = events[0]?.sessionId ?? fallbackSessionId;
    await reviewEvents(events, workspaceRoot(), sessionId);
    console.log(`imported and reviewed ${events.length} OTel-derived events from ${path}`);
  } else if (command === "harvest") {
    const sessionId = args[0];
    if (!sessionId) throw new Error("Usage: arc harvest <copilot-session-id>");
    const harvested = await harvestSession(sessionId);
    if (!harvested) throw new Error(`No Copilot transcript or OTel data found for session: ${sessionId}`);
    console.log(`harvested ${sessionId}`);
  } else if (command === "doctor") {
    await doctor(args);
  } else if (command === "reset") {
    await reset(args);
  } else if (command === "debug-bundle") {
    const result = await writeDebugBundle(args[0]);
    console.log(`wrote redacted debug bundle to ${result.path}`);
    console.log(`files: ${result.fileCount}, traces: ${result.traceCount}`);
  } else if (command === "smoke") {
    await smoke();
  } else if (command === "logs") {
    await logs(args);
  } else if (command === "setup") {
    await runSetup(args, workspaceRoot());
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function runPlugin(args: string[]): Promise<void> {
  const json = hasJson(args);
  const clean = stripFlag(args, "--json");
  const subcommand = clean[0] ?? "status";
  if (subcommand === "path") {
    const payload = { pluginDir: arcPluginDir() };
    if (json) writeJson(payload);
    else console.log(payload.pluginDir);
    return;
  }
  const status = subcommand === "install" ? installCopilotPlugin() : copilotPluginStatus();
  if (subcommand !== "install" && subcommand !== "status") throw new Error("Usage: arc plugin install|status|path [--json]");
  if (json) {
    writeJson(status);
    if (subcommand === "install" && !status.installed) process.exitCode = 1;
    return;
  }
  console.log(`copilot plugin: ${status.installed ? "installed" : "not installed"}`);
  console.log(`plugin path: ${status.pluginDir}`);
  if (status.reason) console.log(`reason: ${status.reason}`);
  if (status.listOutput) console.log(status.listOutput);
  if (subcommand === "install" && !status.installed) process.exitCode = 1;
}

async function runSetup(args: string[], workspace: string): Promise<void> {
  assertKnownFlags(args, new Set(["--json", "--install-copilot-tab", "--no-copilot-tab", "--sidecar-copilot-command", "--copilot-root"]));
  const configuredSidecar = setupSidecarCopilotCommand(args);
  const config = configuredSidecar ? await saveArcConfig({ sidecarCopilotCommand: configuredSidecar }) : await loadArcConfig();
  const plugin = installCopilotPlugin();
  const [capsules, extension, hook, integration] = await Promise.all([
    loadCapsules(workspace),
    copilotSdkExtensionStatus(workspace),
    copilotHookStatus(workspace),
    readActivationIntegration(workspace)
  ]);
  const ignoredTab = args.includes("--install-copilot-tab") && !args.includes("--no-copilot-tab");
  const payload = {
    workspace,
    integration,
    integrationReason: integration
      ? `Workspace already activated through ${integration}.`
      : "The Copilot plugin auto-activates this workspace the first time its hook runs.",
    plugin,
    extension,
    runtime: currentArcRuntime(),
    configPath: arcConfigPath(),
    sidecarCopilotCommand: config.sidecarCopilotCommand ?? null,
    legacyHook: hook,
    copilotTabIgnored: ignoredTab,
    copilotTabCaveat: "The Copilot Arc tab patch is experimental. Run arc copilot-tab install explicitly if you want to try it.",
    capsuleCount: capsules.length,
    launch: "copilot"
  };
  if (hasJson(args)) {
    writeJson(payload);
    if (!plugin.installed) process.exitCode = 1;
    return;
  }
  console.log(`ARC Copilot plugin ${plugin.installed ? "installed" : "not installed"} for ${workspace}.`);
  console.log(`plugin: ${plugin.pluginDir}`);
  if (plugin.reason) console.log(`plugin reason: ${plugin.reason}`);
  if (plugin.listOutput) console.log(plugin.listOutput);
  console.log(`launch: copilot`);
  console.log(`view: arc ui`);
  console.log(`workspace activation: ${integration ?? "pending first plugin hook"}`);
  console.log(`runtime: ${currentArcRuntime().node} ${currentArcRuntime().entrypoint}`);
  console.log(`config: ${arcConfigPath()}`);
  console.log(`sidecar copilot command: ${config.sidecarCopilotCommand ?? "auto (uses copilot on PATH)"}`);
  console.log(`legacy json hook: ${hook.installed ? "installed (explicit fallback)" : "not installed"}`);
  console.log(`SDK extension: ${extension.installed ? "installed (experimental)" : "not installed"}`);
  if (ignoredTab) console.log("copilot tab: ignored by setup; run arc copilot-tab install explicitly for the experimental patch");
  console.log(`capsules: ${capsules.length}`);
  if (!plugin.installed) process.exitCode = 1;
}

async function runJsonHooks(args: string[], workspace: string): Promise<void> {
  const json = hasJson(args);
  const clean = stripFlag(args, "--json");
  const subcommand = clean[0] ?? "status";
  let hook: Awaited<ReturnType<typeof copilotHookStatus>>;
  if (subcommand === "install") {
    await installCopilotPromptHook(workspace);
    hook = await copilotHookStatus(workspace);
  } else if (subcommand === "status") {
    hook = await copilotHookStatus(workspace);
  } else {
    throw new Error("Usage: arc json-hooks install|status [--json]");
  }
  if (json) {
    writeJson({ hook });
    return;
  }
  console.log(`json hooks: ${hook.installed ? "installed" : "not installed"}`);
  console.log(`hook path: ${hook.path}`);
  if (hook.reason) console.log(`reason: ${hook.reason}`);
}

async function runSdkExtension(args: string[], workspace: string): Promise<void> {
  const json = hasJson(args);
  const clean = stripFlag(args, "--json");
  const subcommand = clean[0] ?? "status";
  let install: Awaited<ReturnType<typeof installCopilotSdkExtension>> | null = null;
  if (subcommand === "install") install = await installCopilotSdkExtension(workspace);
  else if (subcommand !== "status") throw new Error("Usage: arc sdk-extension install|status [--json]");
  const extension = await copilotSdkExtensionStatus(workspace);
  const payload = { extension, install };
  if (json) {
    writeJson(payload);
    return;
  }
  console.log(`SDK extension: ${extension.installed ? "installed" : "not installed"}`);
  console.log(`project extension: ${extension.projectExtensionPath}`);
  console.log(`user extension: ${extension.userExtensionPath}`);
  console.log(`host: ${extensionHostSummary(extension.host)}`);
  if (extension.reason) console.log(`reason: ${extension.reason}`);
}

async function runTab(args: string[], workspace: string): Promise<void> {
  if (hasJson(args)) {
    writeJson(await loadArcUiViewModel(workspace));
    return;
  }
  if (args[0] !== "--frame") throw new Error("Usage: arc tab --json | arc tab --frame [--width N] [--height N]");
  process.stdout.write(`${await renderCopilotTabFrame(args.slice(1), workspace)}\n`);
}

async function runCopilotTab(args: string[]): Promise<void> {
  const json = hasJson(args);
  const clean = stripFlag(args, "--json");
  const subcommand = clean[0] ?? "status";
  const rest = clean.slice(1);
  let result: Awaited<ReturnType<typeof copilotTabStatus>>;
  if (subcommand === "install") result = await installCopilotTab(rest);
  else if (subcommand === "status") result = await copilotTabStatus(rest);
  else if (subcommand === "restore") result = await restoreCopilotTab(rest);
  else throw new Error("Usage: arc copilot-tab install|status|restore [--copilot-root <path>] [--json]");
  if (json) {
    writeJson(result);
    return;
  }
  console.log(`copilot tab: ${result.installed ? "installed" : "not installed"}`);
  if (result.changed) console.log("changed: yes");
  if (result.appJs) console.log(`app: ${result.appJs}`);
  if (result.backupPath) console.log(`backup: ${result.backupPath}`);
  if (result.runtimeEntrypoint) console.log(`runtime: ${result.runtimeEntrypoint}`);
  if (result.runtimePinned !== undefined) console.log(`runtime pinned: ${result.runtimePinned ? "yes" : "no"}`);
  if (result.reason) console.log(`reason: ${result.reason}`);
  console.log(`caveat: ${result.caveat}`);
}

async function logs(args: string[]): Promise<void> {
  const workspace = workspaceRoot();
  const file = debugPath(workspace);
  const follow = args.includes("--follow") || args.includes("-f");
  let offset = 0;
  while (true) {
    if (existsSync(file)) {
      const text = await readFile(file, "utf8");
      const next = text.slice(offset);
      offset = text.length;
      for (const line of next.split(/\r?\n/).filter(Boolean)) {
        console.log(formatLogLine(line));
      }
    }
    if (!follow) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

function formatLogLine(line: string): string {
  try {
    const record = JSON.parse(line) as { timestamp?: string; action?: string; details?: Record<string, unknown> };
    const time = record.timestamp ? record.timestamp.slice(11, 19) : "--:--:--";
    const action = record.action ?? "event";
    const details = record.details ? summarizeDetails(record.details) : "";
    return `[${time}] ${action}${details ? ` ${details}` : ""}`;
  } catch {
    return line;
  }
}

function summarizeDetails(details: Record<string, unknown>): string {
  const keep = ["sessionId", "reason", "source", "status", "currentGoal", "possibleReusableWork", "title", "eventCount", "total", "newEvents", "sidecarCalls"];
  const compact: Record<string, unknown> = {};
  for (const key of keep) {
    if (details[key] !== undefined) compact[key] = details[key];
  }
  return Object.keys(compact).length ? JSON.stringify(compact) : "";
}

async function runStatus(args: string[], workspace: string): Promise<void> {
  assertKnownFlags(args, new Set(["--json"]));
  const payload = await statusPayload(workspace);
  if (hasJson(args)) {
    writeJson(payload);
    return;
  }
  console.log(`workspace: ${payload.workspace}`);
  console.log(`cache: ${payload.cacheDir}`);
  console.log(`capsules: ${payload.capsuleCount}`);
  console.log(`events: ${payload.eventCount}`);
  const judge = payload.judge as { mode: string; model: { provider: string; id: string } | null; reachability: JudgeReachability };
  console.log(`judge: ${judge.mode} (${judge.model ? `${judge.model.provider}:${judge.model.id}` : "none"})`);
  console.log(`judge reachable: ${judge.reachability.reachable ? "yes" : "no"} (${judge.reachability.reason})`);
}

async function runCapsules(args: string[], workspace: string): Promise<void> {
  const json = hasJson(args);
  const clean = stripFlag(args, "--json");
  if (clean[0] === "declined") {
    assertKnownFlags(clean.slice(1), new Set());
    const declined = await loadDeclinedDraftViews(workspace);
    if (json) writeJson({ declined });
    else {
      console.log(`${declined.length} declined draft${declined.length === 1 ? "" : "s"}`);
      for (const draft of declined) {
        console.log(`${draft.id.slice(0, 18)}  ${draft.outcome}  ${ageFromSeconds(draft.ageSeconds)}  ${draft.title}`);
        console.log(`  ${draft.reason.slice(0, 120)}`);
      }
    }
    return;
  }
  if (clean[0] === "promote") {
    assertKnownFlags(clean.slice(1), new Set());
    const id = clean[1];
    if (!id) throw new Error("Usage: arc capsules promote <id> [--json]");
    const promoted = await promoteDeclinedDraft(id, workspace);
    if (json) writeJson(promoted);
    else console.log(`promoted ${promoted.declinedDraftId} to capsule ${promoted.capsule.id}`);
    return;
  }
  if (clean[0] === "set") {
    await runCapsuleSet(clean.slice(1), workspace, json);
    return;
  }
  assertKnownFlags(clean, new Set());
  const capsules = await loadCapsules(workspace);
  const id = clean[0];
  if (id) {
    const capsule = findCapsule(capsules, id);
    if (!capsule) throw new Error(`No capsule matches ${id}`);
    if (json) writeJson({ capsule });
    else printCapsule(capsule);
    return;
  }
  if (json) writeJson({ capsules });
  else {
    console.log(`${capsules.length} capsule${capsules.length === 1 ? "" : "s"}`);
    for (const capsule of capsules.slice().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
      console.log(`${capsule.id.slice(0, 8)}  ${capsule.status}/${capsule.privacyLabel}  ${capsule.title}`);
    }
  }
}

function ageFromSeconds(seconds: number): string {
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 60)}m`;
}

async function runCapsuleSet(args: string[], workspace: string, json: boolean): Promise<void> {
  const id = args[0];
  if (!id) throw new Error("Usage: arc capsules set <id> [--status <s>] [--privacy <label>] [--json]");
  const patch: Record<string, string> = {};
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--status") {
      const value = args[++index];
      if (!value) throw new Error("Missing value for --status");
      patch.status = value;
    } else if (arg === "--privacy") {
      const value = args[++index];
      if (!value) throw new Error("Missing value for --privacy");
      patch.privacyLabel = value;
    } else {
      throw new Error(`Unknown capsules set option: ${arg}`);
    }
  }
  if (!Object.keys(patch).length) throw new Error("Provide --status and/or --privacy");
  const capsule = await updateCapsuleMetadata(id, patch, workspace);
  if (!capsule) throw new Error(`No capsule matches ${id}`);
  if (json) writeJson({ capsule });
  else console.log(`updated ${capsule.id}: ${capsule.status}/${capsule.privacyLabel}`);
}

async function runEvents(args: string[], workspace: string): Promise<void> {
  const json = hasJson(args);
  const limit = parseLimit(args);
  const clean = stripLimit(stripFlag(args, "--json"));
  assertKnownFlags(clean, new Set());
  const events = await loadMemoryEvents(workspace);
  const payload = { total: events.length, events: events.slice(-limit).reverse() };
  if (json) {
    writeJson(payload);
    return;
  }
  console.log(`${payload.total} event${payload.total === 1 ? "" : "s"}`);
  for (const event of payload.events) {
    const detail = event.details?.title || event.details?.reason || event.capsuleId || event.sessionId || "";
    console.log(`${event.timestamp}  ${event.type}${detail ? `  ${detail}` : ""}`);
  }
}

async function runProbe(args: string[], workspace: string): Promise<void> {
  const json = hasJson(args);
  const prompt = stripFlag(args, "--json").join(" ").trim();
  if (!prompt) throw new Error("Usage: arc probe \"<prompt>\" [--json]");
  const previous = process.env.AGENT_RUN_CACHE_MODEL_SIDECAR;
  process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = "off";
  try {
    const plan = await buildInjectionPlan(prompt, workspace);
    if (json) {
      writeJson(plan);
      return;
    }
    console.log(plan.shouldInject ? "injection: yes" : "injection: no");
    console.log(`reason: ${plan.reason}`);
    if (plan.capsule) console.log(`capsule: ${plan.capsule.id} ${plan.capsule.title}`);
    if (plan.message) console.log(plan.message);
  } finally {
    if (previous === undefined) delete process.env.AGENT_RUN_CACHE_MODEL_SIDECAR;
    else process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = previous;
  }
}

async function runJudge(args: string[]): Promise<void> {
  const json = hasJson(args);
  const clean = stripFlag(args, "--json");
  const subcommand = clean[0] ?? "status";
  if (subcommand === "models") {
    const models = await listJudgeModels();
    if (json) writeJson(models);
    else {
      console.log(`${models.models.length} judge-capable model${models.models.length === 1 ? "" : "s"}`);
      for (const model of models.models) {
        const hints = [model.costHint, model.sizeHint].filter(Boolean).join(", ");
        console.log(`${model.provider}:${model.id}${hints ? `  ${hints}` : ""}`);
      }
      for (const [provider, error] of Object.entries(models.errors)) console.log(`${provider}: ${error}`);
    }
    return;
  }
  if (subcommand === "decisions") {
    const workspace = workspaceRoot();
    const decisions = await loadJudgeDecisions(workspace, parseLimit(clean));
    if (json) writeJson({ total: decisions.length, decisions: decisions.slice().reverse() });
    else {
      console.log(`${decisions.length} judge decision${decisions.length === 1 ? "" : "s"}`);
      for (const decision of decisions.slice().reverse().slice(0, 20)) {
        const verdict = decision.verdict.inject ? `inject ${decision.verdict.inject}` : "abstain";
        console.log(`${decision.timestamp}  ${decision.mode}  ${verdict}  ${decision.verdict.confidence ?? "?"}  ${decision.verdict.reason ?? ""}`);
      }
    }
    return;
  }
  if (subcommand === "reputation") {
    const workspace = workspaceRoot();
    const reputation = await loadRetrievalReputation(workspace);
    const rows = [...reputation.entries()].sort((left, right) => right[1] - left[1]);
    if (json) writeJson({ reputation: rows.map(([capsuleId, multiplier]) => ({ capsuleId, multiplier })) });
    else {
      console.log(`${rows.length} capsule reputation signal${rows.length === 1 ? "" : "s"}`);
      for (const [capsuleId, multiplier] of rows) console.log(`${capsuleId}  ${multiplier.toFixed(3)}`);
    }
    return;
  }
  if (subcommand === "set") {
    const mode = optionValue(clean, "--mode");
    const model = optionValue(clean, "--model");
    const patch: Parameters<typeof saveArcConfig>[0] = {};
    if (mode) {
      if (mode !== "embedding-only" && mode !== "provider-judge") throw new Error("--mode must be embedding-only or provider-judge");
      patch.injectionJudgeMode = mode;
    }
    if (model) patch.injectionJudgeModel = parseJudgeModel(model);
    const config = await saveArcConfig(patch);
    const reachability = judgeReachability(config);
    const warning = judgeWarning(reachability);
    if (json) writeJson({ configPath: arcConfigPath(), config, reachability, warning });
    else printJudgeConfig(config, reachability);
    return;
  }
  if (subcommand !== "status") throw new Error("Usage: arc judge [status|models|decisions|reputation|set] [--json] [--mode embedding-only|provider-judge] [--model provider:id]");
  const config = await loadArcConfig();
  const reachability = judgeReachability(config);
  const warning = judgeWarning(reachability);
  if (json) writeJson({ configPath: arcConfigPath(), config, reachability, warning });
  else printJudgeConfig(config, reachability);
}

function parseJudgeModel(value: string): { provider: "copilot" | "ollama"; id: string } {
  const index = value.indexOf(":");
  const provider = index >= 0 ? value.slice(0, index) : "";
  const id = index >= 0 ? value.slice(index + 1) : "";
  if ((provider !== "copilot" && provider !== "ollama") || !id.trim()) {
    throw new Error("--model must be provider:id, for example ollama:gemma4:31b-cloud");
  }
  return { provider, id: id.trim() };
}

function printJudgeConfig(config: Awaited<ReturnType<typeof loadArcConfig>>, reachability: JudgeReachability): void {
  const mode = config.injectionJudgeMode ?? "embedding-only";
  const model = config.injectionJudgeModel ? `${config.injectionJudgeModel.provider}:${config.injectionJudgeModel.id}` : "none";
  console.log(`judge mode: ${mode}`);
  console.log(`judge model: ${model}`);
  console.log(`judge reachable: ${reachability.reachable ? "yes" : "no"} (${reachability.reason})`);
  const warning = judgeWarning(reachability);
  if (warning) console.log(`WARNING: ${warning}`);
  console.log(`config: ${arcConfigPath()}`);
}

function judgeWarning(reachability: JudgeReachability): string | null {
  return reachability.configured && !reachability.reachable ? reachability.reason : null;
}

async function statusPayload(workspace: string): Promise<Record<string, unknown>> {
  const [capsules, events, extension, hook, plugin, config, integration] = await Promise.all([
    loadCapsules(workspace),
    loadMemoryEvents(workspace),
    copilotSdkExtensionStatus(workspace),
    copilotHookStatus(workspace),
    Promise.resolve(copilotPluginStatus()),
    loadArcConfig(),
    readActivationIntegration(workspace)
  ]);
  return {
    workspace,
    cacheDir: cacheDir(workspace),
    memoryPath: memoryPath(workspace),
    memoryEventsPath: memoryEventsPath(workspace),
    integration,
    plugin,
    extension,
    hook,
    judge: {
      mode: config.injectionJudgeMode ?? "embedding-only",
      model: config.injectionJudgeModel ?? null,
      reachability: judgeReachability(config)
    },
    capsuleCount: capsules.length,
    eventCount: events.length,
    generatedAt: new Date().toISOString()
  };
}

function findCapsule(capsules: Capsule[], idOrPrefix: string): Capsule | null {
  return capsules.find((capsule) => capsule.id === idOrPrefix || capsule.id.startsWith(idOrPrefix)) ?? null;
}

function printCapsule(capsule: Capsule): void {
  console.log(`${capsule.id}  ${capsule.status}/${capsule.privacyLabel}`);
  console.log(capsule.title);
  if (capsule.summary) console.log(capsule.summary);
  if (capsule.nextRunInstruction) console.log(`next: ${capsule.nextRunInstruction}`);
}

function hasJson(args: string[]): boolean {
  return args.includes("--json");
}

function stripFlag(args: string[], flag: string): string[] {
  return args.filter((arg) => arg !== flag);
}

function parseLimit(args: string[]): number {
  const index = args.indexOf("--limit");
  if (index < 0) return 200;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error("Usage: arc events [--json] [--limit N]");
  return Math.min(Math.floor(value), 2000);
}

async function runMetrics(args: string[], workspace: string): Promise<void> {
  assertKnownFlags(args, new Set(["--json"]));
  const report = await buildMetricsReport(workspace);
  if (hasJson(args)) return writeJson(report);
  console.log(`sessions: ${report.summary.sessionCount}`);
  console.log(`tools: ${report.summary.toolCalls} (failed ${(report.summary.failedToolRate * 100).toFixed(1)}%)`);
  console.log(`tokens: ${report.summary.tokens.total} (provider ${report.summary.tokens.provider}, estimated ${report.summary.tokens.estimated})`);
  console.log(`cost: $${report.summary.cost.knownUsd.toFixed(4)}${report.summary.cost.unknownSessions ? ` known; ${report.summary.cost.unknownSessions} session(s) unknown` : ""}`);
}

async function runReplayEval(args: string[], workspace: string): Promise<void> {
  assertKnownFlags(args, new Set(["--json"]));
  const evaluations = (await buildMetricsReport(workspace)).evaluations;
  if (hasJson(args)) return writeJson(evaluations);
  console.log(JSON.stringify(evaluations, null, 2));
}

function stripLimit(args: string[]): string[] {
  const index = args.indexOf("--limit");
  if (index < 0) return args;
  return [...args.slice(0, index), ...args.slice(index + 2)];
}

function assertKnownFlags(args: string[], known: Set<string>): void {
  for (const arg of args) {
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (arg.startsWith("-") && !known.has(name)) throw new Error(`Unknown option: ${name}`);
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function printHelp(): void {
  console.log(`Agent Run Cache

Usage:
  arc
  arc ui
  arc plugin install|status|path [--json]
  arc setup [--sidecar-copilot-command "<command>"]
  arc mcp
  arc json-hooks install|status [--json]
  arc sdk-extension install|status [--json]
  arc copilot-tab install|status|restore [--json]
  arc tab --json
  arc acp
  arc status [--json]
  arc capsules [--json]
  arc capsules <id> [--json]
  arc capsules set <id> [--status <s>] [--privacy <label>] [--json]
  arc capsules declined [--json]
  arc capsules promote <id> [--json]
  arc events [--json] [--limit N]
  arc metrics --json
  arc replay-eval --json
  arc probe "<prompt>" [--json]
  arc judge [status|models|decisions|reputation|set] [--json] [--mode embedding-only|provider-judge] [--model provider:id]
  arc doctor [--json]
  arc reset --yes

arc opens the terminal UI for the current repo. It shows seam status, capsules, live memory events, and a detail/action pane. If stdout is not a TTY, arc prints a short status summary and exits.

arc plugin install is the normal Copilot setup. It installs ARC's packaged Copilot plugin with supported plugin hooks and the read-only ARC MCP server. After installing or upgrading ARC with the migration-aware installer in the README, run arc plugin install once, then launch Copilot normally with \`copilot\`. The plugin hooks inject recall through userPromptSubmitted, capture/review at sessionEnd, and auto-create the per-workspace ARC cache on first use. The plugin MCP server exposes arc_search, arc_status, and arc_capsule over stdio.

arc setup is kept as a compatibility alias for plugin install and optional config persistence. It no longer installs the SDK extension or patches Copilot. The legacy JSON-hook fallback and SDK extension experiment are explicit commands only.

arc copilot-tab install is experimental and optional. It patches the installed Copilot terminal app with a designed native Arc tab where the active Copilot build supports top tabs, or an Arc route in older builds. Copilot package updates can replace the bundle, so re-run this command after updates. ARC correctness does not depend on this patch.

arc acp remains available as an advanced Agent Client Protocol middleware path for clients that explicitly want to launch through ARC.

status, capsules, events, probe, and tab --json are the canonical local inspection/control surface. The Copilot plugin, JSON-hook fallback, SDK extension experiment, and optional Copilot Arc tab call back into these shared ARC paths; ARC backend logic stays in the CLI runtime.

Developer/import commands still exist for captured traces, tests, and diagnostics, but they are not the normal product path.`);
}

async function reset(args: string[]): Promise<void> {
  if (!args.includes("--yes")) {
    throw new Error("Refusing to reset without confirmation. Run `arc reset --yes` to remove ARC workspace and app caches.");
  }
  const workspace = workspaceRoot();
  const targets = [
    { label: "workspace cache", path: cacheDir(workspace) }
  ];
  const removed: typeof targets = [];
  for (const target of targets) {
    const existed = existsSync(target.path);
    await rm(target.path, { recursive: true, force: true });
    if (existed) removed.push(target);
  }
  console.log("ARC reset complete");
  for (const target of removed) {
    console.log(`removed ${target.label}: ${target.path}`);
  }
  if (removed.length === 0) console.log("nothing existed on disk");
  console.log("If ARC is open, quit and reopen it so the sidebar reloads from disk.");
}

async function doctor(args: string[]): Promise<void> {
  assertKnownFlags(args, new Set(["--json"]));
  const workspace = workspaceRoot();
  const [capsules, events, extension, hook, plugin, config, tab] = await Promise.all([
    loadCapsules(workspace),
    loadMemoryEvents(workspace),
    copilotSdkExtensionStatus(workspace),
    copilotHookStatus(workspace),
    Promise.resolve(copilotPluginStatus()),
    loadArcConfig(),
    copilotTabStatus().catch((error) => ({
      installed: false,
      changed: false,
      appJs: undefined,
      runtimeEntrypoint: undefined,
      runtimePinned: false,
      reason: error instanceof Error ? error.message : String(error),
      caveat: "Run arc copilot-tab install to install or reapply the Copilot tab."
    }))
  ]);
  const lastInjection = lastEventOfTypes(events, ["capsule.injected"]);
  const lastSave = lastEventOfTypes(events, ["capsule.created", "capsule.updated", "capsule.finalized"]);
  const runtime = currentArcRuntime();
  const arcOnPath = resolveArcOnPath();
  const integration = await readActivationIntegration(workspace);
  const payload = {
    workspace,
    integration,
    cacheDir: cacheDir(workspace),
    arcOnPath,
    runtime,
    configPath: arcConfigPath(),
    sidecarCopilotCommand: config.sidecarCopilotCommand ?? null,
    judge: {
      mode: config.injectionJudgeMode ?? "embedding-only",
      model: config.injectionJudgeModel ?? null,
      reachability: judgeReachability(config)
    },
    plugin,
    extension,
    hook,
    copilotTab: tab,
    capsuleCount: capsules.length,
    eventCount: events.length,
    lastInjection: summarizeMemoryEvent(lastInjection),
    lastSave: summarizeMemoryEvent(lastSave),
    copilotTranscriptExample: copilotTranscriptPath("<session-id>"),
    sidecar: process.env.AGENT_RUN_CACHE_MODEL_SIDECAR || "auto"
  };
  if (hasJson(args)) {
    writeJson(payload);
    return;
  }
  console.log("Agent Run Cache doctor");
  console.log(`[OK] workspace: ${workspace}`);
  console.log(`[INFO] integration: ${integration ?? "not activated"}`);
  console.log(`[OK] cache: ${cacheDir(workspace)}`);
  console.log(`${arcOnPath.found ? "[OK]" : "[WARN]"} arc on PATH: ${arcOnPath.path ?? "not found - use the install/upgrade command in the README"}`);
  console.log(`${runtime.transient ? "[WARN]" : "[OK]"} runtime: ${runtime.node} ${runtime.entrypoint}${runtime.transientReason ? ` (${runtime.transientReason})` : ""}`);
  console.log(`[INFO] config: ${arcConfigPath()}`);
  const reachability = judgeReachability(config);
  console.log(`${reachability.reachable ? "[OK]" : "[WARN]"} judge reachability: ${reachability.reason}`);
  console.log(`[INFO] sidecar copilot command: ${config.sidecarCopilotCommand ?? "auto (uses copilot on PATH unless overridden)"}`);
  console.log(`${plugin.installed ? "[OK]" : "[WARN]"} copilot plugin: ${plugin.pluginDir}${plugin.reason ? ` (${plugin.reason})` : ""}`);
  console.log(`[INFO] copilot SDK extension experiment: ${extension.installed ? extension.projectExtensionPath : "not installed"}`);
  console.log(`[INFO] copilot extension host: ${formatExtensionHost(extension.host)}`);
  if (extension.installed) {
    console.log(`${extension.projectRuntimePinned ? "[OK]" : "[WARN]"} project extension runtime: ${extension.projectExtensionPath}`);
    console.log(`${extension.userRuntimePinned ? "[OK]" : "[WARN]"} user extension runtime: ${extension.userExtensionPath}`);
  }
  console.log(`[INFO] legacy json hook: ${hook.installed ? integration === "sdk-extension" ? "present, disabled when SDK extension is primary" : "installed explicit fallback" : "not installed"}`);
  console.log(`[INFO] hook events: sessionStart=${hook.sessionStart ? "yes" : "no"} userPromptSubmitted=${hook.userPromptSubmitted ? "yes" : "no"} sessionEnd=${hook.sessionEnd ? "yes" : "no"}`);
  if (hook.renderMode) console.log(`[INFO] hook render: ${hook.renderMode}`);
  console.log(`[INFO] copilot tab: ${tab.installed ? tab.appJs ?? "installed" : "not installed (experimental, not required)"}`);
  if (tab.installed) console.log(`${tab.runtimePinned ? "[OK]" : "[WARN]"} copilot tab runtime: ${tab.runtimeEntrypoint ?? "unknown"}`);
  console.log(`[OK] capsules: ${capsules.length}`);
  console.log(`[INFO] events: ${events.length}`);
  console.log(`[INFO] last injection: ${formatMemoryEvent(lastInjection)}`);
  console.log(`[INFO] last save: ${formatMemoryEvent(lastSave)}`);
  console.log(`[INFO] copilot transcript example: ${copilotTranscriptPath("<session-id>")}`);
  const sidecar = process.env.AGENT_RUN_CACHE_MODEL_SIDECAR || "auto";
  console.log(`[INFO] sidecar: ${sidecar === "off" ? "off" : `${sidecar} (same-runner by default) unless AGENT_RUN_CACHE_REVIEWER_COMMAND is set`}`);
}

function formatExtensionHost(host: {
  copilotRoot?: string;
  extensionAvailability?: string;
  extensionFeatureFlag?: boolean;
  extensionDiscoveryPresent: boolean;
  extensionModeDefault?: string;
  experimentalFlagPresent?: boolean;
  experimentalLoadsExtensionsLikely?: boolean;
  canvasesApiPresent: boolean;
  sdkCanvasApiPresent?: boolean;
  likelyLoadsExtensions: boolean;
  reason?: string;
}): string {
  const parts = [
    `root=${host.copilotRoot ?? "unknown"}`,
    `discovery=${host.extensionDiscoveryPresent ? "yes" : "no"}`,
    `availability=${host.extensionAvailability ?? "unknown"}`,
    `EXTENSIONS=${host.extensionFeatureFlag === undefined ? "unknown" : host.extensionFeatureFlag ? "on" : "off"}`,
    `modeDefault=${host.extensionModeDefault ?? "unknown"}`,
    `experimentalFlag=${host.experimentalFlagPresent ? "yes" : "no"}`,
    `experimentalLoadLikely=${host.experimentalLoadsExtensionsLikely ? "yes" : "no"}`,
    `sdkCanvasApi=${host.sdkCanvasApiPresent ? "yes" : "no"}`,
    `internalCanvasTools=${host.canvasesApiPresent ? "yes" : "no"}`
  ];
  if (host.reason) parts.push(`reason=${host.reason}`);
  return parts.join(" ");
}

function extensionHostSummary(host: {
  likelyLoadsExtensions: boolean;
  experimentalLoadsExtensionsLikely?: boolean;
  reason?: string;
}): string {
  if (host.likelyLoadsExtensions) return "available by default";
  if (host.experimentalLoadsExtensionsLikely) return "experimental-gated; use --experimental for SDK primary, JSON hooks fallback remains active";
  return `not proven - ${host.reason ?? "host capability unknown"}`;
}

function setupSidecarCopilotCommand(args: string[]): string | undefined {
  const fromOption = optionValue(args, "--sidecar-copilot-command");
  if (fromOption) return fromOption;
  const fromEnv = process.env.AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND?.trim();
  return fromEnv || undefined;
}

function optionValue(args: string[], name: string): string | undefined {
  const assignment = args.find((arg) => arg.startsWith(`${name}=`));
  if (assignment) return assignment.slice(name.length + 1).trim() || undefined;
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
  return value.trim() || undefined;
}

function lastEventOfTypes(events: MemoryEvent[], types: string[]): MemoryEvent | undefined {
  const wanted = new Set(types);
  return events.slice().reverse().find((event) => wanted.has(event.type));
}

function summarizeMemoryEvent(event: MemoryEvent | undefined): Record<string, unknown> | null {
  if (!event) return null;
  return {
    type: event.type,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    capsuleId: event.capsuleId,
    title: event.details?.title,
    capsuleIds: event.details?.capsuleIds
  };
}

function formatMemoryEvent(event: MemoryEvent | undefined): string {
  if (!event) return "none";
  const title = event.details?.title;
  const capsuleIds = event.details?.capsuleIds;
  const detail = typeof title === "string"
    ? title
    : Array.isArray(capsuleIds)
    ? capsuleIds.join(",")
    : event.capsuleId ?? "";
  return `${event.timestamp} ${event.type}${detail ? ` ${detail}` : ""}`;
}

async function smoke(): Promise<void> {
  const workspace = workspaceRoot();
  // Run against an isolated temp cache so smoke never writes to the caller's
  // ./.agent-run-cache/.
  const previousCacheDir = process.env.AGENT_RUN_CACHE_DIR;
  const tempCache = await mkdtemp(join(tmpdir(), "arc-smoke-"));
  process.env.AGENT_RUN_CACHE_DIR = tempCache;
  try {
    await runSmoke(workspace);
  } finally {
    if (previousCacheDir === undefined) delete process.env.AGENT_RUN_CACHE_DIR;
    else process.env.AGENT_RUN_CACHE_DIR = previousCacheDir;
    await rm(tempCache, { recursive: true, force: true });
  }
}

async function runSmoke(workspace: string): Promise<void> {
  await saveCapsule({
    runner: "copilot",
    workspace,
    sourceSessionId: "smoke",
    reusable: true,
    confidence: 0.99,
    title: "Smoke test folder workflow",
    summary: "For test folder orientation, inspect the test directory before broad rediscovery.",
    reuseWhen: ["test folder", "public regression test", "what is in the test folder"],
    doNotReuseWhen: ["the user asks for current test results"],
    nextRunInstruction: "List the test directory and inspect the focused public test file before broad rediscovery.",
    evidence: ["offline smoke capsule"],
    provenance: [],
    workflow: {
      purpose: "Orient a future agent on the test folder.",
      parameters: ["current test folder name"],
      bindingSources: ["test/"],
      steps: ["List test/.", "Read the focused public test file if present.", "Only run tests if user asks for results."],
      commands: ["ls test"],
      successCriteria: ["The test folder contents are identified."],
      failedAttempts: [],
      validationProbe: ["Check that test/ still exists."]
    }
  }, workspace);
  const previous = process.env.AGENT_RUN_CACHE_MODEL_SIDECAR;
  process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = "off";
  try {
    const plan = await buildInjectionPlan("what is in the test folder", workspace);
    console.log(`smoke: ${plan.shouldInject ? "injection yes" : "injection no"} (${plan.reason})`);
  } finally {
    if (previous === undefined) delete process.env.AGENT_RUN_CACHE_MODEL_SIDECAR;
    else process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = previous;
  }
}
