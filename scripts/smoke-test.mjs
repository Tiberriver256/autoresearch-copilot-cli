import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { StateManager } from "../.github/extensions/autoresearch/lib/state.mjs";
import { DashboardServer, buildExportHTML } from "../.github/extensions/autoresearch/lib/server.mjs";

const tempRoots = new Set();

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "autoresearch-test-"));
  tempRoots.add(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sampleState(overrides = {}) {
  return {
    sessionId: "session-1234567890",
    status: "running",
    goal: "escape <goal>",
    benchmarkCommand: "npm test",
    bestMetric: { value: 0.75, experiment: "exp-1", at: "2024-01-01T00:00:00Z" },
    paused: false,
    startedAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:01:00Z",
    currentExperiment: "exp-1",
    metrics: [
      { experiment: "exp-1", value: 0.5, at: "2024-01-01T00:00:10Z", params: { step: 1 } },
      { experiment: "exp-2", value: 0.75, at: "2024-01-01T00:00:20Z", params: { step: 2 } },
    ],
    experiments: [
      {
        id: "exp-1",
        name: "first <experiment>",
        status: "done",
        metric: 0.5,
        startedAt: "2024-01-01T00:00:00Z",
        finishedAt: "2024-01-01T00:00:15Z",
        params: {},
      },
      {
        id: "exp-2",
        name: "second",
        status: "running",
        metric: null,
        startedAt: "2024-01-01T00:00:16Z",
        finishedAt: null,
        params: { lr: 0.1 },
      },
    ],
    logs: [
      { at: "2024-01-01T00:00:00Z", level: "info", msg: "started <ok>" },
      { at: "2024-01-01T00:01:00Z", level: "warn", msg: "careful & continue" },
    ],
    ...overrides,
  };
}

test("StateManager starts from an idle state and recovers from unreadable JSON", () => {
  const dir = tempDir();
  const sm = new StateManager(dir);

  assert.equal(sm.getState().status, "idle");

  writeFileSync(join(dir, "state.json"), "{not-json", "utf8");
  assert.deepEqual(sm.getState().experiments, []);
});

test("StateManager creates a missing state directory", () => {
  const root = tempDir();
  const dir = join(root, "missing", "nested");
  new StateManager(dir);
  assert.equal(existsSync(dir), true);
});

test("StateManager persists state changes atomically and emits changed state", async () => {
  const sm = new StateManager(tempDir());
  const changed = once(sm, "change");

  const state = sm.setState({ status: "running", goal: "measure behavior" });
  const [emitted] = await changed;

  assert.equal(state.status, "running");
  assert.equal(sm.getState().goal, "measure behavior");
  assert.equal(emitted.updatedAt, state.updatedAt);
});

test("StateManager records lifecycle transitions as durable log entries", () => {
  const sm = new StateManager(tempDir());

  const started = sm.startSession("increase coverage", "npm test");
  assert.equal(started.status, "running");
  assert.equal(started.goal, "increase coverage");
  assert.equal(started.benchmarkCommand, "npm test");
  assert.match(started.sessionId, /^[0-9a-f-]+$/);
  assert.equal(started.logs.at(-1).msg, "Session started. Goal: increase coverage");

  const paused = sm.pause();
  assert.equal(paused.status, "paused");
  assert.equal(paused.paused, true);
  assert.equal(paused.logs.at(-1).msg, "Session paused by user");

  const resumed = sm.resume();
  assert.equal(resumed.status, "running");
  assert.equal(resumed.paused, false);
  assert.equal(resumed.logs.at(-1).msg, "Session resumed by user");

  const stopped = sm.stopSession();
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.currentExperiment, null);
  assert.equal(stopped.logs.at(-1).msg, "Session stopped");
});

test("StateManager tolerates older partial state files while appending new data", () => {
  const dir = tempDir();
  const sm = new StateManager(dir);

  writeFileSync(join(dir, "state.json"), "{}", "utf8");
  const withAtomicLog = sm.setState(
    { status: "running" },
    { at: "2024-01-01T00:00:00Z", level: "info", msg: "created from partial state" },
  );
  assert.deepEqual(withAtomicLog.logs.map((entry) => entry.msg), ["created from partial state"]);

  writeFileSync(join(dir, "state.json"), "{}", "utf8");
  const logged = sm.addLog("info", "log from partial state");
  assert.deepEqual(logged.logs.map((entry) => entry.msg), ["log from partial state"]);

  writeFileSync(join(dir, "state.json"), "{}", "utf8");
  const metered = sm.addMetric("exp-from-partial", 0.25);
  assert.equal(metered.metrics.length, 1);
  assert.equal(metered.bestMetric.value, 0.25);

  writeFileSync(join(dir, "state.json"), "{}", "utf8");
  const added = sm.addExperiment("exp-from-partial", "experiment from partial state");
  assert.equal(added.currentExperiment, "exp-from-partial");
  assert.equal(added.experiments.length, 1);

  writeFileSync(join(dir, "state.json"), "{}", "utf8");
  const updated = sm.updateExperiment("missing-experiment", { status: "done" });
  assert.deepEqual(updated.experiments, []);
});

test("StateManager can start a session without optional metadata", () => {
  const sm = new StateManager(tempDir());

  const started = sm.startSession();

  assert.equal(started.goal, null);
  assert.equal(started.benchmarkCommand, null);
  assert.equal(started.logs.at(-1).msg, "Session started. Goal: (none)");
});

test("StateManager keeps bounded logs and preserves the newest entries", () => {
  const sm = new StateManager(tempDir());

  for (let i = 0; i < 205; i += 1) {
    sm.addLog("info", `message-${i}`);
  }

  const logs = sm.getState().logs;
  assert.equal(logs.length, 200);
  assert.equal(logs[0].msg, "message-5");
  assert.equal(logs.at(-1).msg, "message-204");
});

test("StateManager tracks metrics, best metric, and metric retention", () => {
  const sm = new StateManager(tempDir());

  for (let i = 0; i < 505; i += 1) {
    sm.addMetric(`exp-${i}`, i, { generation: i });
  }
  const afterGrowth = sm.addMetric("not-the-best", 10);

  assert.equal(afterGrowth.metrics.length, 500);
  assert.equal(afterGrowth.metrics[0].experiment, "exp-6");
  assert.equal(afterGrowth.metrics.at(-1).experiment, "not-the-best");
  assert.equal(afterGrowth.bestMetric.value, 504);
  assert.equal(afterGrowth.bestMetric.experiment, "exp-504");
});

test("StateManager records and finishes experiments", () => {
  const sm = new StateManager(tempDir());

  const withNamed = sm.addExperiment("chosen-id", "named experiment", { seed: 123 });
  assert.equal(withNamed.currentExperiment, "chosen-id");
  assert.equal(withNamed.experiments[0].name, "named experiment");
  assert.deepEqual(withNamed.experiments[0].params, { seed: 123 });

  const withGenerated = sm.addExperiment(null, "generated experiment");
  assert.match(withGenerated.currentExperiment, /^[0-9a-f-]+$/);

  sm.updateExperiment("chosen-id", { status: "paused" });
  const finished = sm.finishExperiment("chosen-id", 0.9);
  const experiment = finished.experiments.find((e) => e.id === "chosen-id");

  assert.equal(experiment.status, "done");
  assert.equal(experiment.metric, 0.9);
  assert.match(experiment.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("StateManager watches external state file changes and can be stopped repeatedly", async () => {
  const dir = tempDir();
  const sm = new StateManager(dir);
  const changed = new Promise((resolve) => sm.startWatching(resolve));

  sm.startWatching(() => assert.fail("second watcher should not replace the first watcher"));
  writeFileSync(join(dir, "state.json"), JSON.stringify(sampleState({ status: "paused" })), "utf8");

  const state = await changed;
  assert.equal(state.status, "paused");

  sm.stopWatching();
  sm.stopWatching();
});

test("buildExportHTML renders populated and empty snapshots without executable user content", () => {
  const populated = buildExportHTML(sampleState({
    goal: '</script><script>alert("x")</script>',
    logs: [{ at: null, level: "info", msg: "<log>" }],
  }));

  assert.match(populated, /autoresearch snapshot/);
  assert.match(populated, /0\.750000/);
  assert.match(populated, /first &lt;experiment&gt;/);
  assert.match(populated, /&lt;log&gt;/);
  assert.doesNotMatch(populated.match(/<script>([\s\S]*?)<\/script>/)[1], /<\/script>/);
  assert.match(populated, /\\u003c\/script/);
  assert.doesNotMatch(populated, /<script>alert/);

  const empty = buildExportHTML({
    status: "idle",
    goal: null,
    benchmarkCommand: null,
    sessionId: null,
    startedAt: null,
    bestMetric: null,
    experiments: [],
    metrics: [],
    logs: [],
  });
  assert.match(empty, /no experiments/);
  assert.match(empty, /no metrics/);
  assert.match(empty, /no logs/);
  assert.match(empty, /\[idle\]/);

  const partial = buildExportHTML({
    experiments: [{ name: "partial experiment", status: "done", metric: null }],
    metrics: [{ experiment: "partial metric", value: 1 }],
  });
  assert.match(partial, /\[idle\]/);
  assert.match(partial, /partial experiment/);
  assert.match(partial, /partial metric/);
  assert.match(partial, /no logs/);

  const minimal = buildExportHTML({});
  assert.match(minimal, /no experiments/);
  assert.match(minimal, /no metrics/);
  assert.match(minimal, /no logs/);
});

test("DashboardServer serves dashboard, JSON APIs, controls, CORS, SSE, and export", async () => {
  const sm = new StateManager(tempDir());
  sm.setState(sampleState());
  const dashboard = new DashboardServer(sm, 0);
  const baseUrl = await dashboard.start();

  try {
    const dashboardPage = await fetch(`${baseUrl}/`);
    assert.equal(dashboardPage.status, 200);
    assert.match(await dashboardPage.text(), /Agent Activity/);

    const stateResponse = await fetch(`${baseUrl}/api/state`, {
      headers: { Origin: baseUrl },
    });
    assert.equal(stateResponse.headers.get("access-control-allow-origin"), baseUrl);
    assert.equal((await stateResponse.json()).goal, "escape <goal>");

    const disallowedCors = await fetch(`${baseUrl}/api/state`, {
      headers: { Origin: "http://example.com" },
    });
    assert.equal(disallowedCors.headers.get("access-control-allow-origin"), null);

    const malformedCors = await fetch(`${baseUrl}/api/state`, {
      headers: { Origin: "http://%" },
    });
    assert.equal(malformedCors.headers.get("access-control-allow-origin"), null);

    const options = await fetch(`${baseUrl}/api/state`, { method: "OPTIONS" });
    assert.equal(options.status, 204);

    dashboard.broadcastEvent("tool.start", { toolName: "node:test" });
    const activity = await fetch(`${baseUrl}/api/activity`);
    assert.equal((await activity.json()).at(-1).toolName, "node:test");

    const pause = await fetch(`${baseUrl}/api/pause`, { method: "POST" });
    assert.deepEqual(await pause.json(), { ok: true, status: "paused" });
    assert.equal(sm.getState().status, "paused");

    const resume = await fetch(`${baseUrl}/api/resume`, { method: "POST" });
    assert.deepEqual(await resume.json(), { ok: true, status: "running" });
    assert.equal(sm.getState().status, "running");

    const exported = await fetch(`${baseUrl}/api/export`);
    assert.equal(exported.headers.get("content-disposition"), 'attachment; filename="autoresearch-snapshot.html"');
    assert.match(await exported.text(), /autoresearch snapshot/);

    const missing = await fetch(`${baseUrl}/missing`);
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), "Not Found");

    const controller = new AbortController();
    const events = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    assert.equal(events.headers.get("content-type"), "text/event-stream");
    const reader = events.body.getReader();
    const firstChunk = new TextDecoder().decode((await reader.read()).value);
    assert.match(firstChunk, /: connected|data:/);
    assert.equal(dashboard.activeClients, 1);

    writeFileSync(join(sm.stateDir, "state.json"), JSON.stringify(sampleState({ status: "stopped" })), "utf8");
    let sawExternalUpdate = false;
    for (let i = 0; i < 10 && !sawExternalUpdate; i += 1) {
      const next = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve(null), 500)),
      ]);
      sawExternalUpdate = Boolean(
        next?.value && new TextDecoder().decode(next.value).includes('"status":"stopped"'),
      );
    }
    assert.equal(sawExternalUpdate, true);

    controller.abort();

    await assert.rejects(reader.read(), /AbortError/);
    for (let i = 0; i < 20 && dashboard.activeClients !== 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(dashboard.activeClients, 0);
  } finally {
    await dashboard.stop();
  }

  assert.equal(dashboard.activeClients, 0);
});

test("DashboardServer retains only the most recent activity events", async () => {
  const dashboard = new DashboardServer(new StateManager(tempDir()), 0);
  const baseUrl = await dashboard.start();

  try {
    for (let i = 0; i < 105; i += 1) {
      dashboard.broadcastEvent("activity", { index: i });
    }

    const activity = await fetch(`${baseUrl}/api/activity`).then((r) => r.json());
    assert.equal(activity.length, 100);
    assert.equal(activity[0].index, 5);
    assert.equal(activity.at(-1).index, 104);
  } finally {
    await dashboard.stop();
  }
});

test("DashboardServer returns 500 when route handling throws", async () => {
  const dashboard = new DashboardServer(new StateManager(tempDir()), 0);
  const baseUrl = await dashboard.start();

  try {
    dashboard._route = () => { throw new Error("boom"); };
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "boom");
  } finally {
    await dashboard.stop();
  }
});

test("DashboardServer drops broken SSE clients during broadcasts", () => {
  const dashboard = new DashboardServer(new StateManager(tempDir()), 0);
  const broken = { write() { throw new Error("closed"); } };
  dashboard.clients.add(broken);
  dashboard._broadcast({ status: "running" });
  assert.equal(dashboard.activeClients, 0);

  dashboard.clients.add(broken);
  dashboard.broadcastEvent("tool.start", { toolName: "node:test" });
  assert.equal(dashboard.activeClients, 0);
});

test("DashboardServer closes active clients on stop", async () => {
  const dashboard = new DashboardServer(new StateManager(tempDir()), 0);
  let ended = 0;
  dashboard.clients.add({ end() { ended += 1; } });

  await dashboard.stop();

  assert.equal(ended, 1);
  assert.equal(dashboard.activeClients, 0);
});

test("DashboardServer ignores clients that are already closed during stop", async () => {
  const dashboard = new DashboardServer(new StateManager(tempDir()), 0);
  dashboard.clients.add({ end() { throw new Error("already closed"); } });

  await dashboard.stop();

  assert.equal(dashboard.activeClients, 0);
});

test("DashboardServer can stop before it has been started", async () => {
  const dashboard = new DashboardServer(new StateManager(tempDir()), 0);
  await dashboard.stop();
  assert.equal(dashboard.activeClients, 0);
});
