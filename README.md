# ARC for GitHub Copilot CLI

> ARC watches a coding agent solve something in your repo, keeps the route that
> actually worked, and hands it back before the next similar run.

[![Latest release](https://img.shields.io/github/v/release/arc-cache/copilot?label=release)](https://github.com/arc-cache/copilot/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](#license)

ARC for Copilot is a local-first run cache and terminal companion for GitHub
Copilot CLI. It is not a memory store, daemon, hosted service, model proxy, or
replacement agent UI. It keeps verified reusable methods from completed runs
and injects a compact note before the next similar prompt.

The production Copilot integration is a Copilot plugin. The plugin declares ARC
hooks and an ARC MCP server, both pointing back to the installed `arc` binary:

```bash
npm i -g arc-copilot
arc setup
arc split
```

`arc split` opens Copilot and a narrow, live ARC companion pane in one terminal.
It does not modify Copilot. Plain `copilot` and
`ollama launch copilot --model gemma4:31b-cloud` continue to work normally, and
no `--experimental` flag is required for plugin hooks or MCP.

To use a different Copilot launch command:

```bash
arc split --copilot-command "ollama launch copilot --model gemma4:31b-cloud"
```

`arc ui` remains the standalone full dashboard. `/arc` is a compact dialog
inside Copilot, not a persistent tab or page. Enable Copilot's experimental
SDK-extension loader once to use it:

```text
/settings experimental on
/clear
```

Then type `/arc` inside Copilot. The dialog is UI-only; prompt recall still
comes from the plugin hook path so plain Copilot launches keep working.

The plugin is the integration. `arc split`, `arc ui`, and `/arc` are control
surfaces over the same local `.agent-run-cache/` store and config file.

The npm package installs a native Rust `arc` executable at `bin/arc`. The
TypeScript implementation remains in this repository as the parity spec for
tests, but it is not the packaged runtime.

## What The Plugin Provides

The packaged plugin lives under `plugin/` and is installed through Copilot's
supported plugin mechanism. Its manifest points Copilot at:

- `hooks.json`: runs `arc hook copilot ...` for `sessionStart`,
  `userPromptSubmitted`, and `sessionEnd`.
- `.mcp.json`: starts `arc mcp` over stdio and exposes `arc_search`,
  `arc_status`, `arc_capsule`, pause/resume, judge selection, and capsule
  delete/share tools.

The hook path reuses ARC's normal retrieval, judge, capture, observer, and
review code. The MCP server is stdio JSON-RPC inside the same Rust binary; ARC
has no production npm dependencies at runtime.

On the first plugin hook in a workspace, ARC creates
`.agent-run-cache/enabled.json` automatically. There is no per-repo setup step.

## Companion View

Run `arc split` in a repo for the normal combined workspace. Copilot occupies
the main pane and ARC uses roughly one third of the terminal. The ARC pane is
mouse-first: click a summary row to drill in, click breadcrumbs to go back,
click folded capsule sections to expand them, use the wheel to scroll, and
click `⧉` to copy a command or section. Drag the divider to resize either pane.

The pane rereads the local store while it is open, so capsules, activity,
injection state, and judge settings update without restarting. Copies use
OSC52 and also write a temporary `arc-clipboard-<pid>.txt` fallback. Set
`AGENT_RUN_CACHE_OSC52=off` to use only the fallback.

On macOS and Linux, release archives include ARC's pinned Zellij appliance
build. Source checkouts build that exact revision and the small ARC patch with
`node scripts/build-zellij-appliance.cjs`; stock Zellij is rejected because its
advanced mouse controls also expose pane grouping. ARC starts the appliance in
locked mode: no status or keybinding bar, no pane/tab/resize modes, and no
shortcuts or mouse gestures that can open, close, move, float, group, or
fullscreen panes. `Ctrl+q` is the only Zellij binding and exits the complete
split cleanly.

Windows uses a Windows Terminal split fallback; `arc ui` remains available when
`wt.exe` is unavailable.

Run `arc` or `arc ui` to open only the full dashboard. The combined split
workflow is mouse-first and requires no multiplexer commands.

When stdout is not a TTY, `arc` prints a short status summary instead of opening
the interactive view.

## Local Commands

`--json` writes machine-readable JSON to stdout. Errors go to stderr and return
non-zero so scripts and thin clients can shell out reliably.

```text
arc
arc ui
arc split [--copilot-command "<command>"]
arc plugin install|status|path [--json]
arc setup [--enable-experimental] [--sidecar-copilot-command "<command>"]
arc mcp
arc status [--json]
arc pause [1h|2h|today|off] [--json]
arc resume [--json]
arc capsules [--json]
arc capsule <id> [--json]
arc capsules <id> [--json]
arc capsules set <id> [--status <s>] [--privacy <label>] [--json]
arc capsules delete <id> [--json]
arc capsules share <id> [--out <file>] [--json]
arc events [--json] [--limit N]
arc probe "<prompt>" [--json]
arc judge status|models|decisions|reputation|set [<provider:id>] [--json]
arc import-copilot <events.jsonl>
arc import-otel <otel.jsonl> [session-id]
arc harvest <copilot-session-id>
arc logs [--follow]
arc debug-bundle [out-dir]
arc ask [--runner opencode] <prompt>
arc reset --yes
arc smoke
arc doctor [--json]
```

`arc probe` asks what would be injected for a prompt. `arc doctor` reports the
installed plugin, runtime, split-view readiness, config, optional fallback
surfaces, capsule count, and recent injection/save events.

`arc pause` temporarily disables prompt injection without deleting capsules.
`arc resume` clears the pause. `arc setup --enable-experimental` explicitly
sets Copilot's experimental setting for the `/arc` menu; without that flag ARC
only prints the one-line instruction.

## Experimental Fallbacks

These are explicit commands only. ARC correctness does not depend on them.

```text
arc json-hooks install|status [--json]
arc copilot-tab ...
arc acp
```

The Copilot tab patch is a demoted legacy experiment. The supported product path
is plugin hooks + MCP, the `arc split` companion view, standalone `arc ui`, and
the UI-only `/arc` SDK extension dialog after Copilot experimental mode is
enabled.

`arc acp` is not part of the normal Rust product flow. Use `arc plugin install`
and launch Copilot normally.

## What A Capsule Looks Like

A capsule is the route, not a transcript. Here is one ARC might keep after a
green test run:

```text
Capsule: Run the integration test suite
First move: bring up the test db, then run the suite
Reuse when: running or fixing integration tests
Do not reuse when: only unit tests changed
Binding sources to verify: vitest.config.ts, test/integration/**
Command shapes: docker compose up -d test-db
                pnpm test:integration
Validation probe: "Test Files  12 passed (12)", exit code 0
Dead ends to avoid: plain `pnpm test` skips the db, dies on "connection refused"
```

Every field came from a run that finished and proved itself. ARC asks the
configured host reviewer only after deterministic gates decide the run is worth
reviewing.

## How It Works

ARC runs in six stages:

1. It reads the typed event stream: prompts, tool calls, command exits, edited
   paths, and assistant output.
2. A deterministic gate drops obvious no-ops, failed runs, and small talk.
3. Success evidence is checked before anything can become reusable.
4. The configured reviewer writes a capsule from observed evidence only.
5. A small local embedder looks for the closest matching capsule on later
   prompts and abstains when nothing is close enough.
6. Binding sources and validation probes keep capsules from being reused when
   the old route has gone stale.

## Development

```bash
npm install
npm run build      # builds/copies the Rust binary to bin/arc
npm run build:ts   # builds the TypeScript spec into dist/
npm test
npm link
```

To prove the Rust binary can retrieve with its self-managed embedder on a clean
state, run:

```bash
cargo build --release
npm run verify:rust-local-embeddings
```

That check creates a temporary ARC store, downloads the managed llama.cpp
runtime and `nomic-embed-text-v1.5.f16.gguf` model into temporary directories,
starts the local embedding server, and verifies `arc probe --json` retrieves a
seeded capsule without any external embedding endpoint.

Release binaries are built into the prebuild layout consumed by npm
postinstall:

```bash
npm run build:release
# or a subset:
node scripts/build-release-binaries.cjs --targets darwin-arm64,darwin-x64
```

The release target keys are `darwin-arm64`, `darwin-x64`, `linux-x64`,
`linux-arm64`, and `windows-x64`. The script writes native binaries under
`prebuilds/<target>/` and archive artifacts under `release/`. macOS and Linux
archives include the pinned ARC Zellij appliance used by `arc split` and its
MIT notice; Windows packages use the documented Windows Terminal fallback.

## Scope

This repo holds the local ARC CLI runtime, ACP middleware, capture/review logic,
retrieval, MCP server, Copilot plugin files, and terminal UI. Keep product work
focused on the local run-cache path.

## License

This repository is licensed under Apache-2.0. See [LICENSE](LICENSE).
