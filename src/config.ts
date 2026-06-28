import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { arcHome } from "./paths.js";

export interface ArcConfig {
  version: 1;
  updatedAt?: string;
  sidecarCopilotCommand?: string;
  injectionJudgeMode?: "embedding-only" | "provider-judge";
  injectionJudgeModel?: {
    provider: "copilot" | "ollama";
    id: string;
  };
}

export function arcConfigPath(): string {
  return join(arcHome(), "config.json");
}

export async function loadArcConfig(): Promise<ArcConfig> {
  return parseConfig(existsSync(arcConfigPath()) ? await readFile(arcConfigPath(), "utf8") : "");
}

export function loadArcConfigSync(): ArcConfig {
  return parseConfig(existsSync(arcConfigPath()) ? readFileSync(arcConfigPath(), "utf8") : "");
}

export async function saveArcConfig(patch: Partial<Omit<ArcConfig, "version">>): Promise<ArcConfig> {
  const next: ArcConfig = {
    ...await loadArcConfig(),
    ...cleanPatch(patch),
    version: 1,
    updatedAt: new Date().toISOString()
  };
  await mkdir(dirname(arcConfigPath()), { recursive: true });
  await writeFile(arcConfigPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

function parseConfig(raw: string): ArcConfig {
  if (!raw.trim()) return { version: 1 };
  try {
    const value = JSON.parse(raw) as Partial<ArcConfig>;
    return {
      version: 1,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
      sidecarCopilotCommand: cleanString(value.sidecarCopilotCommand),
      injectionJudgeMode: cleanJudgeMode(value.injectionJudgeMode),
      injectionJudgeModel: cleanJudgeModel(value.injectionJudgeModel)
    };
  } catch {
    return { version: 1 };
  }
}

function cleanPatch(patch: Partial<Omit<ArcConfig, "version">>): Partial<Omit<ArcConfig, "version">> {
  const cleaned: Partial<Omit<ArcConfig, "version">> = {};
  if ("updatedAt" in patch) cleaned.updatedAt = cleanString(patch.updatedAt);
  if ("sidecarCopilotCommand" in patch) cleaned.sidecarCopilotCommand = cleanString(patch.sidecarCopilotCommand);
  if ("injectionJudgeMode" in patch) cleaned.injectionJudgeMode = cleanJudgeMode(patch.injectionJudgeMode);
  if ("injectionJudgeModel" in patch) cleaned.injectionJudgeModel = cleanJudgeModel(patch.injectionJudgeModel);
  return cleaned;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanJudgeMode(value: unknown): ArcConfig["injectionJudgeMode"] {
  if (value === "provider-judge") return "provider-judge";
  if (value === "embedding-only") return "embedding-only";
  return undefined;
}

function cleanJudgeModel(value: unknown): ArcConfig["injectionJudgeModel"] {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const provider = record.provider === "copilot" || record.provider === "ollama" ? record.provider : undefined;
  const id = cleanString(record.id);
  return provider && id ? { provider, id } : undefined;
}
