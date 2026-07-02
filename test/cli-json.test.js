import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { buildHookCommand } from "../dist/install.js";
import { recordMemoryEvent } from "../dist/ledger.js";
import { recordJudgeDecision, recordJudgeOutcome } from "../dist/retrieval-reputation.js";
import { transientRuntimeReason } from "../dist/runtime.js";
import { saveCapsule } from "../dist/store.js";

const cli = resolve("dist/cli.js");

test("status --json emits the local cache shape", withCliCache(async ({ cwd, env }) => {
  const result = runCli(["status", "--json"], cwd, env);
  const status = parseJsonStdout(result);

  assert.equal(status.workspace, cwd);
  assert.equal(typeof status.cacheDir, "string");
  assert.equal(typeof status.memoryPath, "string");
  assert.equal(typeof status.memoryEventsPath, "string");
  assert.equal(status.capsuleCount, 0);
  assert.equal(status.eventCount, 0);
  assert.equal(typeof status.generatedAt, "string");
}));

test("arc with no args prints a non-TTY status summary", withCliCache(async ({ cwd, env }) => {
  const result = runCli([], cwd, env);
  assert.match(result.stdout, /^ARC /);
  assert.match(result.stdout, /capsules: 0/);
  assert.match(result.stdout, /seam: plugin pending/);
}));

test("capsules --json emits saved capsules", withCliCache(async ({ cwd, env }) => {
  const saved = await saveCapsule({
    id: "cli-json-capsule",
    runner: "codex",
    workspace: cwd,
    sourceSessionId: "cli-json-session",
    kind: "workflow",
    mergeKey: "cli-json.test-capsule",
    reusable: true,
    confidence: 0.9,
    title: "Inspect CLI JSON output",
    summary: "Use the CLI JSON commands to inspect local ARC state.",
    reuseWhen: ["checking CLI JSON output"],
    doNotReuseWhen: [],
    evidence: ["The CLI emitted valid JSON."],
    provenance: ["test"],
    nextRunInstruction: "Run arc status --json and arc capsules --json before building a thin client.",
    workflow: {
      purpose: "Inspect ARC through server-free CLI JSON.",
      parameters: ["workspace"],
      bindingSources: ["test"],
      steps: ["Run status JSON.", "Run capsules JSON."],
      commands: ["arc status --json", "arc capsules --json"],
      successCriteria: ["Both commands emit parseable JSON."],
      failedAttempts: [],
      validationProbe: ["node -e 'JSON.parse(input)'"]
    }
  }, cwd);
  assert.ok(saved);

  const list = parseJsonStdout(runCli(["capsules", "--json"], cwd, env));
  assert.equal(list.capsules.length, 1);
  assert.equal(list.capsules[0].id, "cli-json-capsule");
  assert.equal(list.capsules[0].title, "Inspect CLI JSON output");

  const single = parseJsonStdout(runCli(["capsules", "cli-json", "--json"], cwd, env));
  assert.equal(single.capsule.id, "cli-json-capsule");
}));

test("declined drafts list and promote through the CLI", withCliCache(async ({ cwd, env }) => {
  const cache = join(cwd, ".agent-run-cache");
  await mkdir(cache, { recursive: true });
  const declined = {
    id: "declined-cli-test",
    mergeKey: "draft:declined-cli-test",
    createdAt: new Date().toISOString(),
    sessionId: "declined-cli-session",
    outcome: "success",
    reason: "reviewer considered this one-off",
    draft: {
      packetKind: "assembled_draft",
      runner: "copilot",
      sessionId: "declined-cli-session",
      workspace: cwd,
      createdAt: new Date().toISOString(),
      goalId: "declined-goal",
      mergeKey: "draft:declined-cli-test",
      span: { eventCount: 2 },
      goal: "Validate the local package",
      prompts: ["Validate the local package"],
      evidenceSnippets: ["success command result (exit code 0): package-check\noutput tail:\nPACKAGE_OK"],
      commands: ["package-check --local"],
      parameters: ["--local"],
      paths: ["package.json"],
      outcome: {
        status: "success",
        confidence: 1,
        reasons: [],
        successSignals: ["exit code 0"],
        failureSignals: [],
        abortedSignals: []
      },
      observations: [],
      sourceEventIds: []
    }
  };
  await writeFile(join(cache, "declined.jsonl"), `${JSON.stringify(declined)}\n`, "utf8");

  const listed = parseJsonStdout(runCli(["capsules", "declined", "--json"], cwd, env));
  assert.equal(listed.declined.length, 1);
  assert.equal(listed.declined[0].title, "Validate the local package");
  assert.equal(listed.declined[0].sessionId, "declined-cli-session");
  assert.equal(typeof listed.declined[0].ageSeconds, "number");
  assert.equal("draft" in listed.declined[0], false);

  const promoted = parseJsonStdout(runCli(["capsules", "promote", "declined-cli-test", "--json"], cwd, env));
  assert.equal(promoted.declinedDraftId, "declined-cli-test");
  assert.equal(promoted.capsule.confidence, 0.5);
  assert.equal(promoted.capsule.provenance.includes("promoted-by-user"), true);

  const capsules = parseJsonStdout(runCli(["capsules", "--json"], cwd, env));
  assert.equal(capsules.capsules[0].id, promoted.capsule.id);
  const remaining = parseJsonStdout(runCli(["capsules", "declined", "--json"], cwd, env));
  assert.equal(remaining.declined.length, 0);
  assert.match(await readFile(join(cache, "judge-decisions.jsonl"), "utf8"), /"mode":"user-override"/);
  assert.match(await readFile(join(cache, "retrieval-reputation.json"), "utf8"), new RegExp(promoted.capsule.id));
}));

test("hook command builder quotes POSIX and Windows runtime paths", () => {
  const posix = buildHookCommand(
    "/Applications/Node Current/bin/node",
    "/Users/Ayub Dev/.agent-run-cache/bin/copilot-hook.mjs",
    "SessionStart"
  );
  assert.equal(posix, "'/Applications/Node Current/bin/node' '/Users/Ayub Dev/.agent-run-cache/bin/copilot-hook.mjs' SessionStart");

  const winNode = String.raw`C:\Program Files\nodejs\node.exe`;
  const winShim = String.raw`C:\Users\Ayub Dev\.agent-run-cache\bin\copilot-hook.mjs`;
  const windows = buildHookCommand(winNode, winShim, "SessionEnd");
  assert.equal(windows, `"${winNode}" "${winShim}" SessionEnd`);
});

test("transient npm exec runtimes are detected before setup pins hooks", () => {
  assert.equal(
    transientRuntimeReason("/Users/example/.npm/_npx/abc/node_modules/agent-run-cache/dist/cli.js"),
    "/.npm/_npx/"
  );
  assert.equal(
    transientRuntimeReason("/Users/example/.cache/pnpm/dlx/abc/node_modules/agent-run-cache/dist/cli.js"),
    "/.cache/pnpm/dlx/"
  );
  assert.equal(transientRuntimeReason("/usr/local/lib/node_modules/agent-run-cache/dist/cli.js"), undefined);
});

test("plugin command exposes a marketplace-ready local plugin and installs through copilot plugin install", withCliCache(async ({ cwd, env }) => {
  const bin = join(cwd, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "arc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(bin, "copilot"), `#!/bin/sh
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then
  test -f "$3/plugin.json" || exit 3
  echo "installed agent-run-cache"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  echo "agent-run-cache 2.1.0 enabled"
  exit 0
fi
exit 2
`, { mode: 0o755 });
  const pluginEnv = { ...env, PATH: `${bin}:${env.PATH}` };

  const path = parseJsonStdout(runCli(["plugin", "path", "--json"], cwd, pluginEnv));
  assert.equal(path.pluginDir.endsWith("plugin"), true);
  assert.equal((await readFile(join(path.pluginDir, "plugin.json"), "utf8")).includes("\"mcpServers\""), true);
  assert.equal((await readFile(join(path.pluginDir, "hooks.json"), "utf8")).includes("arc hook copilot UserPromptSubmit"), true);
  assert.equal((await readFile(join(path.pluginDir, ".mcp.json"), "utf8")).includes("arc_search"), true);

  const installed = parseJsonStdout(runCli(["plugin", "install", "--json"], cwd, pluginEnv));
  assert.equal(installed.installed, true);
  assert.match(installed.listOutput, /agent-run-cache/);
}));

test("plugin hook auto-activates a workspace and injects through the shared hook path", withCliCache(async ({ cwd, env }) => {
  const saved = await seedCliCapsule(cwd);
  const pluginEnv = { ...env, AGENT_RUN_CACHE_COPILOT_PLUGIN: "1" };

  const result = parseJsonStdout(runCli(["hook", "copilot", "UserPromptSubmit"], cwd, pluginEnv, {
    sessionId: "plugin-hook-session",
    cwd,
    prompt: "checking CLI JSON output"
  }));

  assert.match(result.additionalContext, /Inspect CLI JSON output/);
  assert.match(result.modifiedPrompt, /User task:/);
  const activation = JSON.parse(await readFile(join(cwd, ".agent-run-cache", "enabled.json"), "utf8"));
  assert.equal(activation.integration, "copilot-plugin");
  const events = parseJsonStdout(runCli(["events", "--json"], cwd, env));
  assert.equal(events.events[0].type, "capsule.injected");
  assert.equal(events.events[0].capsuleId, saved.id);
}));

test("MCP server exposes read-only ARC tools over stdio JSON-RPC", withCliCache(async ({ cwd, env }) => {
  const saved = await seedCliCapsule(cwd);
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "arc_search", arguments: { query: "checking CLI JSON output", limit: 3 } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "arc_capsule", arguments: { id: saved.id.slice(0, 8) } } }
  ].map((item) => JSON.stringify(item)).join("\n");
  const result = runCliRaw(["mcp"], cwd, env, input);
  const responses = result.stdout.trim().split(/\n/).map((line) => JSON.parse(line));

  assert.equal(responses[0].result.serverInfo.name, "arc");
  assert.equal(responses[1].result.tools.some((tool) => tool.name === "arc_search"), true);
  assert.match(responses[2].result.content[0].text, /Inspect CLI JSON output/);
  assert.match(responses[3].result.content[0].text, new RegExp(saved.id));
}));

test("MCP server launched from Copilot's installed plugin directory uses the active hook workspace", withCliCache(async ({ cwd, env }) => {
  await seedCliCapsule(cwd);
  const pluginEnv = { ...env, AGENT_RUN_CACHE_COPILOT_PLUGIN: "1" };
  parseJsonStdout(runCli(["hook", "copilot", "SessionStart"], cwd, pluginEnv, {
    sessionId: "plugin-mcp-workspace-session",
    cwd
  }));

  const pluginCwd = join(cwd, ".copilot", "installed-plugins", "_direct", "plugin");
  await mkdir(pluginCwd, { recursive: true });
  const input = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "arc_search", arguments: { query: "checking CLI JSON output", limit: 3 } } }
  ].map((item) => JSON.stringify(item)).join("\n");
  const result = runCliRaw(["mcp"], pluginCwd, env, input);
  const responses = result.stdout.trim().split(/\n/).map((line) => JSON.parse(line));

  assert.match(responses[1].result.content[0].text, new RegExp(escapeRegExp(cwd)));
  assert.match(responses[1].result.content[0].text, /Inspect CLI JSON output/);
}));

test("setup installs the Copilot plugin compatibility path and doctor reports plugin state", withCliCache(async ({ cwd, env }) => {
  const bin = join(cwd, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "arc"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(bin, "copilot"), `#!/bin/sh
if [ "$1" = "plugin" ] && [ "$2" = "install" ]; then
  test -f "$3/plugin.json" || exit 3
  echo "installed agent-run-cache"
  exit 0
fi
if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then
  echo "agent-run-cache 2.1.0 enabled"
  exit 0
fi
exit 2
`, { mode: 0o755 });
  const sidecarCopilotCommand = "ollama launch copilot --model gemma4:31b-cloud --";
  const setupEnv = {
    ...env,
    PATH: `${bin}:${env.PATH}`
  };

  const setup = parseJsonStdout(runCli(["setup", "--json", "--sidecar-copilot-command", sidecarCopilotCommand], cwd, setupEnv));
  assert.equal(setup.integration, null);
  assert.match(setup.integrationReason, /auto-activates/);
  assert.equal(setup.plugin.installed, true);
  assert.equal(setup.plugin.pluginDir.endsWith("plugin"), true);
  assert.equal(setup.sidecarCopilotCommand, sidecarCopilotCommand);
  assert.equal(setup.runtime.entrypoint.endsWith("dist/cli.js"), true);
  assert.equal(setup.extension.installed, false);
  assert.equal(setup.legacyHook.installed, false);

  const saved = await seedCliCapsule(cwd);
  await recordMemoryEvent({
    type: "capsule.injected",
    workspace: cwd,
    sessionId: "doctor-session",
    capsuleId: saved.id,
    details: { title: saved.title }
  });

  const freshShellEnv = { ...setupEnv };
  delete freshShellEnv.AGENT_RUN_CACHE_SIDECAR_COPILOT_COMMAND;
  const judgeSet = parseJsonStdout(runCli(["judge", "set", "--json", "--mode", "provider-judge", "--model", "ollama:gemma4:31b-cloud"], cwd, freshShellEnv));
  assert.equal(judgeSet.config.sidecarCopilotCommand, sidecarCopilotCommand);
  assert.equal(judgeSet.config.injectionJudgeMode, "provider-judge");
  const doctor = parseJsonStdout(runCli(["doctor", "--json"], cwd, freshShellEnv));
  assert.equal(doctor.plugin.installed, true);
  assert.equal(doctor.extension.installed, false);
  assert.equal(doctor.integration, null);
  assert.equal(doctor.hook.installed, false);
  assert.equal(doctor.sidecarCopilotCommand, sidecarCopilotCommand);
  assert.equal(doctor.capsuleCount, 1);
  assert.equal(doctor.lastInjection.capsuleId, saved.id);
  assert.equal(doctor.lastSave.type, "capsule.created");
}));

test("Copilot hook no-ops before repo activation", withCliCache(async ({ cwd, env }) => {
  const result = runCli(["hook", "copilot", "UserPromptSubmit"], cwd, env, {
    sessionId: "inactive-hook-session",
    cwd,
    prompt: "checking CLI JSON output"
  });
  assert.deepEqual(parseJsonStdout(result), {});

  const events = parseJsonStdout(runCli(["events", "--json"], cwd, env));
  assert.equal(events.events.length, 0);
}));

test("SDK extension prompt hook injects a recalled note and records the event", withCliCache(async ({ cwd, env }) => {
  const fakeCopilotRoot = join(cwd, "fake-capable-copilot");
  await mkdir(fakeCopilotRoot, { recursive: true });
  await writeFile(join(fakeCopilotRoot, "app.js"), copilotExtensionCapableAppFixture(), "utf8");
  const install = parseJsonStdout(runCli(["sdk-extension", "install", "--json"], cwd, { ...env, AGENT_RUN_CACHE_COPILOT_ROOT: fakeCopilotRoot }));
  assert.equal(install.extension.installed, true);
  assert.match((await readFile(install.install.projectExtensionPath, "utf8")), /agent-run-cache\/copilot-sdk-extension\/v1/);
  const saved = await seedCliCapsule(cwd);
  const result = runCli(["extension", "hook", "user-prompt"], cwd, env, {
    input: {
      sessionId: "sdk-hook-session",
      cwd,
      prompt: "checking CLI JSON output"
    },
    invocation: {
      sessionId: "sdk-hook-session"
    },
    capabilities: {
      ui: { elicitation: true }
    }
  });
  const output = parseJsonStdout(result);

  assert.equal(typeof output.hookResult.additionalContext, "string");
  assert.equal(output.hookResult.additionalContext.includes("ARC recalled: Inspect CLI JSON output"), true);
  assert.equal(output.hookResult.modifiedPrompt.includes("User task:\nchecking CLI JSON output"), true);
  assert.equal(output.notice, "ARC recalled Inspect CLI JSON output");
  assert.equal(output.plan.capsuleId, saved.id);

  const duplicate = runCli(["extension", "hook", "user-prompt"], cwd, env, {
    input: {
      sessionId: "sdk-hook-session",
      cwd,
      prompt: "checking CLI JSON output"
    },
    invocation: {
      sessionId: "sdk-hook-session"
    },
    capabilities: {
      ui: { elicitation: true }
    }
  });
  assert.deepEqual(parseJsonStdout(duplicate), { hookResult: {} });

  const staleLegacyHook = runCli(["hook", "copilot", "UserPromptSubmit"], cwd, { ...env, AGENT_RUN_CACHE_COPILOT_ROOT: fakeCopilotRoot }, {
    sessionId: "legacy-hook-session",
    cwd,
    prompt: "checking CLI JSON output"
  });
  assert.deepEqual(parseJsonStdout(staleLegacyHook), {});

  const events = parseJsonStdout(runCli(["events", "--json"], cwd, env));
  const injected = events.events.filter((event) => event.type === "capsule.injected" && event.capsuleId === saved.id && event.sessionId === "sdk-hook-session");
  assert.equal(injected.length, 1);
}));

test("JSON hook and SDK extension cannot double inject the same Copilot prompt", withCliCache(async ({ cwd, env }) => {
  const fakeCopilotRoot = join(cwd, "fake-copilot");
  await mkdir(fakeCopilotRoot, { recursive: true });
  await writeFile(join(fakeCopilotRoot, "app.js"), copilotAppFixture(), "utf8");
  parseJsonStdout(runCli(["json-hooks", "install", "--json"], cwd, { ...env, AGENT_RUN_CACHE_COPILOT_ROOT: fakeCopilotRoot }));
  const saved = await seedCliCapsule(cwd);
  const input = {
    sessionId: "cross-surface-session",
    cwd,
    prompt: "checking CLI JSON output"
  };

  const jsonHook = parseJsonStdout(runCli(["hook", "copilot", "UserPromptSubmit"], cwd, env, input));
  assert.equal(typeof jsonHook.additionalContext, "string");

  const sdkHook = parseJsonStdout(runCli(["extension", "hook", "user-prompt"], cwd, env, {
    input,
    invocation: { sessionId: input.sessionId },
    capabilities: { ui: { elicitation: true } }
  }));
  assert.deepEqual(sdkHook.hookResult, {});
  assert.equal(sdkHook.plan.reason, "duplicate prompt injection invocation");

  const events = parseJsonStdout(runCli(["events", "--json"], cwd, env));
  const injected = events.events.filter((event) => event.type === "capsule.injected" && event.capsuleId === saved.id && event.sessionId === input.sessionId);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].details.surface, "json-hook");
}));

test("SDK active session marker makes JSON hooks yield to the extension", withCliCache(async ({ cwd, env }) => {
  const fakeCopilotRoot = join(cwd, "fake-copilot");
  await mkdir(fakeCopilotRoot, { recursive: true });
  await writeFile(join(fakeCopilotRoot, "app.js"), copilotAppFixture(), "utf8");
  parseJsonStdout(runCli(["json-hooks", "install", "--json"], cwd, { ...env, AGENT_RUN_CACHE_COPILOT_ROOT: fakeCopilotRoot }));
  const saved = await seedCliCapsule(cwd);
  const input = {
    sessionId: "sdk-primary-session",
    cwd,
    prompt: "checking CLI JSON output"
  };

  const loaded = parseJsonStdout(runCli(["extension", "loaded"], cwd, env, {
    sessionId: input.sessionId,
    input: { cwd },
    capabilities: { ui: { canvases: true } }
  }));
  assert.equal(loaded.active, true);

  const jsonHook = parseJsonStdout(runCli(["hook", "copilot", "UserPromptSubmit"], cwd, env, input));
  assert.deepEqual(jsonHook, {});

  const sdkHook = parseJsonStdout(runCli(["extension", "hook", "user-prompt"], cwd, env, {
    input,
    invocation: { sessionId: input.sessionId },
    capabilities: { ui: { elicitation: true, canvases: true } }
  }));
  assert.equal(typeof sdkHook.hookResult.additionalContext, "string");
  assert.equal(sdkHook.plan.capsuleId, saved.id);

  const events = parseJsonStdout(runCli(["events", "--json"], cwd, env));
  const injected = events.events.filter((event) => event.type === "capsule.injected" && event.capsuleId === saved.id && event.sessionId === input.sessionId);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].details.surface, "sdk-extension");
}));

test("judge config persists and records Gate-1 decisions without mutating capsule confidence", withCliCache(async ({ cwd, env }) => {
  const saved = await seedCliCapsule(cwd);
  const consult = join(cwd, "judge-consult.cjs");
  await writeFile(consult, `
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ applies: false, confidence: 0.91, reason: "judge abstained for regression test" }));
});
`, "utf8");

  const set = parseJsonStdout(runCli(["judge", "set", "--json", "--mode", "provider-judge", "--model", "ollama:gemma4:31b-cloud"], cwd, env));
  assert.equal(set.config.injectionJudgeMode, "provider-judge");
  assert.deepEqual(set.config.injectionJudgeModel, { provider: "ollama", id: "gemma4:31b-cloud" });

  const consultEnv = {
    ...env,
    AGENT_RUN_CACHE_CONSULT_COMMAND: `${process.execPath} ${consult}`
  };
  const plan = parseJsonStdout(runCli(["consult", "checking", "CLI", "JSON", "output"], cwd, consultEnv));
  assert.equal(plan.shouldInject, false);
  assert.equal(plan.source, "sidecar");
  assert.match(plan.reason, /judge abstained/);

  const decisions = parseJsonStdout(runCli(["judge", "decisions", "--json"], cwd, env));
  assert.equal(decisions.total, 1);
  assert.equal(decisions.decisions[0].mode, "provider-judge");
  assert.equal(decisions.decisions[0].model.provider, "ollama");
  assert.equal(decisions.decisions[0].verdict.abstain, true);
  assert.equal(decisions.decisions[0].candidates[0].capsuleId, saved.id);

  const reputation = parseJsonStdout(runCli(["judge", "reputation", "--json"], cwd, env));
  assert.equal(reputation.reputation[0].capsuleId, saved.id);
  const capsules = parseJsonStdout(runCli(["capsules", saved.id, "--json"], cwd, env));
  assert.equal(capsules.capsule.confidence, 0.9);
}));

test("provider judge does not log a Gate-1 abstain when embeddings are unavailable", withCliCache(async ({ cwd, env }) => {
  await seedCliCapsule(cwd);
  parseJsonStdout(runCli(["judge", "set", "--json", "--mode", "provider-judge", "--model", "ollama:gemma4:31b-cloud"], cwd, env));

  const plan = parseJsonStdout(runCli(["consult", "checking", "CLI", "JSON", "output"], cwd, env));
  assert.equal(plan.shouldInject, true);
  assert.equal(plan.source, "local");
  assert.equal(plan.judgeDecisionId, undefined);

  const decisions = parseJsonStdout(runCli(["judge", "decisions", "--json"], cwd, env));
  assert.equal(decisions.total, 0);
}));

test("judge outcome reconciliation updates Gate-1 log and reputation without mutating confidence", withCliCache(async ({ cwd, env }) => {
  const saved = await seedCliCapsule(cwd);
  const decision = await recordJudgeDecision({
    workspace: cwd,
    sessionId: "judge-outcome-session",
    prompt: "checking CLI JSON output",
    mode: "provider-judge",
    model: { provider: "ollama", id: "gemma4:31b-cloud" },
    candidates: [{ capsuleId: saved.id, score: 0.66, reputation: 1 }],
    verdict: { inject: saved.id, confidence: 0.9, reason: "judge accepted for regression test" },
    outcome: { injected: true, used: "unknown", helped: "unknown" }
  });
  const before = parseJsonStdout(runCli(["judge", "reputation", "--json"], cwd, env));
  assert.equal(before.reputation[0].capsuleId, saved.id);
  assert.ok(before.reputation[0].multiplier > 1);

  const updated = await recordJudgeOutcome({
    workspace: cwd,
    sessionId: "judge-outcome-session",
    decisionIds: [decision.id],
    injectedCapsuleIds: [saved.id],
    outcome: { injected: true, used: "no", helped: "no" },
    reason: "no typed tool evidence"
  });
  assert.equal(updated.length, 1);

  const decisions = parseJsonStdout(runCli(["judge", "decisions", "--json"], cwd, env));
  assert.equal(decisions.total, 1);
  assert.equal(decisions.decisions[0].id, decision.id);
  assert.deepEqual(decisions.decisions[0].outcome, { injected: true, used: "no", helped: "no" });
  assert.equal(decisions.decisions[0].outcomeReason, "no typed tool evidence");

  const after = parseJsonStdout(runCli(["judge", "reputation", "--json"], cwd, env));
  assert.equal(after.reputation[0].capsuleId, saved.id);
  assert.ok(after.reputation[0].multiplier < before.reputation[0].multiplier);

  const capsules = parseJsonStdout(runCli(["capsules", saved.id, "--json"], cwd, env));
  assert.equal(capsules.capsule.confidence, 0.9);
}));

test("judge outcome reconciliation does not update stale decisions by capsule alone", withCliCache(async ({ cwd, env }) => {
  const saved = await seedCliCapsule(cwd);
  await recordJudgeDecision({
    workspace: cwd,
    sessionId: "old-provider-session",
    prompt: "checking CLI JSON output",
    mode: "provider-judge",
    model: { provider: "ollama", id: "gemma4:31b-cloud" },
    candidates: [{ capsuleId: saved.id, score: 0.66, reputation: 1 }],
    verdict: { inject: saved.id, confidence: 0.9, reason: "old judge accepted" },
    outcome: { injected: true, used: "unknown", helped: "unknown" }
  });

  const updated = await recordJudgeOutcome({
    workspace: cwd,
    sessionId: "embedding-only-session",
    injectedCapsuleIds: [saved.id],
    outcome: { injected: true, used: "no", helped: "no" },
    reason: "embedding-only run had no judge decision"
  });
  assert.equal(updated.length, 0);

  const decisions = parseJsonStdout(runCli(["judge", "decisions", "--json"], cwd, env));
  assert.equal(decisions.total, 1);
  assert.deepEqual(decisions.decisions[0].outcome, { injected: true, used: "unknown", helped: "unknown" });
}));

function withCliCache(fn) {
  return async () => {
    const cwd = await realpath(await mkdtemp(join(tmpdir(), "arc-cli-json-")));
    const env = {
      ...process.env,
      AGENT_RUN_CACHE_DIR: join(cwd, ".agent-run-cache"),
      AGENT_RUN_CACHE_HOME: join(cwd, "arc-home"),
      COPILOT_HOME: join(cwd, "copilot-home"),
      AGENT_RUN_CACHE_MODEL_SIDECAR: "off",
      AGENT_RUN_CACHE_LOCAL_OBSERVER: "off",
      AGENT_RUN_CACHE_LOCAL_EMBEDDINGS: "off",
      AGENT_RUN_CACHE_SKIP_COPILOT_TAB_SETUP: "1"
    };
    try {
      await fn({ cwd, env });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };
}

async function seedCliCapsule(cwd) {
  const saved = await saveCapsule({
    id: "cli-json-capsule",
    runner: "codex",
    workspace: cwd,
    sourceSessionId: "cli-json-session",
    kind: "workflow",
    mergeKey: "cli-json.test-capsule",
    reusable: true,
    confidence: 0.9,
    title: "Inspect CLI JSON output",
    summary: "Use the CLI JSON commands to inspect local ARC state.",
    reuseWhen: ["checking CLI JSON output"],
    doNotReuseWhen: [],
    evidence: ["The CLI emitted valid JSON."],
    provenance: ["test"],
    nextRunInstruction: "Run arc status --json and arc capsules --json before building a thin client.",
    workflow: {
      purpose: "Inspect ARC through server-free CLI JSON.",
      parameters: ["workspace"],
      bindingSources: ["test"],
      steps: ["Run status JSON.", "Run capsules JSON."],
      commands: ["arc status --json", "arc capsules --json"],
      successCriteria: ["Both commands emit parseable JSON."],
      failedAttempts: [],
      validationProbe: ["node -e 'JSON.parse(input)'"]
    }
  }, cwd);
  assert.ok(saved);
  return saved;
}

function runCli(args, cwd, env, input) {
  const result = runCliRaw(args, cwd, env, input === undefined ? undefined : JSON.stringify(input));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result;
}

function runCliRaw(args, cwd, env, input) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env,
    input,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return result;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function copilotAppFixture() {
  return 'var Tbn=[{value:"copilot",label:"Session"},{value:"agents",label:"Agents"},{value:"issues",label:"Issues"},{value:"pull-requests",label:"Pull requests"},{value:"gists",label:"Gists"}],beo=Tbn.filter(t=>t.value!=="issues"&&t.value!=="pull-requests");var cz=Ne(Ve(),1),Hf=({children:t})=>cz.default.createElement(cz.default.Fragment,null,t),Y_n=({activeView:t,defaultRoute:e,children:n})=>{let r=null,o=null;return cz.default.Children.forEach(n,s=>{!cz.default.isValidElement(s)||s.type!==Hf||(s.props.view===e&&(o??=s),!r&&s.props.view===t&&(r=s))}),cz.default.createElement(cz.default.Fragment,null,r??o)};var v0=Ne(Ve(),1);let UE=(0,oe.useCallback)(q=>{switch(q){case"copilot":Ni("main",{replace:!0});return;case"agents":Ni("agents",{replace:!0});return;case"pull-requests":Ni("pull-requests",{replace:!0});return;case"issues":Ni("issues",{replace:!0});return;case"gists":Ni("gists",{replace:!0});return}},[Ni,Ee]);oe.default.createElement(Y_n,{activeView:$a,defaultRoute:"main"},oe.default.createElement(Hf,{view:"main"},oe.default.createElement(cCn,{})),Jg(Ee)&&oe.default.createElement(Hf,{view:"agents"},oe.default.createElement(ort,{})),oe.default.createElement(Hf,{view:"gists"},oe.default.createElement(qot,{})))';
}

function copilotExtensionCapableAppFixture() {
  return [
    copilotAppFixture(),
    'const ext="extension_bootstrap.mjs extensionDiscoverAll .github/extensions";',
    'const flags={EXTENSIONS:{availability:"on",capiSanity:false}};',
    'function BV(t){return t.extensions?.mode??"load_and_augment"}',
    'const canvas="list_canvas_capabilities open_canvas invoke_canvas_action";'
  ].join("\n");
}

function parseJsonStdout(result) {
  assert.equal(result.stdout.trim().startsWith("{"), true, result.stdout);
  return JSON.parse(result.stdout);
}
