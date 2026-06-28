import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ARC's strong reviewer/consultant runs `copilot -p ...`, and every such run
// persists a normal resumable session under ~/.copilot/session-state — so the
// user's `copilot --resume` list fills with junk "You are the Agent Run
// Cache..." entries (an audited real run produced 16 in one afternoon). The
// CLI has no ephemeral mode, so ARC deletes its own sidecar sessions instead:
// incrementally after each sidecar run, and as a full sweep at startup to
// clear historical junk.

// A sidecar session is identified by its prompt STARTING with the sidecar
// preamble, anchored to the JSON field opener so a user session that merely
// quotes the phrase mid-text never matches.
const SIDECAR_MARKERS = [
  '"You are the Agent Run Cache',
  '"prompt":"You are the Agent Run Cache',
  '"text":"You are the Agent Run Cache',
  '"content":"You are the Agent Run Cache'
];
const SCAN_BYTES = 256 * 1024;
const SCAN_LINES = 25;

export function copilotSessionStateRoot(): string {
  return process.env.AGENT_RUN_CACHE_COPILOT_STATE_DIR ?? join(homedir(), ".copilot", "session-state");
}

export async function listCopilotSessionIds(): Promise<Set<string>> {
  try {
    const entries = await readdir(copilotSessionStateRoot(), { withFileTypes: true });
    return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

/**
 * Delete Copilot sessions created by ARC's own sidecar runs. With `onlyNew`,
 * checks just the sessions that did not exist in that snapshot (the cheap
 * after-each-run path); without it, sweeps everything (startup cleanup).
 * Returns the deleted session ids.
 */
export async function cleanupSidecarCopilotSessions(onlyNew?: Set<string>): Promise<string[]> {
  const root = copilotSessionStateRoot();
  const ids = await listCopilotSessionIds();
  const removed: string[] = [];
  for (const id of ids) {
    if (onlyNew?.has(id)) continue;
    if (!(await isSidecarSession(join(root, id)))) continue;
    try {
      await rm(join(root, id), { recursive: true, force: true });
      removed.push(id);
    } catch {
      // Session in use or already gone; leave it for the next sweep.
    }
  }
  return removed;
}

async function isSidecarSession(sessionDir: string): Promise<boolean> {
  let text: string;
  try {
    const buffer = await readFile(join(sessionDir, "events.jsonl"));
    text = buffer.subarray(0, SCAN_BYTES).toString("utf8");
  } catch {
    return false;
  }
  const head = text.split("\n", SCAN_LINES).join("\n");
  return SIDECAR_MARKERS.some((marker) => head.includes(marker));
}
