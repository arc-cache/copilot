import { createHash } from "node:crypto";
import { createWriteStream, renameSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// Shared downloader for ARC's self-bootstrapped artifacts (llama-server and
// model weights). Retries stalled CDN streams and verifies integrity when a
// checksum is pinned.

export interface DownloadOptions {
  onPercent?: (percent: number) => void;
  sha256?: string;
  attempts?: number;
}

export async function downloadFile(url: string, target: string, options: DownloadOptions = {}): Promise<void> {
  const attempts = options.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await downloadFileOnce(url, target, options.onPercent ?? (() => undefined));
      if (options.sha256) {
        const actual = createHash("sha256").update(await readFile(target)).digest("hex");
        if (actual !== options.sha256.toLowerCase()) {
          rmSync(target, { force: true });
          throw new Error(`checksum mismatch for ${url}: expected ${options.sha256}, got ${actual}`);
        }
      }
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function downloadFileOnce(url: string, target: string, onPercent: (percent: number) => void): Promise<void> {
  const partial = `${target}.part`;
  rmSync(partial, { force: true });
  // CDN streams can stall silently mid-transfer; abort when no bytes arrive
  // for a while so the retry loop gets a fresh connection.
  const controller = new AbortController();
  let stallTimer = setTimeout(() => controller.abort(), downloadStallTimeoutMs());
  const touch = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), downloadStallTimeoutMs());
    stallTimer.unref();
  };
  stallTimer.unref();
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`download failed with ${response.status} for ${url}`);
    }
    const total = Number(response.headers.get("content-length") ?? 0);
    let received = 0;
    let lastPercent = -1;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        touch();
        received += chunk.length;
        if (total > 0) {
          const percent = Math.floor((received / total) * 100);
          if (percent !== lastPercent) {
            lastPercent = percent;
            onPercent(percent);
          }
        }
        callback(null, chunk);
      }
    });
    await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(partial));
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error instanceof Error && error.name === "AbortError"
      ? new Error(`download stalled (no data for ${downloadStallTimeoutMs()}ms) for ${url}`)
      : error;
  } finally {
    clearTimeout(stallTimer);
  }
}

function downloadStallTimeoutMs(): number {
  const value = Number(process.env.AGENT_RUN_CACHE_DOWNLOAD_STALL_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}
