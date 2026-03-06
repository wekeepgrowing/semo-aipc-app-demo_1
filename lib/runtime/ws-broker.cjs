class RuntimeWsBroker {
  constructor() {
    this.clients = new Map();
  }

  addClient(ws, { runId = null } = {}) {
    this.clients.set(ws, {
      runId: runId ? String(runId) : null,
    });

    ws.on("close", () => {
      this.clients.delete(ws);
    });

    ws.on("error", () => {
      this.clients.delete(ws);
    });
  }

  size() {
    return this.clients.size;
  }

  listSubscribedRunIds() {
    const set = new Set();
    for (const meta of this.clients.values()) {
      if (meta.runId) set.add(String(meta.runId));
    }
    return [...set.values()];
  }

  send(ws, payload) {
    if (!ws || ws.readyState !== 1) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      this.clients.delete(ws);
    }
  }

  broadcast(payload) {
    for (const ws of this.clients.keys()) {
      this.send(ws, payload);
    }
  }

  broadcastRun(runId, payload) {
    const key = String(runId);
    for (const [ws, meta] of this.clients.entries()) {
      if (!meta.runId || meta.runId === key) {
        this.send(ws, payload);
      }
    }
  }

  broadcastSnapshot({ items, runById }) {
    for (const [ws, meta] of this.clients.entries()) {
      const run = meta.runId && runById ? runById[String(meta.runId)] || null : null;
      this.send(ws, {
        type: "snapshot",
        items: Array.isArray(items) ? items : [],
        run,
        ts: Date.now(),
      });
    }
  }
}

module.exports = {
  RuntimeWsBroker,
};
