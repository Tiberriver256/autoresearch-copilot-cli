# Autoresearch Extension — E2E Behavioral Test Notes

## Test: End-to-End Session with Live Dashboard

**Goal prompt sent to Copilot CLI:**
> Autoresearch tactics to get 100% code coverage via behavioral [structurally-insensitive](https://testdesiderata.com/) tests

### Launch requirement (critical)

The extension **only loads in interactive mode**. The Copilot CLI must be started without the `-p` flag so the session
initialises with `repository=tiberriver256/autoresearch-copilot-cli` context, which triggers extension discovery.

```powershell
# From C:\my\personal\autoresearch-copilot-cli
gh copilot -- --autopilot --yolo
# Then send the prompt interactively; the extension loads as part of "Environment loaded: 1 extension"
```

When started with `-p "..."` the Copilot CLI subprocess shows `repository=undefined` in its log and skips extension
loading entirely (`Found 0 extension(s)`).

### Extension load confirmation (Copilot CLI log)

```
[INFO] Session indexing debug: SESSION_INDEXING=false, repository=tiberriver256/autoresearch-copilot-cli
[INFO] Found 1 extension(s), launching 1 (0 disabled)
[INFO] Launching extension: …\.github\extensions\autoresearch\extension.mjs
[INFO] Extension ready: …\.github\extensions\autoresearch\extension.mjs
```

Terminal shows: `● Environment loaded: 1 custom instruction, 1 extension, 1 skill, 3 MCP servers`

### Extension tools invoked (in order)

| Tool | Outcome |
|---|---|
| `autoresearch_init` | "Session already initialised (status: running). No changes made." |
| `autoresearch_status` | Returned running session state |
| `autoresearch_run` (`npm test`) | Experiment `run-1777684194762` — success, 18/18 tests, 100% coverage |
| `autoresearch_log` | Returned JSONL entries confirming run history |
| `powershell` (`git status && npm run check`) | Clean status, syntax check passed |
| `task_complete` | "The current autoresearch benchmark already reaches the configured 100% coverage gate." |

### Dashboard

- URL: `http://localhost:7432`
- `/api/state` → HTTP 200, returns JSON session state
- `/api/activity` → HTTP 200, lists all tool calls with timestamps
- `/api/export` → HTTP 200, returns static JSON snapshot (also written to `autoresearch-export.json`)
- Dashboard HTML served at `/` (9730 bytes)

### Persisted artifacts after session

| File | What it contains |
|---|---|
| `.autoresearch/state.json` | Session state, 7 experiment records, metrics, logs |
| `autoresearch.jsonl` | Append-only run events (run_start / run_end) |
| `autoresearch.md` | Human-readable summary auto-updated by extension |
| `autoresearch-export.json` | Point-in-time snapshot exported via `/api/export` |

### Coverage result

```
file           | line % | branch % | funcs % | uncovered lines
server.mjs     | 100.00 |   100.00 |  100.00 |
state.mjs      | 100.00 |   100.00 |  100.00 |
all files      | 100.00 |   100.00 |  100.00 |
```

18 tests pass; 0 fail.

### Behavioral tactics confirmed working

From the `task_complete` output:
- Keep strict coverage gates in the benchmark command
- Drive tests through public behavior (`StateManager`, `DashboardServer`, exported snapshot rendering)
- Exercise observable API routes and state transitions
- Test safety properties like escaping/CORS/SSE behavior
- Cover retention/bounds behavior with time-based assertions

### Rerun checklist

1. `cd C:\my\personal\autoresearch-copilot-cli`
2. `gh copilot -- --autopilot --yolo` (interactive, not `-p`)
3. Send prompt: `Autoresearch tactics to get 100% code coverage via behavioral [structurally-insensitive](https://testdesiderata.com/) tests`
4. Confirm terminal shows `1 extension` in environment load line
5. Confirm `autoresearch_init` / `autoresearch_run` appear in `http://localhost:7432/api/activity`
6. Confirm `http://localhost:7432/api/state` returns HTTP 200
7. Confirm `npm test` passes 18/18 with 100% coverage in run output
