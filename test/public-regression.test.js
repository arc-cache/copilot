import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { redactSensitiveText } from "../dist/redact.js";
import { buildInjectionPlan } from "../dist/retrieval.js";
import { reviewEvents } from "../dist/review.js";
import { maybeReviewTurn } from "../dist/review-decision.js";
import { loadCapsules, saveCapsule } from "../dist/store.js";
import { loadMemoryEvents } from "../dist/ledger.js";
import { debugPath, memoryPath, reviewedPath } from "../dist/paths.js";

function withCache(fn) {
  return async () => {
    const root = await mkdtemp(join(tmpdir(), "arc-public-test-"));
    const previousCache = process.env.AGENT_RUN_CACHE_DIR;
    const previousSidecar = process.env.AGENT_RUN_CACHE_MODEL_SIDECAR;
    const previousConsult = process.env.AGENT_RUN_CACHE_CONSULT_COMMAND;
    const previousLocalObserver = process.env.AGENT_RUN_CACHE_LOCAL_OBSERVER;
    const previousEmbeddingEndpoint = process.env.AGENT_RUN_CACHE_EMBEDDING_ENDPOINT;
    const previousLocalEmbeddingEndpoint = process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDING_ENDPOINT;
    const previousLocalEmbeddings = process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDINGS;

    process.env.AGENT_RUN_CACHE_DIR = join(root, ".agent-run-cache");
    process.env.AGENT_RUN_CACHE_MODEL_SIDECAR = "off";
    process.env.AGENT_RUN_CACHE_LOCAL_OBSERVER = "off";
    delete process.env.AGENT_RUN_CACHE_CONSULT_COMMAND;
    delete process.env.AGENT_RUN_CACHE_EMBEDDING_ENDPOINT;
    delete process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDING_ENDPOINT;
    delete process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDINGS;

    try {
      await fn(root);
    } finally {
      restoreEnv("AGENT_RUN_CACHE_DIR", previousCache);
      restoreEnv("AGENT_RUN_CACHE_MODEL_SIDECAR", previousSidecar);
      restoreEnv("AGENT_RUN_CACHE_CONSULT_COMMAND", previousConsult);
      restoreEnv("AGENT_RUN_CACHE_LOCAL_OBSERVER", previousLocalObserver);
      restoreEnv("AGENT_RUN_CACHE_EMBEDDING_ENDPOINT", previousEmbeddingEndpoint);
      restoreEnv("AGENT_RUN_CACHE_LOCAL_EMBEDDING_ENDPOINT", previousLocalEmbeddingEndpoint);
      restoreEnv("AGENT_RUN_CACHE_LOCAL_EMBEDDINGS", previousLocalEmbeddings);
      await rm(root, { recursive: true, force: true });
    }
  };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function reviewEventsFor(sessionId, workspace, prompt, assistant = "Verified from the available evidence.") {
  const timestamp = new Date("2026-06-25T00:00:00.000Z").toISOString();
  return [
    {
      id: `${sessionId}-user`,
      runner: "codex",
      sessionId,
      workspace,
      timestamp,
      type: "user_prompt",
      source: "test",
      text: prompt
    },
    {
      id: `${sessionId}-assistant`,
      runner: "codex",
      sessionId,
      workspace,
      timestamp,
      type: "assistant_message",
      source: "test",
      text: assistant
    },
    {
      id: `${sessionId}-end`,
      runner: "codex",
      sessionId,
      workspace,
      timestamp,
      type: "session_end",
      source: "test",
      text: "done"
    }
  ];
}

function arcEvent(sessionId, workspace, id, type, text = "", extra = {}) {
  return {
    id: `${sessionId}-${id}`,
    runner: "codex",
    sessionId,
    workspace,
    timestamp: new Date("2026-06-25T00:00:00.000Z").toISOString(),
    type,
    source: "test",
    text,
    ...extra
  };
}

function liveActionReviewCapsule(title = "Run external check") {
  return {
    title,
    kind: "workflow",
    mergeKey: "test-automation.review-action-risk-external-action",
    reusable: true,
    confidence: 0.9,
    summary: "Run an external action outside the local workspace.",
    reuseWhen: ["check external operation result"],
    doNotReuseWhen: [],
    evidence: ["The trace discussed external operation result."],
    provenance: ["bindings/external-operation.yml"],
    nextRunInstruction: "Run the external action and inspect the operation result.",
    workflow: {
      purpose: "Inspect operation result through an explicit external action.",
      parameters: ["operation name", "action context"],
      bindingSources: ["bindings/external-operation.yml"],
      steps: ["Run the external action.", "Inspect operation result."],
      commands: ["external-runner inspect sample-operation"],
      successCriteria: ["The operation result is confirmed."],
      failedAttempts: [],
      validationProbe: ["external-runner verify sample-operation"]
    }
  };
}

function correctionFactCapsule(title = "Record corrected assumption fact") {
  return {
    title,
    kind: "project_fact",
    mergeKey: "test-automation.corrected-assumption-fact",
    reusable: true,
    confidence: 0.85,
    summary: "The checked repository pattern did not support the prior assumption.",
    reuseWhen: ["when the same assumption comes up"],
    doNotReuseWhen: [],
    evidence: ["The assistant checked the current evidence and corrected the prior claim."],
    provenance: ["current trace"],
    nextRunInstruction: "Treat the prior assumption as unverified and check current evidence first.",
    workflow: {
      purpose: "Preserve a corrected project fact.",
      parameters: ["assumption"],
      bindingSources: ["current trace"],
      steps: ["Check the current evidence.", "State the corrected fact."],
      commands: [],
      successCriteria: ["The corrected fact is scoped to current evidence."],
      failedAttempts: ["Do not reuse the prior assumption as validation."],
      validationProbe: []
    }
  };
}

test("redaction handles generic secret assignment names", () => {
  const input = [
    "SERVICE_TOKEN=secret-token-value",
    "\"PROJECT_API_KEY\": \"secret-api-key\"",
    "WORKSPACE_PASSWORD='secret-password'",
  ].join("\n");
  const redacted = redactSensitiveText(input);

  assert.equal(redacted.includes("secret-token-value"), false);
  assert.equal(redacted.includes("secret-api-key"), false);
  assert.equal(redacted.includes("secret-password"), false);
  assert.match(redacted, /SERVICE_TOKEN=<token>/);
  assert.match(redacted, /"PROJECT_API_KEY": <token>/);
  assert.match(redacted, /WORKSPACE_PASSWORD=<token>/);
});

test("capsule save does not fuzzy-merge across explicit merge keys", withCache(async (workspace) => {
  const sharedWorkflow = {
    purpose: "Use an explicit external action to inspect an operation.",
    parameters: ["operation name", "external action context"],
    bindingSources: ["bindings/external-operation-alpha.yml"],
    steps: ["Prepare the external action.", "Run the operation inspection command.", "Record the verification output."],
    commands: ["external-runner inspect sample-operation --mode base"],
    successCriteria: ["The operation command returns the expected marker."],
    failedAttempts: [],
    validationProbe: ["external-runner verify sample-operation --mode base"]
  };

  const first = await saveCapsule({
    runner: "codex",
    workspace,
    sourceSessionId: "session-alpha",
    kind: "workflow",
    mergeKey: "test-automation.external-action-operation-check",
    reusable: true,
    confidence: 0.9,
    title: "Inspect operation through external action",
    summary: "Use an explicit external action before inspecting the operation.",
    reuseWhen: ["inspect an operation through an external action"],
    doNotReuseWhen: [],
    evidence: ["Verified an operation command through an external action."],
    provenance: ["bindings/external-operation-alpha.yml"],
    nextRunInstruction: "Run the external action and verify the operation command output.",
    workflow: sharedWorkflow
  }, workspace);

  const second = await saveCapsule({
    runner: "codex",
    workspace,
    sourceSessionId: "session-marker",
    kind: "workflow",
    mergeKey: "test-automation.verify-output-marker",
    reusable: true,
    confidence: 0.9,
    title: "Verify output marker",
    summary: "Use the same external action but verify the output marker.",
    reuseWhen: ["check the output marker"],
    doNotReuseWhen: [],
    evidence: ["Verified the output marker through the external action."],
    provenance: ["bindings/external-operation-alpha.yml"],
    nextRunInstruction: "Use the external action and check only the output marker.",
    workflow: sharedWorkflow
  }, workspace);

  await saveCapsule({
    runner: "codex",
    workspace,
    sourceSessionId: "session-marker-update",
    kind: "workflow",
    mergeKey: "test-automation.verify-output-marker",
    reusable: true,
    confidence: 0.95,
    title: "Verify output marker after update",
    summary: "Use the same external action but verify the output marker after update.",
    reuseWhen: ["check the output marker after update"],
    doNotReuseWhen: [],
    evidence: ["Verified the output marker after update."],
    provenance: ["bindings/external-operation-alpha.yml"],
    nextRunInstruction: "Use the external action and check the output marker after update.",
    workflow: sharedWorkflow
  }, workspace);

  const capsules = await loadCapsules(workspace);
  assert.equal(capsules.length, 2);

  const alpha = capsules.find((capsule) => capsule.id === first?.id);
  const marker = capsules.find((capsule) => capsule.id === second?.id);
  assert.ok(alpha);
  assert.ok(marker);
  assert.deepEqual(alpha.sourceSessionIds, ["session-alpha"]);
  assert.equal(alpha.sourceSessionIds.includes("session-marker"), false);
  assert.equal(marker.sourceSessionIds.includes("session-alpha"), false);
  assert.equal(marker.sourceSessionIds.includes("session-marker"), true);
  assert.equal(marker.sourceSessionIds.includes("session-marker-update"), true);
}));

test("capsule update records terminal merge event for replacement id", withCache(async (workspace) => {
  const workflow = {
    purpose: "Inspect a local source set.",
    parameters: ["note id"],
    bindingSources: ["source notes"],
    steps: ["Read the note index.", "Load the source notes.", "Inspect the missing-note list."],
    commands: ["note-tool index sample-case", "note-tool sources sample-case"],
    successCriteria: ["The missing note is identified from the source notes."],
    failedAttempts: [],
    validationProbe: ["note-tool status"]
  };

  const durable = await saveCapsule({
    id: "durable-capsule",
    runner: "codex",
    workspace,
    sourceSessionId: "session-a",
    kind: "workflow",
    mergeKey: "test-automation.note-source-gap",
    reusable: true,
    confidence: 0.8,
    title: "Summarize note gap",
    summary: "Use note-tool to inspect indexes and source notes.",
    reuseWhen: ["summarize a note gap"],
    doNotReuseWhen: [],
    evidence: ["The missing note was identified from logs."],
    provenance: ["source notes"],
    nextRunInstruction: "Use note-tool to inspect the index and source notes before naming a root cause.",
    workflow
  }, workspace);

  const updated = await saveCapsule({
    id: "replacement-candidate",
    runner: "codex",
    workspace,
    sourceSessionId: "session-b",
    sourceSessionIds: ["session-b", "session-b-extra"],
    kind: "workflow",
    mergeKey: "test-automation.note-source-gap",
    reusable: true,
    confidence: 0.9,
    title: "Summarize note gap from sources",
    summary: "Use source notes to inspect missing-note lists before deciding root cause.",
    reuseWhen: ["summarize a note gap from sources"],
    doNotReuseWhen: [],
    evidence: ["The source notes contained the missing note."],
    provenance: ["source notes"],
    nextRunInstruction: "Use note-tool to inspect the source notes and preserve the quoted warning.",
    workflow
  }, workspace);

  assert.equal(durable?.id, "durable-capsule");
  assert.equal(updated?.id, "durable-capsule");

  const events = await loadMemoryEvents(workspace);
  const updatedEvent = events.find((event) => event.type === "capsule.updated" && event.capsuleId === "durable-capsule");
  const mergedEvent = events.find((event) => event.type === "capsule.merged" && event.capsuleId === "replacement-candidate");

  assert.ok(updatedEvent);
  assert.ok(mergedEvent);
  assert.equal(mergedEvent.details.fromCapsuleId, "replacement-candidate");
  assert.equal(mergedEvent.details.toCapsuleId, "durable-capsule");
  assert.equal(mergedEvent.details.fromMergeKey, "test-automation.note-source-gap");
  assert.equal(mergedEvent.details.toMergeKey, "test-automation.note-source-gap");
  assert.deepEqual(mergedEvent.details.movedSourceSessionIds, ["session-b", "session-b-extra"]);
  assert.equal(typeof mergedEvent.details.reason, "string");
}));

test("capsule saved debug event names durable and draft ids", withCache(async (workspace) => {
  const workflow = {
    purpose: "Inspect a local source set.",
    parameters: ["note id"],
    bindingSources: ["source notes"],
    steps: ["Read the note index.", "Load the source notes."],
    commands: ["note-tool index sample-case"],
    successCriteria: ["The missing note is identified."],
    failedAttempts: [],
    validationProbe: ["note-tool status"]
  };

  await saveCapsule({
    id: "debug-durable",
    runner: "codex",
    workspace,
    sourceSessionId: "debug-session-create",
    kind: "workflow",
    mergeKey: "debug.note",
    reusable: true,
    confidence: 0.8,
    title: "Summarize note set",
    summary: "Summarize note gap.",
    reuseWhen: ["summarize note set"],
    doNotReuseWhen: [],
    evidence: ["log read"],
    provenance: ["note"],
    nextRunInstruction: "Read log.",
    workflow
  }, workspace);

  await saveCapsule({
    id: "debug-replacement",
    runner: "codex",
    workspace,
    sourceSessionId: "debug-session-update",
    kind: "workflow",
    mergeKey: "debug.note",
    reusable: true,
    confidence: 0.85,
    title: "Summarize note set from sources",
    summary: "Summarize note gap from sources.",
    reuseWhen: ["summarize note set from sources"],
    doNotReuseWhen: [],
    evidence: ["source notes read"],
    provenance: ["note"],
    nextRunInstruction: "Read index and source notes.",
    workflow
  }, workspace);

  await saveCapsule({
    id: "debug-docs-durable",
    runner: "codex",
    workspace,
    sourceSessionId: "debug-docs-create",
    kind: "workflow",
    mergeKey: "debug.docs",
    reusable: true,
    confidence: 0.8,
    title: "Read docs",
    summary: "Read docs.",
    reuseWhen: ["read docs"],
    doNotReuseWhen: [],
    evidence: ["docs read"],
    provenance: ["README.md"],
    nextRunInstruction: "Read docs.",
    workflow: {
      purpose: "Read documentation.",
      parameters: ["topic"],
      bindingSources: ["README.md"],
      steps: ["Read docs."],
      commands: ["sed -n '1,80p' README.md"],
      successCriteria: ["Answer cites docs."],
      failedAttempts: [],
      validationProbe: ["test -f README.md"]
    }
  }, workspace);

  await saveCapsule({
    id: "debug-docs-replacement",
    runner: "codex",
    workspace,
    sourceSessionId: "debug-docs-update",
    kind: "workflow",
    mergeKey: "debug.docs",
    reusable: true,
    confidence: 0.85,
    title: "Read docs carefully",
    summary: "Read docs carefully.",
    reuseWhen: ["read docs carefully"],
    doNotReuseWhen: [],
    evidence: ["docs reread"],
    provenance: ["README.md"],
    nextRunInstruction: "Read docs carefully.",
    workflow: {
      purpose: "Read documentation.",
      parameters: ["topic"],
      bindingSources: ["README.md"],
      steps: ["Read docs carefully."],
      commands: ["sed -n '1,120p' README.md"],
      successCriteria: ["Answer cites docs."],
      failedAttempts: [],
      validationProbe: ["test -f README.md"]
    }
  }, workspace);

  const savedEvents = (await readFile(debugPath(workspace), "utf8"))
    .trim()
    .split(/\n/)
    .map((line) => JSON.parse(line))
    .filter((event) => event.action === "capsule.saved");
  const create = savedEvents.find((event) => event.details.sessionId === "debug-session-create");
  const update = savedEvents.find((event) => event.details.sessionId === "debug-session-update");
  const docsUpdate = savedEvents.find((event) => event.details.sessionId === "debug-docs-update");

  assert.ok(create);
  assert.ok(update);
  assert.ok(docsUpdate);
  assert.equal(create.details.id, "debug-durable");
  assert.equal(create.details.durableCapsuleId, "debug-durable");
  assert.equal(create.details.draftCapsuleId, "debug-durable");
  assert.equal(create.details.replacementCandidateId, undefined);

  assert.equal(update.details.id, "debug-durable");
  assert.equal(update.details.durableCapsuleId, "debug-durable");
  assert.equal(update.details.draftCapsuleId, "debug-replacement");
  assert.equal(update.details.replacementCandidateId, "debug-replacement");

  assert.equal(docsUpdate.details.id, "debug-docs-durable");
  assert.equal(docsUpdate.details.durableCapsuleId, "debug-docs-durable");
  assert.equal(docsUpdate.details.replacementCandidateId, "debug-docs-replacement");
}));

test("save-time compaction records terminal merge event for stored duplicate id", withCache(async (workspace) => {
  const workflow = {
    purpose: "Add a test module to config and registry.",
    parameters: ["module name", "action context"],
    bindingSources: ["modules_config.yml", "bindings/external-operation.yml"],
    steps: ["Find the config entries.", "Add the module mapping.", "Validate the selected registry entry."],
    commands: ["rg \"test_module\" modules_config.yml registry"],
    successCriteria: ["The config and registry entries are both present."],
    failedAttempts: [],
    validationProbe: ["rg \"new_module\" modules_config.yml registry"]
  };

  const durable = await saveCapsule({
    id: "durable-config-capsule",
    runner: "codex",
    workspace,
    sourceSessionId: "session-config-a",
    kind: "workflow",
    mergeKey: "test-automation.add-test-module-config-registry",
    reusable: true,
    confidence: 0.8,
    title: "Add test module config",
    summary: "Update module config and registry together.",
    reuseWhen: ["add a new test module"],
    doNotReuseWhen: [],
    evidence: ["The config and registry mapping were validated."],
    provenance: ["modules_config.yml", "bindings/external-operation.yml"],
    nextRunInstruction: "Update config and registry together, then validate both files.",
    workflow
  }, workspace);

  assert.ok(durable);
  const storedDuplicate = {
    ...durable,
    id: "stored-duplicate-capsule",
    sourceSessionId: "session-config-b",
    sourceSessionIds: ["session-config-b"],
    title: "Wire test module into registry",
    summary: "Duplicate durable row for the same config and registry method.",
    createdAt: "2026-06-24T11:00:00.000Z",
    updatedAt: "2026-06-24T11:00:00.000Z"
  };
  await writeFile(memoryPath(workspace), `${JSON.stringify(durable)}\n${JSON.stringify(storedDuplicate)}\n`, "utf8");

  await saveCapsule({
    id: "later-config-update",
    runner: "codex",
    workspace,
    sourceSessionId: "session-config-c",
    kind: "workflow",
    mergeKey: "test-automation.add-test-module-config-registry",
    reusable: true,
    confidence: 0.9,
    title: "Validate test module config",
    summary: "Validate the same config and registry method after setup.",
    reuseWhen: ["validate a new test module"],
    doNotReuseWhen: [],
    evidence: ["The same config and registry mapping was checked again."],
    provenance: ["modules_config.yml", "bindings/external-operation.yml"],
    nextRunInstruction: "Validate config and registry before reusing the setup.",
    workflow
  }, workspace);

  const capsules = await loadCapsules(workspace);
  assert.equal(capsules.length, 1);
  assert.equal(capsules[0].id, "durable-config-capsule");

  const events = await loadMemoryEvents(workspace);
  const storedMerge = events.find((event) => event.type === "capsule.merged" && event.capsuleId === "stored-duplicate-capsule");
  assert.ok(storedMerge);
  assert.equal(storedMerge.details.fromCapsuleId, "stored-duplicate-capsule");
  assert.equal(storedMerge.details.toCapsuleId, "durable-config-capsule");
  assert.equal(storedMerge.details.fromMergeKey, "test-automation.add-test-module-config-registry");
  assert.equal(storedMerge.details.toMergeKey, "test-automation.add-test-module-config-registry");
  assert.deepEqual(storedMerge.details.movedSourceSessionIds, ["session-config-b"]);
  assert.match(storedMerge.details.reason, /compaction/);
}));

test("capsule outcome downgrades when merged sources are mixed", withCache(async (workspace) => {
  const workflow = {
    purpose: "Check an external setup through an explicit action.",
    parameters: ["operation name", "action context"],
    bindingSources: ["bindings/external-operation.yml"],
    steps: ["Inspect the external state.", "Check the operation result.", "Verify the result."],
    commands: ["external-runner status sample-operation"],
    successCriteria: ["The external checks match the expected state."],
    failedAttempts: [],
    validationProbe: ["external-runner verify sample-operation"]
  };

  const success = await saveCapsule({
    id: "mixed-outcome-capsule",
    runner: "codex",
    workspace,
    sourceSessionId: "session-success",
    kind: "workflow",
    mergeKey: "test-automation.mixed-outcome-setup",
    reusable: true,
    confidence: 0.9,
    title: "Validate external setup",
    summary: "Validate external setup through the external action.",
    reuseWhen: ["validate external setup"],
    doNotReuseWhen: [],
    evidence: ["The setup validation passed."],
    provenance: ["bindings/external-operation.yml"],
    outcomeStatus: "success",
    nextRunInstruction: "Check the external state before noteing success.",
    workflow
  }, workspace);

  const downgraded = await saveCapsule({
    id: "mixed-outcome-partial",
    runner: "codex",
    workspace,
    sourceSessionId: "session-partial",
    kind: "workflow",
    mergeKey: "test-automation.mixed-outcome-setup",
    reusable: true,
    confidence: 0.7,
    title: "Validate external setup partially",
    summary: "Validate external setup but leave external check unresolved.",
    reuseWhen: ["validate external setup after partial recovery"],
    doNotReuseWhen: [],
    evidence: ["The first check worked but an external check remained unresolved."],
    provenance: ["bindings/external-operation.yml"],
    outcomeStatus: "partial",
    nextRunInstruction: "Record partial state if any verification check remains unresolved.",
    workflow
  }, workspace);

  assert.equal(success?.outcomeStatus, "success");
  assert.equal(downgraded?.id, "mixed-outcome-capsule");
  assert.equal(downgraded?.outcomeStatus, "partial");

  const control = await saveCapsule({
    id: "success-control-capsule",
    runner: "codex",
    workspace,
    sourceSessionId: "session-control-a",
    kind: "workflow",
    mergeKey: "test-automation.success-control",
    reusable: true,
    confidence: 0.9,
    title: "Validate successful control",
    summary: "Validate a setup with only successful source outcomes.",
    reuseWhen: ["validate a successful setup"],
    doNotReuseWhen: [],
    evidence: ["The setup validation passed."],
    provenance: ["bindings/external-operation.yml"],
    outcomeStatus: "success",
    nextRunInstruction: "Record success only when validation passes.",
    workflow
  }, workspace);

  const stillSuccess = await saveCapsule({
    id: "success-control-update",
    runner: "codex",
    workspace,
    sourceSessionId: "session-control-b",
    kind: "workflow",
    mergeKey: "test-automation.success-control",
    reusable: true,
    confidence: 0.95,
    title: "Validate successful control again",
    summary: "Validate a setup with another successful source outcome.",
    reuseWhen: ["validate a successful setup again"],
    doNotReuseWhen: [],
    evidence: ["The repeated setup validation passed."],
    provenance: ["bindings/external-operation.yml"],
    outcomeStatus: "success",
    nextRunInstruction: "Record success when repeated validation passes.",
    workflow
  }, workspace);

  assert.equal(control?.outcomeStatus, "success");
  assert.equal(stillSuccess?.outcomeStatus, "success");

  const events = await loadMemoryEvents(workspace);
  const mixedUpdate = events.find((event) => event.type === "capsule.updated" && event.capsuleId === "mixed-outcome-capsule");
  const controlUpdate = events.find((event) => event.type === "capsule.updated" && event.capsuleId === "success-control-capsule");
  assert.ok(mixedUpdate);
  assert.ok(controlUpdate);
  assert.deepEqual(mixedUpdate.details.sourceOutcomeStatuses, {
    existing: "success",
    incoming: "partial",
    final: "partial"
  });
  assert.deepEqual(controlUpdate.details.sourceOutcomeStatuses, {
    existing: "success",
    incoming: "success",
    final: "success"
  });
}));

test("capsule updates preserve core fields for token-distinct methods", withCache(async (workspace) => {
  const noteWorkflow = {
    purpose: "Diagnose a missing note from index and source notes data.",
    parameters: ["note id"],
    bindingSources: ["source notes"],
    steps: ["Read the note index.", "Load the source notes.", "Inspect missing-note lists."],
    commands: ["note-tool index sample-case", "note-tool sources sample-case"],
    successCriteria: ["The missing note is identified from the source notes."],
    failedAttempts: [],
    validationProbe: ["note-tool status"]
  };
  await saveCapsule({
    id: "core-note",
    runner: "codex",
    workspace,
    sourceSessionId: "core-note-a",
    kind: "workflow",
    mergeKey: "test-automation.note-source-gap",
    reusable: true,
    confidence: 0.8,
    title: "Summarize note gap",
    summary: "Use note-tool indexes and source notes to find the missing note.",
    reuseWhen: ["summarize a note gap"],
    doNotReuseWhen: [],
    evidence: ["The missing note was identified from the source notes."],
    provenance: ["source notes"],
    nextRunInstruction: "Inspect the note index and source notes before naming a root cause.",
    workflow: noteWorkflow
  }, workspace);

  await saveCapsule({
    id: "core-note-variant",
    runner: "codex",
    workspace,
    sourceSessionId: "core-note-b",
    kind: "workflow",
    mergeKey: "test-automation.note-source-gap",
    reusable: true,
    confidence: 0.8,
    title: "Trace variant",
    summary: "Follow configuration variables to determine which variant was selected.",
    reuseWhen: ["trace configuration variant selection"],
    doNotReuseWhen: [],
    evidence: ["The selected variant was found from configuration variables."],
    provenance: ["configuration variables"],
    nextRunInstruction: "Inspect configuration variables and compare variants.",
    workflow: {
      purpose: "Trace which configuration variant was selected.",
      parameters: ["case id"],
      bindingSources: ["configuration variables"],
      steps: ["Read configuration variables.", "Compare variants."],
      commands: ["note-tool case view sample-case", "note-tool config view --variables"],
      successCriteria: ["The selected variant is explained."],
      failedAttempts: [],
      validationProbe: ["note-tool status"]
    }
  }, workspace);

  let capsule = (await loadCapsules(workspace)).find((item) => item.id === "core-note");
  assert.ok(capsule);
  assert.equal(capsule.title, "Summarize note gap");
  assert.equal(capsule.summary, "Use note-tool indexes and source notes to find the missing note.");
  assert.equal(capsule.workflow.purpose, "Diagnose a missing note from index and source notes data.");
  assert.equal(capsule.nextRunInstruction, "Inspect the note index and source notes before naming a root cause.");
  assert.equal(capsule.sourceSessionIds.includes("core-note-b"), true);

  await saveCapsule({
    id: "core-note-refinement",
    runner: "codex",
    workspace,
    sourceSessionId: "core-note-c",
    kind: "workflow",
    mergeKey: "test-automation.note-source-gap",
    reusable: true,
    confidence: 0.9,
    title: "Summarize note gap from sources",
    summary: "Use note-tool indexes, source notes, missing-note lists, and quoted warning together to identify the exact missing note before claiming a root cause.",
    reuseWhen: ["summarize a note gap from sources"],
    doNotReuseWhen: [],
    evidence: ["The missing note and quoted warning were identified from the source notes."],
    provenance: ["source notes"],
    nextRunInstruction: "Inspect the note index, source notes, and quoted warning before naming a root cause.",
    workflow: noteWorkflow
  }, workspace);

  capsule = (await loadCapsules(workspace)).find((item) => item.id === "core-note");
  assert.ok(capsule);
  assert.equal(capsule.summary, "Use note-tool indexes, source notes, missing-note lists, and quoted warning together to identify the exact missing note before claiming a root cause.");

  await saveCapsule({
    id: "core-release-notes",
    runner: "codex",
    workspace,
    sourceSessionId: "core-release-a",
    kind: "workflow",
    mergeKey: "docs.release-workflow",
    reusable: true,
    confidence: 0.8,
    title: "Draft release notes",
    summary: "Summarize changelog entries into release notes.",
    reuseWhen: ["draft release notes"],
    doNotReuseWhen: [],
    evidence: ["Release notes were drafted from the changelog."],
    provenance: ["CHANGELOG.md"],
    nextRunInstruction: "Read the changelog and summarize the requested release.",
    workflow: {
      purpose: "Draft release notes from changelog entries.",
      parameters: ["release version"],
      bindingSources: ["CHANGELOG.md"],
      steps: ["Read changelog.", "Summarize changes."],
      commands: ["sed -n '1,160p' CHANGELOG.md"],
      successCriteria: ["The notes cite changelog entries."],
      failedAttempts: [],
      validationProbe: ["test -f CHANGELOG.md"]
    }
  }, workspace);

  await saveCapsule({
    id: "core-package-publish",
    runner: "codex",
    workspace,
    sourceSessionId: "core-release-b",
    kind: "workflow",
    mergeKey: "docs.release-workflow",
    reusable: true,
    confidence: 0.8,
    title: "Publish package to npm",
    summary: "Build, tag, authenticate, and publish a package release to npm.",
    reuseWhen: ["publish npm package"],
    doNotReuseWhen: [],
    evidence: ["The package publish completed."],
    provenance: ["package.json"],
    nextRunInstruction: "Build the package and publish it with npm.",
    workflow: {
      purpose: "Publish a package archive to npm.",
      parameters: ["package version"],
      bindingSources: ["package.json"],
      steps: ["Build package.", "Publish package."],
      commands: ["npm publish"],
      successCriteria: ["The package is available in npm."],
      failedAttempts: [],
      validationProbe: ["npm whoami"]
    }
  }, workspace);

  const release = (await loadCapsules(workspace)).find((item) => item.id === "core-release-notes");
  assert.ok(release);
  assert.equal(release.title, "Draft release notes");
  assert.equal(release.workflow.purpose, "Draft release notes from changelog entries.");
  assert.equal(release.nextRunInstruction, "Read the changelog and summarize the requested release.");
  assert.equal(release.sourceSessionIds.includes("core-release-b"), true);
}));

test("retrieval blocks live-action capsules for advice-only prompts", withCache(async (workspace) => {
  const consult = join(workspace, "action-risk-consult.cjs");
  const consultLog = join(workspace, "action-risk-consult.jsonl");
  await writeFile(consult, `
const fs = require("fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.resume();
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  fs.appendFileSync(${JSON.stringify(consultLog)}, JSON.stringify(payload.capsules.map((capsule) => capsule.id)) + "\\n");
  const selected = payload.capsules.find((capsule) => capsule.id === "live-external-action") ?? payload.capsules[0];
  console.log(JSON.stringify({
    applies: Boolean(selected),
    capsuleId: selected?.id,
    reason: selected ? "selected test candidate" : "no candidate"
  }));
});
`, "utf8");
  process.env.AGENT_RUN_CACHE_CONSULT_COMMAND = `${process.execPath} ${consult}`;

  await saveCapsule({
    id: "live-external-action",
    runner: "codex",
    workspace,
    sourceSessionId: "session-live",
    kind: "workflow",
    mergeKey: "test-automation.external-action-operation-check",
    reusable: true,
    confidence: 0.95,
    title: "Check external operation result",
    summary: "Run an external action to inspect operation result.",
    reuseWhen: ["external-runner run sample-operation", "check sample operation with external-runner"],
    doNotReuseWhen: [],
    evidence: ["The external action returned an operation result."],
    provenance: ["bindings/external-operation.yml"],
    nextRunInstruction: "Run the external action and inspect the operation result.",
    workflow: {
      purpose: "Check operation result through an explicit external action.",
      parameters: ["operation name", "action context"],
      bindingSources: ["bindings/external-operation.yml"],
      steps: ["Run the external action.", "Inspect operation result.", "Check operation readiness."],
      commands: ["external-runner inspect sample-operation --with-readiness"],
      successCriteria: ["The result and readiness check match the requested operation."],
      failedAttempts: [],
      validationProbe: ["external-runner verify sample-operation"]
    }
  }, workspace);

  await saveCapsule({
    id: "local-file",
    runner: "codex",
    workspace,
    sourceSessionId: "session-local",
    kind: "workflow",
    mergeKey: "docs.read-local-diagnostics",
    reusable: true,
    confidence: 0.7,
    title: "Read local diagnostic notes",
    summary: "Inspect local diagnostic notes without external access.",
    reuseWhen: ["diagnostic output", "manual check notes"],
    doNotReuseWhen: [],
    evidence: ["A previous answer used local notes only."],
    provenance: ["diagnostics.md"],
    nextRunInstruction: "Read the local diagnostic notes and answer from the pasted evidence.",
    workflow: {
      purpose: "Read local diagnostic notes.",
      parameters: ["diagnostic note"],
      bindingSources: ["diagnostics.md"],
      steps: ["Read the local notes.", "Compare them with the pasted output."],
      commands: ["sed -n '1,160p' diagnostics.md"],
      successCriteria: ["The answer cites only local notes and pasted evidence."],
      failedAttempts: [],
      validationProbe: ["test -f diagnostics.md"]
    }
  }, workspace);

  const pasted = await buildInjectionPlan(
    "diagnostic output:\\nline one: ok\\nline two: missing\\nWhat does this suggest?",
    workspace,
    { runner: "codex" }
  );
  const manual = await buildInjectionPlan(
    "no external-runner, just tell me how to check the operation result manually",
    workspace,
    { runner: "codex" }
  );

  assert.notEqual(pasted.capsule?.id, "live-external-action");
  assert.notEqual(manual.capsule?.id, "live-external-action");
  let capsules = await loadCapsules(workspace);
  assert.equal(capsules.find((capsule) => capsule.id === "live-external-action")?.useCount, 0);

  const explicit = await buildInjectionPlan(
    "external-runner run sample-operation",
    workspace,
    { runner: "codex" }
  );

  assert.equal(explicit.shouldInject, true);
  assert.equal(explicit.capsule?.id, "live-external-action");
  capsules = await loadCapsules(workspace);
  assert.equal(capsules.find((capsule) => capsule.id === "live-external-action")?.useCount, 1);

  const candidateLists = (await readFile(consultLog, "utf8")).trim().split(/\n/).map((line) => JSON.parse(line));
  assert.equal(candidateLists[0].includes("live-external-action"), false);
  assert.equal(candidateLists[1].includes("live-external-action"), false);
  assert.equal(candidateLists[2].includes("live-external-action"), true);
}));

test("review blocks broad live-action saves after action-risk abstention", withCache(async (workspace) => {
  const blocked = await reviewEvents(
    reviewEventsFor(
      "review-action-risk-diagnostic",
      workspace,
      "Pasted diagnostic output says line one is ok and line two is missing. What does this suggest?",
      "The pasted output suggests the expected step did not complete; verified from the transcript only."
    ),
    workspace,
    "review-action-risk-diagnostic",
    "auto",
    {
      consultApplied: false,
      consultAbstainReason: "consult abstained for no live-action intent",
      actionRisk: "prompt is pasted diagnostic output without live-action intent",
      reviewer: async (request) => {
        assert.equal(request.reviewContext?.actionRisk, "prompt is pasted diagnostic output without live-action intent");
        return { shouldSave: true, capsule: liveActionReviewCapsule("external action from pasted diagnostic") };
      }
    }
  );

  assert.equal(blocked.status, "no_capsule");
  assert.match(blocked.reason, /action-risk/);
  assert.equal((await loadCapsules(workspace)).length, 0);

  const allowed = await reviewEvents(
    reviewEventsFor(
      "review-action-risk-allowed",
      workspace,
      "external-runner run sample-operation.",
      "Verified the external operation result successfully."
    ),
    workspace,
    "review-action-risk-allowed",
    "auto",
    {
      consultApplied: true,
      consultCapsuleId: "live-external-action",
      reviewer: async () => ({ shouldSave: true, capsule: liveActionReviewCapsule("external action when requested") })
    }
  );

  assert.equal(allowed.status, "saved");
  assert.equal((await loadCapsules(workspace)).length, 1);

  const differentlyWorded = await reviewEvents(
    reviewEventsFor(
      "review-action-risk-manual",
      workspace,
      "I need the manual checks for why the operation never completes; do not run external actions.",
      "Listed manual checks from the provided evidence."
    ),
    workspace,
    "review-action-risk-manual",
    "auto",
    {
      consultApplied: false,
      consultAbstainReason: "manual guidance requested",
      actionRisk: "prompt asks for manual guidance rather than live action",
      reviewer: async (request) => {
        assert.equal(request.reviewContext?.actionRisk, "prompt asks for manual guidance rather than live action");
        return { shouldSave: true, capsule: liveActionReviewCapsule("external action from manual guidance") };
      }
    }
  );

  assert.equal(differentlyWorded.status, "no_capsule");
  assert.match(differentlyWorded.reason, /action-risk/);
  assert.equal((await loadCapsules(workspace)).length, 1);
}));

test("manual wording with explicit live-action intent can still save reviewed capsule", withCache(async (workspace) => {
  await saveCapsule({
    id: "review-live-action-seed",
    runner: "codex",
    workspace,
    sourceSessionId: "review-live-action-seed-session",
    ...liveActionReviewCapsule("Seed external action")
  }, workspace);

  const prompt = "Manually verify by running external-runner inspect sample-operation against the remote environment.";
  const plan = await buildInjectionPlan(prompt, workspace, { runner: "codex" });
  assert.equal(plan.actionRisk, undefined);

  const sessionId = "review-manual-explicit-live";
  const events = [
    arcEvent(sessionId, workspace, "user", "user_prompt", prompt),
    arcEvent(sessionId, workspace, "tool-start", "tool_start", "", {
      toolName: "Bash",
      command: "external-runner inspect sample-operation"
    }),
    arcEvent(sessionId, workspace, "tool-end", "tool_end", "operation result verified", {
      toolName: "Bash",
      command: "external-runner inspect sample-operation",
      toolStatus: "success",
      exitCode: 0
    }),
    arcEvent(sessionId, workspace, "assistant", "assistant_message", "Verified the external operation successfully."),
    arcEvent(sessionId, workspace, "end", "session_end", "done")
  ];

  const review = await maybeReviewTurn(
    events,
    plan,
    "completed",
    "review-manual-explicit-live-turn",
    workspace,
    {
      reviewer: async (request) => {
        assert.equal(request.reviewContext?.actionRisk, undefined);
        return { shouldSave: true, capsule: liveActionReviewCapsule("Reviewed external action") };
      }
    }
  );

  assert.equal(review?.status, "saved");
  const saved = (await loadCapsules(workspace)).find((capsule) => capsule.id === "review-live-action-seed");
  assert.ok(saved);
  assert.equal(saved.sourceSessionIds.includes(sessionId), true);
}));

test("review records correction signals instead of plain validation", withCache(async (workspace) => {
  const plainValidation = await reviewEvents(
    reviewEventsFor(
      "review-correction-validation",
      workspace,
      "Where did that assumption come from? Is it an existing pattern?",
      "You are right; it was my addition, not an existing pattern."
    ),
    workspace,
    "review-correction-validation",
    "auto",
    {
      reviewer: async () => ({ shouldSave: false, reason: "validated existing capsule" })
    }
  );

  assert.equal(plainValidation.status, "no_capsule");
  assert.match(plainValidation.reason, /correction signal/);
  let events = await loadMemoryEvents(workspace);
  const correctionRejection = events.find((event) => event.sessionId === "review-correction-validation" && event.type === "capsule.rejected");
  assert.ok(correctionRejection);
  assert.equal(correctionRejection.details.correctionSignal, true);

  const allowedFact = await reviewEvents(
    reviewEventsFor(
      "review-correction-fact",
      workspace,
      "Why did you not follow the existing pattern?",
      "I checked again and narrowed the claim: the existing setup does not use that step."
    ),
    workspace,
    "review-correction-fact",
    "auto",
    {
      reviewer: async () => ({ shouldSave: true, capsule: correctionFactCapsule() })
    }
  );

  assert.equal(allowedFact.status, "saved");
  assert.equal((await loadCapsules(workspace)).length, 1);

  const blockedWorkflow = await reviewEvents(
    reviewEventsFor(
      "review-correction-workflow",
      workspace,
      "That assumption is wrong because the previous setup used another path.",
      "I was wrong; I assumed the assumption without validating it."
    ),
    workspace,
    "review-correction-workflow",
    "auto",
    {
      reviewer: async () => ({ shouldSave: true, capsule: liveActionReviewCapsule("external action workflow from corrected assumption") })
    }
  );

  assert.equal(blockedWorkflow.status, "no_capsule");
  assert.match(blockedWorkflow.reason, /correction signal/);
  assert.equal((await loadCapsules(workspace)).length, 1);
  events = await loadMemoryEvents(workspace);
  const blockedEvent = events.find((event) => event.sessionId === "review-correction-workflow" && event.details?.correctionSignal === true);
  assert.ok(blockedEvent);
}));

test("failed runner rejections include structured failure shape", withCache(async (workspace) => {
  const emptyPlan = { shouldInject: false, message: "", reason: "no injection", source: "local" };
  const injectedPlan = {
    shouldInject: true,
    message: "prior capsule",
    reason: "matched",
    source: "local",
    capsule: { id: "injected-live-capsule" }
  };

  await maybeReviewTurn(
    [
      arcEvent("failed-timeout", workspace, "user", "user_prompt", "Set up the external operation."),
      arcEvent("failed-timeout", workspace, "assistant", "assistant_message", "Starting the external apply."),
      arcEvent("failed-timeout", workspace, "tool-start", "tool_start", "", {
        toolName: "shell",
        command: "external-runner apply setup.yml"
      }),
      arcEvent("failed-timeout", workspace, "end", "session_end", "Timeout waiting for session.idle while the command was still running.")
    ],
    injectedPlan,
    "failed",
    "turn-timeout",
    workspace
  );

  await maybeReviewTurn(
    [
      arcEvent("completed-smalltalk", workspace, "user", "user_prompt", "thanks"),
      arcEvent("completed-smalltalk", workspace, "assistant", "assistant_message", "ok")
    ],
    emptyPlan,
    "completed",
    "turn-completed",
    workspace
  );

  await maybeReviewTurn(
    [
      arcEvent("failed-empty", workspace, "user", "user_prompt", "Why did the note fail?"),
      arcEvent("failed-empty", workspace, "end", "session_end", "runner exited before output")
    ],
    emptyPlan,
    "failed",
    "turn-empty",
    workspace
  );

  const events = await loadMemoryEvents(workspace);
  const timeout = events.find((event) => event.turnId === "turn-timeout" && event.type === "capsule.rejected");
  const completed = events.find((event) => event.turnId === "turn-completed" && event.type === "capsule.rejected");
  const empty = events.find((event) => event.turnId === "turn-empty" && event.type === "capsule.rejected");

  assert.ok(timeout);
  assert.equal(timeout.details.failureKind, "timeout_pending_shell");
  assert.equal(timeout.details.externalMutationRisk, true);
  assert.deepEqual(timeout.details.injectedCapsuleIds, ["injected-live-capsule"]);
  assert.equal(timeout.details.toolCount, 1);

  assert.ok(completed);
  assert.equal(completed.details.reason, "small-talk turn");
  assert.equal(completed.details.failureKind, undefined);

  assert.ok(empty);
  assert.equal(empty.details.failureKind, "no_assistant_output");
  assert.deepEqual(empty.details.injectedCapsuleIds, []);
}));

test("fast-path rejections write reviewed audit rows", withCache(async (workspace) => {
  const emptyPlan = { shouldInject: false, message: "", reason: "no injection", source: "local" };
  await maybeReviewTurn(
    [
      arcEvent("audit-smalltalk", workspace, "user", "user_prompt", "thanks"),
      arcEvent("audit-smalltalk", workspace, "assistant", "assistant_message", "ok")
    ],
    emptyPlan,
    "completed",
    "audit-turn-smalltalk",
    workspace
  );

  await maybeReviewTurn(
    [
      arcEvent("audit-failed", workspace, "user", "user_prompt", "run the check"),
      arcEvent("audit-failed", workspace, "end", "session_end", "runner exited before output")
    ],
    emptyPlan,
    "failed",
    "audit-turn-failed",
    workspace
  );

  await reviewEvents(
    reviewEventsFor("audit-normal-review", workspace, "Summarize this small repo fact.", "Nothing reusable was learned."),
    workspace,
    "audit-normal-review",
    "auto",
    { reviewer: async () => ({ shouldSave: false, reason: "not reusable" }) }
  );

  const reviewed = (await readFile(reviewedPath(workspace), "utf8")).trim().split(/\n/).map((line) => JSON.parse(line));
  const smalltalkRows = reviewed.filter((row) => row.sessionId === "audit-smalltalk");
  const failedRows = reviewed.filter((row) => row.sessionId === "audit-failed");
  const normalRows = reviewed.filter((row) => row.sessionId === "audit-normal-review");

  assert.equal(smalltalkRows.length, 1);
  assert.equal(smalltalkRows[0].status, "no_capsule");
  assert.equal(smalltalkRows[0].turnId, "audit-turn-smalltalk");
  assert.equal(smalltalkRows[0].rejectionPath, "fast-path");
  assert.equal(smalltalkRows[0].reason, "small-talk turn");

  assert.equal(failedRows.length, 1);
  assert.equal(failedRows[0].status, "failed");
  assert.equal(failedRows[0].turnId, "audit-turn-failed");
  assert.equal(failedRows[0].rejectionPath, "fast-path");
  assert.equal(failedRows[0].reason, "runner did not complete");

  assert.equal(normalRows.length, 1);
  assert.equal(normalRows[0].status, "no_capsule");
  assert.equal(normalRows[0].reason, "not reusable");
  assert.equal(normalRows[0].rejectionPath, undefined);
}));

test("retrieval honors a consult decline without local fallback", withCache(async (workspace) => {
  const consult = join(workspace, "declining-consult.cjs");
  const consultInput = join(workspace, "declining-consult-input.json");
  await writeFile(consult, `
const fs = require("fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(consultInput)}, input);
  console.log(JSON.stringify({
    applies: false,
    reason: "The current request explicitly asks not to run the saved workflow."
  }));
});
`, "utf8");
  process.env.AGENT_RUN_CACHE_CONSULT_COMMAND = `${process.execPath} ${consult}`;

  const saved = await saveCapsule({
    runner: "codex",
    workspace,
    sourceSessionId: "seed",
    reusable: true,
    confidence: 0.9,
    title: "Generate release notes",
    summary: "Build concise release notes from a local changelog.",
    reuseWhen: ["generate release notes", "summarize changelog"],
    doNotReuseWhen: [],
    evidence: ["A previous run read CHANGELOG.md and produced a release summary."],
    provenance: ["CHANGELOG.md"],
    nextRunInstruction: "Read the current changelog and summarize only the requested release section.",
    workflow: {
      purpose: "Generate release notes from repository-local source text.",
      parameters: ["release section"],
      bindingSources: ["CHANGELOG.md"],
      steps: ["Read the changelog.", "Find the requested section.", "Summarize the user-facing changes."],
      commands: ["sed -n '1,160p' CHANGELOG.md"],
      successCriteria: ["The answer cites only entries from the requested section."],
      failedAttempts: [],
      validationProbe: ["test -f CHANGELOG.md"]
    }
  }, workspace);

  const plan = await buildInjectionPlan(
    "do not generate release notes; just tell me what file you would inspect",
    workspace,
    { runner: "codex" }
  );

  assert.equal(plan.shouldInject, false);
  assert.equal(plan.source, "sidecar");
  assert.match(plan.reason, /not to run/);

  const reloaded = (await loadCapsules(workspace)).find((capsule) => capsule.id === saved?.id);
  assert.equal(reloaded?.useCount, 0);

  const payload = JSON.parse(await readFile(consultInput, "utf8"));
  assert.equal(payload.capsules.length, 1);
  assert.equal(payload.capsules[0].id, saved?.id);
  assert.equal(payload.capsules[0].sourceSessionIds, undefined);
  assert.equal(payload.capsules[0].evidence, undefined);
  assert.equal(payload.capsules[0].bindingSnapshots, undefined);
  assert.equal(payload.capsules[0].embedding, undefined);
  assert.equal(payload.capsules[0].graph, undefined);
}));
