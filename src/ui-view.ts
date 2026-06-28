import type { ArcUiCapsuleRow, ArcUiEventRow, ArcUiState, ArcUiViewModel } from "./ui-model.js";

export const ARC_UI_LIST_ROW_START = 7;

export function initialArcUiState(): ArcUiState {
  return {
    mode: "list",
    query: "",
    selectedIndex: 0,
    listOffset: 0,
    feedOffset: 0,
    searchActive: false
  };
}

export function renderArcView(model: ArcUiViewModel, state: ArcUiState, options: { width?: number; height?: number } = {}): string {
  const width = Math.max(60, options.width ?? 100);
  const height = Math.max(20, options.height ?? 32);
  const listLimit = visibleListLimit(height);
  const feedLimit = visibleFeedLimit(height);
  const capsules = model.capsules;
  const selectedIndex = clamp(state.selectedIndex, 0, Math.max(0, capsules.length - 1));
  const listOffset = clamp(state.listOffset, 0, Math.max(0, capsules.length - listLimit));
  const selected = capsules[selectedIndex] ?? model.selectedCapsule;
  const lines: string[] = [];

  lines.push(fit(`ARC ${model.status.repo} | ${model.status.capsuleCount} capsule${model.status.capsuleCount === 1 ? "" : "s"} | seam ${seamStateLabel(model)} | events ${model.status.eventCount} | judge ${judgeStateLabel(model)}`, width));
  lines.push(fit(`workspace ${model.status.workspace}`, width));
  lines.push(fit(`keys q quit | / search | arrows/jk move | enter detail | e enable | d disable | x invalidate | p privacy | g judge | m model | mouse`, width));
  lines.push(fit(`${state.searchActive ? "search>" : "search:"} ${state.query || "(all capsules)"}`, width));
  if (state.message) lines.push(fit(`message: ${state.message}`, width));
  else lines.push("");

  lines.push("Capsules");
  if (!capsules.length) {
    lines.push(...emptyCapsuleLines(model, state.query, width));
  } else {
    for (const [index, capsule] of capsules.slice(listOffset, listOffset + listLimit).entries()) {
      const absolute = listOffset + index;
      lines.push(renderCapsuleRow(capsule, absolute === selectedIndex, width));
    }
  }

  lines.push("");
  lines.push(state.mode === "detail" && selected ? "Detail" : "Detail (press enter)");
  lines.push(...renderDetail(selected, width, state.mode === "detail" ? 7 : 4));

  lines.push("");
  lines.push("Live feed");
  const feed = model.recentEvents.slice(state.feedOffset, state.feedOffset + feedLimit);
  if (!feed.length) lines.push("  No ARC activity yet. Matching prompts and completed sessions will appear here.");
  for (const event of feed) lines.push(renderEventRow(event, width));

  return lines.slice(0, height).map((line) => fit(line, width)).join("\n");
}

export function renderArcStatusSummary(model: ArcUiViewModel): string {
  const lastInjection = model.status.lastInjection ? `${model.status.lastInjection.type} ${model.status.lastInjection.detail}` : "none";
  const lastSave = model.status.lastSave ? `${model.status.lastSave.type} ${model.status.lastSave.detail}` : "none";
  return [
    `ARC ${model.status.repo}`,
    `workspace: ${model.status.workspace}`,
    `capsules: ${model.status.capsuleCount}`,
    `seam: ${seamStateLabel(model)}`,
    `json hook fallback: ${model.status.hook.installed ? "installed" : "not installed"}`,
    `judge: ${judgeStateLabel(model)}`,
    `events: ${model.status.eventCount}`,
    `last injection: ${lastInjection}`,
    `last save: ${lastSave}`
  ].join("\n");
}

export function visibleListLimit(height: number): number {
  return Math.max(3, Math.min(10, Math.floor(height / 3)));
}

export function visibleFeedLimit(height: number): number {
  return Math.max(3, Math.min(8, Math.floor(height / 4)));
}

function renderCapsuleRow(capsule: ArcUiCapsuleRow, selected: boolean, width: number): string {
  const marker = selected ? ">" : " ";
  return fit(`${marker} ${capsule.shortId} ${capsuleStateLabel(capsule)} ${capsule.title}`, width);
}

function renderDetail(capsule: ArcUiCapsuleRow | null, width: number, limit: number): string[] {
  if (!capsule) return ["  No capsule selected."];
  const lines = [
    `  ${capsule.title}`,
    `  id: ${capsule.id}`,
    `  state: ${capsuleStateLabel(capsule)} | uses ${capsule.useCount}`,
    capsule.summary ? `  ${capsule.summary}` : "",
    capsule.nextRunInstruction ? `  first move: ${capsule.nextRunInstruction}` : "",
    listLine("reuse", capsule.reuseWhen),
    listLine("commands", capsule.commands),
    listLine("validation", capsule.validationProbe),
    listLine("dead ends", capsule.failedAttempts)
  ].filter(Boolean);
  return lines.slice(0, limit).map((line) => fit(line, width));
}

function renderEventRow(event: ArcUiEventRow, width: number): string {
  const time = event.timestamp.slice(11, 19);
  return fit(`  ${time} ${eventTypeLabel(event.type)}${event.detail ? ` | ${event.detail}` : ""}`, width);
}

function listLine(label: string, values: string[]): string {
  return values.length ? `  ${label}: ${values.slice(0, 3).join("; ")}` : "";
}

function fit(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return "";
  return `${text.slice(0, width - 1)}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function seamStateLabel(model: ArcUiViewModel): string {
  if (model.status.integration === "copilot-plugin") return "plugin active";
  if (model.status.integration === "json-hooks") return model.status.hook.installed ? "json hooks active" : "json hooks configured";
  if (model.status.integration === "sdk-extension") return model.status.extension.installed ? "SDK extension active" : "SDK extension configured";
  return "plugin pending";
}

function judgeStateLabel(model: ArcUiViewModel): string {
  const mode = model.status.judge.mode === "provider-judge" ? "provider" : "embedding";
  const selected = model.status.judge.model;
  return selected ? `${mode}:${selected.provider}:${selected.id}` : mode;
}

function capsuleStateLabel(capsule: ArcUiCapsuleRow): string {
  return `${statusLabel(capsule.status)} / ${privacyLabel(capsule.privacyLabel)}`;
}

function statusLabel(status: ArcUiCapsuleRow["status"]): string {
  const labels: Record<ArcUiCapsuleRow["status"], string> = {
    local: "Active",
    shareable: "Shareable",
    shared: "Shared",
    rejected: "Rejected",
    superseded: "Invalidated",
    private: "Disabled"
  };
  return labels[status];
}

function privacyLabel(privacy: ArcUiCapsuleRow["privacyLabel"]): string {
  const labels: Record<ArcUiCapsuleRow["privacyLabel"], string> = {
    local: "Local only",
    shareable: "Shareable",
    private: "Private",
    redacted: "Redacted"
  };
  return labels[privacy];
}

function eventTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    "capsule.created": "Capsule saved",
    "capsule.updated": "Capsule updated",
    "capsule.finalized": "Capsule finalized",
    "capsule.injected": "Capsule injected",
    "capsule.rejected": "Capture skipped",
    "capsule.superseded": "Capsule invalidated",
    "capsule.privacy_updated": "Capsule settings changed",
    "capsule.merged": "Capsule merged"
  };
  return labels[type] ?? type;
}

function emptyCapsuleLines(model: ArcUiViewModel, query: string, width: number): string[] {
  if (query.trim()) {
    return [fit(`  No capsules match "${query.trim()}". Clear search or try a broader term.`, width)];
  }
  if (!model.status.integration) {
    return [
      "  No capsules saved yet.",
      "  Run arc plugin install once, then launch Copilot normally."
    ];
  }
  return [
    "  No capsules saved yet.",
    "  ARC saves only verified reusable methods after successful sessions."
  ];
}
