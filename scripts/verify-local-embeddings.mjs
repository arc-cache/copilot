#!/usr/bin/env node
// Live verification of ARC's managed local embedding path: downloads the pinned
// llama-server build and nomic embedder weights if missing, starts the embedding
// server, and verifies a real vector response.
// Usage: npm run build && node scripts/verify-local-embeddings.mjs

import assert from "node:assert/strict";

// Force startup for verification even if the normal auto path would wait until
// app/acp startup has warmed the embedder.
process.env.AGENT_RUN_CACHE_LOCAL_EMBEDDINGS ??= "on";

import {
  ensureLocalEmbeddings,
  embedTexts,
  localEmbeddingInfo,
  stopLocalEmbeddings
} from "../dist/local-embeddings.js";

const workspace = process.cwd();

const progress = setInterval(() => {
  const info = localEmbeddingInfo();
  process.stdout.write(`local embeddings: ${info.state} - ${info.detail}\n`);
}, 5000);
progress.unref();

try {
  console.log("ensuring managed embedding model (downloads on first run)...");
  const embeddingInfo = await ensureLocalEmbeddings(workspace);
  clearInterval(progress);
  console.log("embedding model:", JSON.stringify(embeddingInfo, null, 2));
  assert.equal(embeddingInfo.state, "ready", `embedding model is not ready: ${embeddingInfo.detail}`);
  assert.equal(localEmbeddingInfo().state, "ready");

  const vectors = await embedTexts(["ARC stores reusable workflow capsules for future coding-agent runs."], workspace);
  assert.equal(Array.isArray(vectors), true);
  assert.equal(vectors.length, 1);
  assert.equal(vectors[0].length > 0, true);

  console.log("\nLOCAL_EMBEDDINGS_VERIFY_OK");
} finally {
  clearInterval(progress);
  stopLocalEmbeddings();
}
