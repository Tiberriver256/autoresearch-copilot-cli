/**
 * StateManager — reads/writes .autoresearch/state.json and emits 'change' events.
 * All public methods perform atomic writes (write-to-tmp then rename).
 */
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  watchFile,
  unwatchFile,
} from 'node:fs';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

const MAX_LOGS = 200;
const MAX_METRICS = 500;

const DEFAULT_STATE = {
  sessionId: null,
  status: 'idle',          // idle | running | paused | stopped
  goal: null,
  benchmarkCommand: null,
  bestMetric: null,        // { value, experiment, at }
  paused: false,
  startedAt: null,
  updatedAt: null,
  currentExperiment: null,
  metrics: [],             // [{ experiment, value, at, params }]
  experiments: [],         // [{ id, name, status, metric, startedAt, finishedAt, params }]
  logs: [],                // [{ at, level, msg }]  — last 200
};

export class StateManager extends EventEmitter {
  /** @param {string} stateDir  Absolute path to the .autoresearch directory */
  constructor(stateDir) {
    super();
    this.stateDir = stateDir;
    this.stateFile = join(stateDir, 'state.json');
    this._ensureDir();
    this._watching = false;
  }

  _ensureDir() {
    if (!existsSync(this.stateDir)) {
      mkdirSync(this.stateDir, { recursive: true });
    }
  }

  /** Returns current state (never throws). */
  getState() {
    if (!existsSync(this.stateFile)) return { ...DEFAULT_STATE };
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8'));
    } catch {
      return { ...DEFAULT_STATE };
    }
  }

  /** Merges updates into current state and persists atomically. */
  setState(updates) {
    const next = { ...this.getState(), ...updates, updatedAt: new Date().toISOString() };
    const tmp = this.stateFile + '.tmp';
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(tmp, this.stateFile);
    this.emit('change', next);
    return next;
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  startSession(goal, benchmarkCommand) {
    return this.setState({
      sessionId: randomUUID(),
      status: 'running',
      goal: goal || null,
      benchmarkCommand: benchmarkCommand || null,
      paused: false,
      startedAt: new Date().toISOString(),
      bestMetric: null,
      metrics: [],
      experiments: [],
      currentExperiment: null,
      logs: [{
        at: new Date().toISOString(),
        level: 'info',
        msg: `Session started. Goal: ${goal || '(none)'}`,
      }],
    });
  }

  stopSession() {
    this._addLogMutation('info', 'Session stopped');
    return this.setState({ status: 'stopped', currentExperiment: null });
  }

  pause() {
    this._addLogMutation('info', 'Session paused by user');
    return this.setState({ paused: true, status: 'paused' });
  }

  resume() {
    this._addLogMutation('info', 'Session resumed by user');
    return this.setState({ paused: false, status: 'running' });
  }

  // ── Logging ────────────────────────────────────────────────────────────────

  /** Prepares a log entry to append; call from within setState to avoid double-write. */
  _addLogMutation(level, msg) {
    // This is a direct in-memory prep; actual write handled by caller calling setState after
    this._pendingLog = { at: new Date().toISOString(), level, msg };
  }

  addLog(level, msg) {
    const current = this.getState();
    const entry = { at: new Date().toISOString(), level, msg };
    const logs = [...(current.logs || []), entry].slice(-MAX_LOGS);
    return this.setState({ logs });
  }

  // ── Metrics ────────────────────────────────────────────────────────────────

  /**
   * Records a metric value. Updates bestMetric if value is higher.
   * @param {string} experiment  Experiment ID or name
   * @param {number} value
   * @param {object} [params]    Optional hyperparameters or tags
   */
  addMetric(experiment, value, params = {}) {
    const current = this.getState();
    const entry = { experiment, value, at: new Date().toISOString(), params };
    const metrics = [...(current.metrics || []), entry].slice(-MAX_METRICS);
    const updates = { metrics };
    if (!current.bestMetric || value > current.bestMetric.value) {
      updates.bestMetric = { value, experiment, at: entry.at };
    }
    return this.setState(updates);
  }

  // ── Experiments ────────────────────────────────────────────────────────────

  addExperiment(id, name, params = {}) {
    const current = this.getState();
    const exp = {
      id: id || randomUUID(),
      name,
      status: 'running',
      metric: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      params,
    };
    return this.setState({
      experiments: [...(current.experiments || []), exp],
      currentExperiment: exp.id,
    });
  }

  updateExperiment(id, updates) {
    const current = this.getState();
    const experiments = (current.experiments || []).map(e =>
      e.id === id ? { ...e, ...updates } : e
    );
    return this.setState({ experiments });
  }

  finishExperiment(id, metric, status = 'done') {
    return this.updateExperiment(id, {
      status,
      metric,
      finishedAt: new Date().toISOString(),
    });
  }

  // ── File watching ──────────────────────────────────────────────────────────

  /**
   * Watches the state file for external changes (e.g., written by another process).
   * Calls callback(state) on each change.
   */
  startWatching(callback) {
    if (this._watching) return;
    this._watching = true;
    this._ensureDir();
    // Create file so watchFile has something to watch
    if (!existsSync(this.stateFile)) {
      writeFileSync(this.stateFile, JSON.stringify(DEFAULT_STATE, null, 2), 'utf8');
    }
    watchFile(this.stateFile, { interval: 400, persistent: false }, () => {
      if (callback) callback(this.getState());
    });
  }

  stopWatching() {
    if (!this._watching) return;
    this._watching = false;
    unwatchFile(this.stateFile);
  }
}
