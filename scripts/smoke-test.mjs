/**
 * smoke-test.mjs — minimal validation without a live Copilot session.
 *
 * Tests the pure-logic helpers extracted from the extension:
 *   - parseMetrics
 *   - buildStatusSummary
 *   - state read/write round-trip
 *   - JSONL append/read round-trip
 */

import { mkdirSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// ── inline copies of helpers (no side-effects from the real extension) ────────

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

function buildStatusSummary(state) {
  const runs = Array.isArray(state.runs) ? state.runs : [];
  const last = runs[runs.length - 1];
  const lines = [`Status: ${state.status || "idle"}`, `Total runs: ${runs.length}`];
  if (last) lines.push(`Last run: ${last.id || "?"} at ${last.started || "?"} — ${last.outcome || "unknown"}`);
  const mKeys = Object.keys(state.metrics || {});
  if (mKeys.length) {
    lines.push("Metrics:");
    mKeys.forEach((k) => lines.push(`  ${k} = ${state.metrics[k]}`));
  }
  return lines.join("\n");
}

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ── Test: parseMetrics ────────────────────────────────────────────────────────

console.log("\nparseMetrics");
{
  const text = `
Training complete
METRIC accuracy=0.93
METRIC loss=0.042
METRIC epoch=10
non-metric line
METRIC bad=abc
`;
  const m = parseMetrics(text);
  assert(m.accuracy === 0.93, "accuracy=0.93");
  assert(m.loss === 0.042, "loss=0.042");
  assert(m.epoch === 10, "epoch=10");
  assert(!("bad" in m), "non-numeric value ignored");
  assert(Object.keys(m).length === 3, "exactly 3 metrics");
}

// ── Test: parseMetrics edge cases ─────────────────────────────────────────────

console.log("\nparseMetrics edge cases");
{
  assert(Object.keys(parseMetrics("")).length === 0, "empty string → no metrics");
  const m = parseMetrics("METRIC f1=1e-3");
  assert(Math.abs(m.f1 - 0.001) < 1e-9, "scientific notation");
}

// ── Test: buildStatusSummary ──────────────────────────────────────────────────

console.log("\nbuildStatusSummary");
{
  const state = {
    status: "ready",
    runs: [{ id: "run-1", started: "2024-01-01T00:00:00Z", outcome: "success" }],
    metrics: { accuracy: 0.93 },
  };
  const s = buildStatusSummary(state);
  assert(s.includes("Status: ready"), "contains status");
  assert(s.includes("Total runs: 1"), "contains run count");
  assert(s.includes("run-1"), "contains run id");
  assert(s.includes("accuracy = 0.93"), "contains metric");
}

// ── Test: state file round-trip ───────────────────────────────────────────────

console.log("\nState file round-trip");
{
  const dir = join(process.cwd(), ".autoresearch-smoke-test-tmp");
  const stateFile = join(dir, "state.json");
  try {
    mkdirSync(dir, { recursive: true });
    const original = { status: "ready", runs: [], metrics: { x: 1 } };
    writeFileSync(stateFile, JSON.stringify(original, null, 2), "utf-8");
    const loaded = JSON.parse(readFileSync(stateFile, "utf-8"));
    assert(loaded.status === "ready", "status round-trips");
    assert(loaded.metrics.x === 1, "metric round-trips");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Test: JSONL append/read ───────────────────────────────────────────────────

console.log("\nJSONL append/read");
{
  const dir = join(process.cwd(), ".autoresearch-smoke-test-tmp2");
  const logFile = join(dir, "test.jsonl");
  try {
    mkdirSync(dir, { recursive: true });
    const records = [
      { event: "init", ts: "2024-01-01T00:00:00Z" },
      { event: "run_start", runId: "run-1", ts: "2024-01-01T00:01:00Z" },
      { event: "run_end", runId: "run-1", outcome: "success", ts: "2024-01-01T00:02:00Z" },
    ];
    for (const r of records) {
      appendFileSync(logFile, JSON.stringify(r) + "\n", "utf-8");
    }
    const lines = readFileSync(logFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert(lines.length === 3, "3 lines written");
    assert(lines[0].event === "init", "first event is init");
    assert(lines[2].outcome === "success", "third event has outcome");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
