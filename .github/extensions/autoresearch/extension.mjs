/**
 * autoresearch — Copilot CLI extension
 *
 * Registers slash command /autoresearch and a suite of autoresearch_* tools
 * for managing autonomous research sessions: init, status, run, log, export,
 * server controls (pause/resume/server), and metric tracking via JSONL state.
 */

import { joinSession } from "@github/copilot-sdk/extension";
import { execFile } from "node:child_process";
import { writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { StateManager } from "./lib/state.mjs";

const execFileAsync = promisify(execFile);

// ─── Paths ────────────────────────────────────────────────────────────────────

const CWD = process.cwd();
const STATE_DIR = join(CWD, ".autoresearch");
const LOG_FILE = join(CWD, "autoresearch.jsonl");
const MD_FILE = join(CWD, "autoresearch.md");

const stateMgr = new StateManager(STATE_DIR);

// ─── State helpers (thin wrappers over StateManager) ─────────────────────────

/** @returns {Record<string,unknown>} */
function readState() {
  return stateMgr.getState();
}

/** @param {Record<string,unknown>} updates */
function writeState(updates) {
  return stateMgr.setState(updates);
}

// ─── JSONL helpers ────────────────────────────────────────────────────────────

/** @param {Record<string,unknown>} record */
function appendLog(record) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
  appendFileSync(LOG_FILE, line + "\n", "utf-8");
}

/** @returns {Array<Record<string,unknown>>} */
function readLog(limit = 50) {
  if (!existsSync(LOG_FILE)) return [];
  const lines = readFileSync(LOG_FILE, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return lines.slice(-limit);
}

// ─── Metric parsing ───────────────────────────────────────────────────────────

/**
 * Parse `METRIC name=value` lines from arbitrary text.
 * @param {string} text
 * @returns {Record<string, number>}
 */
function parseMetrics(text) {
  const metrics = {};
  const re = /^METRIC\s+([A-Za-z0-9_.-]+)\s*=\s*([0-9.eE+\-]+)/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    const val = parseFloat(m[2]);
    if (!isNaN(val)) metrics[m[1]] = val;
  }
  return metrics;
}

// ─── Shell execution ──────────────────────────────────────────────────────────

/**
 * Run a shell command cross-platform.
 * @param {string} command
 * @param {{ cwd?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number}>}
 */
async function runShell(command, opts = {}) {
  const isWindows = process.platform === "win32";
  const shell = isWindows ? "powershell" : (process.env.SHELL || "sh");
  const shellArgs = isWindows
    ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["-c", command];

  try {
    const { stdout, stderr } = await execFileAsync(shell, shellArgs, {
      cwd: opts.cwd || CWD,
      timeout: opts.timeoutMs || 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout || "", stderr: stderr || "", exitCode: 0 };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || "Unknown error",
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

// ─── Status summary ───────────────────────────────────────────────────────────

function buildStatusSummary(state) {
  const experiments = Array.isArray(state.experiments) ? state.experiments : [];
  const metrics = Array.isArray(state.metrics) ? state.metrics : [];
  const lines = [
    `Status: ${state.status || "idle"}`,
    `Experiments: ${experiments.length}`,
    `Goal: ${state.goal || "(none)"}`,
  ];
  if (state.currentExperiment) {
    lines.push(`Current experiment: ${state.currentExperiment}`);
  }
  if (state.bestMetric) {
    lines.push(`Best metric: ${state.bestMetric.value} (${state.bestMetric.experiment})`);
  }
  const recent = metrics.slice(-5);
  if (recent.length) {
    lines.push("Recent metrics:");
    recent.forEach((m) => lines.push(`  ${m.experiment}: ${m.value}`));
  }
  return lines.join("\n");
}

// ─── Export snapshot ──────────────────────────────────────────────────────────

function buildExportSnapshot(state) {
  const logs = readLog(200);
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      state,
      recentLog: logs,
    },
    null,
    2
  );
}

// ─── Markdown summary ─────────────────────────────────────────────────────────

function updateMarkdownSummary(state) {
  const experiments = Array.isArray(state.experiments) ? state.experiments : [];
  const metrics = Array.isArray(state.metrics) ? state.metrics : [];
  const lines = [
    "# autoresearch session",
    "",
    `**Status:** ${state.status || "idle"}  `,
    `**Updated:** ${state.updatedAt || new Date().toISOString()}`,
    `**Goal:** ${state.goal || "(none)"}`,
    "",
    "## Experiments",
    "",
  ];
  if (experiments.length === 0) {
    lines.push("_No experiments yet._");
  } else {
    experiments.slice(-20).forEach((e) => {
      lines.push(`- **${e.id}** (${e.name || "?"}) — ${e.status}, metric: ${e.metric ?? "?"}`);
    });
  }
  lines.push("", "## Recent Metrics", "");
  const recent = metrics.slice(-10);
  if (recent.length === 0) {
    lines.push("_No metrics recorded yet._");
  } else {
    recent.forEach((m) => lines.push(`- **${m.experiment}**: ${m.value} at ${m.at}`));
  }
  if (state.bestMetric) {
    lines.push("", `**Best:** ${state.bestMetric.value} (${state.bestMetric.experiment})`);
  }
  writeFileSync(MD_FILE, lines.join("\n") + "\n", "utf-8");
}

// ─── Command help text ────────────────────────────────────────────────────────

const HELP_TEXT = `autoresearch — autonomous research session manager

Subcommands (use as /autoresearch <sub>):
  help     Show this help
  init     Initialise a new research session in .autoresearch/
  status   Print current session status and metrics
  run      Execute the configured research command
  log      Show recent JSONL log entries
  export   Write a full snapshot to autoresearch-export.json
  server   Show server info / check daemon status
  pause    Pause the active research run
  resume   Resume a paused research run

Tools registered: autoresearch_init, autoresearch_status, autoresearch_run,
  autoresearch_log, autoresearch_export, autoresearch_server`;

// ─── Join session ─────────────────────────────────────────────────────────────

const session = await joinSession({
  // ── Slash command ──────────────────────────────────────────────────────────
  commands: [
    {
      name: "autoresearch",
      description: "Manage autonomous research sessions (init/status/run/log/export/server/pause/resume)",
      handler: async (ctx) => {
        const sub = ctx.args.trim().split(/\s+/)[0] || "help";

        if (sub === "help" || sub === "") {
          await session.log(HELP_TEXT);
          return;
        }

        if (sub === "init") {
          const state = readState();
          if (state.status !== "idle") {
            await session.log(`Session already initialised (status: ${state.status}). Use /autoresearch status to inspect.`, { level: "warning" });
            return;
          }
          const goal = ctx.args.replace(/^init\s*/, "").trim() || undefined;
          stateMgr.startSession(goal, undefined);
          appendLog({ event: "init", goal, cwd: CWD });
          updateMarkdownSummary(readState());
          await session.log(`autoresearch session initialised${goal ? ` — goal: ${goal}` : ""}. State stored in .autoresearch/state.json`);
          return;
        }

        if (sub === "status") {
          const state = readState();
          await session.log(buildStatusSummary(state));
          return;
        }

        if (sub === "run") {
          const state = readState();
          const cmd = ctx.args.replace(/^run\s*/, "").trim();
          if (!cmd) {
            await session.log("Usage: /autoresearch run <shell-command>", { level: "warning" });
            return;
          }
          await session.log(`Running: ${cmd}`, { ephemeral: true });
          const expId = `run-${Date.now()}`;
          stateMgr.addExperiment(expId, cmd);
          appendLog({ event: "run_start", expId, command: cmd });

          const result = await runShell(cmd);
          const newMetrics = parseMetrics(result.stdout);
          const metricValue = Object.values(newMetrics)[0] ?? null;

          stateMgr.finishExperiment(expId, metricValue, result.ok ? "done" : "failed");
          if (Object.keys(newMetrics).length) {
            for (const [k, v] of Object.entries(newMetrics)) {
              stateMgr.addMetric(`${expId}/${k}`, v);
            }
          }
          stateMgr.addLog(result.ok ? "info" : "warning", `Run ${expId}: ${result.ok ? "success" : "failure"}`);
          appendLog({ event: "run_end", expId, outcome: result.ok ? "success" : "failure", exitCode: result.exitCode, metrics: newMetrics });
          updateMarkdownSummary(readState());

          const summary = result.ok
            ? `Run ${expId} succeeded.\n${result.stdout.slice(0, 500)}`
            : `Run ${expId} failed (exit ${result.exitCode}).\n${result.stderr.slice(0, 500)}`;
          await session.log(summary, { level: result.ok ? "info" : "warning" });
          return;
        }

        if (sub === "log") {
          const entries = readLog(20);
          if (entries.length === 0) {
            await session.log("No log entries yet.");
          } else {
            await session.log(entries.map((e) => JSON.stringify(e)).join("\n"));
          }
          return;
        }

        if (sub === "export") {
          const state = readState();
          const snapshot = buildExportSnapshot(state);
          const outPath = join(CWD, "autoresearch-export.json");
          writeFileSync(outPath, snapshot, "utf-8");
          appendLog({ event: "export", path: outPath });
          await session.log(`Snapshot exported to ${outPath}`);
          return;
        }

        if (sub === "server") {
          const state = readState();
          await session.log(`Server info:\n  cwd: ${CWD}\n  status: ${state.status || "idle"}\n  pid: ${process.pid}`);
          return;
        }

        if (sub === "pause") {
          const state = readState();
          if (state.status === "running") {
            stateMgr.pause();
            appendLog({ event: "pause" });
            await session.log("Research session paused. Use /autoresearch resume to continue.");
          } else {
            await session.log(`Cannot pause: current status is "${state.status}".`, { level: "warning" });
          }
          return;
        }

        if (sub === "resume") {
          const state = readState();
          if (state.status === "paused") {
            stateMgr.resume();
            appendLog({ event: "resume" });
            await session.log("Research session resumed.");
          } else {
            await session.log(`Cannot resume: current status is "${state.status}".`, { level: "warning" });
          }
          return;
        }

        await session.log(`Unknown subcommand: ${sub}. Try /autoresearch help.`, { level: "warning" });
      },
    },
  ],

  // ── Tools ──────────────────────────────────────────────────────────────────
  tools: [
    // autoresearch_init
    {
      name: "autoresearch_init",
      description: "Initialise a new autoresearch session in .autoresearch/state.json and autoresearch.md. Safe to call multiple times; only acts when status is idle.",
      parameters: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description: "Optional human-readable label / goal for this research session.",
          },
          goal: {
            type: "string",
            description: "Research goal description (alias for label).",
          },
          benchmark_command: {
            type: "string",
            description: "Optional shell command used as the benchmark/evaluation step.",
          },
        },
        required: [],
      },
      handler: async (args) => {
        const state = readState();
        if (state.status !== "idle") {
          return {
            resultType: "success",
            textResultForLlm: `Session already initialised (status: ${state.status}). No changes made.`,
          };
        }
        const goal = args?.label || args?.goal || undefined;
        stateMgr.startSession(goal, args?.benchmark_command || undefined);
        appendLog({ event: "init", goal, cwd: CWD });
        updateMarkdownSummary(readState());
        await session.log(`autoresearch initialised${goal ? ` — ${goal}` : ""}`);
        return {
          resultType: "success",
          textResultForLlm: `Session initialised. State: ${join(STATE_DIR, "state.json")}, Log: ${LOG_FILE}, Summary: ${MD_FILE}`,
        };
      },
    },

    // autoresearch_status
    {
      name: "autoresearch_status",
      description: "Return the current autoresearch session status, run count, and metrics.",
      parameters: { type: "object", properties: {}, required: [] },
      handler: async () => {
        const state = readState();
        const summary = buildStatusSummary(state);
        return { resultType: "success", textResultForLlm: summary };
      },
    },

    // autoresearch_run
    {
      name: "autoresearch_run",
      description: "Execute a shell command as a research run. Captures stdout/stderr, parses METRIC lines, updates state and JSONL log.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Shell command to execute (PowerShell on Windows, sh elsewhere).",
          },
          timeout_seconds: {
            type: "number",
            description: "Execution timeout in seconds (default: 30).",
          },
        },
        required: ["command"],
      },
      handler: async (args) => {
        if (!args?.command) {
          return { resultType: "failure", textResultForLlm: "command is required." };
        }
        const expId = `run-${Date.now()}`;
        stateMgr.addExperiment(expId, args.command);
        appendLog({ event: "run_start", expId, command: args.command });
        await session.log(`autoresearch_run: ${args.command}`, { ephemeral: true });

        const result = await runShell(args.command, {
          timeoutMs: (args.timeout_seconds || 30) * 1000,
        });

        const newMetrics = parseMetrics(result.stdout);
        const metricValue = Object.values(newMetrics)[0] ?? null;

        stateMgr.finishExperiment(expId, metricValue, result.ok ? "done" : "failed");
        for (const [k, v] of Object.entries(newMetrics)) {
          stateMgr.addMetric(`${expId}/${k}`, v);
        }
        stateMgr.addLog(result.ok ? "info" : "warning", `Run ${expId}: ${result.ok ? "success" : "failure"}`);
        appendLog({
          event: "run_end",
          expId,
          outcome: result.ok ? "success" : "failure",
          exitCode: result.exitCode,
          metrics: newMetrics,
        });
        updateMarkdownSummary(readState());

        const text = [
          `Experiment ID: ${expId}`,
          `Outcome: ${result.ok ? "success" : "failure"}`,
          `Exit code: ${result.exitCode}`,
          result.stdout ? `stdout:\n${result.stdout.slice(0, 1000)}` : "",
          result.stderr ? `stderr:\n${result.stderr.slice(0, 500)}` : "",
          Object.keys(newMetrics).length ? `Metrics parsed: ${JSON.stringify(newMetrics)}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        await session.log(
          `Run ${expId}: ${result.ok ? "success" : "failure"}` +
            (Object.keys(newMetrics).length ? ` | metrics: ${JSON.stringify(newMetrics)}` : ""),
          { level: result.ok ? "info" : "warning" }
        );

        return {
          resultType: result.ok ? "success" : "failure",
          textResultForLlm: text,
        };
      },
    },

    // autoresearch_log
    {
      name: "autoresearch_log",
      description: "Read recent entries from the autoresearch JSONL event log.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of entries to return (default: 20).",
          },
        },
        required: [],
      },
      handler: async (args) => {
        const limit = typeof args?.limit === "number" ? Math.min(Math.max(args.limit, 1), 200) : 20;
        const entries = readLog(limit);
        if (entries.length === 0) {
          return { resultType: "success", textResultForLlm: "No log entries found." };
        }
        return {
          resultType: "success",
          textResultForLlm: entries.map((e) => JSON.stringify(e)).join("\n"),
        };
      },
    },

    // autoresearch_export
    {
      name: "autoresearch_export",
      description: "Export a full session snapshot (state + recent logs) to autoresearch-export.json in the working directory.",
      parameters: {
        type: "object",
        properties: {
          output_path: {
            type: "string",
            description: "Custom output path (default: autoresearch-export.json in cwd).",
          },
        },
        required: [],
      },
      handler: async (args) => {
        const state = readState();
        const snapshot = buildExportSnapshot(state);
        const outPath = args?.output_path
          ? resolve(args.output_path)
          : join(CWD, "autoresearch-export.json");
        try {
          writeFileSync(outPath, snapshot, "utf-8");
        } catch (err) {
          return {
            resultType: "failure",
            textResultForLlm: `Failed to write export: ${err.message}`,
          };
        }
        appendLog({ event: "export", path: outPath });
        await session.log(`Snapshot exported to ${outPath}`);
        return {
          resultType: "success",
          textResultForLlm: `Snapshot written to ${outPath} (${snapshot.length} bytes).`,
        };
      },
    },

    // autoresearch_server
    {
      name: "autoresearch_server",
      description: "Return server/daemon info for the autoresearch extension process.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["info", "pause", "resume"],
            description: "Action to perform: info (default), pause, or resume.",
          },
        },
        required: [],
      },
      handler: async (args) => {
        const action = args?.action || "info";
        const state = readState();

        if (action === "pause") {
          if (state.status === "running") {
            stateMgr.pause();
            appendLog({ event: "pause" });
            await session.log("Research session paused.");
            return { resultType: "success", textResultForLlm: "Session paused." };
          }
          return {
            resultType: "success",
            textResultForLlm: `Cannot pause: current status is "${state.status}".`,
          };
        }

        if (action === "resume") {
          if (state.status === "paused") {
            stateMgr.resume();
            appendLog({ event: "resume" });
            await session.log("Research session resumed.");
            return { resultType: "success", textResultForLlm: "Session resumed." };
          }
          return {
            resultType: "success",
            textResultForLlm: `Cannot resume: current status is "${state.status}".`,
          };
        }

        // info
        const info = {
          cwd: CWD,
          pid: process.pid,
          platform: process.platform,
          nodeVersion: process.version,
          sessionStatus: state.status,
          goal: state.goal,
          stateDir: STATE_DIR,
          logFile: LOG_FILE,
          summaryFile: MD_FILE,
        };
        return {
          resultType: "success",
          textResultForLlm: JSON.stringify(info, null, 2),
        };
      },
    },
  ],

  // ── Session hooks ──────────────────────────────────────────────────────────
  hooks: {
    onSessionStart: async () => {
      await session.log("autoresearch extension loaded", { ephemeral: true });
    },
  },
});
