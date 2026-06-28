import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export interface JudgeModelInfo {
  provider: "copilot" | "ollama";
  id: string;
  name: string;
  judgeCapable: boolean;
  reason?: string;
  costHint?: string;
  sizeHint?: string;
  raw?: unknown;
}

export interface JudgeModelList {
  generatedAt: string;
  models: JudgeModelInfo[];
  errors: Record<string, string>;
}

export async function listJudgeModels(): Promise<JudgeModelList> {
  const errors: Record<string, string> = {};
  const [copilot, ollama] = await Promise.all([
    listCopilotModels().catch((error) => {
      errors.copilot = error instanceof Error ? error.message : String(error);
      return [] as JudgeModelInfo[];
    }),
    listOllamaModels().catch((error) => {
      errors.ollama = error instanceof Error ? error.message : String(error);
      return [] as JudgeModelInfo[];
    })
  ]);
  return {
    generatedAt: new Date().toISOString(),
    models: [...copilot, ...ollama].filter((model) => model.judgeCapable),
    errors
  };
}

async function listCopilotModels(): Promise<JudgeModelInfo[]> {
  const sdk = await importCopilotSdk();
  const Client = (sdk as { CopilotClient?: new (options?: Record<string, unknown>) => {
    connect?: () => Promise<void> | void;
    start?: () => Promise<void> | void;
    listModels: () => Promise<unknown[]>;
    disconnect?: () => Promise<void> | void;
    stop?: () => Promise<void> | void;
  } }).CopilotClient;
  if (!Client) throw new Error("CopilotClient export not found");
  const client = new Client({ autoStart: true });
  try {
    await withTimeout(Promise.resolve(client.connect ? client.connect() : client.start?.()), 12_000, "Copilot SDK connect timed out");
    const models = await withTimeout(client.listModels(), 12_000, "Copilot model listing timed out");
    return models.map((model) => copilotJudgeModel(model)).filter(Boolean) as JudgeModelInfo[];
  } finally {
    await (client.disconnect ? client.disconnect() : client.stop?.());
  }
}

async function listOllamaModels(): Promise<JudgeModelInfo[]> {
  const base = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${base}/api/tags`, { signal: controller.signal });
    if (!response.ok) throw new Error(`Ollama /api/tags returned ${response.status}`);
    const payload = await response.json() as { models?: unknown[] };
    return (payload.models ?? []).map((model) => ollamaJudgeModel(model)).filter(Boolean) as JudgeModelInfo[];
  } finally {
    clearTimeout(timer);
  }
}

async function importCopilotSdk(): Promise<unknown> {
  for (const candidate of copilotSdkCandidates()) {
    if (!existsSync(candidate)) continue;
    const sdk = await import(pathToFileURL(candidate).href);
    if (hasCopilotClient(sdk)) return sdk;
  }
  const direct = await importByName("@github/copilot/sdk").catch(() => null);
  if (hasCopilotClient(direct)) return direct;
  throw new Error("Could not resolve @github/copilot/sdk from local install");
}

function importByName(specifier: string): Promise<unknown> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (value: string) => Promise<unknown>;
  return dynamicImport(specifier);
}

function copilotSdkCandidates(): string[] {
  const candidates = new Set<string>();
  const explicit = process.env.AGENT_RUN_CACHE_COPILOT_SDK_PATH;
  if (explicit) candidates.add(explicit);
  const prefix = dirname(dirname(process.execPath));
  candidates.add(join(prefix, "lib", "node_modules", "@github", "copilot", "copilot-sdk", "index.js"));
  candidates.add(join(prefix, "lib", "node_modules", "@github", "copilot", "sdk", "index.js"));
  const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (npmRoot.status === 0) {
    candidates.add(join(npmRoot.stdout.trim(), "@github", "copilot", "copilot-sdk", "index.js"));
    candidates.add(join(npmRoot.stdout.trim(), "@github", "copilot", "sdk", "index.js"));
  }
  try {
    const require = createRequire(import.meta.url);
    candidates.add(require.resolve("@github/copilot/sdk"));
  } catch {
    // Best-effort only; Copilot's SDK is host-provided.
  }
  return [...candidates];
}

function hasCopilotClient(value: unknown): boolean {
  return !!value && typeof value === "object" && typeof (value as { CopilotClient?: unknown }).CopilotClient === "function";
}

function copilotJudgeModel(value: unknown): JudgeModelInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) return null;
  const name = typeof record.name === "string" ? record.name : id;
  const capabilities = record.capabilities && typeof record.capabilities === "object" ? record.capabilities as Record<string, unknown> : {};
  const limits = capabilities.limits && typeof capabilities.limits === "object" ? capabilities.limits as Record<string, unknown> : {};
  const billing = record.billing && typeof record.billing === "object" ? record.billing as Record<string, unknown> : {};
  return {
    provider: "copilot",
    id,
    name,
    judgeCapable: id !== "auto" && !looksLikeEmbedder(id) && !disabledByPolicy(record),
    reason: id === "auto" ? "model router, not a concrete judge" : disabledByPolicy(record) ? "disabled by Copilot model policy" : undefined,
    costHint: typeof billing.multiplier === "number"
      ? `${billing.multiplier}x`
      : typeof record.modelPickerPriceCategory === "string"
      ? record.modelPickerPriceCategory
      : undefined,
    sizeHint: typeof limits.max_context_window_tokens === "number" ? `${limits.max_context_window_tokens} context` : undefined,
    raw: value
  };
}

function ollamaJudgeModel(value: unknown): JudgeModelInfo | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.name === "string" ? record.name : typeof record.model === "string" ? record.model : "";
  if (!id) return null;
  return {
    provider: "ollama",
    id,
    name: id,
    judgeCapable: !looksLikeEmbedder(id),
    reason: looksLikeEmbedder(id) ? "embedding model" : undefined,
    sizeHint: sizeHint(id),
    raw: value
  };
}

function looksLikeEmbedder(id: string): boolean {
  return /\b(?:embed|embedding|nomic-embed|bge|e5|gte)\b/i.test(id);
}

function disabledByPolicy(record: Record<string, unknown>): boolean {
  const policy = record.policy && typeof record.policy === "object" ? record.policy as Record<string, unknown> : {};
  return policy.state === "disabled";
}

function sizeHint(id: string): string | undefined {
  const match = id.match(/(?:^|:|[-_])(\d+(?:\.\d+)?b)(?:$|[-_])/i);
  return match?.[1]?.toLowerCase();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
