import { createHash } from "node:crypto";
import { open, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ensureCache } from "./paths.js";

export async function claimInvocationLock(
  workspace: string,
  namespace: string,
  parts: unknown[],
  ttlMs = 10 * 60 * 1000
): Promise<boolean> {
  const file = invocationPath(workspace, namespace, parts);
  const now = Date.now();
  try {
    const handle = await open(file, "wx");
    await handle.writeFile(String(now));
    await handle.close();
    return true;
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const ageMs = await stat(file).then((info) => now - info.mtimeMs, () => 0);
    if (ageMs < ttlMs) return false;
    await unlink(file).catch(() => undefined);
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(String(now));
      await handle.close();
      return true;
    } catch (retryError) {
      if (isAlreadyExists(retryError)) return false;
      throw retryError;
    }
  }
}

export async function writeInvocationMarker(
  workspace: string,
  namespace: string,
  parts: unknown[]
): Promise<void> {
  await writeFile(invocationPath(workspace, namespace, parts), String(Date.now()), "utf8");
}

export async function hasRecentInvocationMarker(
  workspace: string,
  namespace: string,
  parts: unknown[],
  ttlMs = 60 * 60 * 1000
): Promise<boolean> {
  try {
    const info = await stat(invocationPath(workspace, namespace, parts));
    return Date.now() - info.mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

function invocationPath(workspace: string, namespace: string, parts: unknown[]): string {
  const key = hash(parts.map((part) => String(part ?? "")).join("\0"));
  return join(ensureCache(workspace), "locks", `${safeNamespace(namespace)}-${key}.lock`);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function safeNamespace(value: string): string {
  return value.replace(/[^a-z0-9_.-]+/gi, "-").slice(0, 48) || "invocation";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}
