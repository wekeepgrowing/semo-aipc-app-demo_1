const FEATURE_DEFINITIONS = [
  {
    uiId: "knowledgeMap",
    canonicalId: "ontology",
    name: "기억 구조화",
    description: "사람/프로젝트/업무 정보를 관계로 연결해 기억해요",
  },
  {
    uiId: "memoryAutoImprove",
    canonicalId: "self-improving-loop",
    name: "자동 기억 개선",
    description: "기록/검색/정리를 반복해 기억 품질을 개선해요",
  },
  {
    uiId: "proactiveCheck",
    canonicalId: "proactive",
    name: "먼저 알려주기",
    description: "정해진 주기(기본 30분)로 점검하고 필요하면 먼저 알려줘요",
  },
  {
    uiId: "skillFinder",
    canonicalId: "find-skills",
    name: "스킬 찾기",
    description: "필요한 스킬을 찾아 설치/활성화까지 자동으로 시도해요",
  },
];

const FEATURE_IDS = FEATURE_DEFINITIONS.map((item) => item.uiId);
const FEATURE_UI_ROWS = FEATURE_DEFINITIONS.map((item) => ({
  id: item.uiId,
  canonicalId: item.canonicalId,
  name: item.name,
  description: item.description,
}));

function toFiniteNumber(value, fallback = null) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function normalizeFeatureStatus(raw) {
  const row = raw && typeof raw === "object" ? raw : {};
  const source = row.source === "api" || row.source === "none" ? row.source : "none";
  return {
    source,
    supported: row.supported === true ? true : row.supported === false ? false : null,
    confirmedEnabled: Boolean(row.confirmedEnabled),
    lastAppliedAt: toFiniteNumber(row.lastAppliedAt),
    errorCode: row.errorCode ? String(row.errorCode) : null,
    lastError: row.lastError ? String(row.lastError) : null,
    details: row.details && typeof row.details === "object" ? row.details : null,
  };
}

function normalizeExecutionFeatures(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of rows) {
    const value = String(item || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeExecutionFeaturesStatus(value) {
  const next = String(value || "").trim().toLowerCase();
  if (next === "locked" || next === "enforced" || next === "failed") return next;
  return "none";
}

function normalizeExecutionFeaturesError(raw) {
  if (!raw || typeof raw !== "object") return null;
  const code = raw.code ? String(raw.code) : "";
  const message = raw.message ? String(raw.message) : raw.error ? String(raw.error) : "";
  if (!code && !message) return null;
  return {
    code: code || "execution_features_error",
    message: message || "execution feature enforcement failed",
    details: raw.details && typeof raw.details === "object" ? raw.details : null,
  };
}

function getFeatureDefinitionByUiId(id) {
  return FEATURE_DEFINITIONS.find((item) => item.uiId === String(id || "")) || null;
}

function getFeatureDefinitionByCanonicalId(id) {
  return FEATURE_DEFINITIONS.find((item) => item.canonicalId === String(id || "")) || null;
}

function getEnabledFeatureCanonicalIds(flags = {}, statuses = {}) {
  const out = [];
  for (const item of FEATURE_DEFINITIONS) {
    const status = normalizeFeatureStatus(statuses[item.uiId]);
    if (!Boolean(flags[item.uiId])) continue;
    if (status.supported === false) continue;
    if (!status.confirmedEnabled) continue;
    out.push(item.canonicalId);
  }
  return out;
}

module.exports = {
  FEATURE_DEFINITIONS,
  FEATURE_IDS,
  FEATURE_UI_ROWS,
  getEnabledFeatureCanonicalIds,
  getFeatureDefinitionByCanonicalId,
  getFeatureDefinitionByUiId,
  normalizeExecutionFeatures,
  normalizeExecutionFeaturesError,
  normalizeExecutionFeaturesStatus,
  normalizeFeatureStatus,
};
