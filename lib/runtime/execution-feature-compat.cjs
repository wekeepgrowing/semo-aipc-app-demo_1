const crypto = require("crypto");
const {
  FEATURE_UI_ROWS,
  getFeatureDefinitionByCanonicalId,
  normalizeExecutionFeatures,
} = require("./feature-contract.cjs");

const FEATURE_ENFORCEMENT_CONTRACT_VERSION = 1;

function normalizeContractVersion(value) {
  const next = Number(value);
  if (!Number.isFinite(next) || next < FEATURE_ENFORCEMENT_CONTRACT_VERSION) return 0;
  return Math.floor(next);
}

function safeObject(value) {
  return value && typeof value === "object" ? value : {};
}

class ExecutionFeatureCompat {
  constructor({
    runtimeStore,
    compatEnabled = process.env.OPENCLAW_FEATURE_COMPAT_MODE !== "0",
    syntheticChatEnabled = process.env.OPENCLAW_FEATURE_TEST_MODE === "1",
  }) {
    this.runtimeStore = runtimeStore;
    this.compatEnabled = Boolean(compatEnabled);
    this.syntheticChatEnabled = Boolean(syntheticChatEnabled);
    this.nativeHttpContractVersion = 0;
    this.nativeWsContractVersion = 0;
  }

  getHttpContractVersion() {
    if (this.nativeHttpContractVersion >= FEATURE_ENFORCEMENT_CONTRACT_VERSION) {
      return this.nativeHttpContractVersion;
    }
    return this.compatEnabled ? FEATURE_ENFORCEMENT_CONTRACT_VERSION : 0;
  }

  getWsContractVersion() {
    if (this.nativeWsContractVersion >= FEATURE_ENFORCEMENT_CONTRACT_VERSION) {
      return this.nativeWsContractVersion;
    }
    return this.compatEnabled ? FEATURE_ENFORCEMENT_CONTRACT_VERSION : 0;
  }

  getStatus() {
    return {
      compatEnabled: this.compatEnabled,
      syntheticChatEnabled: this.syntheticChatEnabled,
      httpContractVersion: this.getHttpContractVersion(),
      wsContractVersion: this.getWsContractVersion(),
      httpContractSource:
        this.nativeHttpContractVersion >= FEATURE_ENFORCEMENT_CONTRACT_VERSION ? "native" : this.compatEnabled ? "compat" : "none",
      wsContractSource:
        this.nativeWsContractVersion >= FEATURE_ENFORCEMENT_CONTRACT_VERSION ? "native" : this.compatEnabled ? "compat" : "none",
    };
  }

  observeHttpCatalog(body) {
    const contractVersion = normalizeContractVersion(safeObject(body).contractVersion);
    if (contractVersion >= FEATURE_ENFORCEMENT_CONTRACT_VERSION) {
      this.nativeHttpContractVersion = contractVersion;
    }
    return this.nativeHttpContractVersion;
  }

  observeWsHello(payload) {
    const snapshot = safeObject(safeObject(payload).snapshot);
    const contracts = safeObject(snapshot.contracts);
    const contractVersion = normalizeContractVersion(contracts.featureEnforcement);
    if (contractVersion >= FEATURE_ENFORCEMENT_CONTRACT_VERSION) {
      this.nativeWsContractVersion = contractVersion;
    }
    return this.nativeWsContractVersion;
  }

  decorateHelloPayload(payload) {
    const source = safeObject(payload);
    this.observeWsHello(source);
    if (this.nativeWsContractVersion >= FEATURE_ENFORCEMENT_CONTRACT_VERSION || !this.compatEnabled) {
      return source;
    }

    const snapshot = safeObject(source.snapshot);
    const contracts = safeObject(snapshot.contracts);
    return {
      ...source,
      snapshot: {
        ...snapshot,
        contracts: {
          ...contracts,
          featureEnforcement: FEATURE_ENFORCEMENT_CONTRACT_VERSION,
        },
      },
    };
  }

  buildCatalogItems() {
    const flags = typeof this.runtimeStore?.getFeatureFlags === "function" ? this.runtimeStore.getFeatureFlags() : {};
    return FEATURE_UI_ROWS.map((row) => ({
      id: row.canonicalId,
      uiId: row.id,
      canonicalId: row.canonicalId,
      supported: true,
      enabled: Boolean(flags[row.id]),
      contractSource:
        this.nativeHttpContractVersion >= FEATURE_ENFORCEMENT_CONTRACT_VERSION ? "native" : this.compatEnabled ? "compat" : "none",
    }));
  }

  buildCatalogPayload() {
    return {
      contractVersion: FEATURE_ENFORCEMENT_CONTRACT_VERSION,
      items: this.buildCatalogItems(),
    };
  }

  handleHttpRequest({ method = "GET", path = "/", body = null }) {
    const requestMethod = String(method || "GET").trim().toUpperCase();
    const requestPath = String(path || "").trim();
    if (!this.compatEnabled) return null;
    if (this.nativeHttpContractVersion >= FEATURE_ENFORCEMENT_CONTRACT_VERSION) return null;

    if (requestMethod === "GET" && (requestPath === "/api/features" || requestPath === "/api/v1/features")) {
      return {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
        },
        body: this.buildCatalogPayload(),
        text: JSON.stringify(this.buildCatalogPayload()),
      };
    }

    const toggleMatch = requestPath.match(/^\/api\/features\/([^/]+)\/toggle$/);
    if (toggleMatch && requestMethod === "POST") {
      const featureId = decodeURIComponent(toggleMatch[1]);
      return this.#toggleFeature(featureId, Boolean(safeObject(body).enabled));
    }

    return null;
  }

  prepareChatSendParams(params = {}) {
    if (this.nativeWsContractVersion >= FEATURE_ENFORCEMENT_CONTRACT_VERSION) {
      return {
        params,
        requestedFeatures: normalizeExecutionFeatures(params.executionFeatures),
      };
    }

    const requestedFeatures = normalizeExecutionFeatures(params.executionFeatures);
    const nextParams = {
      ...params,
    };
    delete nextParams.executionFeatures;
    return {
      params: nextParams,
      requestedFeatures,
    };
  }

  decorateChatSendResponse(payload, requestedFeatures = []) {
    const source = safeObject(payload);
    if (this.nativeWsContractVersion >= FEATURE_ENFORCEMENT_CONTRACT_VERSION) return source;
    if (!this.compatEnabled) return source;
    return {
      ...source,
      ...this.buildExecutionFeatureEnvelope(requestedFeatures),
    };
  }

  createSyntheticChatResult({ sessionKey, message, idempotencyKey, requestedFeatures = [] }) {
    if (!this.syntheticChatEnabled) return null;
    const runId = String(idempotencyKey || crypto.randomUUID());
    const envelope = this.buildExecutionFeatureEnvelope(requestedFeatures);
    const text = `[OpenClaw compatibility test mode]\n${String(message || "").trim() || "테스트 메시지"}`;
    return {
      response: {
        runId,
        id: runId,
        sessionKey: String(sessionKey || "agent:main:main"),
        status: "running",
        ...envelope,
      },
      event: {
        runId,
        sessionKey: String(sessionKey || "agent:main:main"),
        seq: Date.now(),
        state: "final",
        message: {
          role: "assistant",
          text,
        },
        ...envelope,
      },
    };
  }

  buildExecutionFeatureEnvelope(requestedFeatures = []) {
    const normalizedRequested = normalizeExecutionFeatures(requestedFeatures);
    if (normalizedRequested.length === 0) {
      return {
        executionFeatures: [],
        executionFeaturesStatus: "none",
        executionFeaturesError: null,
      };
    }

    const items = new Map(this.buildCatalogItems().map((item) => [item.id, item]));
    for (const featureId of normalizedRequested) {
      const definition = getFeatureDefinitionByCanonicalId(featureId);
      const item = items.get(featureId);
      if (!definition || !item || item.supported === false) {
        return {
          executionFeatures: [],
          executionFeaturesStatus: "failed",
          executionFeaturesError: {
            code: "feature_unsupported",
            message: "OpenClaw feature is not supported",
            details: {
              featureId,
              requestedFeatures: normalizedRequested,
            },
          },
        };
      }
      if (!item.enabled) {
        return {
          executionFeatures: [],
          executionFeaturesStatus: "failed",
          executionFeaturesError: {
            code: "feature_disabled",
            message: "OpenClaw feature is disabled",
            details: {
              featureId,
              requestedFeatures: normalizedRequested,
            },
          },
        };
      }
    }

    return {
      executionFeatures: normalizedRequested,
      executionFeaturesStatus: "enforced",
      executionFeaturesError: null,
    };
  }

  #toggleFeature(canonicalId, enabled) {
    const definition = getFeatureDefinitionByCanonicalId(canonicalId);
    if (!definition) {
      const body = {
        ok: false,
        code: "feature_unsupported",
        error: "unsupported feature id",
      };
      return {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
        body,
        text: JSON.stringify(body),
      };
    }

    this.runtimeStore?.setFeatureEnabled?.(definition.uiId, Boolean(enabled));
    const item = this.buildCatalogItems().find((row) => row.id === definition.canonicalId) || {
      id: definition.canonicalId,
      supported: true,
      enabled: Boolean(enabled),
    };
    const body = {
      ok: true,
      item,
    };
    return {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
      body,
      text: JSON.stringify(body),
    };
  }
}

module.exports = {
  ExecutionFeatureCompat,
  FEATURE_ENFORCEMENT_CONTRACT_VERSION,
};
