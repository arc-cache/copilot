import { basename } from "node:path";

import { loadArcConfig, saveArcConfig } from "./config.js";
import { copilotSdkExtensionStatus } from "./copilot-extension.js";
import { copilotHookStatus } from "./hook-status.js";
import { readActivationIntegration } from "./install.js";
import { loadMemoryEvents } from "./ledger.js";
import { cacheDir, workspaceRoot } from "./paths.js";
import { buildInjectionPlan } from "./retrieval.js";
import { judgeReachability } from "./judge-reachability.js";
import { loadCapsules, updateCapsuleMetadata } from "./store.js";
import type { MemoryEvent } from "./ledger.js";
import type { ArcUiAction, ArcUiCapsuleRow, ArcUiEventRow, ArcUiViewModel } from "./ui-model.js";

export interface LoadArcUiViewModelOptions {
  query?: string;
  selectedId?: string;
  eventLimit?: number;
}

export async function loadArcUiViewModel(workspace = workspaceRoot(), options: LoadArcUiViewModelOptions = {}): Promise<ArcUiViewModel> {
  const [capsules, events, extension, hook, config, integration] = await Promise.all([
    loadCapsules(workspace),
    loadMemoryEvents(workspace),
    copilotSdkExtensionStatus(workspace),
    copilotHookStatus(workspace),
    loadArcConfig(),
    readActivationIntegration(workspace)
  ]);
  const query = (options.query ?? "").trim();
  const rows = capsules
    .slice()
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map(capsuleToRow)
    .filter((row) => matchesQuery(row, query));
  const selectedCapsule = rows.find((row) => row.id === options.selectedId) ?? rows[0] ?? null;
  const recentEvents = events.slice(-(options.eventLimit ?? 80)).reverse().map(eventToRow);
  const lastInjection = lastEventOfTypes(events, ["capsule.injected"]);
  const lastSave = lastEventOfTypes(events, ["capsule.created", "capsule.updated", "capsule.finalized"]);
  return {
    status: {
      repo: basename(workspace),
      workspace,
      cacheDir: cacheDir(workspace),
      capsuleCount: capsules.length,
      eventCount: events.length,
      judge: {
        mode: config.injectionJudgeMode ?? "embedding-only",
        model: config.injectionJudgeModel ?? null,
        reachability: judgeReachability(config)
      },
      integration,
      extension,
      hook,
      lastInjection: lastInjection ? eventToRow(lastInjection) : null,
      lastSave: lastSave ? eventToRow(lastSave) : null,
      generatedAt: new Date().toISOString()
    },
    query,
    capsules: rows,
    selectedCapsule,
    recentEvents
  };
}

export async function applyArcUiAction(workspace: string, action: ArcUiAction): Promise<ArcUiCapsuleRow | null> {
  if (action.type === "set-judge-mode") {
    await saveArcConfig({ injectionJudgeMode: action.mode });
    return null;
  }
  if (action.type === "set-judge-model") {
    await saveArcConfig({ injectionJudgeMode: "provider-judge", injectionJudgeModel: action.model });
    return null;
  }
  const patch = actionPatch(action);
  const capsule = await updateCapsuleMetadata(action.capsuleId, patch, workspace);
  return capsule ? capsuleToRow(capsule) : null;
}

export async function probeArcUiPrompt(prompt: string, workspace = workspaceRoot()): Promise<{ shouldInject: boolean; reason: string; capsuleTitle?: string }> {
  const plan = await buildInjectionPlan(prompt, workspace);
  return { shouldInject: plan.shouldInject, reason: plan.reason, capsuleTitle: plan.capsule?.title };
}

function capsuleToRow(capsule: Awaited<ReturnType<typeof loadCapsules>>[number]): ArcUiCapsuleRow {
  return {
    id: capsule.id,
    shortId: capsule.id.slice(0, 8),
    title: capsule.title,
    summary: capsule.summary,
    status: capsule.status,
    privacyLabel: capsule.privacyLabel,
    kind: capsule.kind,
    confidence: capsule.confidence,
    updatedAt: capsule.updatedAt,
    useCount: capsule.useCount,
    reuseWhen: capsule.reuseWhen,
    doNotReuseWhen: capsule.doNotReuseWhen,
    nextRunInstruction: capsule.nextRunInstruction,
    steps: capsule.workflow?.steps ?? [],
    commands: capsule.workflow?.commands ?? [],
    validationProbe: capsule.workflow?.validationProbe ?? [],
    failedAttempts: capsule.workflow?.failedAttempts ?? []
  };
}

function matchesQuery(capsule: ArcUiCapsuleRow, query: string): boolean {
  if (!query) return true;
  const normalized = query.toLowerCase();
  return [
    capsule.id,
    capsule.title,
    capsule.summary,
    capsule.status,
    capsule.privacyLabel,
    capsule.nextRunInstruction,
    ...capsule.reuseWhen,
    ...capsule.doNotReuseWhen
  ].join("\n").toLowerCase().includes(normalized);
}

function actionPatch(action: ArcUiAction): { status?: "local" | "shareable" | "shared" | "rejected" | "superseded" | "private"; privacyLabel?: "local" | "shareable" | "private" | "redacted" } {
  if (action.type === "set-status") return { status: action.status };
  if (action.type === "set-privacy") return { privacyLabel: action.privacyLabel };
  if (action.type === "enable") return { status: "local" };
  if (action.type === "disable") return { status: "private" };
  return { status: "superseded" };
}

function eventToRow(event: MemoryEvent): ArcUiEventRow {
  const title = typeof event.details?.title === "string"
    ? event.details.title
    : Array.isArray(event.details?.capsuleIds)
    ? event.details.capsuleIds.join(",")
    : event.capsuleId ?? "";
  const detail = title || event.details?.reason?.toString() || event.sessionId || "";
  return {
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    capsuleId: event.capsuleId,
    sessionId: event.sessionId,
    title,
    detail
  };
}

function lastEventOfTypes(events: MemoryEvent[], types: string[]): MemoryEvent | undefined {
  const wanted = new Set(types);
  return events.slice().reverse().find((event) => wanted.has(event.type));
}
