import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeDebugBundle } from "../dist/bundle.js";
import { telemetryPath, telemetryPolicyPath } from "../dist/paths.js";
import { saveTraceEvents } from "../dist/store.js";
import { buildMetricsReport, loadTelemetryRecords, reviewerBudgetReason } from "../dist/telemetry.js";

test("Copilot telemetry prefers provider usage and stores no trace content", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "arc-telemetry-"));
  try {
    const base = { runner: "copilot", sessionId: "telemetry-session", workspace, source: "test" };
    const events = [
      { ...base, id: "prompt", timestamp: "2026-01-01T00:00:00.000Z", type: "user_prompt", text: "private prompt" },
      { ...base, id: "tool-start", timestamp: "2026-01-01T00:00:01.000Z", type: "tool_start", toolName: "shell", toolUseId: "call-1", command: "curl https://example.invalid --header token=secret" },
      { ...base, id: "tool-end", timestamp: "2026-01-01T00:00:03.000Z", type: "tool_end", toolName: "shell", toolUseId: "call-1", command: "curl https://example.invalid --header token=secret", toolStatus: "success" },
      { ...base, id: "assistant", timestamp: "2026-01-01T00:00:04.000Z", type: "assistant_message", text: "private answer", raw: { usage: { input_tokens: 7, output_tokens: 5, total_tokens: 12, cost_usd: 0.25 } } },
      { ...base, id: "end", timestamp: "2026-01-01T00:00:05.000Z", type: "session_end" }
    ];
    await saveTraceEvents(events, "telemetry-session", workspace);

    const ledger = await readFile(telemetryPath(workspace), "utf8");
    assert.doesNotMatch(ledger, /private prompt|private answer|example\.invalid|token=secret/);
    const report = await buildMetricsReport(workspace);
    assert.equal(report.summary.toolCalls, 1);
    assert.equal(report.summary.tokens.provider, 12);
    assert.equal(report.summary.tokens.estimated, 0);
    assert.equal(report.summary.cost.providerUsd, 0.25);
    assert.equal(report.summary.latencyMs.tool.p50, 2_000);

    const bundle = await writeDebugBundle(join(workspace, "bundle"), workspace);
    assert.equal(bundle.traceCount, 1);
    assert.match(await readFile(join(bundle.path, "metrics.aggregate.redacted.json"), "utf8"), /"summary"/);
    await assert.rejects(readFile(join(bundle.path, "telemetry.redacted.jsonl"), "utf8"));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("reviewer hard call budget records a blocked decision", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "arc-review-budget-"));
  try {
    await mkdir(join(workspace, ".agent-run-cache"), { recursive: true });
    await writeFile(telemetryPolicyPath(workspace), JSON.stringify({ reviewer: { maxCallsPerSession: 0 } }));
    const reason = await reviewerBudgetReason(workspace, "budget-session");
    assert.match(reason, /hard call limit/);
    const records = await loadTelemetryRecords(workspace);
    assert.equal(records[0].kind, "reviewer_call");
    assert.equal(records[0].status, "blocked");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
