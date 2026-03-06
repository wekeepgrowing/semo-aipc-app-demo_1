const crypto = require("crypto");
const EventEmitter = require("events");
const WebSocket = require("ws");

const DEFAULT_SCOPES = ["operator.admin", "operator.approvals", "operator.pairing"];

function randomId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `rpc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

class GatewayRpcClient extends EventEmitter {
  constructor({
    url,
    getToken,
    getPassword,
    origin,
    sendOrigin = false,
    clientId = "gateway-client",
    clientVersion = "dev",
    clientPlatform = "node",
    clientMode = "backend",
    instanceId = `semo-ui-${process.pid}`,
    reconnectBaseMs = 800,
    executionFeatureCompat = null,
  }) {
    super();
    this.url = String(url || "");
    this.origin = String(origin || this.url.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:"));
    this.getToken = typeof getToken === "function" ? getToken : () => null;
    this.getPassword = typeof getPassword === "function" ? getPassword : () => null;
    this.sendOrigin = Boolean(sendOrigin);
    this.clientId = String(clientId || "gateway-client");
    this.clientVersion = clientVersion;
    this.clientPlatform = clientPlatform;
    this.clientMode = clientMode;
    this.instanceId = instanceId;
    this.reconnectBaseMs = Math.max(200, Number(reconnectBaseMs) || 800);
    this.executionFeatureCompat = executionFeatureCompat && typeof executionFeatureCompat === "object" ? executionFeatureCompat : null;

    this.ws = null;
    this.pending = new Map();
    this.closed = true;
    this.ready = false;
    this.connectNonce = null;
    this.connectSent = false;
    this.connectTimer = null;
    this.reconnectTimer = null;
    this.backoffMs = this.reconnectBaseMs;
    this.readyWaiters = [];
    this.lastHelloPayload = null;
  }

  start() {
    this.closed = false;
    this.#connect();
  }

  stop() {
    this.closed = true;
    this.ready = false;
    this.connectNonce = null;
    this.connectSent = false;
    this.lastHelloPayload = null;
    this.#clearTimers();
    this.#rejectAllPending(new Error("gateway rpc stopped"));
    this.#rejectReadyWaiters(new Error("gateway rpc stopped"));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }
    this.ws = null;
  }

  async waitUntilReady(timeoutMs = 8_000) {
    if (this.ready && this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.closed) this.start();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((entry) => entry.resolve !== resolve);
        reject(new Error("gateway rpc connect timeout"));
      }, Math.max(500, Number(timeoutMs) || 8_000));
      this.readyWaiters.push({ resolve, reject, timeout });
      this.#connect();
    });
  }

  async request(method, params, { timeoutMs = 8_000 } = {}) {
    await this.waitUntilReady(timeoutMs);
    return this.#requestRaw(method, params, timeoutMs);
  }

  async sendChat({ sessionKey, message, idempotencyKey, deliver = false, attachments = undefined, executionFeatures = undefined }) {
    const basePayload = {
      sessionKey: String(sessionKey || "agent:main:main"),
      message: String(message || ""),
      deliver: Boolean(deliver),
      idempotencyKey: idempotencyKey || randomId(),
    };
    if (Array.isArray(attachments) && attachments.length > 0) basePayload.attachments = attachments;
    if (Array.isArray(executionFeatures)) {
      basePayload.executionFeatures = executionFeatures.map((item) => String(item || "").trim()).filter(Boolean);
    }

    const compatPrepared =
      this.executionFeatureCompat && typeof this.executionFeatureCompat.prepareChatSendParams === "function"
        ? this.executionFeatureCompat.prepareChatSendParams(basePayload)
        : { params: basePayload, requestedFeatures: Array.isArray(basePayload.executionFeatures) ? basePayload.executionFeatures : [] };

    const synthetic =
      this.executionFeatureCompat && typeof this.executionFeatureCompat.createSyntheticChatResult === "function"
        ? this.executionFeatureCompat.createSyntheticChatResult({
            sessionKey: basePayload.sessionKey,
            message: basePayload.message,
            idempotencyKey: basePayload.idempotencyKey,
            requestedFeatures: compatPrepared.requestedFeatures,
          })
        : null;

    if (synthetic) {
      queueMicrotask(() => {
        try {
          this.emit("chat", synthetic.event);
        } catch {}
      });
      return synthetic.response;
    }

    const result = await this.request("chat.send", compatPrepared.params, { timeoutMs: 20_000 });
    if (this.executionFeatureCompat && typeof this.executionFeatureCompat.decorateChatSendResponse === "function") {
      return this.executionFeatureCompat.decorateChatSendResponse(result, compatPrepared.requestedFeatures);
    }
    return result;
  }

  async chatHistory({ sessionKey, limit = 200 }) {
    return this.request(
      "chat.history",
      {
        sessionKey: String(sessionKey || "agent:main:main"),
        limit: Number.isFinite(Number(limit)) ? Number(limit) : 200,
      },
      { timeoutMs: 8_000 }
    );
  }

  #clearTimers() {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.connectTimer = null;
    this.reconnectTimer = null;
  }

  #resolveReadyWaiters() {
    const entries = [...this.readyWaiters];
    this.readyWaiters = [];
    for (const entry of entries) {
      clearTimeout(entry.timeout);
      try {
        entry.resolve();
      } catch {}
    }
  }

  #rejectReadyWaiters(error) {
    const entries = [...this.readyWaiters];
    this.readyWaiters = [];
    for (const entry of entries) {
      clearTimeout(entry.timeout);
      try {
        entry.reject(error);
      } catch {}
    }
  }

  #rejectAllPending(error) {
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const pending of entries) {
      clearTimeout(pending.timeout);
      try {
        pending.reject(error);
      } catch {}
    }
  }

  #scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(15_000, Math.round(this.backoffMs * 1.7));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  #connect() {
    if (this.closed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (!this.url) return;

    try {
      const options = {};
      if (this.sendOrigin && this.origin) {
        options.origin = this.origin;
        options.headers = {
          origin: this.origin,
        };
      }
      this.ws = new WebSocket(this.url, options);
    } catch (error) {
      this.#scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.connectNonce = null;
      this.connectSent = false;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = setTimeout(() => this.#sendConnect(), 750);
    });

    this.ws.on("message", (raw) => this.#handleMessage(String(raw || "")));
    this.ws.on("error", () => {});
    this.ws.on("close", (code, reason) => {
      const closeReason = String(reason || "");
      this.ready = false;
      this.lastHelloPayload = null;
      this.connectNonce = null;
      this.connectSent = false;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.ws = null;
      const error = new Error(`gateway closed (${code}): ${closeReason || "no reason"}`);
      this.#rejectAllPending(error);
      this.#rejectReadyWaiters(error);
      this.emit("disconnected", { code, reason: closeReason });
      this.#scheduleReconnect();
    });
  }

  #handleMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (!message || typeof message !== "object") return;

    if (message.type === "event") {
      const eventName = String(message.event || "");
      if (eventName === "connect.challenge") {
        this.connectNonce = message?.payload?.nonce || null;
        void this.#sendConnect();
      } else {
        this.emit("event", message);
        if (eventName === "chat") this.emit("chat", message.payload || {});
      }
      return;
    }

    if (message.type === "res") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.ok) pending.resolve(message.payload);
      else {
        const error = new Error(message?.error?.message || "gateway request failed");
        if (message?.error?.code) error.code = String(message.error.code);
        if (message?.error?.details && typeof message.error.details === "object") error.details = message.error.details;
        pending.reject(error);
      }
    }
  }

  async #sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }

    const token = this.getToken?.();
    const password = this.getPassword?.();
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: this.clientId,
        version: this.clientVersion,
        platform: this.clientPlatform,
        mode: this.clientMode,
        instanceId: this.instanceId,
      },
      role: "operator",
      scopes: [...DEFAULT_SCOPES],
      caps: [],
      auth: {
        ...(token ? { token } : {}),
        ...(password ? { password } : {}),
      },
      userAgent: "semo-ui-gateway",
      locale: "ko-KR",
    };

    try {
      let responsePayload = await this.#requestRaw("connect", params, 8_000);
      if (this.executionFeatureCompat && typeof this.executionFeatureCompat.decorateHelloPayload === "function") {
        responsePayload = this.executionFeatureCompat.decorateHelloPayload(responsePayload);
      }
      this.lastHelloPayload = responsePayload;
      this.ready = true;
      this.backoffMs = this.reconnectBaseMs;
      this.#resolveReadyWaiters();
      this.emit("connected", responsePayload);
    } catch (error) {
      this.ready = false;
      this.#rejectReadyWaiters(error);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.close(1008, "connect failed");
        } catch {}
      }
    }
  }

  #requestRaw(method, params, timeoutMs = 8_000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("gateway not connected"));
    }
    const id = randomId();
    const packet = { type: "req", id, method, params };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request timeout: ${method}`));
      }, Math.max(500, Number(timeoutMs) || 8_000));
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.ws.send(JSON.stringify(packet));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  getExecutionFeatureContractState() {
    const compatStatus =
      this.executionFeatureCompat && typeof this.executionFeatureCompat.getStatus === "function"
        ? this.executionFeatureCompat.getStatus()
        : null;
    return {
      hello: this.lastHelloPayload || null,
      httpContractVersion: compatStatus?.httpContractVersion || 0,
      wsContractVersion: compatStatus?.wsContractVersion || 0,
      httpContractSource: compatStatus?.httpContractSource || "none",
      wsContractSource: compatStatus?.wsContractSource || "none",
      compatEnabled: Boolean(compatStatus?.compatEnabled),
      syntheticChatEnabled: Boolean(compatStatus?.syntheticChatEnabled),
    };
  }
}

module.exports = {
  GatewayRpcClient,
};
