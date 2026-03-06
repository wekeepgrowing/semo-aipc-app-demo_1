const fs = require("fs");
const path = require("path");

const DEFAULT_FIX_STATE = {
  advancedBypass: {
    disableDeviceAuth: false,
    allowHostHeaderOriginFallback: false,
    enabledAt: null,
    expiresAt: null,
  },
  lastClose: {
    code: null,
    reason: "",
    at: null,
  },
  lastRecover: {
    at: null,
    status: "idle",
    category: "unknown",
    summaryKo: "",
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  return fallback;
}

function asTimestamp(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeAdvancedBypass(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    disableDeviceAuth: asBoolean(source.disableDeviceAuth, false),
    allowHostHeaderOriginFallback: asBoolean(source.allowHostHeaderOriginFallback, false),
    enabledAt: asTimestamp(source.enabledAt),
    expiresAt: asTimestamp(source.expiresAt),
  };
}

function normalizeLastClose(input) {
  const source = input && typeof input === "object" ? input : {};
  const code = Number(source.code);
  return {
    code: Number.isFinite(code) ? code : null,
    reason: source.reason ? String(source.reason) : "",
    at: asTimestamp(source.at),
  };
}

function normalizeLastRecover(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    at: asTimestamp(source.at),
    status: source.status ? String(source.status) : "idle",
    category: source.category ? String(source.category) : "unknown",
    summaryKo: source.summaryKo ? String(source.summaryKo) : "",
  };
}

function normalizeFixState(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    advancedBypass: normalizeAdvancedBypass(source.advancedBypass),
    lastClose: normalizeLastClose(source.lastClose),
    lastRecover: normalizeLastRecover(source.lastRecover),
  };
}

class FixStateStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = clone(DEFAULT_FIX_STATE);
    this.ensureDir();
    this.load();
    this.save();
  }

  ensureDir() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      this.state = clone(DEFAULT_FIX_STATE);
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = normalizeFixState(parsed);
    } catch (error) {
      console.error("fix-state load failed:", error.message);
      this.state = clone(DEFAULT_FIX_STATE);
    }
  }

  save() {
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      console.error("fix-state save failed:", error.message);
    }
  }

  getState() {
    return clone(this.state);
  }

  replace(nextState) {
    this.state = normalizeFixState(nextState);
    this.save();
    return this.getState();
  }

  patch(partial) {
    const source = partial && typeof partial === "object" ? partial : {};
    const merged = {
      ...this.state,
      ...source,
      advancedBypass: source.advancedBypass
        ? { ...this.state.advancedBypass, ...source.advancedBypass }
        : this.state.advancedBypass,
      lastClose: source.lastClose ? { ...this.state.lastClose, ...source.lastClose } : this.state.lastClose,
      lastRecover: source.lastRecover ? { ...this.state.lastRecover, ...source.lastRecover } : this.state.lastRecover,
    };
    this.state = normalizeFixState(merged);
    this.save();
    return this.getState();
  }
}

module.exports = {
  FixStateStore,
  DEFAULT_FIX_STATE,
};
