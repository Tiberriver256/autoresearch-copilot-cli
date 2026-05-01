# autoresearch-copilot-cli

A [Copilot CLI extension](https://docs.github.com/copilot/about-github-copilot/what-is-github-copilot) that adds autonomous research session management as a slash command and tool suite.

## Features

| Slash command | Tool | Description |
|---|---|---|
| `/autoresearch init` | `autoresearch_init` | Initialise session state in `.autoresearch/` |
| `/autoresearch status` | `autoresearch_status` | Print current status and metrics |
| `/autoresearch run <cmd>` | `autoresearch_run` | Execute a research command, parse `METRIC` lines |
| `/autoresearch log` | `autoresearch_log` | Read recent JSONL log entries |
| `/autoresearch export` | `autoresearch_export` | Write full snapshot to `autoresearch-export.json` |
| `/autoresearch server` | `autoresearch_server` | Show extension process info |
| `/autoresearch pause` | `autoresearch_server action=pause` | Pause active session |
| `/autoresearch resume` | `autoresearch_server action=resume` | Resume paused session |
| `/autoresearch help` | — | Show command reference |

## State files

| File | Purpose |
|---|---|
| `.autoresearch/state.json` | Structured session state (status, runs, metrics) |
| `autoresearch.jsonl` | Append-only event log (one JSON object per line) |
| `autoresearch.md` | Human-readable session summary (auto-updated) |
| `autoresearch-export.json` | Point-in-time snapshot (written on export) |

## Metric parsing

Any line in a command's stdout matching `METRIC name=value` is automatically captured:

```
METRIC accuracy=0.93
METRIC loss=0.042
```

Parsed metrics are persisted in `.autoresearch/state.json` and displayed in status/export.

## Installation

This extension lives in `.github/extensions/autoresearch/extension.mjs` and is automatically
discovered by the Copilot CLI (no `npm install` required — `@github/copilot-sdk` is resolved by the CLI host).

## Cross-platform

Shell commands run via PowerShell on Windows and `sh` (or `$SHELL`) on macOS/Linux.

## Development

```bash
# Syntax check
node --check .github/extensions/autoresearch/extension.mjs

# Smoke test (no CLI required)
node scripts/smoke-test.mjs
```
