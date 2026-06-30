# arc-copilot

A local-first run cache for the GitHub Copilot CLI. ARC watches a coding agent
solve something in your repo, keeps the route that actually worked, and hands it
back before the next similar run.

[![npm](https://img.shields.io/npm/v/arc-copilot)](https://www.npmjs.com/package/arc-copilot)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

macOS (Apple silicon or Intel), Node 22+:

```bash
npm i -g arc-copilot
arc setup
arc split
```

Linux and Windows builds are coming next.

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
arc capsules   list kept capsules
arc doctor     plugin, runtime, and split-view readiness
```

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
