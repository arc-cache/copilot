import { applyArcUiAction, loadArcUiViewModel } from "./ui-data.js";
import { ARC_UI_LIST_ROW_START, initialArcUiState, renderArcStatusSummary, renderArcView, visibleListLimit } from "./ui-view.js";
import { listJudgeModels } from "./judge-models.js";
import { workspaceRoot } from "./paths.js";
import type { CapsuleStatus, PrivacyLabel } from "./types.js";
import type { ArcUiState, ArcUiViewModel } from "./ui-model.js";

const STATUS_CYCLE: CapsuleStatus[] = ["local", "private", "shareable", "shared", "rejected", "superseded"];
const PRIVACY_CYCLE: PrivacyLabel[] = ["local", "shareable", "private", "redacted"];
const REFRESH_MS = 1000;

export async function runArcUi(args: string[], workspace = workspaceRoot()): Promise<number> {
  assertUiArgs(args);
  const once = args.includes("--once");
  const state = initialArcUiState();
  const model = await loadArcUiViewModel(workspace, { query: state.query });
  if (once) {
    process.stdout.write(`${renderArcView(model, state, terminalSize())}\n`);
    return 0;
  }
  if (!process.stdout.isTTY) {
    process.stdout.write(`${renderArcStatusSummary(model)}\n`);
    return 0;
  }
  return runInteractiveArcUi(workspace, state, model);
}

function assertUiArgs(args: string[]): void {
  const known = new Set(["--once"]);
  for (const arg of args) {
    if (!known.has(arg)) throw new Error(`Unknown arc ui option: ${arg}`);
  }
}

async function runInteractiveArcUi(workspace: string, state: ArcUiState, initialModel: ArcUiViewModel): Promise<number> {
  let model = initialModel;
  let running = true;
  let refreshing = false;
  let exitCode = 0;
  const stdin = process.stdin;
  const stdout = process.stdout;
  const previousRawMode = stdin.isTTY ? stdin.isRaw : false;

  const render = () => {
    stdout.write(`\x1b[H\x1b[2J${renderArcView(model, state, terminalSize())}`);
  };

  const refresh = async () => {
    if (refreshing || !running) return;
    refreshing = true;
    try {
      model = await loadArcUiViewModel(workspace, { query: state.query, selectedId: state.selectedId });
      normalizeSelection(state, model);
      render();
    } catch (error) {
      state.message = `refresh failed: ${String(error).slice(0, 120)}`;
      render();
    } finally {
      refreshing = false;
    }
  };

  const stop = (code = 0) => {
    if (!running) return;
    running = false;
    exitCode = code;
    clearInterval(timer);
    stdin.off("data", onData);
    process.off("SIGINT", onSigint);
    if (stdin.isTTY) stdin.setRawMode(previousRawMode);
    stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[0m\n");
  };

  const onSigint = () => stop(0);
  const onData = (chunk: Buffer | string) => {
    void handleInput(String(chunk), state, () => model, workspace, stop).then(refresh).catch((error) => {
      state.message = `action failed: ${String(error).slice(0, 120)}`;
      render();
    });
  };

  stdout.write("\x1b[?25l\x1b[?1000h\x1b[?1006h");
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  stdin.on("data", onData);
  process.once("SIGINT", onSigint);
  const timer = setInterval(() => void refresh(), REFRESH_MS);
  render();

  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (running) return;
      clearInterval(check);
      resolve(exitCode);
    }, 25);
  });
}

async function handleInput(
  text: string,
  state: ArcUiState,
  getModel: () => ArcUiViewModel,
  workspace: string,
  stop: (code?: number) => void
): Promise<void> {
  for (const mouse of mouseEvents(text)) {
    handleMouse(mouse, state, getModel());
  }
  if (text.includes("\u0003") || text === "q") {
    stop(0);
    return;
  }
  if (state.searchActive) {
    handleSearchInput(text, state);
    return;
  }
  if (text === "/" || text === "f") {
    state.searchActive = true;
    state.message = "type to filter, enter to apply, esc to cancel";
    return;
  }
  if (text === "\r" || text === "\n") {
    state.mode = state.mode === "detail" ? "list" : "detail";
    state.message = undefined;
    return;
  }
  if (text === "\x1b" || text === "b") {
    state.mode = "list";
    state.searchActive = false;
    state.message = undefined;
    return;
  }
  if (text === "\x1b[B" || text === "j") {
    moveSelection(state, getModel(), 1);
    return;
  }
  if (text === "\x1b[A" || text === "k") {
    moveSelection(state, getModel(), -1);
    return;
  }
  if (text === "s") {
    await cycleSelectedStatus(state, getModel(), workspace);
    return;
  }
  if (text === "p") {
    await cycleSelectedPrivacy(state, getModel(), workspace);
    return;
  }
  if (text === "g") {
    await cycleJudgeMode(state, getModel(), workspace);
    return;
  }
  if (text === "m") {
    await cycleJudgeModel(state, getModel(), workspace);
    return;
  }
  if (text === "e") {
    await applySelectedAction(state, getModel(), workspace, "enable", "enabled");
    return;
  }
  if (text === "d") {
    await applySelectedAction(state, getModel(), workspace, "disable", "disabled");
    return;
  }
  if (text === "x") {
    await applySelectedAction(state, getModel(), workspace, "invalidate", "invalidated");
  }
}

function handleSearchInput(text: string, state: ArcUiState): void {
  if (text === "\r" || text === "\n") {
    state.searchActive = false;
    state.selectedIndex = 0;
    state.listOffset = 0;
    state.selectedId = undefined;
    state.message = undefined;
    return;
  }
  if (text === "\x1b") {
    state.searchActive = false;
    state.message = undefined;
    return;
  }
  if (text === "\u007f" || text === "\b") {
    state.query = state.query.slice(0, -1);
    return;
  }
  if (/^[\x20-\x7e]+$/.test(text)) {
    state.query += text;
  }
}

function moveSelection(state: ArcUiState, model: ArcUiViewModel, delta: number): void {
  state.selectedIndex = clamp(state.selectedIndex + delta, 0, Math.max(0, model.capsules.length - 1));
  state.selectedId = model.capsules[state.selectedIndex]?.id;
  const limit = visibleListLimit(terminalSize().height ?? 32);
  if (state.selectedIndex < state.listOffset) state.listOffset = state.selectedIndex;
  if (state.selectedIndex >= state.listOffset + limit) state.listOffset = state.selectedIndex - limit + 1;
}

async function cycleSelectedStatus(state: ArcUiState, model: ArcUiViewModel, workspace: string): Promise<void> {
  const capsule = model.capsules[state.selectedIndex];
  if (!capsule) return;
  const status = nextValue(STATUS_CYCLE, capsule.status);
  await applyArcUiAction(workspace, { type: "set-status", capsuleId: capsule.id, status });
  state.message = `updated status: ${capsule.title} -> ${status}`;
}

async function cycleSelectedPrivacy(state: ArcUiState, model: ArcUiViewModel, workspace: string): Promise<void> {
  const capsule = model.capsules[state.selectedIndex];
  if (!capsule) return;
  const privacyLabel = nextValue(PRIVACY_CYCLE, capsule.privacyLabel);
  await applyArcUiAction(workspace, { type: "set-privacy", capsuleId: capsule.id, privacyLabel });
  state.message = `updated privacy: ${capsule.title} -> ${privacyLabel}`;
}

async function cycleJudgeMode(state: ArcUiState, model: ArcUiViewModel, workspace: string): Promise<void> {
  const mode = model.status.judge.mode === "embedding-only" ? "provider-judge" : "embedding-only";
  await applyArcUiAction(workspace, { type: "set-judge-mode", mode });
  state.message = mode === "provider-judge" && !model.status.judge.model
    ? "judge mode: provider-judge; press m to pick a model"
    : `judge mode: ${mode}`;
}

async function cycleJudgeModel(state: ArcUiState, model: ArcUiViewModel, workspace: string): Promise<void> {
  state.message = "loading judge models...";
  const available = await listJudgeModels();
  const models = available.models;
  if (!models.length) {
    const errors = Object.entries(available.errors).map(([provider, error]) => `${provider}: ${error}`).join("; ");
    state.message = errors ? `no judge models (${errors})` : "no judge-capable models found";
    return;
  }
  const current = model.status.judge.model ? `${model.status.judge.model.provider}:${model.status.judge.model.id}` : "";
  const index = models.findIndex((item) => `${item.provider}:${item.id}` === current);
  const next = models[(index + 1) % models.length] ?? models[0];
  await applyArcUiAction(workspace, { type: "set-judge-model", model: { provider: next.provider, id: next.id } });
  state.message = `judge model: ${next.provider}:${next.id}`;
}

async function applySelectedAction(
  state: ArcUiState,
  model: ArcUiViewModel,
  workspace: string,
  type: "enable" | "disable" | "invalidate",
  label: string
): Promise<void> {
  const capsule = model.capsules[state.selectedIndex];
  if (!capsule) return;
  await applyArcUiAction(workspace, { type, capsuleId: capsule.id });
  state.message = `${label}: ${capsule.title}`;
}

function normalizeSelection(state: ArcUiState, model: ArcUiViewModel): void {
  if (state.selectedId) {
    const index = model.capsules.findIndex((capsule) => capsule.id === state.selectedId);
    if (index >= 0) state.selectedIndex = index;
  }
  state.selectedIndex = clamp(state.selectedIndex, 0, Math.max(0, model.capsules.length - 1));
  state.selectedId = model.capsules[state.selectedIndex]?.id;
  state.listOffset = clamp(state.listOffset, 0, Math.max(0, model.capsules.length - visibleListLimit(terminalSize().height ?? 32)));
}

interface MouseEvent {
  button: number;
  x: number;
  y: number;
  released: boolean;
}

function mouseEvents(text: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  const pattern = /\x1b\[<(\d+);(\d+);(\d+)([mM])/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    events.push({
      button: Number(match[1]),
      x: Number(match[2]),
      y: Number(match[3]),
      released: match[4] === "m"
    });
  }
  return events;
}

function handleMouse(event: MouseEvent, state: ArcUiState, model: ArcUiViewModel): void {
  if (event.released) return;
  if (event.button === 64) {
    state.listOffset = Math.max(0, state.listOffset - 1);
    return;
  }
  if (event.button === 65) {
    state.listOffset = Math.min(Math.max(0, model.capsules.length - visibleListLimit(terminalSize().height ?? 32)), state.listOffset + 1);
    return;
  }
  const zeroBasedY = event.y - 1;
  const row = zeroBasedY - ARC_UI_LIST_ROW_START;
  if (row >= 0 && row < visibleListLimit(terminalSize().height ?? 32)) {
    const index = state.listOffset + row;
    if (model.capsules[index]) {
      state.selectedIndex = index;
      state.selectedId = model.capsules[index].id;
      state.mode = "detail";
    }
  }
}

function nextValue<T extends string>(values: T[], current: T): T {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length] ?? values[0];
}

function terminalSize(): { width?: number; height?: number } {
  return { width: process.stdout.columns || 100, height: process.stdout.rows || 32 };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
