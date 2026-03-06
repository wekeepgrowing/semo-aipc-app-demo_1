const {
  FEATURE_IDS,
  FEATURE_UI_ROWS,
  getEnabledFeatureCanonicalIds,
  getFeatureDefinitionByCanonicalId,
  getFeatureDefinitionByUiId,
} = require("./feature-contract.cjs");
const { getDefaultSkillRuntimeRows } = require("./default-skills.cjs");

const FEATURE_LIST_CANDIDATES = [
  { method: "GET", path: "/api/features" },
  { method: "GET", path: "/features" },
  { method: "GET", path: "/api/v1/features" },
];

const FEATURE_TOGGLE_CANDIDATES = [
  { method: "POST", path: "/api/features/:id/toggle", body: (enabled) => ({ enabled }) },
  { method: "PATCH", path: "/api/features/:id", body: (enabled) => ({ enabled }) },
  { method: "POST", path: "/features/:id/toggle", body: (enabled) => ({ enabled }) },
  { method: "PATCH", path: "/features/:id", body: (enabled) => ({ enabled }) },
];

function safeNow() {
  return Date.now();
}

function firstArray(payload, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), payload);
    if (Array.isArray(value)) return value;
  }
  if (Array.isArray(payload)) return payload;
  return null;
}

function firstValue(payload, keys) {
  for (const key of keys) {
    const value = key.split(".").reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), payload);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function normalizeCatalogRows(payload) {
  const rows = firstArray(payload, ["items", "features", "data.items", "data.features"]) || [];
  const out = [];
  for (const row of rows) {
    const rawId = String(firstValue(row, ["id", "slug", "name"]) || "").trim();
    const definition =
      getFeatureDefinitionByCanonicalId(rawId) ||
      getFeatureDefinitionByCanonicalId(String(firstValue(row, ["canonicalId", "canonical_id"]) || "").trim()) ||
      getFeatureDefinitionByUiId(String(firstValue(row, ["uiId", "ui_id"]) || "").trim());
    if (!definition) continue;
    out.push({
      canonicalId: definition.canonicalId,
      uiId: definition.uiId,
      supported: firstValue(row, ["supported"]) === false ? false : true,
      enabled: Boolean(firstValue(row, ["enabled", "active", "installed"])),
      raw: row,
    });
  }
  return out;
}

function normalizeGatewayError(result, fallbackCode, fallbackMessage) {
  const body = result?.body;
  const code = body?.code ? String(body.code) : fallbackCode;
  const message =
    body?.error ? String(body.error) : body?.message ? String(body.message) : fallbackMessage;
  return {
    code,
    error: message,
    details: body && typeof body === "object" ? body : null,
  };
}

function uniqueById(rows = []) {
  const map = new Map();
  for (const row of rows) {
    if (!row || !row.id) continue;
    if (map.has(row.id)) continue;
    map.set(row.id, row);
  }
  return Array.from(map.values());
}

class FeatureToggleManager {
  constructor({ requestRaw, runtimeStore, runtimeAdapter, usecaseDemoRuntime, getExecutionFeatureContractState = null }) {
    this.requestRaw = requestRaw;
    this.runtimeStore = runtimeStore;
    this.runtimeAdapter = runtimeAdapter;
    this.usecaseDemoRuntime = usecaseDemoRuntime;
    this.getExecutionFeatureContractState =
      typeof getExecutionFeatureContractState === "function" ? getExecutionFeatureContractState : () => null;
  }

  buildRows() {
    const flags = this.runtimeStore.getFeatureFlags();
    const status = this.runtimeStore.getFeatureStatus();
    return FEATURE_UI_ROWS.map((row) => ({
      id: row.id,
      canonicalId: row.canonicalId,
      name: row.name,
      description: row.description,
      enabled: Boolean(flags[row.id]),
      status: status[row.id] || null,
    }));
  }

  captureExecutionFeatures() {
    return getEnabledFeatureCanonicalIds(this.runtimeStore.getFeatureFlags(), this.runtimeStore.getFeatureStatus());
  }

  getFeatureSnapshot() {
    return {
      flags: this.runtimeStore.getFeatureFlags(),
      status: this.runtimeStore.getFeatureStatus(),
      executionFeatures: this.captureExecutionFeatures(),
    };
  }

  async refreshFeatures() {
    const contractState = this.getExecutionFeatureContractState() || null;
    const wsContractVersion = Number(contractState?.wsContractVersion || 0);
    if (wsContractVersion < 1) {
      const error = {
        ok: false,
        code: "feature_contract_unsupported",
        error: "OpenClaw execution feature contract is unavailable",
        items: this.buildRows(),
      };
      for (const row of FEATURE_UI_ROWS) {
        const current = this.runtimeStore.getFeatureStatus()[row.id];
        this.runtimeStore.setFeatureEnabled(row.id, false);
        this.runtimeStore.setFeatureStatus(row.id, {
          ...current,
          source: "none",
          supported: false,
          confirmedEnabled: false,
          errorCode: error.code,
          lastError: "OpenClaw 업그레이드가 필요해요",
          details: {
            canonicalId: row.canonicalId,
            contractState,
          },
        });
      }
      return {
        ...error,
        items: this.buildRows(),
      };
    }

    const catalog = await this.fetchFeatureCatalog();
    if (!catalog.ok) {
      for (const row of FEATURE_UI_ROWS) {
        const current = this.runtimeStore.getFeatureStatus()[row.id];
        const next = {
          ...current,
          source: "none",
          supported: false,
          confirmedEnabled: false,
          errorCode: catalog.code,
          lastError: catalog.error,
          details: {
            canonicalId: row.canonicalId,
            ...(catalog.details ? { gateway: catalog.details } : {}),
          },
        };
        this.runtimeStore.setFeatureEnabled(row.id, false);
        this.runtimeStore.setFeatureStatus(row.id, next);
      }
      return {
        ok: false,
        code: catalog.code,
        error: catalog.error,
        items: this.buildRows(),
      };
    }

    this.applyCatalog(catalog.items);
    return {
      ok: true,
      items: this.buildRows(),
    };
  }

  async toggleFeature(featureId, enabled) {
    const definition = getFeatureDefinitionByUiId(featureId);
    if (!definition) {
      return { ok: false, code: "invalid_input", error: "unsupported feature id" };
    }

    const nextEnabled = Boolean(enabled);
    const catalog = await this.fetchFeatureCatalog();
    if (!catalog.ok) {
      await this.refreshFeatures();
      return { ok: false, code: catalog.code, error: catalog.error, details: catalog.details || null };
    }

    const current =
      catalog.items.find((item) => item.canonicalId === definition.canonicalId) ||
      { canonicalId: definition.canonicalId, uiId: definition.uiId, supported: false, enabled: false, raw: null };

    if (!current.supported) {
      const error = {
        code: "feature_unsupported",
        error: `${definition.name} 기능은 현재 OpenClaw에서 지원되지 않아요`,
      };
      this.runtimeStore.setFeatureEnabled(definition.uiId, false);
      this.runtimeStore.setFeatureStatus(definition.uiId, {
        source: "none",
        supported: false,
        confirmedEnabled: false,
        lastAppliedAt: safeNow(),
        errorCode: error.code,
        lastError: error.error,
        details: { canonicalId: definition.canonicalId },
      });
      return { ok: false, ...error };
    }

    const toggled = await this.requestToggle(definition.canonicalId, nextEnabled);
    if (!toggled.ok) {
      this.applyCatalog(catalog.items);
      this.runtimeStore.setFeatureStatus(definition.uiId, {
        source: "api",
        supported: true,
        confirmedEnabled: current.enabled,
        lastAppliedAt: safeNow(),
        errorCode: toggled.code,
        lastError: toggled.error,
        details: {
          canonicalId: definition.canonicalId,
          ...(toggled.details ? { gateway: toggled.details } : {}),
        },
      });
      return toggled;
    }

    const confirmed = await this.fetchFeatureCatalog();
    if (!confirmed.ok) {
      this.runtimeStore.setFeatureEnabled(definition.uiId, false);
      this.runtimeStore.setFeatureStatus(definition.uiId, {
        source: "none",
        supported: true,
        confirmedEnabled: false,
        lastAppliedAt: safeNow(),
        errorCode: "feature_confirmation_missing",
        lastError: "OpenClaw feature state confirmation failed",
        details: {
          canonicalId: definition.canonicalId,
          ...(confirmed.details ? { gateway: confirmed.details } : {}),
        },
      });
      return {
        ok: false,
        code: "feature_confirmation_missing",
        error: "OpenClaw feature state confirmation failed",
      };
    }

    this.applyCatalog(confirmed.items, {
      appliedUiId: definition.uiId,
      appliedAt: safeNow(),
    });

    const target =
      confirmed.items.find((item) => item.canonicalId === definition.canonicalId) ||
      { canonicalId: definition.canonicalId, uiId: definition.uiId, supported: false, enabled: false };

    if (!target.supported) {
      return {
        ok: false,
        code: "feature_unsupported",
        error: `${definition.name} 기능은 현재 OpenClaw에서 지원되지 않아요`,
      };
    }

    if (target.enabled !== nextEnabled) {
      this.runtimeStore.setFeatureEnabled(definition.uiId, false);
      this.runtimeStore.setFeatureStatus(definition.uiId, {
        source: "api",
        supported: true,
        confirmedEnabled: false,
        lastAppliedAt: safeNow(),
        errorCode: "feature_state_mismatch",
        lastError: "OpenClaw feature state does not match the requested value",
        details: {
          canonicalId: definition.canonicalId,
          requested: nextEnabled,
          confirmed: target.enabled,
        },
      });
      return {
        ok: false,
        code: "feature_state_mismatch",
        error: "OpenClaw feature state does not match the requested value",
      };
    }

    let skillAutomation = null;
    if (definition.uiId === "skillFinder" && nextEnabled) {
      skillAutomation = await this.applySkillFinderAutomation();
      this.runtimeStore.setFeatureStatus(definition.uiId, {
        details: {
          canonicalId: definition.canonicalId,
          skillAutomation,
        },
      });
    }

    return {
      ok: true,
      featureId: definition.uiId,
      enabled: nextEnabled,
      status: this.runtimeStore.getFeatureStatus()[definition.uiId],
      skillAutomation,
    };
  }

  applyCatalog(items, { appliedUiId = "", appliedAt = null } = {}) {
    const itemMap = new Map(items.map((item) => [item.canonicalId, item]));
    for (const row of FEATURE_UI_ROWS) {
      const entry = itemMap.get(row.canonicalId);
      const confirmedEnabled = Boolean(entry?.supported && entry?.enabled);
      this.runtimeStore.setFeatureEnabled(row.id, confirmedEnabled);
      this.runtimeStore.setFeatureStatus(row.id, {
        source: "api",
        supported: entry ? Boolean(entry.supported) : false,
        confirmedEnabled,
        lastAppliedAt: row.id === appliedUiId && appliedAt ? appliedAt : this.runtimeStore.getFeatureStatus()[row.id]?.lastAppliedAt,
        errorCode: null,
        lastError: null,
        details: {
          canonicalId: row.canonicalId,
          contractSource: entry?.raw?.contractSource || null,
          ...(entry?.raw && typeof entry.raw === "object" ? { gateway: entry.raw } : {}),
        },
      });
    }
  }

  async fetchFeatureCatalog() {
    if (typeof this.requestRaw !== "function") {
      return { ok: false, code: "feature_unavailable", error: "feature catalog endpoint unavailable" };
    }

    const errors = [];
    for (const candidate of FEATURE_LIST_CANDIDATES) {
      try {
        const result = await this.requestRaw({
          method: candidate.method,
          path: candidate.path,
          timeoutMs: 2500,
        });
        const status = Number(result?.status || 0);
        if (status >= 200 && status < 300) {
          const contractVersion = Number(result?.body?.contractVersion || 0);
          const items = normalizeCatalogRows(result.body);
          if (contractVersion < 1) {
            errors.push({
              code: "feature_contract_unsupported",
              error: `feature contract unavailable from ${candidate.method} ${candidate.path}`,
              details: result?.body || null,
            });
            continue;
          }
          if (items.length === 0) {
            errors.push({
              code: "feature_catalog_failed",
              error: `invalid response from ${candidate.method} ${candidate.path}`,
              details: result?.body || null,
            });
            continue;
          }
          return { ok: true, items };
        }

        if (status === 404) continue;
        errors.push(normalizeGatewayError(result, "feature_catalog_failed", `feature catalog failed (${status || "unknown"})`));
      } catch (error) {
        errors.push({
          code: error?.code || "feature_catalog_failed",
          error: error?.message || `feature catalog request failed: ${candidate.method} ${candidate.path}`,
        });
      }
    }

    return (
      errors[0] || {
        ok: false,
        code: "feature_unavailable",
        error: "feature catalog endpoint unavailable",
      }
    );
  }

  async requestToggle(canonicalId, enabled) {
    if (typeof this.requestRaw !== "function") {
      return { ok: false, code: "feature_unavailable", error: "feature toggle endpoint unavailable" };
    }

    const errors = [];
    for (const candidate of FEATURE_TOGGLE_CANDIDATES) {
      const path = candidate.path.replace(":id", encodeURIComponent(String(canonicalId)));
      try {
        const result = await this.requestRaw({
          method: candidate.method,
          path,
          body: candidate.body ? candidate.body(enabled) : undefined,
          timeoutMs: 2500,
        });
        const status = Number(result?.status || 0);
        if (status >= 200 && status < 300) {
          return { ok: true };
        }
        if (status === 404) continue;
        return {
          ok: false,
          ...normalizeGatewayError(result, "feature_toggle_failed", `feature toggle failed (${status || "unknown"})`),
        };
      } catch (error) {
        errors.push({
          code: error?.code || "feature_toggle_failed",
          error: error?.message || `feature toggle request failed: ${candidate.method} ${path}`,
        });
      }
    }

    return (
      errors[0] || {
        ok: false,
        code: "feature_unavailable",
        error: "feature toggle endpoint unavailable",
      }
    );
  }

  async applySkillFinderAutomation() {
    const rows = uniqueById(getDefaultSkillRuntimeRows());
    let appliedCount = 0;
    const failures = [];

    for (const row of rows) {
      try {
        const result = await this.runtimeAdapter.toggleSkill(row.id, true, { disableLocalFallback: true });
        if (result?.ok) appliedCount += 1;
        else failures.push({ id: row.id, error: result?.error || "toggle failed" });
      } catch (error) {
        failures.push({ id: row.id, error: error?.message || "toggle failed" });
      }
    }

    return {
      discoveredCount: rows.length,
      appliedCount,
      failedCount: failures.length,
      failures,
    };
  }
}

module.exports = {
  FeatureToggleManager,
  FEATURE_IDS,
};
