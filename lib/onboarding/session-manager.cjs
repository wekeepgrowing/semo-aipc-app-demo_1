const crypto = require("crypto");
const { EventEmitter } = require("events");
const pty = require("node-pty");

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 28;

class OnboardingSessionManager {
  constructor({ idleTimeoutMs = 10 * 60 * 1000 } = {}) {
    this.idleTimeoutMs = idleTimeoutMs;
    this.sessions = new Map();
    this.activeSessionId = null;
  }

  hasActiveSession() {
    return Boolean(this.activeSessionId && this.sessions.has(this.activeSessionId));
  }

  getActiveSessionId() {
    if (!this.hasActiveSession()) return null;
    return this.activeSessionId;
  }

  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  startSession({ command, args, cwd, env, cols = DEFAULT_COLS, rows = DEFAULT_ROWS }) {
    if (this.hasActiveSession()) {
      this.cancelSession(this.activeSessionId, "interactive_replaced");
    }

    const sessionId = crypto.randomUUID();
    const events = new EventEmitter();

    let proc;
    try {
      proc = pty.spawn(command, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env: {
          ...env,
          TERM: "xterm-256color",
        },
      });
    } catch (error) {
      const wrapped = new Error(`failed to start interactive session: ${error.message || "spawn failed"}`);
      wrapped.code = "SPAWN_FAILED";
      throw wrapped;
    }

    const session = {
      id: sessionId,
      process: proc,
      events,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      closeReason: null,
      idleTimer: null,
      resolveExit: null,
      exitPromise: null,
    };

    const resetIdleTimer = () => {
      session.lastActivityAt = Date.now();
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.idleTimer = setTimeout(() => {
        this.cancelSession(sessionId, "timeout");
      }, this.idleTimeoutMs);
    };

    session.exitPromise = new Promise((resolve) => {
      session.resolveExit = resolve;
    });

    proc.onData((data) => {
      resetIdleTimer();
      session.events.emit("output", data);
    });

    proc.onExit(({ exitCode, signal }) => {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      this.sessions.delete(sessionId);
      if (this.activeSessionId === sessionId) this.activeSessionId = null;

      const payload = {
        sessionId,
        exitCode,
        signal,
        reason: session.closeReason,
      };

      session.events.emit("exit", payload);
      if (typeof session.resolveExit === "function") session.resolveExit(payload);
      session.events.removeAllListeners();
    });

    resetIdleTimer();
    this.sessions.set(sessionId, session);
    this.activeSessionId = sessionId;

    return {
      sessionId,
      events,
      exitPromise: session.exitPromise,
    };
  }

  sendInput(sessionId, data) {
    const session = this.getSession(sessionId);
    if (!session) return false;
    session.lastActivityAt = Date.now();
    session.process.write(String(data || ""));
    return true;
  }

  resizeSession(sessionId, cols, rows) {
    const session = this.getSession(sessionId);
    if (!session) return false;

    const nextCols = Number(cols) > 0 ? Number(cols) : DEFAULT_COLS;
    const nextRows = Number(rows) > 0 ? Number(rows) : DEFAULT_ROWS;

    try {
      session.process.resize(nextCols, nextRows);
      session.lastActivityAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  cancelSession(sessionId, reason = "interactive_cancelled") {
    const session = this.getSession(sessionId);
    if (!session) return false;
    session.closeReason = reason;
    try {
      session.process.kill();
    } catch {}
    return true;
  }

  shutdownAll(reason = "shutdown") {
    for (const sessionId of this.sessions.keys()) {
      this.cancelSession(sessionId, reason);
    }
  }
}

module.exports = {
  OnboardingSessionManager,
};
