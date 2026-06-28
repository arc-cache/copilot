import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";

import { loadMemoryEvents, recordMemoryEvent } from "../dist/ledger.js";
import { buildInjectionPlan } from "../dist/retrieval.js";
import { loadCapsules, saveCapsule } from "../dist/store.js";
import { applyArcUiAction, loadArcUiViewModel } from "../dist/ui-data.js";
import { initialArcUiState, renderArcView } from "../dist/ui-view.js";

test("ARC view renders header, capsule row, and feed line from real repo data", withUiCache(async (workspace) => {
  const capsule = await seedUiCapsule(workspace, "ui-render-capsule", "Render UI capsule");
  await recordMemoryEvent({
    type: "capsule.injected",
    workspace,
    sessionId: "ui-render-session",
    capsuleId: capsule.id,
    details: { title: capsule.title, reason: "test feed event" }
  });

  const model = await loadArcUiViewModel(workspace);
  const frame = renderArcView(model, initialArcUiState(), { width: 100, height: 30 });

  assert.match(frame, new RegExp(`ARC ${basename(workspace)}`));
  assert.match(frame, /Render UI capsule/);
  assert.match(frame, /Active \/ Local only/);
  assert.doesNotMatch(frame, /local\/local/);
  assert.match(frame, /seam plugin pending/);
  assert.match(frame, /judge embedding/);
  assert.match(frame, /Capsule injected/);
}));

test("ARC live feed view-model reflects newly appended ledger events on refresh", withUiCache(async (workspace) => {
  const capsule = await seedUiCapsule(workspace, "ui-live-capsule", "Live feed capsule");
  const before = await loadArcUiViewModel(workspace);
  assert.equal(before.recentEvents.some((event) => event.type === "capsule.injected"), false);

  await recordMemoryEvent({
    type: "capsule.injected",
    workspace,
    sessionId: "ui-live-session",
    capsuleId: capsule.id,
    details: { title: capsule.title }
  });

  const after = await loadArcUiViewModel(workspace);
  assert.equal(after.recentEvents[0].type, "capsule.injected");
  assert.equal(after.recentEvents[0].title, "Live feed capsule");
}));

test("ARC UI action path persists status and privacy changes", withUiCache(async (workspace) => {
  const capsule = await seedUiCapsule(workspace, "ui-action-capsule", "Action capsule");

  await applyArcUiAction(workspace, { type: "set-status", capsuleId: capsule.id, status: "private" });
  await applyArcUiAction(workspace, { type: "set-privacy", capsuleId: capsule.id, privacyLabel: "redacted" });

  const persisted = (await loadCapsules(workspace)).find((item) => item.id === capsule.id);
  const events = await loadMemoryEvents(workspace);
  assert.equal(persisted?.status, "private");
  assert.equal(persisted?.privacyLabel, "redacted");
  assert.equal(events.some((event) => event.type === "capsule.privacy_updated" && event.capsuleId === capsule.id), true);
}));

test("ARC UI action path persists judge mode and model without touching capsules", withUiCache(async (workspace) => {
  const capsule = await seedUiCapsule(workspace, "ui-judge-capsule", "Judge capsule");

  await applyArcUiAction(workspace, { type: "set-judge-mode", mode: "provider-judge" });
  await applyArcUiAction(workspace, { type: "set-judge-model", model: { provider: "ollama", id: "gemma4:31b-cloud" } });

  const model = await loadArcUiViewModel(workspace);
  const frame = renderArcView(model, initialArcUiState(), { width: 120, height: 30 });
  const persisted = (await loadCapsules(workspace)).find((item) => item.id === capsule.id);

  assert.equal(model.status.judge.mode, "provider-judge");
  assert.deepEqual(model.status.judge.model, { provider: "ollama", id: "gemma4:31b-cloud" });
  assert.match(frame, /judge provider:ollama:gemma4:31b-cloud/);
  assert.equal(persisted?.title, "Judge capsule");
}));

test("ARC UI enable, disable, and invalidate actions control retrieval", withUiCache(async (workspace) => {
  const capsule = await seedUiCapsule(workspace, "ui-retrieval-action-capsule", "Retrieval action capsule");

  const enabled = await buildInjectionPlan("testing the ARC UI", workspace);
  assert.equal(enabled.shouldInject, true);
  assert.equal(enabled.capsule?.id, capsule.id);

  await applyArcUiAction(workspace, { type: "disable", capsuleId: capsule.id });
  const disabled = await buildInjectionPlan("testing the ARC UI", workspace);
  assert.equal(disabled.shouldInject, false);

  await applyArcUiAction(workspace, { type: "enable", capsuleId: capsule.id });
  const reenabled = await buildInjectionPlan("testing the ARC UI", workspace);
  assert.equal(reenabled.shouldInject, true);

  await applyArcUiAction(workspace, { type: "invalidate", capsuleId: capsule.id });
  const invalidated = await buildInjectionPlan("testing the ARC UI", workspace);
  assert.equal(invalidated.shouldInject, false);
  const persisted = (await loadCapsules(workspace)).find((item) => item.id === capsule.id);
  assert.equal(persisted?.status, "superseded");
}));

test("ARC UI tolerates malformed cache data", withUiCache(async (workspace) => {
  const cache = join(workspace, ".agent-run-cache");
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "memory.jsonl"), "{not json}\n{}\n", "utf8");
  await writeFile(join(cache, "memory-events.jsonl"), "{not json}\n{}\n", "utf8");

  const model = await loadArcUiViewModel(workspace);
  const frame = renderArcView(model, initialArcUiState(), { width: 90, height: 20 });

  assert.equal(model.capsules.length, 0);
  assert.equal(model.recentEvents.length, 0);
  assert.match(frame, /No capsules saved yet/);
}));

function withUiCache(fn) {
  return async () => {
    const workspace = await mkdtemp(join(tmpdir(), "arc-ui-test-"));
    const previousCache = process.env.AGENT_RUN_CACHE_DIR;
    const previousHome = process.env.AGENT_RUN_CACHE_HOME;
    const previousSidecar = process.env.AGENT_RUN_CACHE_MODEL_SIDECAR;
    const previousObserver = process.env.AGENT_RUN_CACHE_LOCAL_OBSERVER;
    process.env.AGENT_RUN_CACHE_DIR = join(workspace, ".agent-run-cache");
    process.env.AGENT_RUN_CACHE_HOME = join(workspace, "arc-home");
    process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = "off";
    process.env.AGENT_RUN_CACHE_LOCAL_OBSERVER = "off";
    try {
      await fn(workspace);
    } finally {
      restoreEnv("AGENT_RUN_CACHE_DIR", previousCache);
      restoreEnv("AGENT_RUN_CACHE_HOME", previousHome);
      restoreEnv("AGENT_RUN_CACHE_MODEL_SIDECAR", previousSidecar);
      restoreEnv("AGENT_RUN_CACHE_LOCAL_OBSERVER", previousObserver);
      await rm(workspace, { recursive: true, force: true });
    }
  };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function seedUiCapsule(workspace, id, title) {
  const capsule = await saveCapsule({
    id,
    runner: "copilot",
    workspace,
    sourceSessionId: `${id}-session`,
    kind: "workflow",
    mergeKey: id,
    reusable: true,
    confidence: 0.93,
    title,
    summary: "Use the ARC terminal UI to inspect this capsule.",
    reuseWhen: ["testing the ARC UI"],
    doNotReuseWhen: ["unrelated prompt"],
    evidence: ["The test seeded this capsule through the store."],
    provenance: ["test"],
    nextRunInstruction: "Open the ARC terminal UI and inspect the capsule row.",
    workflow: {
      purpose: "Exercise the ARC terminal UI.",
      parameters: ["workspace"],
      bindingSources: ["test"],
      steps: ["Load the view model.", "Render the frame."],
      commands: ["arc"],
      successCriteria: ["The frame contains this capsule."],
      failedAttempts: [],
      validationProbe: ["renderArcView"]
    }
  }, workspace);
  assert.ok(capsule);
  return capsule;
}
