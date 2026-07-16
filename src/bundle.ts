import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { readJsonl, writeJsonl } from "./json.js";
import { cacheDir, debugPath, memoryEventsPath, memoryPath, reviewedPath, sidecarPath, workspaceRoot } from "./paths.js";
import { redactJson, redactSensitiveText } from "./redact.js";
import { sanitizedMetricsAggregate } from "./telemetry.js";

export interface DebugBundleResult {
  path: string;
  fileCount: number;
  traceCount: number;
}

export async function writeDebugBundle(outDir?: string, workspace = workspaceRoot()): Promise<DebugBundleResult> {
  const root = resolve(outDir ?? join(cacheDir(workspace), "debug-bundles", timestampName()));
  await mkdir(root, { recursive: true });
  const manifest: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    workspace: redactSensitiveText(workspace),
    cacheDir: redactSensitiveText(cacheDir(workspace)),
    files: []
  };
  let fileCount = 0;
  let traceCount = 0;

  for (const item of [
    { source: memoryPath(workspace), target: "memory.redacted.jsonl" },
    { source: memoryEventsPath(workspace), target: "memory-events.redacted.jsonl" },
    { source: reviewedPath(workspace), target: "reviewed.redacted.jsonl" },
    { source: debugPath(workspace), target: "runtime.redacted.jsonl" },
    { source: sidecarPath(workspace), target: "sidecar.redacted.jsonl" }
  ]) {
    if (!existsSync(item.source)) continue;
    await writeRedactedJsonl(item.source, join(root, item.target));
    (manifest.files as unknown[]).push(item.target);
    fileCount += 1;
  }

  await writeFile(join(root, "metrics.aggregate.redacted.json"), `${JSON.stringify(await sanitizedMetricsAggregate(workspace), null, 2)}\n`, "utf8");
  (manifest.files as unknown[]).push("metrics.aggregate.redacted.json");
  fileCount += 1;

  const traceRoot = join(cacheDir(workspace), "traces");
  const traceOut = join(root, "traces");
  if (existsSync(traceRoot)) {
    await mkdir(traceOut, { recursive: true });
    for (const name of await readdir(traceRoot)) {
      if (!name.endsWith(".jsonl")) continue;
      await writeRedactedJsonl(join(traceRoot, name), join(traceOut, `${basename(name, ".jsonl")}.redacted.jsonl`));
      traceCount += 1;
      fileCount += 1;
    }
  }

  const logRoot = join(cacheDir(workspace), "copilot-logs");
  if (existsSync(logRoot)) {
    const summaries = [];
    for (const file of await collectFiles(logRoot)) {
      if (!file.endsWith(".log")) continue;
      summaries.push(await summarizeCopilotLog(file, workspace));
    }
    if (summaries.length) {
      await writeJsonl(join(root, "copilot-log-summary.redacted.jsonl"), summaries);
      (manifest.files as unknown[]).push("copilot-log-summary.redacted.jsonl");
      fileCount += 1;
    }
  }

  manifest["traceCount"] = traceCount;
  manifest["fileCount"] = fileCount;
  await writeFile(join(root, "manifest.json"), `${JSON.stringify(redactJson(manifest), null, 2)}\n`, "utf8");
  return { path: root, fileCount: fileCount + 1, traceCount };
}

async function writeRedactedJsonl(source: string, target: string): Promise<void> {
  const records = await readJsonl<unknown>(source);
  await writeJsonl(target, records.map(redactJson));
  if (!records.length) {
    const text = await readFile(source, "utf8").catch(() => "");
    if (text) await writeFile(target, redactSensitiveText(text), "utf8");
  }
}

function timestampName(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function collectFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else files.push(path);
  }
  return files.sort();
}

async function summarizeCopilotLog(path: string, workspace: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, "utf8");
  const categories: Record<string, number> = {};
  const retainedSignals: string[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const category = logNoiseCategory(line);
    if (category) {
      categories[category] = (categories[category] ?? 0) + 1;
      continue;
    }
    if (/\b(ERROR|WARN|warning|failed|failure|denied|timeout|refused)\b/i.test(line)) {
      retainedSignals.push(redactSensitiveText(line).slice(0, 1000));
    }
  }
  return {
    source: redactSensitiveText(path.split(workspace).join(".")),
    lineCount: lines.filter(Boolean).length,
    noiseCategories: categories,
    retainedSignals: [...new Set(retainedSignals)].slice(0, 40)
  };
}

function logNoiseCategory(line: string): string | null {
  if (/telemetry|telemetry-queue|Sending telemetry event/i.test(line)) return "telemetry";
  if (/No GitHub repository detected|Mission Control|remote session|403|repo-less remote session/i.test(line)) return "remote_session_policy";
  if (/MCP|mcp|forge_extension|Model Context Protocol/i.test(line)) return "mcp_lifecycle";
  if (/shutdown|Ignoring transient stdout error|Unregistering foreground session|Broadcasting session lifecycle/i.test(line)) return "session_shutdown";
  if (/Possible EventEmitter memory leak|paletteColor/i.test(line)) return "eventemitter_warning";
  return null;
}
