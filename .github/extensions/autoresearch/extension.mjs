/**
 * autoresearch — Copilot CLI extension
 *
 * Registers slash command /autoresearch and a suite of autoresearch_* tools
 * for managing autonomous research sessions: init, status, run, log, export,
 * server controls (pause/resume/server), and metric tracking via JSONL state.
 */

import { joinSession } from "@github/copilot-sdk/extension";
import { exec, execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { StateManager } from "./lib/state.mjs";
import { DashboardServer, DEFAULT_PORT, buildExportHTML } from "./lib/server.mjs";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// ─── Paths ────────────────────────────────────────────────────────────────────

const CWD = process.cwd();
const STATE_DIR = join(CWD, ".autoresearch");
const LOG_FILE = join(CWD, "autoresearch.jsonl");
const MD_FILE = join(CWD, "autoresearch.md");

const stateMgr = new StateManager(STATE_DIR);

// ─── Dashboard server (lazy-started) ─────────────────────────────────────────

let dashboard = new DashboardServer(stateMgr, DEFAULT_PORT);
let dashboardUrl = null;

async function ensureDashboard() {
  if (!dashboardUrl) {
    try {
      dashboardUrl = await dashboard.start();
    } catch (err) {
      appendLog({ event: "dashboard_start_error", port: DEFAULT_PORT, error: err.message });

      // A stale extension/dashboard can keep the default port busy. Do not
      // report that stale URL as if this process owns it; fall back to an
      // ephemeral port so this session's broadcasts reach the displayed UI.
      dashboard = new DashboardServer(stateMgr, 0);
      dashboardUrl = await dashboard.start();
      appendLog({ event: "dashboard_started_ephemeral", url: dashboardUrl });
    }
  }
  return dashboardUrl;
}

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

function extractToolResultText(toolResult) {
  if (!toolResult) return "";
  if (typeof toolResult === "string") return toolResult;
  const parts = [];
  for (const key of ["textResultForLlm", "result", "stdout", "stderr", "output", "content", "message", "error"]) {
    const value = toolResult[key];
    if (typeof value === "string") parts.push(value);
  }
  if (parts.length) return parts.join("\n");
  try {
    return JSON.stringify(toolResult);
  } catch {
    return String(toolResult);
  }
}

// ─── Shell execution ──────────────────────────────────────────────────────────

/**
 * Run a shell command cross-platform.
 *
 * On Windows we use exec() which spawns cmd.exe, letting PowerShell, npm.cmd,
 * npx.cmd, and other .cmd wrappers resolve correctly. On POSIX we use execFile
 * with sh (or $SHELL) directly for cleaner arg escaping.
 *
 * @param {string} command
 * @param {{ cwd?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string, exitCode: number}>}
 */
async function runShell(command, opts = {}) {
  const isWindows = process.platform === "win32";
  const runOpts = {
    cwd: opts.cwd || CWD,
    timeout: opts.timeoutMs || 30_000,
    maxBuffer: 2 * 1024 * 1024,
  };

  try {
    if (isWindows) {
      // exec() uses CreateProcess with cmd.exe; resolves npm.cmd, npx.cmd, etc.
      // Wrap in PowerShell so the user can write PS idioms, but via exec shell:
      const psCmd = `powershell -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`;
      const { stdout, stderr } = await execAsync(psCmd, runOpts);
      return { ok: true, stdout: stdout || "", stderr: stderr || "", exitCode: 0 };
    } else {
      const shell = process.env.SHELL || "sh";
      const { stdout, stderr } = await execFileAsync(shell, ["-c", command], runOpts);
      return { ok: true, stdout: stdout || "", stderr: stderr || "", exitCode: 0 };
    }
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
  help      Show this help
  init      Initialise a new research session in .autoresearch/
  status    Print current session status and metrics
  run       Execute a research command (remainder of args is the command)
  log       Show recent JSONL log entries
  export    Write a full JSON snapshot to autoresearch-export.json
  server    Show extension server info (pid, cwd, status)
  dashboard Start or return the live web dashboard URL
  pause     Pause the active research run
  resume    Resume a paused research run

Tools registered: autoresearch_init, autoresearch_status, autoresearch_run,
  autoresearch_log, autoresearch_export, autoresearch_server,
  autoresearch_dashboard, autoresearch_export_html`;

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
          await ensureDashboard();
          const state = readState();
          if (state.status !== "idle") {
            await session.log(`Session already initialised (status: ${state.status}). Use /autoresearch status to inspect.`, { level: "warning" });
            return;
          }
          const goal = ctx.args.replace(/^init\s*/, "").trim() || undefined;
          stateMgr.startSession(goal, undefined);
          appendLog({ event: "init", goal, cwd: CWD });
          updateMarkdownSummary(readState());
          await session.log(
            `autoresearch session initialised${goal ? ` — goal: ${goal}` : ""}. ` +
              `Dashboard: ${dashboardUrl}. State stored in .autoresearch/state.json`
          );
          return;
        }

        if (sub === "status") {
          await ensureDashboard();
          const state = readState();
          await session.log(buildStatusSummary(state));
          return;
        }

        if (sub === "run") {
          await ensureDashboard();
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
          await ensureDashboard();
          const state = readState();
          const url = dashboardUrl;
          await session.log(
            `Server info:\n` +
            `  cwd: ${CWD}\n` +
            `  pid: ${process.pid}\n` +
            `  status: ${state.status || "idle"}\n` +
            `  dashboard: ${url}\n` +
            `  active SSE clients: ${dashboard.activeClients}`
          );
          return;
        }

        if (sub === "dashboard") {
          const url = await ensureDashboard();
          await session.log(`AutoResearch dashboard: ${url}`);
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
        await ensureDashboard();
        const state = readState();
        if (state.status !== "idle") {
          return {
            resultType: "success",
            textResultForLlm: `Session already initialised (status: ${state.status}). No changes made.`,
          };
        }

        // If the agent didn't supply a goal but UI elicitation is available, ask the user.
        let goal = args?.label || args?.goal || undefined;
        if (!goal && session.capabilities.ui?.elicitation) {
          try {
            const result = await session.ui.input("Research goal for this session?", {
              title: "autoresearch — session goal",
              description: "Describe what you are trying to optimise or discover.",
              maxLength: 200,
            });
            if (result) goal = result;
          } catch {
            // elicitation not available in this host — silently skip
          }
        }

        stateMgr.startSession(goal, args?.benchmark_command || undefined);
        appendLog({ event: "init", goal, cwd: CWD });
        updateMarkdownSummary(readState());
        await session.log(`autoresearch initialised${goal ? ` — ${goal}` : ""}`);
        return {
          resultType: "success",
          textResultForLlm:
            `Session initialised. Dashboard: ${dashboardUrl}. ` +
            `State: ${join(STATE_DIR, "state.json")}, Log: ${LOG_FILE}, Summary: ${MD_FILE}`,
        };
      },
    },

    // autoresearch_status
    {
      name: "autoresearch_status",
      description: "Return the current autoresearch session status, run count, and metrics.",
      parameters: { type: "object", properties: {}, required: [] },
      handler: async () => {
        await ensureDashboard();
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
        await ensureDashboard();
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
          dashboardUrl: dashboardUrl || `http://127.0.0.1:${DEFAULT_PORT} (not started — call autoresearch_dashboard)`,
          dashboardActiveClients: dashboard.activeClients,
          dashboardActivityBuffered: dashboard.copilotEvents.length,
        };
        return {
          resultType: "success",
          textResultForLlm: JSON.stringify(info, null, 2),
        };
      },
    },

    // autoresearch_dashboard
    {
      name: "autoresearch_dashboard",
      description:
        "Start the live localhost web dashboard (http://127.0.0.1:7432) and return its URL. " +
        "The dashboard displays real-time session status, goal, benchmark command, " +
        "metric history chart, experiments table, log tail, best metric, pause/resume controls, " +
        "and a live Agent Activity feed bridged from Copilot CLI session events. " +
        "Uses Server-Sent Events (SSE) for all live updates — zero extra dependencies. " +
        "Endpoints: GET / (UI), GET /api/state (JSON), GET /api/events (SSE stream), " +
        "GET /api/activity (recent agent events JSON), " +
        "POST /api/pause, POST /api/resume, GET /api/export (static HTML snapshot).",
      parameters: { type: "object", properties: {}, required: [] },
      handler: async () => {
        const url = await ensureDashboard();
        await session.log(`AutoResearch dashboard: ${url}`, { ephemeral: true });
        return {
          resultType: "success",
          textResultForLlm:
            `Dashboard URL: ${url}\n` +
            `Endpoints:\n` +
            `  ${url}/               — live SPA dashboard (SSE-powered)\n` +
            `  ${url}/api/state      — current state JSON\n` +
            `  ${url}/api/events     — SSE stream (state + named 'copilot' events)\n` +
            `  ${url}/api/activity   — recent agent activity events JSON\n` +
            `  ${url}/api/export     — static HTML snapshot download\n` +
            `  POST ${url}/api/pause  — pause session\n` +
            `  POST ${url}/api/resume — resume session\n` +
            `Active SSE clients: ${dashboard.activeClients}`,
        };
      },
    },

    // autoresearch_export_html
    {
      name: "autoresearch_export_html",
      description:
        "Export a self-contained static HTML snapshot of the current session " +
        "(experiments, metrics, logs, best metric) to a file. " +
        "The HTML embeds all data and requires no server to view. " +
        "Also available at GET /api/export on the running dashboard.",
      parameters: {
        type: "object",
        properties: {
          output_path: {
            type: "string",
            description: "Output path for the HTML file (default: .autoresearch/snapshot.html).",
          },
        },
        required: [],
      },
      handler: async (args) => {
        const outPath = args?.output_path
          ? resolve(args.output_path)
          : join(STATE_DIR, "snapshot.html");
        const state = readState();
        const html = buildExportHTML(state);
        try {
          writeFileSync(outPath, html, "utf-8");
        } catch (err) {
          return { resultType: "failure", textResultForLlm: `Failed to write HTML: ${err.message}` };
        }
        appendLog({ event: "export_html", path: outPath });
        await session.log(`HTML snapshot exported to ${outPath}`);
        return {
          resultType: "success",
          textResultForLlm: `HTML snapshot written to ${outPath} (${html.length.toLocaleString()} bytes).`,
        };
      },
    },
  ],

  // ── Session hooks ──────────────────────────────────────────────────────────
  hooks: {
    onSessionStart: async (input) => {
      const url = await ensureDashboard();
      dashboard.broadcastEvent('session.start', { source: input.source, dashboardUrl: url });
      await session.log(
        `autoresearch extension loaded (source: ${input.source}) — dashboard: ${url}`,
        { ephemeral: true }
      );
      return {
        additionalContext:
          "The autoresearch extension is active. " +
          "Tools available: autoresearch_init (start session), autoresearch_run (execute experiments), " +
          "autoresearch_status (check progress), autoresearch_dashboard (live web UI at " + url + "), " +
          "autoresearch_log (JSONL entries), autoresearch_export (JSON snapshot), " +
          "autoresearch_export_html (HTML snapshot), autoresearch_server (pause/resume/info). " +
          "METRIC name=value lines in any stdout are automatically captured.",
      };
    },

    onSessionEnd: async (input) => {
      dashboard.broadcastEvent('session.end', { reason: input.reason });
      // Flush final state snapshot so nothing is lost.
      try {
        const s = readState();
        if (s.status !== "idle") {
          updateMarkdownSummary(s);
          appendLog({ event: "session_end", reason: input.reason });
        }
      } catch {
        // best-effort during teardown
      }
      try { await dashboard.stop(); } catch { /* already stopped */ }
    },

    onPreToolUse: async (input) => {
      // Notify the dashboard activity feed of the pending tool call.
      dashboard.broadcastEvent('tool.start', {
        toolName: input.toolName,
        command: input.toolArgs?.command,
      });

      // Block destructive git/fs commands when no session is active.
      if (input.toolName === "bash" || input.toolName === "shell") {
        const cmd = String(input.toolArgs?.command || "");
        const DESTRUCTIVE = /git\s+reset\s+--hard|git\s+clean\s+-[a-zA-Z]*f|rm\s+-rf\s+\//i;
        if (DESTRUCTIVE.test(cmd)) {
          const state = readState();
          if (state.status === "idle") {
            dashboard.broadcastEvent('tool.denied', { toolName: input.toolName, command: cmd.slice(0, 200) });
            return {
              permissionDecision: "deny",
              permissionDecisionReason:
                "Destructive command blocked: autoresearch session not initialised. " +
                "Call autoresearch_init first, or run the command manually.",
            };
          }
          await session.log(
            `⚠ Destructive command in active session: ${cmd.slice(0, 120)}`,
            { level: "warning" }
          );
        }
      }
    },

    onPostToolUse: async (input) => {
      const resultText = extractToolResultText(input.toolResult);
      // Always notify the dashboard that the tool call completed.
      dashboard.broadcastEvent('tool.end', {
        toolName: input.toolName,
        ok: input.toolResult?.resultType !== "failure",
        resultType: input.toolResult?.resultType,
        output: resultText.slice(0, 500),
      });

      // Harvest METRIC lines from any tool output, not just shell tools. In
      // different CLI hosts, shell execution may surface as bash, shell,
      // powershell, or a structured custom-tool result.
      const metrics = parseMetrics(resultText);
      if (Object.keys(metrics).length) {
        const label = `agent_${Date.now()}`;
        for (const [k, v] of Object.entries(metrics)) {
          stateMgr.addMetric(`${label}/${k}`, v);
        }
        appendLog({ event: "metrics_from_agent_tool", tool: input.toolName, metrics });
        dashboard.broadcastEvent('tool.metrics', { toolName: input.toolName, metrics });
        await session.log(
          `autoresearch captured ${Object.keys(metrics).length} metric(s) from agent ${input.toolName} output`,
          { ephemeral: true }
        );
        return {
          additionalContext: `Captured metrics: ${JSON.stringify(metrics)}`,
        };
      }
    },

    onErrorOccurred: async (input) => {
      dashboard.broadcastEvent('error', {
        context: input.errorContext,
        error: String(input.error).slice(0, 300),
        recoverable: input.recoverable,
      });
      try {
        appendLog({
          event: "error",
          context: input.errorContext,
          error: input.error,
          recoverable: input.recoverable,
        });
      } catch { /* don't throw inside error handler */ }
      // Retry transient model call failures once; abort everything else.
      if (input.recoverable && input.errorContext === "model_call") {
        return { errorHandling: "retry", retryCount: 1 };
      }
    },
  },
});

// ── Session event subscriptions ──────────────────────────────────────────────
//
// These bridge Copilot CLI session.on() events to the dashboard SSE activity
// feed via dashboard.broadcastEvent(). The dashboard listens as:
//   es.addEventListener('copilot', handler)
// No separate transport layer is needed because extension.mjs and the HTTP
// server run in the same Node.js process.

// Bridge assistant messages: surface content in the activity feed and harvest
// any METRIC name=value lines the agent may have written in its response.
session.on("tool.execution_start", (event) => {
  try {
    const data = event.data || {};
    dashboard.broadcastEvent('event.tool.start', {
      toolName: data.toolName,
      command: data.arguments?.command,
    });
  } catch { /* never throw in an event listener */ }
});

session.on("tool.execution_complete", (event) => {
  try {
    const data = event.data || {};
    const resultText = extractToolResultText(data.result || data.toolResult || data);
    dashboard.broadcastEvent('event.tool.end', {
      toolName: data.toolName,
      ok: data.success !== false,
      output: resultText.slice(0, 500),
    });
    const metrics = parseMetrics(resultText);
    if (Object.keys(metrics).length) {
      const label = `event_${Date.now()}`;
      for (const [k, v] of Object.entries(metrics)) {
        stateMgr.addMetric(`${label}/${k}`, v);
      }
      appendLog({ event: "metrics_from_tool_event", tool: data.toolName, metrics });
      dashboard.broadcastEvent('event.tool.metrics', { toolName: data.toolName, metrics });
    }
  } catch { /* never throw in an event listener */ }
});

session.on("assistant.message", (event) => {
  try {
    const content = event.data?.content;
    // Truncate to 500 chars to keep the dashboard readable.
    dashboard.broadcastEvent('assistant.message', {
      content: typeof content === 'string' ? content.slice(0, 500) : undefined,
    });
    if (content) {
      // Harvest any METRIC lines the agent itself may have emitted in its response.
      const metrics = parseMetrics(content);
      if (Object.keys(metrics).length) {
        const label = `assistant_${Date.now()}`;
        for (const [k, v] of Object.entries(metrics)) {
          stateMgr.addMetric(`${label}/${k}`, v);
        }
        appendLog({ event: "metrics_from_assistant", metrics });
      }
    }
  } catch { /* never throw in an event listener */ }
});

// Persist on shutdown so the last state is always flushed.
session.on("session.shutdown", () => {
  try {
    dashboard.broadcastEvent('session.shutdown', {});
    const s = readState();
    if (s.status !== "idle") updateMarkdownSummary(s);
    appendLog({ event: "shutdown" });
  } catch { /* best-effort */ }
});
