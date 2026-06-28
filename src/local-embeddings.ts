import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { totalmem } from "node:os";
import { join } from "node:path";

import { downloadFile } from "./download.js";
import { modelsDir, runtimeDir } from "./paths.js";
import { debug } from "./store.js";

// ARC keeps one managed local process in the default product path: a small
// embedding model for conservative retrieval and abstention. Capsule synthesis
// and ambiguous decisions stay with the deterministic observer plus the user's
// configured reviewer/agent.

const LLAMA_RELEASE = process.env.AGENT_RUN_CACHE_LLAMA_RELEASE ?? "b9585";
const EMBEDDING_MODEL_FILE = process.env.AGENT_RUN_CACHE_EMBEDDING_MODEL_FILE ?? "nomic-embed-text-v1.5.f16.gguf";
const EMBEDDING_MODEL_URL = process.env.AGENT_RUN_CACHE_EMBEDDING_MODEL_URL
  ?? `https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/${EMBEDDING_MODEL_FILE}`;
export const LOCAL_EMBEDDING_MODEL_NAME = "nomic-embed-text-v1.5";

export type LocalEmbeddingState =
  | "idle"
  | "downloading-runtime"
  | "downloading-model"
  | "starting"
  | "ready"
  | "stopped"
  | "error";

export interface LocalEmbeddingInfo {
  state: LocalEmbeddingState;
  detail: string;
  endpoint: string | null;
  model: string;
  progressPercent?: number;
}

let embeddingState: LocalEmbeddingState = "idle";
let embeddingDetail = "local embedding model not started";
let embeddingEndpoint: string | null = null;
let embeddingProgressPercent: number | undefined;
let embeddingChild: ChildProcess | null = null;
let embeddingStopping = false;
let ensureEmbeddingPromise: Promise<LocalEmbeddingInfo> | null = null;
let embeddingExitCleanupInstalled = false;

export function localEmbeddingInfo(): LocalEmbeddingInfo {
  const override = embeddingEndpointOverride();
  if (override) {
    return { state: "ready", detail: "local embedding endpoint override", endpoint: override, model: LOCAL_EMBEDDING_MODEL_NAME };
  }
  return {
    state: embeddingState,
    detail: embeddingDetail,
    endpoint: embeddingEndpoint,
    model: LOCAL_EMBEDDING_MODEL_NAME,
    progressPercent: embeddingProgressPercent
  };
}

// The embedder is the lean cache's retrieval index. It is on by default and can
// be disabled with AGENT_RUN_CACHE_LOCAL_EMBEDDINGS=off.
export function localEmbeddingsWanted(): boolean {
  if (embeddingEndpointOverride()) return true;
  const setting = (process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDINGS ?? process.env.AGENT_RUN_CACHE_EMBEDDINGS ?? "auto").trim().toLowerCase();
  if (setting === "off") return false;
  return totalmem() >= minTotalMemoryBytes();
}

export async function ensureLocalEmbeddings(workspace: string): Promise<LocalEmbeddingInfo> {
  if (!localEmbeddingsWanted()) {
    if (embeddingState === "idle") embeddingDetail = "managed local embeddings disabled for this configuration";
    return localEmbeddingInfo();
  }
  if (embeddingEndpointOverride()) return localEmbeddingInfo();
  if (embeddingState === "ready" && embeddingEndpoint) return localEmbeddingInfo();
  if (ensureEmbeddingPromise) return ensureEmbeddingPromise;
  embeddingStopping = false;
  ensureEmbeddingPromise = ensureEmbeddingsUnlocked(workspace)
    .catch(async (error) => {
      setEmbeddingState("error", `local embeddings unavailable: ${truncateError(error)}`);
      await debug("local_embeddings.start_failed", { error: String(error) }, workspace);
      return localEmbeddingInfo();
    })
    .finally(() => {
      ensureEmbeddingPromise = null;
    });
  return ensureEmbeddingPromise;
}

export function stopLocalEmbeddings(): void {
  embeddingStopping = true;
  const current = embeddingChild;
  embeddingChild = null;
  embeddingEndpoint = null;
  if (current) {
    current.kill("SIGTERM");
    setEmbeddingState("stopped", "local embedding model stopped");
  }
}

export async function embedTexts(texts: string[], workspace: string): Promise<number[][] | null> {
  const input = texts.map((text) => text.trim()).filter(Boolean);
  if (!input.length) return [];
  const info = localEmbeddingInfo();
  let baseUrl = info.state === "ready" ? info.endpoint : null;
  const setting = (process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDINGS ?? process.env.AGENT_RUN_CACHE_EMBEDDINGS ?? "auto").trim().toLowerCase();
  if (!baseUrl && setting === "on") {
    const started = await ensureLocalEmbeddings(workspace);
    baseUrl = started.state === "ready" ? started.endpoint : null;
  }
  if (!baseUrl) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), embeddingTimeoutMs());
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: LOCAL_EMBEDDING_MODEL_NAME, input }),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`embedding endpoint failed with ${response.status}: ${text.slice(0, 500)}`);
    }
    const json = await response.json() as { data?: { embedding?: unknown }[] };
    const vectors = (json.data ?? []).map((item) => Array.isArray(item.embedding)
      ? item.embedding.map((value) => Number(value)).filter((value) => Number.isFinite(value))
      : []
    );
    if (vectors.length !== input.length || vectors.some((vector) => !vector.length)) {
      throw new Error("embedding endpoint returned incomplete vectors");
    }
    return vectors;
  } catch (error) {
    await debug("local_embeddings.embed_failed", { error: String(error), count: input.length }, workspace);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureEmbeddingsUnlocked(workspace: string): Promise<LocalEmbeddingInfo> {
  const binary = await ensureRuntimeBinary(workspace);
  const model = await ensureWeights(workspace, EMBEDDING_MODEL_FILE, EMBEDDING_MODEL_URL, LOCAL_EMBEDDING_MODEL_NAME, (percent) => {
    embeddingProgressPercent = percent;
    embeddingDetail = `downloading ${LOCAL_EMBEDDING_MODEL_NAME} (${percent}%)`;
  });
  await startEmbeddingServer(binary, model, workspace);
  return localEmbeddingInfo();
}

async function ensureRuntimeBinary(workspace: string): Promise<string> {
  const releaseDir = join(runtimeDir(), `llama-${LLAMA_RELEASE}`);
  const existing = findLlamaServer(releaseDir);
  if (existing) return existing;
  setEmbeddingState("downloading-runtime", `downloading llama.cpp ${LLAMA_RELEASE}`);
  await debug("local_embeddings.runtime_download_started", { release: LLAMA_RELEASE }, workspace);
  mkdirSync(releaseDir, { recursive: true });
  const asset = platformAsset();
  const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_RELEASE}/${asset}`;
  const archive = join(releaseDir, asset);
  await downloadFile(url, archive);
  const extract = spawnSync("tar", ["-xf", archive, "-C", releaseDir], { encoding: "utf8" });
  if (extract.status !== 0) throw new Error(`failed to extract ${asset}: ${extract.stderr?.slice(-500)}`);
  rmSync(archive, { force: true });
  const binary = findLlamaServer(releaseDir);
  if (!binary) throw new Error(`llama-server not found in extracted ${asset}`);
  await debug("local_embeddings.runtime_download_completed", { release: LLAMA_RELEASE, binary }, workspace);
  return binary;
}

async function ensureWeights(
  workspace: string,
  file: string,
  url: string,
  label: string,
  onProgress: (percent: number) => void
): Promise<string> {
  const target = join(modelsDir(), file);
  if (existsSync(target) && statSync(target).size > 0) return target;
  setEmbeddingState("downloading-model", `downloading ${label} (0%)`);
  await debug("local_embeddings.model_download_started", { url }, workspace);
  mkdirSync(modelsDir(), { recursive: true });
  let lastLogged = 0;
  await downloadFile(url, target, {
    onPercent: (percent) => {
      onProgress(percent);
      if (percent >= lastLogged + 20) {
        lastLogged = percent;
        void debug("local_embeddings.model_download_progress", { percent }, workspace);
      }
    }
  });
  embeddingProgressPercent = undefined;
  await debug("local_embeddings.model_download_completed", { path: target }, workspace);
  return target;
}

async function startEmbeddingServer(binary: string, modelPath: string, workspace: string): Promise<void> {
  setEmbeddingState("starting", `loading ${LOCAL_EMBEDDING_MODEL_NAME}`);
  const port = await freePort();
  const startedAt = Date.now();
  const args = [
    "--model", modelPath,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--ctx-size", "8192",
    "-ngl", "99",
    "--no-webui",
    "--embedding"
  ];
  const server = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], env: process.env });
  installEmbeddingExitCleanup();
  let stderrTail = "";
  server.stderr?.on("data", (chunk) => {
    stderrTail = (stderrTail + Buffer.from(chunk).toString("utf8")).slice(-4000);
  });
  embeddingChild = server;
  server.on("exit", (code) => {
    if (embeddingChild === server) embeddingChild = null;
    const wasReady = embeddingState === "ready";
    if (!embeddingStopping) {
      embeddingEndpoint = null;
      setEmbeddingState("error", `local embedding server exited with ${code ?? 0}`);
      void debug("local_embeddings.exited", { code, wasReady, stderr: stderrTail.slice(-1000) }, workspace);
    }
  });
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const healthy = await waitForHealth(`http://127.0.0.1:${port}/health`, server);
  if (!healthy) {
    server.kill("SIGTERM");
    throw new Error(`llama-server did not become healthy: ${stderrTail.slice(-500)}`);
  }
  embeddingEndpoint = baseUrl;
  setEmbeddingState("ready", `${LOCAL_EMBEDDING_MODEL_NAME} ready`);
  server.unref();
  const stderr = server.stderr as (NodeJS.ReadableStream & { unref?: () => void }) | null;
  stderr?.unref?.();
  await debug("local_embeddings.started", { port, loadMs: Date.now() - startedAt, binary }, workspace);
}

function installEmbeddingExitCleanup(): void {
  if (embeddingExitCleanupInstalled) return;
  embeddingExitCleanupInstalled = true;
  process.once("beforeExit", () => {
    stopLocalEmbeddings();
  });
  process.once("exit", () => {
    embeddingChild?.kill("SIGTERM");
  });
}

async function waitForHealth(url: string, server: ChildProcess): Promise<boolean> {
  const deadline = Date.now() + startupTimeoutMs();
  while (Date.now() < deadline) {
    if (server.exitCode !== null) return false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      const response = await fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
      if (response.ok) return true;
    } catch {
      // server still loading
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function findLlamaServer(dir: string): string | null {
  if (!existsSync(dir)) return null;
  const name = process.platform === "win32" ? "llama-server.exe" : "llama-server";
  const queue = [dir];
  while (queue.length) {
    const current = queue.shift() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.name === name) return path;
    }
  }
  return null;
}

function platformAsset(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") return `llama-${LLAMA_RELEASE}-bin-macos-${arch}.tar.gz`;
  if (process.platform === "linux") return `llama-${LLAMA_RELEASE}-bin-ubuntu-${arch}.tar.gz`;
  if (process.platform === "win32") return `llama-${LLAMA_RELEASE}-bin-win-cpu-${arch}.zip`;
  throw new Error(`no prebuilt llama.cpp asset for platform ${process.platform}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("could not allocate a local port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function startupTimeoutMs(): number {
  const value = Number(process.env.AGENT_RUN_CACHE_EMBEDDING_STARTUP_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}

function minTotalMemoryBytes(): number {
  const gb = Number(process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDINGS_MIN_TOTAL_MEM_GB ?? process.env.AGENT_RUN_CACHE_EMBEDDING_MIN_TOTAL_MEM_GB ?? 8);
  const value = Number.isFinite(gb) && gb > 0 ? gb : 8;
  return value * 1024 * 1024 * 1024;
}

function embeddingTimeoutMs(): number {
  const value = Number(process.env.AGENT_RUN_CACHE_EMBEDDING_TIMEOUT_MS ?? 15_000);
  return Number.isFinite(value) && value > 0 ? value : 15_000;
}

function embeddingEndpointOverride(): string {
  return (process.env.AGENT_RUN_CACHE_EMBEDDING_ENDPOINT ?? process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDING_ENDPOINT ?? "").trim();
}

function setEmbeddingState(next: LocalEmbeddingState, nextDetail: string): void {
  embeddingState = next;
  embeddingDetail = nextDetail;
}

function truncateError(error: unknown): string {
  return String(error).slice(0, 300);
}
