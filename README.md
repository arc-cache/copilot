# arc-copilot

A local-first run cache for the GitHub Copilot CLI. ARC watches a coding agent
solve something in your repo, keeps the route that actually worked, and hands it
back before the next similar run.

[![npm](https://img.shields.io/npm/v/arc-copilot)](https://www.npmjs.com/package/arc-copilot)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

macOS (Apple silicon or Intel), Linux, or Windows with Node 22+:

```bash
npm i -g arc-copilot
arc setup
arc split
```

The npm package is named `arc-copilot`; it installs both the `arc` and
`agent-run-cache` commands. Installing `agent-run-cache` as a package returns a
404 because that is the executable alias, not the package name.

## What it does

`arc split` opens Copilot next to a live ARC pane in one terminal. As Copilot
works, ARC keeps only the verified steps from runs that finished and proved
themselves, then injects a compact note before the next similar prompt. It does
not change Copilot, store transcripts, or run as a daemon.

A kept capsule is the route, not a transcript:

```text
Capsule: Run the integration test suite
First move: bring up the test db, then run the suite
Reuse when: running or fixing integration tests
Command shapes: docker compose up -d test-db
                pnpm test:integration
Validation probe: "Test Files  12 passed (12)", exit code 0
```

## Common commands

```text
arc split      Copilot plus the live ARC companion pane
arc ui         the standalone dashboard
arc status     injection state, capsule count, recent activity
arc metrics    latency, tool failures, tokens, cost, and policy warnings
arc replay-eval  evaluate retrieval and redaction against recorded traces
arc capsules   list kept capsules
arc doctor     plugin, runtime, and split-view readiness
```

The live `arc split` companion and `arc ui` both include a Metrics view. ARC
records redacted session aggregates: tool timing and outcome, retries, model
latency, token usage, and cost. Provider-reported usage is labeled `provider`;
fallback token counts are labeled `estimate`; unavailable cost remains
`unknown`.

Optional warning and reviewer hard limits live in
`.agent-run-cache/telemetry-policy.json`:

```json
{
  "warnings": {
    "costUsdPerSession": 2,
    "slowToolMs": 30000,
    "repeatedFailures": 2,
    "retriesPerSession": 3
  },
  "reviewer": {
    "maxCallsPerSession": 2,
    "hardCostUsdPerSession": 0.5,
    "estimatedCostUsdPerCall": 0.1
  }
}
```

Debug bundles contain only the sanitized metrics aggregate, never the local
telemetry ledger.

## Implementation

The product is the native Rust binary in `rust/` — that is what the npm package
installs and runs. `src/` is a TypeScript reference implementation kept for
differential testing: `tests/rust_parity.rs` runs the Rust binary and the
TypeScript side by side and asserts they produce identical behavior. The
TypeScript is never shipped or executed at runtime.

## License

Apache-2.0. See [LICENSE](LICENSE).

---

Built and maintained by [Ayub Mohyadin](https://ayubm.com).
