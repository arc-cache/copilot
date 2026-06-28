#!/usr/bin/env node
const assert = require("node:assert/strict");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const root = resolve(__dirname, "..");
const arc = resolveArcBinary();
const temp = mkdtempSync(join(tmpdir(), "arc-rust-embeddings-"));
const workspace = join(temp, "workspace");
const cache = join(workspace, ".agent-run-cache");
const runtimeDir = join(temp, "runtime");
const modelsDir = join(temp, "models");

mkdirSync(cache, { recursive: true });
mkdirSync(runtimeDir, { recursive: true });
mkdirSync(modelsDir, { recursive: true });

writeFileSync(join(cache, "memory.jsonl"), `${JSON.stringify(seedCapsule(workspace))}\n`);

const result = spawnSync(arc, ["probe", "checking CLI JSON output", "--json"], {
  cwd: workspace,
  encoding: "utf8",
  env: {
    ...process.env,
    AGENT_RUN_CACHE_LOCAL_EMBEDDINGS: "on",
    AGENT_RUN_CACHE_RUNTIME_DIR: runtimeDir,
    AGENT_RUN_CACHE_MODELS_DIR: modelsDir,
    AGENT_RUN_CACHE_DOWNLOAD_STALL_TIMEOUT_MS: process.env.AGENT_RUN_CACHE_DOWNLOAD_STALL_TIMEOUT_MS ?? "600000",
    AGENT_RUN_CACHE_EMBEDDING_STARTUP_TIMEOUT_MS: process.env.AGENT_RUN_CACHE_EMBEDDING_STARTUP_TIMEOUT_MS ?? "300000",
    AGENT_RUN_CACHE_EMBEDDING_ENDPOINT: "",
    AGENT_RUN_CACHE_LOCAL_EMBEDDING_ENDPOINT: ""
  },
  maxBuffer: 32 * 1024 * 1024
});

if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.stderr.write(result.stdout);
  process.exit(result.status ?? 1);
}

const probe = JSON.parse(result.stdout);
assert.equal(probe.shouldInject, true);
assert.equal(probe.capsule.id, "rust-live-embed-capsule");
assert.equal(probe.source, "local");
assert.match(probe.reason, /^embedding matched capsule rust-live-embed-capsule at /);

const debug = readFileSync(join(cache, "debug", "runtime.jsonl"), "utf8");
assert.match(debug, /local_embeddings\.runtime_download_(started|completed)/);
assert.match(debug, /local_embeddings\.model_download_(started|completed)/);
assert.match(debug, /local_embeddings\.started/);

const modelPath = join(modelsDir, "nomic-embed-text-v1.5.f16.gguf");
assert.equal(existsSync(modelPath), true);

process.stdout.write(`${JSON.stringify({
  ok: true,
  arc,
  workspace,
  runtimeDir,
  modelsDir,
  modelBytes: require("node:fs").statSync(modelPath).size,
  reason: probe.reason
}, null, 2)}\n`);

function resolveArcBinary() {
  if (process.env.ARC_BIN) return resolve(process.env.ARC_BIN);
  const packageBin = join(root, "bin", process.platform === "win32" ? "arc.exe" : "arc");
  if (existsSync(packageBin) && !looksLikePlaceholder(packageBin)) return packageBin;
  const releaseBin = join(root, "target", "release", process.platform === "win32" ? "arc.exe" : "arc");
  if (existsSync(releaseBin)) return releaseBin;
  return packageBin;
}

function looksLikePlaceholder(path) {
  try {
    return readFileSync(path, "utf8").includes("ARC Rust binary is not installed");
  } catch {
    return false;
  }
}

function seedCapsule(workspace) {
  return {
    id: "rust-live-embed-capsule",
    runner: "copilot",
    workspace,
    sourceSessionId: "rust-live-embed-seed",
    kind: "workflow",
    mergeKey: "rust.live.embed.proof",
    reusable: true,
    confidence: 0.9,
    title: "Check CLI JSON output",
    summary: "Use ARC CLI JSON commands to inspect local ARC state.",
    reuseWhen: ["checking CLI JSON output", "inspect ARC status JSON"],
    doNotReuseWhen: [],
    evidence: ["Seed capsule for live Rust embedder verification."],
    provenance: ["scripts/verify-rust-local-embeddings.cjs"],
    artifactSources: [],
    supersedes: [],
    confidenceReason: "Seeded for verifying managed embeddings.",
    failureBoundary: [],
    validationProvenance: ["live Rust embedder probe"],
    nextRunInstruction: "Run arc status --json and arc capsules --json to inspect local ARC state.",
    workflow: {
      purpose: "Inspect ARC through server-free CLI JSON.",
      parameters: ["workspace"],
      bindingSources: ["README.md"],
      steps: ["Run status JSON.", "Run capsules JSON."],
      commands: ["arc status --json", "arc capsules --json"],
      successCriteria: ["Both commands emit parseable JSON."],
      failedAttempts: [],
      validationProbe: ["arc status --json"]
    }
  };
}
