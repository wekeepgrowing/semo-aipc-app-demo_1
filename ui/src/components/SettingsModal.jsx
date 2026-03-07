import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bot, KeyRound, RefreshCw, Settings2, ShieldAlert, Wrench, X } from "lucide-react";
import { fetchApiJson } from "../lib/http";
import OAuthInteractiveStep from "../onboarding/steps/OAuthInteractiveStep";

const TABS = [
  { id: "ai", label: "AI 서비스", icon: Bot },
  { id: "skill_env", label: "스킬 환경", icon: KeyRound },
  { id: "general", label: "일반", icon: Settings2 },
  { id: "fix", label: "문제 해결", icon: Wrench },
];

const FIX_CATEGORY_LABELS = {
  gateway_down: "연결 서비스 중단",
  pairing_required: "브라우저 승인 필요",
  origin_not_allowed: "현재 주소 허용 필요",
  gateway_token_mismatch: "게이트웨이 인증 불일치",
  device_token_mismatch: "기기 연결 키 불일치",
  abnormal_closure: "연결이 갑자기 종료됨",
  insecure_http_device_identity_required: "안전한 접속 주소 필요",
  unknown: "원인 추가 확인 필요",
};

const FIX_STATUS_LABELS = {
  idle: "실행 안 함",
  recovered: "복구 완료",
  failed: "복구 실패",
  needs_confirmation: "확인 필요",
  reauth_required: "재인증 필요",
  route_change_required: "접속 경로 변경 필요",
};

const FIX_STEP_STATUS_LABELS = {
  ok: "완료",
  warn: "확인 필요",
  error: "실패",
  info: "안내",
};

const FIX_CATEGORY_COPY = {
  gateway_down: {
    title: "연결 서비스가 멈췄어요",
    description: "복구 버튼을 누르면 서비스 재시작부터 시도해요",
  },
  pairing_required: {
    title: "이 브라우저를 한 번 더 승인해야 해요",
    description: "복구 버튼을 누르면 필요한 승인 단계를 이어서 진행해요",
  },
  origin_not_allowed: {
    title: "현재 주소를 한 번 허용해야 해요",
    description: "지금 열어둔 주소를 허용 목록에 추가하면 연결할 수 있어요",
  },
  gateway_token_mismatch: {
    title: "게이트웨이 인증 정보가 맞지 않아요",
    description: "권장 기준에 맞춰 인증 정보를 다시 정리해요",
  },
  device_token_mismatch: {
    title: "이 브라우저의 연결 키를 다시 맞춰야 해요",
    description: "이전에 연결한 기기 정보를 다시 맞추는 순서로 복구해요",
  },
  abnormal_closure: {
    title: "연결이 갑자기 끊겼어요",
    description: "상태를 다시 확인하고 필요한 복구를 순서대로 시도해요",
  },
  insecure_http_device_identity_required: {
    title: "현재 접속 주소로는 연결할 수 없어요",
    description: "더 안전한 접속 주소로 다시 열어야 해요",
  },
  unknown: {
    title: "먼저 상태를 다시 확인해보겠어요",
    description: "가장 안전한 순서대로 점검하며 필요한 작업만 진행해요",
  },
};

const FIX_CONFIRMATION_COPY = {
  origin_allow: {
    title: "이 주소를 허용할까요?",
    description: "현재 브라우저 주소를 허용 목록에 추가해야 연결을 이어갈 수 있어요",
    approveLabel: "허용하고 계속",
  },
  pairing_approve: {
    title: "새 브라우저 연결을 승인할까요?",
    description: "지금 내가 시도한 연결이 맞을 때만 승인해 주세요",
    approveLabel: "승인하고 계속",
  },
  device_select: {
    title: "다시 연결할 기기를 선택해 주세요",
    description: "이전 연결 정보가 맞지 않아 다시 연결할 대상을 골라야 하니 보통 가장 최근에 사용한 기기를 선택하면 돼요",
    approveLabel: "선택하고 계속",
  },
  doctor_repair: {
    title: "강제 수리를 실행할까요?",
    description: "설정을 정리하는 과정에서 일부 항목이 바뀔 수 있으니 꼭 필요할 때만 실행하세요",
    approveLabel: "강제 수리 실행",
  },
};

const FEATURE_DEFAULTS = [
  {
    id: "knowledgeMap",
    canonicalId: "ontology",
    name: "기억 구조화",
    description: "사람/프로젝트/업무 정보를 관계로 연결해 기억해요",
  },
  {
    id: "memoryAutoImprove",
    canonicalId: "self-improving-loop",
    name: "자동 기억 개선",
    description: "기록/검색/정리를 반복해 기억 품질을 개선해요",
  },
  {
    id: "proactiveCheck",
    canonicalId: "proactive",
    name: "먼저 알려주기",
    description: "정해진 주기(기본 30분)로 점검하고 필요하면 먼저 알려줘요",
  },
  {
    id: "skillFinder",
    canonicalId: "find-skills",
    name: "스킬 찾기",
    description: "필요한 스킬을 찾아 설치/활성화까지 자동으로 시도해요",
  },
];

function normalizeFeatureStatus(status) {
  if (!status || typeof status !== "object") {
    return {
      source: "none",
      supported: null,
      confirmedEnabled: false,
      lastAppliedAt: null,
      errorCode: null,
      lastError: null,
      details: null,
    };
  }
  const source = status.source === "api" ? "api" : "none";
  const lastAppliedAt = Number(status.lastAppliedAt);
  return {
    source,
    supported: status.supported === true ? true : status.supported === false ? false : null,
    confirmedEnabled: Boolean(status.confirmedEnabled),
    lastAppliedAt: Number.isFinite(lastAppliedAt) ? lastAppliedAt : null,
    errorCode: status.errorCode ? String(status.errorCode) : null,
    lastError: status.lastError ? String(status.lastError) : null,
    details: status.details && typeof status.details === "object" ? status.details : null,
  };
}

function normalizeFeatureItems(items) {
  const byId = new Map(
    FEATURE_DEFAULTS.map((row) => [row.id, { ...row, enabled: false, status: normalizeFeatureStatus(null) }])
  );
  for (const item of Array.isArray(items) ? items : []) {
    const id = String(item?.id || "");
    const base = byId.get(id);
    if (!base) continue;
    byId.set(id, {
      ...base,
      canonicalId: item?.canonicalId ? String(item.canonicalId) : base.canonicalId,
      name: item?.name ? String(item.name) : base.name,
      description: item?.description ? String(item.description) : base.description,
      enabled: Boolean(item?.enabled),
      status: normalizeFeatureStatus(item?.status),
    });
  }
  return FEATURE_DEFAULTS.map((row) => byId.get(row.id));
}

function normalizeSkillEnvironmentItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    skillId: String(item?.skillId || ""),
    skillName: String(item?.skillName || item?.skillId || "스킬"),
    description: String(item?.description || ""),
    setupHint: item?.setupHint ? String(item.setupHint) : "",
    mode: item?.mode === "all" ? "all" : "any",
    satisfied: Boolean(item?.satisfied),
    fields: (Array.isArray(item?.fields) ? item.fields : []).map((field) => ({
      key: String(field?.key || ""),
      label: String(field?.label || field?.key || ""),
      inputType: String(field?.inputType || "password"),
      placeholder: String(field?.placeholder || ""),
      required: field?.required !== false,
      present: Boolean(field?.present),
      source: field?.source === "file" || field?.source === "process" ? field.source : "none",
    })),
    oauth:
      item?.oauth && typeof item.oauth === "object"
        ? {
            supported: Boolean(item.oauth.supported),
            credentialsReady: Boolean(item.oauth.credentialsReady),
            accountEmail: String(item.oauth.accountEmail || ""),
            accountConnected: Boolean(item.oauth.accountConnected),
            connectedAccounts: (Array.isArray(item.oauth.connectedAccounts) ? item.oauth.connectedAccounts : []).map((entry) =>
              String(entry || "")
            ),
          }
        : null,
  }));
}

function resolveFeatureStatusBadge(status, pending) {
  if (pending) return { label: "적용 중", className: "pending" };
  if (status?.errorCode === "feature_contract_unsupported") return { label: "업그레이드 필요", className: "pending" };
  if (status?.lastError) return { label: "오류", className: "local" };
  if (status?.supported === false) return { label: "미지원", className: "none" };
  if (status?.confirmedEnabled) return { label: "활성", className: "api" };
  if (status?.supported === true) return { label: "비활성", className: "openclaw" };
  return { label: "확인 대기", className: "pending" };
}

function resolveFeatureStatusMessage(status) {
  if (!status || typeof status !== "object") return "";
  if (status.errorCode === "feature_contract_unsupported") return "현재 Semo AI 버전에서는 이 기능 제어를 지원하지 않아 업그레이드가 필요해요";
  if (status.lastError) return status.lastError;
  if (status.supported === false) return "현재 Semo AI가 이 기능을 지원하지 않아요";
  if (status.confirmedEnabled) return "이 기능은 현재 Semo AI에서 활성 상태로 확인됐어요";
  if (status.supported === true) return "Semo AI에서 지원되지만 현재는 꺼져 있어요";
  return "Semo AI 기능 상태를 아직 확인하지 못했어요";
}

function Toggle({ checked, onChange, ariaLabel, disabled = false }) {
  return (
    <button
      type="button"
      className={`dash-modal-switch ${checked ? "on" : ""} ${disabled ? "disabled" : ""}`}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      <span />
    </button>
  );
}

function needsCredential(method) {
  return Boolean(Array.isArray(method?.requiredFields) && method.requiredFields.length > 0);
}

function formatValidationWarning(payload, fallback = "키를 확인하지 못했지만 그래도 진행할 수 있어요") {
  if (!payload || typeof payload !== "object") {
    return { code: "validation_unavailable", message: fallback };
  }
  return {
    code: payload.code || "validation_unavailable",
    message: payload.message || fallback,
  };
}

function normalizeFixCategory(category) {
  const id = typeof category === "string" ? category : "unknown";
  return FIX_CATEGORY_LABELS[id] || FIX_CATEGORY_LABELS.unknown;
}

function normalizeFixStatus(status) {
  const id = typeof status === "string" ? status : "";
  return FIX_STATUS_LABELS[id] || (id ? id : "대기");
}

function normalizeFixStepStatus(status) {
  const id = typeof status === "string" ? status : "info";
  return FIX_STEP_STATUS_LABELS[id] || FIX_STEP_STATUS_LABELS.info;
}

function normalizeFixOrigin(origin) {
  try {
    return new URL(String(origin || "")).origin;
  } catch {
    return "";
  }
}

function formatDateTime(value) {
  const ts = Number(value);
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  return new Date(ts).toLocaleString("ko-KR");
}

function humanizeMethodLabel(method) {
  if (method?.label) return String(method.label);
  const methodId = String(method?.id || "").trim().toLowerCase();
  if (!methodId) return "알 수 없음";
  if (methodId.includes("oauth")) return "OAuth 연결";
  if (methodId.includes("interactive")) return "브라우저 인증";
  if (methodId.includes("api") || methodId.includes("key")) return "API 키";
  return methodId;
}

function humanizeRuntimeSourceLabel(source) {
  const id = String(source || "").trim().toLowerCase();
  if (id === "gateway_status") return "현재 Semo AI 세션 기준";
  if (id === "session_log") return "최근 Semo AI 대화 기준";
  if (id === "usage_ledger") return "최근 실행 기록 기준";
  return "최근 Semo AI 기준";
}

function formatRuntimeModelLabel(runtimeModel) {
  if (!runtimeModel || typeof runtimeModel !== "object") return "아직 확인되지 않음";
  const model = String(runtimeModel.model || "").trim();
  const api = String(runtimeModel.api || "").trim();
  if (model && api && api !== model) return `${model} · ${api}`;
  if (model) return model;
  if (api) return api;
  return "아직 확인되지 않음";
}

function resolveFixDiagnosisPreview(preview) {
  const category = typeof preview?.category === "string" ? preview.category : "unknown";
  const base = FIX_CATEGORY_COPY[category] || FIX_CATEGORY_COPY.unknown;
  return {
    category,
    label: normalizeFixCategory(category),
    title: base.title,
    description: base.description,
    hint: preview?.hint ? String(preview.hint) : "",
  };
}

function resolveFixConfirmationCopy(confirmation) {
  if (!confirmation || typeof confirmation !== "object") {
    return {
      title: "확인이 필요해요",
      description: "복구 작업을 계속해도 되는지 확인해 주세요",
      approveLabel: "계속",
    };
  }
  const type = typeof confirmation.type === "string" ? confirmation.type : "";
  return FIX_CONFIRMATION_COPY[type] || {
    title: "확인이 필요해요",
    description: confirmation.message || "복구 작업을 계속해도 되는지 확인해 주세요",
    approveLabel: "계속",
  };
}

function SectionHeader({ title, description, onClose }) {
  return (
    <header className="dash-modal-section-header">
      <div className="dash-modal-header-copy">
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <button className="dash-modal-close" aria-label="설정 닫기" onClick={onClose}>
        <X size={16} />
      </button>
    </header>
  );
}

export default function SettingsModal({
  open,
  onOpenChange,
  initialTab = "ai",
  highlightSkillId = "",
  onSkillEnvironmentSaved,
}) {
  const [activeTab, setActiveTab] = useState("ai");
  const [features, setFeatures] = useState(() => normalizeFeatureItems(null));
  const [featurePendingMap, setFeaturePendingMap] = useState({});
  const [featureError, setFeatureError] = useState("");
  const [skillEnvironmentItems, setSkillEnvironmentItems] = useState([]);
  const [skillEnvironmentValues, setSkillEnvironmentValues] = useState({});
  const [skillEnvironmentSavingSkillId, setSkillEnvironmentSavingSkillId] = useState("");
  const [skillEnvironmentError, setSkillEnvironmentError] = useState("");
  const [skillEnvironmentNotice, setSkillEnvironmentNotice] = useState("");
  const [gogOauthUrl, setGogOauthUrl] = useState("");
  const [gogOauthRedirectUrl, setGogOauthRedirectUrl] = useState("");
  const [gogOauthPending, setGogOauthPending] = useState("");

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [providers, setProviders] = useState([]);
  const [connected, setConnected] = useState({ providerId: null, methodId: null, configured: false });
  const [runtimeModel, setRuntimeModel] = useState(null);

  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedMethodId, setSelectedMethodId] = useState("");
  const [credentials, setCredentials] = useState({});
  const [applyError, setApplyError] = useState("");
  const [applyStatus, setApplyStatus] = useState("idle");
  const [keyValidationWarning, setKeyValidationWarning] = useState(null);
  const [interactiveSessionId, setInteractiveSessionId] = useState("");

  const [fixState, setFixState] = useState(null);
  const [fixLoading, setFixLoading] = useState(false);
  const [fixRunning, setFixRunning] = useState(false);
  const [fixError, setFixError] = useState("");
  const [fixResult, setFixResult] = useState(null);
  const [fixConfirmation, setFixConfirmation] = useState(null);
  const [fixConfirmRememberOrigin, setFixConfirmRememberOrigin] = useState(false);
  const [fixSelectedDeviceId, setFixSelectedDeviceId] = useState("");
  const [fixSelectedDeviceRole, setFixSelectedDeviceRole] = useState("operator");
  const [fixOptions, setFixOptions] = useState({
    applyChannelMitigation: true,
  });
  const [fixAdvancedOpen, setFixAdvancedOpen] = useState(false);
  const [fixAdvanced, setFixAdvanced] = useState({
    disableDeviceAuth: false,
    allowHostHeaderOriginFallback: false,
  });

  const resetConnectProgress = useCallback(() => {
    setApplyStatus("idle");
    setApplyError("");
    setKeyValidationWarning(null);
    setInteractiveSessionId("");
  }, []);

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab || "ai");
    }
  }, [initialTab, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeydown = (event) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [open, onOpenChange]);

  const loadSettings = useCallback(async ({ restoreInteractive = false } = {}) => {
    setLoading(true);
    setLoadError("");
    try {
      const json = await fetchApiJson("/api/ui/runtime/settings");
      const nextProviders = Array.isArray(json.providers) ? json.providers : [];
      const providerId = json.connected?.providerId || nextProviders[0]?.id || "";
      const provider = nextProviders.find((entry) => entry.id === providerId) || nextProviders[0] || null;
      const methodId = json.connected?.methodId || provider?.methods?.[0]?.id || "";

      setProviders(nextProviders);
      setConnected(json.connected || { providerId: null, methodId: null, configured: false });
      setRuntimeModel(json.runtimeModel && typeof json.runtimeModel === "object" ? json.runtimeModel : null);
      setSelectedProviderId(providerId);
      setSelectedMethodId(methodId);
      setCredentials({});
      setKeyValidationWarning(null);
      setFeatures(normalizeFeatureItems(json.features?.items));
      setFeatureError(json.features?.ok === false && json.features?.error ? String(json.features.error) : "");
      const nextSkillEnvironmentItems = normalizeSkillEnvironmentItems(json.skillEnvironment?.items);
      setSkillEnvironmentItems(nextSkillEnvironmentItems);
      setSkillEnvironmentValues((prev) => {
        const next = {};
        for (const item of nextSkillEnvironmentItems) {
          next[item.skillId] = {};
          for (const field of item.fields) {
            next[item.skillId][field.key] = prev?.[item.skillId]?.[field.key] || "";
          }
        }
        return next;
      });
      const gogItem = nextSkillEnvironmentItems.find((item) => item.skillId === "gog");
      if (gogItem?.oauth?.accountConnected) {
        setGogOauthUrl("");
        setGogOauthRedirectUrl("");
      }

      if (restoreInteractive) {
        try {
          const onboarding = await fetchApiJson("/api/ui/onboarding/state");
          const activeSessionId = typeof onboarding?.activeSessionId === "string" ? onboarding.activeSessionId : "";
          const hasActiveInteractive = Boolean(onboarding?.interactiveAuthInProgress && activeSessionId);
          if (hasActiveInteractive) {
            const snapshotProviderId =
              typeof onboarding?.activeProviderId === "string" ? onboarding.activeProviderId : "";
            const snapshotMethodId = typeof onboarding?.activeMethodId === "string" ? onboarding.activeMethodId : "";
            const snapshotProvider = nextProviders.find((entry) => entry.id === snapshotProviderId) || null;
            const snapshotMethod =
              snapshotProvider?.methods?.find((method) => method.id === snapshotMethodId) ||
              snapshotProvider?.methods?.[0] ||
              null;

            if (snapshotProvider) {
              setSelectedProviderId(snapshotProvider.id);
              setSelectedMethodId(snapshotMethod?.id || "");
            }

            setApplyStatus("interactive_pending");
            setInteractiveSessionId(activeSessionId);
          }
        } catch {
          // ignore onboarding snapshot restore errors
        }
      }
    } catch (error) {
      setLoadError(error.message || "설정 정보를 불러오지 못했어요");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      resetConnectProgress();
      setSkillEnvironmentError("");
      setSkillEnvironmentNotice("");
      setSkillEnvironmentSavingSkillId("");
      setFixConfirmation(null);
      setFixError("");
      setFixRunning(false);
      setFixResult(null);
      return;
    }
    resetConnectProgress();
    void loadSettings({ restoreInteractive: true });
  }, [open, loadSettings, resetConnectProgress]);

  const selectedProvider = useMemo(() => providers.find((provider) => provider.id === selectedProviderId) || null, [providers, selectedProviderId]);
  const selectedMethod = useMemo(
    () => selectedProvider?.methods?.find((method) => method.id === selectedMethodId) || null,
    [selectedProvider, selectedMethodId]
  );
  const connectedProvider = useMemo(
    () => providers.find((provider) => provider.id === connected?.providerId) || null,
    [providers, connected?.providerId]
  );
  const connectedMethod = useMemo(
    () => connectedProvider?.methods?.find((method) => method.id === connected?.methodId) || null,
    [connected?.methodId, connectedProvider]
  );
  const runtimeProvider = useMemo(
    () => providers.find((provider) => provider.id === runtimeModel?.provider) || null,
    [providers, runtimeModel?.provider]
  );
  const connectedProviderLabel = connectedProvider?.label || connected?.providerId || "알 수 없음";
  const connectedMethodLabel = humanizeMethodLabel(connectedMethod || { id: connected?.methodId, label: connected?.methodId });
  const runtimeProviderLabel = runtimeProvider?.label || runtimeModel?.provider || "";
  const runtimeServiceLabel =
    connected?.providerId && connected?.configured
      ? connectedProviderLabel
      : runtimeProviderLabel || (connected?.configured ? "Semo AI" : "미연결");
  const connectedServiceSummaryLabel = connected?.providerId ? connectedProviderLabel : runtimeServiceLabel;
  const connectedModelLabel = formatRuntimeModelLabel(runtimeModel);
  const runtimeSourceLabel = runtimeModel ? humanizeRuntimeSourceLabel(runtimeModel.source) : "실행 기록 없음";
  const runtimeObservedLabel = runtimeModel?.ts ? formatDateTime(runtimeModel.ts) : "아직 없음";

  useEffect(() => {
    if (!selectedProvider) return;
    if (!selectedProvider.methods?.some((method) => method.id === selectedMethodId)) {
      setSelectedMethodId(selectedProvider.methods?.[0]?.id || "");
    }
  }, [selectedProvider, selectedMethodId]);

  const onApply = async ({ skipKeyValidation = false } = {}) => {
    if (!selectedProvider || !selectedMethod) return;

    if (needsCredential(selectedMethod)) {
      const missing = selectedMethod.requiredFields.some((field) => !String(credentials[field] || "").trim());
      if (missing) {
        setApplyError("필수 인증 정보를 입력해 주세요");
        return;
      }
    }

    if (selectedMethod.mode === "non_interactive" && !skipKeyValidation) {
      try {
        const validation = await fetchApiJson("/api/ui/onboarding/validate-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerId: selectedProvider.id,
            methodId: selectedMethod.id,
            credentials,
          }),
        });

        if (!validation.valid && validation.canProceed) {
          setApplyStatus("idle");
          setKeyValidationWarning(formatValidationWarning(validation));
          return;
        }
        setKeyValidationWarning(null);
      } catch (error) {
        setApplyStatus("idle");
        setKeyValidationWarning(
          formatValidationWarning({
            code: error.code || "validation_unavailable",
            message: error.message || "키를 확인하지 못했지만 그래도 진행할 수 있어요",
          })
        );
        return;
      }
    } else {
      setKeyValidationWarning(null);
    }

    setApplyError("");
    setApplyStatus("connecting");
    setInteractiveSessionId("");

    try {
      const json = await fetchApiJson("/api/ui/onboarding/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: selectedProvider.id,
          methodId: selectedMethod.id,
          credentials,
          options: {
            resetScope: "none",
          },
        }),
      });

      if (json.status === "configured") {
        setApplyStatus("connected");
        await loadSettings();
        return;
      }

      if (json.status === "interactive_required" && json.sessionId) {
        setApplyStatus("interactive_pending");
        setInteractiveSessionId(json.sessionId);
        return;
      }

      throw new Error("지원하지 않는 응답 상태예요");
    } catch (error) {
      setApplyStatus("idle");
      setApplyError(error.message || "서비스 연결에 실패했어요");
    }
  };

  const onInteractiveExit = async (result) => {
    if (result?.ok) {
      setInteractiveSessionId("");
      setApplyStatus("connected");
      setApplyError("");
      await loadSettings();
      return;
    }

    setInteractiveSessionId("");
    setApplyStatus("idle");
    setKeyValidationWarning(null);
    setApplyError(result?.message || "인증 세션이 종료됐어요");
  };

  const onInteractiveCancel = async () => {
    setInteractiveSessionId("");
    setApplyStatus("idle");
    setApplyError("[interactive_cancelled] 인증이 취소됐어요");
  };

  const onChangeSkillEnvironmentValue = (skillId, envKey, nextValue) => {
    setSkillEnvironmentValues((prev) => ({
      ...prev,
      [skillId]: {
        ...(prev?.[skillId] || {}),
        [envKey]: nextValue,
      },
    }));
    setSkillEnvironmentError("");
    setSkillEnvironmentNotice("");
  };

  const onSaveSkillEnvironment = async (item) => {
    const skillId = String(item?.skillId || "").trim();
    if (!skillId) return;
    const drafts = skillEnvironmentValues?.[skillId] || {};
    const updates = {};
    for (const field of item.fields || []) {
      const value = String(drafts[field.key] || "").trim();
      if (value) updates[field.key] = value;
    }

    if (Object.keys(updates).length === 0) {
      setSkillEnvironmentError("저장할 환경 변수 값을 하나 이상 입력해 주세요");
      return;
    }

    setSkillEnvironmentSavingSkillId(skillId);
    setSkillEnvironmentError("");
    setSkillEnvironmentNotice("");

    try {
      const json = await fetchApiJson("/api/ui/runtime/settings/skill-env", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updates,
          restartGateway: true,
        }),
      });
      const sideEffects = Array.isArray(json?.sideEffects) ? json.sideEffects : [];
      const failedSideEffect = sideEffects.find((entry) => entry?.ok === false);
      const successSideEffectMessages = sideEffects
        .filter((entry) => entry?.ok !== false)
        .map((entry) => (entry?.message ? String(entry.message) : ""))
        .filter(Boolean);
      setSkillEnvironmentNotice(
        [
          json?.restart?.requested
            ? json?.restart?.ok === false
              ? "값은 저장했지만 Semo AI 재시작은 확인되지 않았어요"
              : "값을 저장했고 Semo AI를 다시 불러왔어요"
            : "값을 저장했어요",
          ...successSideEffectMessages,
        ]
          .filter(Boolean)
          .join(" ")
      );
      if (failedSideEffect?.message) {
        setSkillEnvironmentError(String(failedSideEffect.message));
      }
      setSkillEnvironmentValues((prev) => ({
        ...prev,
        [skillId]: Object.keys(prev?.[skillId] || {}).reduce((acc, key) => {
          acc[key] = "";
          return acc;
        }, {}),
      }));
      await loadSettings();
      if (typeof onSkillEnvironmentSaved === "function") {
        await onSkillEnvironmentSaved();
      }
    } catch (error) {
      setSkillEnvironmentError(error.message || "환경 변수 저장에 실패했어요");
    } finally {
      setSkillEnvironmentSavingSkillId("");
    }
  };

  const onStartGogOauth = async () => {
    setGogOauthPending("start");
    setSkillEnvironmentError("");
    setSkillEnvironmentNotice("");

    try {
      const json = await fetchApiJson("/api/ui/runtime/settings/skill-env/gog/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      setGogOauthUrl(String(json?.authUrl || ""));
      setSkillEnvironmentNotice("Google 로그인 페이지를 열고 승인한 뒤, 마지막에 이동한 주소를 아래에 붙여 넣어 주세요");
      await loadSettings();
      if (typeof onSkillEnvironmentSaved === "function") {
        await onSkillEnvironmentSaved();
      }
    } catch (error) {
      setSkillEnvironmentError(error.message || "gog 계정 연결 시작에 실패했어요");
    } finally {
      setGogOauthPending("");
    }
  };

  const onCompleteGogOauth = async () => {
    const redirectUrl = String(gogOauthRedirectUrl || "").trim();
    if (!redirectUrl) {
      setSkillEnvironmentError("Google 승인 후 마지막에 이동한 주소를 입력해 주세요");
      return;
    }

    setGogOauthPending("complete");
    setSkillEnvironmentError("");
    setSkillEnvironmentNotice("");

    try {
      await fetchApiJson("/api/ui/runtime/settings/skill-env/gog/oauth/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          redirectUrl,
        }),
      });
      setGogOauthUrl("");
      setGogOauthRedirectUrl("");
      setSkillEnvironmentNotice("gog 계정 연결을 완료했어요");
      await loadSettings();
      if (typeof onSkillEnvironmentSaved === "function") {
        await onSkillEnvironmentSaved();
      }
    } catch (error) {
      setSkillEnvironmentError(error.message || "gog 계정 연결 완료 처리에 실패했어요");
    } finally {
      setGogOauthPending("");
    }
  };

  const onToggleFeature = async (featureId, nextEnabled) => {
    setFeatureError("");
    setFeaturePendingMap((prev) => ({ ...prev, [featureId]: true }));

    try {
      const json = await fetchApiJson(`/api/ui/runtime/features/${encodeURIComponent(featureId)}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      const nextFeature = json?.feature;
      if (nextFeature?.id === featureId) {
        setFeatures((prev) =>
          prev.map((item) =>
            item.id === featureId
              ? {
                  ...item,
                  canonicalId: nextFeature.canonicalId ? String(nextFeature.canonicalId) : item.canonicalId,
                  name: nextFeature.name ? String(nextFeature.name) : item.name,
                  description: nextFeature.description ? String(nextFeature.description) : item.description,
                  enabled: Boolean(nextFeature.enabled),
                  status: normalizeFeatureStatus(nextFeature.status),
                }
              : item
          )
        );
      } else {
        await loadSettings();
      }
    } catch (error) {
      setFeatureError(error.message || "기능 설정 반영에 실패했어요");
    } finally {
      setFeaturePendingMap((prev) => ({ ...prev, [featureId]: false }));
    }
  };

  const currentOrigin = useMemo(() => {
    if (typeof window === "undefined") return "";
    return normalizeFixOrigin(window.location.origin);
  }, []);

  const loadFixState = useCallback(async () => {
    if (!open) return;
    setFixLoading(true);
    try {
      const json = await fetchApiJson(`/api/ui/runtime/fix/state?origin=${encodeURIComponent(currentOrigin || "")}`);
      setFixState(json);
      setFixError("");
      if (json?.advancedBypass && typeof json.advancedBypass === "object") {
        setFixAdvanced({
          disableDeviceAuth: Boolean(json.advancedBypass.disableDeviceAuth),
          allowHostHeaderOriginFallback: Boolean(json.advancedBypass.allowHostHeaderOriginFallback),
        });
      }
    } catch (error) {
      setFixError(error.message || "Fix 상태를 불러오지 못했어요");
    } finally {
      setFixLoading(false);
    }
  }, [open, currentOrigin]);

  useEffect(() => {
    if (!open || activeTab !== "fix") return undefined;
    void loadFixState();
    const timer = window.setInterval(() => {
      void loadFixState();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [open, activeTab, loadFixState]);

  const runFix = useCallback(
    async ({
      confirmation = null,
      runDoctorRepair = false,
      applyAdvancedBypass = false,
      overrideOptions = null,
      overrideAdvancedBypass = null,
    } = {}) => {
      setFixError("");
      setFixConfirmation(null);
      setFixRunning(true);
      try {
        const rememberOriginKey = currentOrigin ? `fix.origin.allow.auto::${currentOrigin}` : "";
        const autoApprovedOrigin =
          !confirmation &&
          rememberOriginKey &&
          typeof window !== "undefined" &&
          window.localStorage.getItem(rememberOriginKey) === "1";

        const requestConfirmation =
          confirmation ||
          (autoApprovedOrigin
            ? {
                type: "origin_allow",
                approved: true,
                remember: true,
                origin: currentOrigin,
                requestId: `remembered-${Date.now()}`,
              }
            : null);

        const baseOptions = overrideOptions && typeof overrideOptions === "object" ? overrideOptions : fixOptions;
        const payload = {
          origin: currentOrigin,
          options: {
            applyChannelMitigation: Boolean(baseOptions.applyChannelMitigation),
            runDoctorRepair: Boolean(runDoctorRepair),
            applyAdvancedBypass: Boolean(applyAdvancedBypass),
            forceCategory: baseOptions.forceCategory || undefined,
            deviceHint: baseOptions.deviceHint || undefined,
            advancedBypass: {
              disableDeviceAuth: Boolean((overrideAdvancedBypass || fixAdvanced).disableDeviceAuth),
              allowHostHeaderOriginFallback: Boolean((overrideAdvancedBypass || fixAdvanced).allowHostHeaderOriginFallback),
            },
          },
          confirmation: requestConfirmation,
        };

        const json = await fetchApiJson("/api/ui/runtime/fix/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        setFixResult(json);
        if (json?.status === "needs_confirmation" && json?.confirmationRequest) {
          setFixConfirmation(json.confirmationRequest);
          setFixConfirmRememberOrigin(false);
          const candidates = Array.isArray(json.confirmationRequest?.candidates) ? json.confirmationRequest.candidates : [];
          if (candidates.length > 0) {
            const first = candidates[0];
            setFixSelectedDeviceId(String(first.id || ""));
            setFixSelectedDeviceRole(String(first.role || "operator"));
          }
        } else {
          setFixConfirmation(null);
        }
        await loadFixState();
      } catch (error) {
        setFixError(error.message || "자동 복구 실행에 실패했어요");
      } finally {
        setFixRunning(false);
      }
    },
    [currentOrigin, fixAdvanced, fixOptions, loadFixState]
  );

  const onApproveConfirmation = async () => {
    if (!fixConfirmation || fixRunning) return;
    const type = fixConfirmation.type;
    if (type === "origin_allow") {
      const normalizedOrigin = normalizeFixOrigin(fixConfirmation.origin || currentOrigin);
      if (fixConfirmRememberOrigin && normalizedOrigin && typeof window !== "undefined") {
        window.localStorage.setItem(`fix.origin.allow.auto::${normalizedOrigin}`, "1");
      }
      await runFix({
        confirmation: {
          type: "origin_allow",
          approved: true,
          remember: fixConfirmRememberOrigin,
          origin: normalizedOrigin,
          requestId: fixConfirmation.requestId || `confirm-${Date.now()}`,
        },
      });
      return;
    }

    if (type === "pairing_approve") {
      await runFix({
        confirmation: {
          type: "pairing_approve",
          approved: true,
          requestId: fixConfirmation.requestId || `confirm-${Date.now()}`,
        },
      });
      return;
    }

    if (type === "device_select") {
      await runFix({
        confirmation: {
          type: "device_select",
          approved: true,
          deviceId: fixSelectedDeviceId,
          role: fixSelectedDeviceRole || "operator",
          requestId: fixConfirmation.requestId || `confirm-${Date.now()}`,
        },
      });
      return;
    }

    if (type === "doctor_repair") {
      await runFix({
        runDoctorRepair: true,
        confirmation: {
          type: "doctor_repair",
          approved: true,
          requestId: fixConfirmation.requestId || `confirm-${Date.now()}`,
        },
      });
    }
  };

  const onRejectConfirmation = () => {
    setFixConfirmation(null);
  };

  const onRunDoctorRepair = async () => {
    const accepted = window.confirm(
      "doctor --repair는 커스텀 키를 정리하거나 지울 수 있으니 백업을 확인한 뒤 계속할까요?"
    );
    if (!accepted) return;
    await runFix({
      runDoctorRepair: true,
      overrideOptions: {
        ...fixOptions,
        forceCategory: "unknown",
      },
      confirmation: {
        type: "doctor_repair",
        approved: true,
        requestId: `doctor-repair-${Date.now()}`,
      },
    });
  };

  const onApplyAdvancedBypass = async () => {
    const hasDangerOption = Boolean(fixAdvanced.disableDeviceAuth || fixAdvanced.allowHostHeaderOriginFallback);
    if (hasDangerOption) {
      const accepted = window.confirm(
        "고급 임시 우회는 보안 수준을 낮추고 30분 뒤 자동으로 꺼져요, 적용할까요?"
      );
      if (!accepted) return;
    }
    await runFix({ applyAdvancedBypass: true });
  };

  const onToggleAdvancedBypass = (key, nextValue) => {
    if (nextValue) {
      const accepted = window.confirm("이 옵션은 보안 수준을 낮출 수 있으니 잠깐만 사용할까요?");
      if (!accepted) return;
    }
    setFixAdvanced((prev) => ({ ...prev, [key]: nextValue }));
  };

  const fixBypassExpiresAt = Number(fixState?.advancedBypass?.expiresAt);
  const fixBypassActive = Boolean(
    fixState?.advancedBypass?.disableDeviceAuth || fixState?.advancedBypass?.allowHostHeaderOriginFallback
  );
  const fixBypassRemaining = fixBypassActive && Number.isFinite(fixBypassExpiresAt) ? Math.max(0, fixBypassExpiresAt - Date.now()) : 0;
  const fixDiagnosisPreview = resolveFixDiagnosisPreview(fixState?.diagnosisPreview);
  const fixConfirmationCopy = resolveFixConfirmationCopy(fixConfirmation);
  const fixLastCloseLabel = fixState?.lastCloseCode
    ? `${fixState.lastCloseCode}${fixState?.lastCloseReason ? ` · ${fixState.lastCloseReason}` : ""}`
    : "기록 없음";
  const fixRecentRecoverLabel = fixState?.lastRecover?.at
    ? normalizeFixStatus(fixState.lastRecover.status)
    : "아직 없음";
  const fixResultTone =
    fixResult?.status === "recovered"
      ? "ok"
      : fixResult?.status === "failed"
        ? "error"
        : fixResult?.status
          ? "warn"
          : "";

  if (!open) return null;

  return (
    <div className="dash-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onOpenChange(false)}>
      <section className="dash-modal" role="dialog" aria-modal="true" aria-label="설정">
        <div className="dash-modal-layout">
          <aside className="dash-modal-sidebar">
            <h2>설정</h2>
            <nav>
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const active = tab.id === activeTab;
                return (
                  <button
                    key={tab.id}
                    className={`dash-modal-tab ${active ? "active" : ""}`}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    <Icon size={16} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <div className="dash-modal-content">
            {activeTab === "ai" ? (
              <div className="dash-modal-stack">
                <SectionHeader
                  title="AI 서비스"
                  description="서비스 연결/재연결은 온보딩 API를 재사용해요"
                  onClose={() => onOpenChange(false)}
                />

                {loading ? <p>불러오는 중</p> : null}
                {loadError ? <p className="error-text">{loadError}</p> : null}

                <article className="dash-modal-general-card">
                  <div>
                    <p className="name">현재 연결</p>
                    <p className="desc">
                      {runtimeModel
                        ? `${runtimeSourceLabel}으로 실제 실행 모델을 확인했어요`
                        : connected?.configured
                          ? `${connectedServiceSummaryLabel}로 연결되어 있지만 아직 실제 실행 모델 기록은 없어요`
                          : "연결한 서비스가 아직 없어요"}
                    </p>
                  </div>
                  {runtimeModel ? (
                    <span className="dash-modal-connection-state">실행 기준</span>
                  ) : connected?.configured ? (
                    <span className="dash-modal-connection-state">사용 중</span>
                  ) : null}
                </article>

                <article className="dash-modal-general-card dash-modal-connection-card">
                  <div className="dash-modal-connection-grid">
                    <div className="dash-modal-connection-item">
                      <span>연결 서비스</span>
                      <strong>{runtimeServiceLabel}</strong>
                    </div>
                    <div className="dash-modal-connection-item">
                      <span>연결 방식</span>
                      <strong>{connected?.configured ? connectedMethodLabel : "-"}</strong>
                    </div>
                    <div className="dash-modal-connection-item">
                      <span>실제 실행 모델</span>
                      <strong>{connectedModelLabel}</strong>
                    </div>
                    <div className="dash-modal-connection-item">
                      <span>관측 기준</span>
                      <strong>{runtimeModel ? `${runtimeSourceLabel} · ${runtimeObservedLabel}` : "아직 없음"}</strong>
                    </div>
                  </div>
                </article>

                <div className="dash-modal-field">
                  <label htmlFor="provider-select">서비스</label>
                  <select
                    id="provider-select"
                    value={selectedProviderId}
                    onChange={(event) => {
                      setSelectedProviderId(event.target.value);
                      setKeyValidationWarning(null);
                      setApplyError("");
                      setApplyStatus("idle");
                      setInteractiveSessionId("");
                    }}
                  >
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="dash-modal-field">
                  <label htmlFor="method-select">연결 방식</label>
                  <select
                    id="method-select"
                    value={selectedMethodId}
                    onChange={(event) => {
                      setSelectedMethodId(event.target.value);
                      setKeyValidationWarning(null);
                      setApplyError("");
                      setApplyStatus("idle");
                      setInteractiveSessionId("");
                    }}
                  >
                    {(selectedProvider?.methods || []).map((method) => (
                      <option key={method.id} value={method.id}>
                        {method.label}
                      </option>
                    ))}
                  </select>
                </div>

                {(selectedMethod?.fields || []).map((field) => (
                  <div key={field.id} className="dash-modal-field compact">
                    <label htmlFor={`setting-${field.id}`}>{field.label}</label>
                    <input
                      id={`setting-${field.id}`}
                      type={field.type || "text"}
                      value={credentials[field.id] || ""}
                      onChange={(event) => {
                        setCredentials((prev) => ({ ...prev, [field.id]: event.target.value }));
                        setKeyValidationWarning(null);
                        setApplyError("");
                      }}
                      placeholder={field.placeholder || ""}
                    />
                  </div>
                ))}

                {interactiveSessionId ? (
                  <OAuthInteractiveStep
                    title="인증 세션"
                    subtitle="인증 완료 후 자동으로 설정 상태가 갱신돼요"
                    sessionId={interactiveSessionId}
                    headLabel="브라우저 인증"
                    onExit={onInteractiveExit}
                    onCancel={onInteractiveCancel}
                    phaseLabel="연결 상태"
                    stepLabel="진행"
                  />
                ) : null}

                {applyError ? <p className="error-text">{applyError}</p> : null}
                {keyValidationWarning && selectedMethod?.mode === "non_interactive" ? (
                  <div className="ov0-soft-warn">
                    <p>
                      [{keyValidationWarning.code}] {keyValidationWarning.message}
                    </p>
                    <div className="ov0-soft-warn-actions">
                      <button type="button" className="ov0-btn ghost" onClick={() => setKeyValidationWarning(null)}>
                        다시 입력
                      </button>
                      <button type="button" className="ov0-btn primary flat" onClick={() => void onApply({ skipKeyValidation: true })}>
                        그래도 진행
                      </button>
                    </div>
                  </div>
                ) : null}

                <button
                  type="button"
                  className="ov0-btn primary"
                  onClick={onApply}
                  disabled={applyStatus === "connecting" || applyStatus === "interactive_pending"}
                >
                  {applyStatus === "connecting"
                    ? "적용 중"
                    : applyStatus === "interactive_pending"
                      ? "브라우저 인증 진행 중"
                      : "연결/재연결 적용"}
                </button>

                <div className="dash-modal-field">
                  <label htmlFor="default-model">최근 Semo AI 실행 모델(읽기)</label>
                  <input id="default-model" value={connectedModelLabel} readOnly />
                </div>
              </div>
            ) : null}

            {activeTab === "skill_env" ? (
              <div className="dash-modal-stack">
                <SectionHeader
                  title="스킬 환경 변수"
                  description="스킬별 API 키나 OAuth 자격증명을 저장하고 바로 Semo AI에 반영해요"
                  onClose={() => onOpenChange(false)}
                />

                <article className="dash-modal-general-card dash-modal-skillenv-summary">
                  <div>
                    <p className="name">저장 방식</p>
                    <p className="desc">값은 Semo AI `.env`에 저장되고 저장 직후 게이트웨이를 다시 불러와요</p>
                  </div>
                </article>

                {skillEnvironmentItems.length === 0 ? (
                  <article className="dash-modal-general-card">
                    <div>
                      <p className="name">추가로 설정할 스킬은 아직 없어요</p>
                      <p className="desc">지금은 환경 변수를 더 설정할 스킬이 없어요</p>
                    </div>
                  </article>
                ) : null}

                {skillEnvironmentItems.map((item) => {
                  const saving = skillEnvironmentSavingSkillId === item.skillId;
                  const drafts = skillEnvironmentValues?.[item.skillId] || {};
                  const highlight = highlightSkillId && highlightSkillId === item.skillId;
                  const gogOauth = item.oauth?.supported ? item.oauth : null;
                  return (
                    <article
                      key={item.skillId}
                      className={`dash-modal-general-card dash-modal-skillenv-card ${highlight ? "highlight" : ""}`}
                    >
                      <div className="dash-modal-skillenv-head">
                        <div>
                          <p className="name">{item.skillName}</p>
                          <p className="desc">{item.description}</p>
                          {item.setupHint ? <p className="desc">{item.setupHint}</p> : null}
                        </div>
                        <span className={`dash-modal-skillenv-badge ${item.satisfied ? "ready" : "pending"}`}>
                          {item.satisfied ? "값 감지됨" : "값 필요"}
                        </span>
                      </div>

                      <p className="dash-modal-skillenv-note">
                        {item.mode === "any"
                          ? "아래 값 중 하나만 있어도 되고 빈칸은 기존 값을 유지해요"
                          : "아래 값을 입력하면 저장되고 빈칸은 기존 값을 유지해요"}
                      </p>

                      <div className="dash-modal-skillenv-grid">
                        {item.fields.map((field) => (
                          <div key={field.key} className="dash-modal-field compact dash-modal-skillenv-field">
                            <label htmlFor={`skill-env-${item.skillId}-${field.key}`}>
                              {field.label}
                              {field.required ? null : " (선택)"}
                            </label>
                            <input
                              id={`skill-env-${item.skillId}-${field.key}`}
                              type={field.inputType || "password"}
                              value={drafts[field.key] || ""}
                              onChange={(event) => onChangeSkillEnvironmentValue(item.skillId, field.key, event.target.value)}
                              placeholder={
                                field.present
                                  ? field.source === "file"
                                    ? "이미 .env에 설정됨"
                                    : "실행 환경에 이미 설정됨"
                                  : field.placeholder || `${field.key} 값을 입력하세요`
                              }
                              autoComplete="off"
                              spellCheck="false"
                            />
                            <small className={`dash-modal-skillenv-field-meta ${field.present ? "ready" : ""}`}>
                              {field.present
                                ? field.source === "file"
                                  ? "현재 .env에 저장됨"
                                  : "현재 실행 환경에서 감지됨"
                                : "아직 설정되지 않음"}
                            </small>
                          </div>
                        ))}
                      </div>

                      {gogOauth ? (
                        <div className="dash-modal-skillenv-oauth">
                          <div className="dash-modal-skillenv-oauth-head">
                            <div>
                              <p className="name">Google 계정 연결</p>
                              <p className="desc">
                                자격증명을 저장한 뒤 연결을 시작하면 Google 로그인 페이지가 열리고 승인 후 마지막에 이동한 주소를 다시 붙여 넣으면 연결이 완료돼요
                              </p>
                            </div>
                            <span className={`dash-modal-skillenv-badge ${gogOauth.accountConnected ? "ready" : "pending"}`}>
                              {gogOauth.accountConnected ? "계정 연결됨" : gogOauth.credentialsReady ? "연결 준비됨" : "자격증명 필요"}
                            </span>
                          </div>

                          <div className="dash-modal-skillenv-oauth-meta">
                            <span>연결 대상</span>
                            <strong>{gogOauth.accountEmail || "아직 입력되지 않음"}</strong>
                          </div>
                          <div className="dash-modal-skillenv-oauth-meta">
                            <span>연결된 계정</span>
                            <strong>
                              {gogOauth.connectedAccounts.length > 0 ? gogOauth.connectedAccounts.join(", ") : "아직 없음"}
                            </strong>
                          </div>

                          {!gogOauth.accountConnected ? (
                            <div className="dash-modal-skillenv-oauth-actions">
                              <button
                                type="button"
                                className="ov0-btn primary flat"
                                onClick={() => void onStartGogOauth()}
                                disabled={gogOauthPending === "start" || gogOauthPending === "complete" || saving}
                              >
                                {gogOauthPending === "start" ? "연결 URL 준비 중" : "계정 연결 시작"}
                              </button>
                            </div>
                          ) : null}

                          {gogOauthUrl ? (
                            <div className="dash-modal-skillenv-oauth-flow">
                              <div className="dash-modal-field compact dash-modal-skillenv-field">
                                <label htmlFor="gog-auth-url">Google 로그인 URL</label>
                                <input id="gog-auth-url" type="text" value={gogOauthUrl} readOnly />
                              </div>

                              <div className="dash-modal-inline-actions">
                                <button type="button" className="ov0-btn ghost" onClick={() => window.open(gogOauthUrl, "_blank", "noopener,noreferrer")}>
                                  새 탭에서 열기
                                </button>
                              </div>

                              <div className="dash-modal-field compact dash-modal-skillenv-field">
                                <label htmlFor="gog-auth-redirect-url">승인 후 마지막 주소</label>
                                <input
                                  id="gog-auth-redirect-url"
                                  type="text"
                                  value={gogOauthRedirectUrl}
                                  onChange={(event) => {
                                    setGogOauthRedirectUrl(event.target.value);
                                    setSkillEnvironmentError("");
                                    setSkillEnvironmentNotice("");
                                  }}
                                  placeholder="브라우저에서 마지막에 열린 전체 주소를 붙여 넣으세요"
                                  autoComplete="off"
                                  spellCheck="false"
                                />
                              </div>

                              <div className="dash-modal-inline-actions">
                                <button
                                  type="button"
                                  className="ov0-btn primary flat"
                                  onClick={() => void onCompleteGogOauth()}
                                  disabled={gogOauthPending === "start" || gogOauthPending === "complete"}
                                >
                                  {gogOauthPending === "complete" ? "연결 완료 처리 중" : "계정 연결 완료"}
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      <div className="dash-modal-inline-actions">
                        <button type="button" className="ov0-btn primary flat" onClick={() => void onSaveSkillEnvironment(item)} disabled={saving}>
                          {saving ? "저장 중" : "저장하고 적용"}
                        </button>
                      </div>
                    </article>
                  );
                })}

                {skillEnvironmentNotice ? <p className="dash-modal-inline-status success">{skillEnvironmentNotice}</p> : null}
                {skillEnvironmentError ? <p className="error-text">{skillEnvironmentError}</p> : null}
              </div>
            ) : null}

            {activeTab === "general" ? (
              <div className="dash-modal-stack">
                <SectionHeader
                  title="일반"
                  description="Semo AI 기능을 켜고 끄는 설정이에요"
                  onClose={() => onOpenChange(false)}
                />

                {!loading && !connected?.configured ? <p className="error-text">Semo AI를 연결하면 기능 토글을 쓸 수 있어요</p> : null}

                {features.map((feature) => {
                  const pending = Boolean(featurePendingMap[feature.id]);
                  const badge = resolveFeatureStatusBadge(feature.status, pending);
                  const disabled = pending || !connected?.configured || feature.status?.supported === false;
                  const statusMessage = resolveFeatureStatusMessage(feature.status);
                  return (
                    <article key={feature.id} className="dash-modal-general-card dash-modal-feature-card">
                      <div>
                        <p className="name">{feature.name}</p>
                        <p className="desc">{feature.description}</p>
                        <p className="desc">공식 ID: {feature.canonicalId}</p>
                        <div className="dash-modal-feature-meta">
                          <span className={`dash-modal-feature-badge ${badge.className}`}>{badge.label}</span>
                        </div>
                        {statusMessage ? <p className="desc">{statusMessage}</p> : null}
                      </div>
                      <Toggle
                        checked={Boolean(feature.enabled)}
                        onChange={(nextChecked) => void onToggleFeature(feature.id, nextChecked)}
                        ariaLabel={`${feature.name} 토글`}
                        disabled={disabled}
                      />
                    </article>
                  );
                })}

                {featureError ? <p className="error-text">{featureError}</p> : null}
              </div>
            ) : null}

            {activeTab === "fix" ? (
              <div className="dash-modal-stack dash-fix-stack">
                <SectionHeader
                  title="문제 해결"
                  description="연결이 끊기면 여기서 바로 복구해요"
                  onClose={() => onOpenChange(false)}
                />

                <article className="dash-modal-general-card dash-fix-hero-card">
                  <div className="dash-fix-hero-top">
                    <div className="dash-fix-hero-copy">
                      <div className="dash-fix-meta-row">
                        <span className={`dash-fix-pill ${fixState?.gatewayRunning ? "ok" : "warn"}`}>
                          {fixState?.gatewayRunning ? "연결 가능" : "연결 끊김"}
                        </span>
                        <span className="dash-fix-pill">{fixDiagnosisPreview.label}</span>
                      </div>
                      <p className="name">{fixDiagnosisPreview.title}</p>
                      <p className="desc">{fixDiagnosisPreview.description}</p>
                    </div>
                    <div className="dash-fix-hero-action">
                      <button type="button" className="ov0-btn primary" onClick={() => void runFix()} disabled={fixRunning}>
                        {fixRunning ? (
                          <>
                            <RefreshCw size={14} className="dash-spin" />
                            복구 중
                          </>
                        ) : (
                          "지금 복구하기"
                        )}
                      </button>
                      <p className="dash-fix-microcopy">보통 10~30초</p>
                    </div>
                  </div>

                  <div className="dash-fix-fact-row">
                    <div className="dash-fix-fact">
                      <span>서비스</span>
                      <strong>{fixState?.gatewayRunning ? "실행 중" : "멈춤"}</strong>
                    </div>
                    <div className="dash-fix-fact">
                      <span>마지막 끊김</span>
                      <strong>{fixLastCloseLabel}</strong>
                    </div>
                    <div className="dash-fix-fact">
                      <span>최근 복구</span>
                      <strong>{fixRecentRecoverLabel}</strong>
                    </div>
                  </div>

                  <details className="dash-fix-details">
                    <summary>상세 보기</summary>
                    <label className="dash-fix-check">
                      <input
                        type="checkbox"
                        checked={Boolean(fixOptions.applyChannelMitigation)}
                        onChange={(event) =>
                          setFixOptions((prev) => ({
                            ...prev,
                            applyChannelMitigation: event.target.checked,
                          }))
                        }
                      />
                      <span>채널 문제도 함께 점검</span>
                    </label>
                    {fixDiagnosisPreview.hint ? (
                      <p className="dash-fix-technical-note">참고 신호: {fixDiagnosisPreview.hint}</p>
                    ) : null}
                    <p className="dash-fix-helper-copy">필요할 때만 중간 확인이 한 번 더 나타나요</p>
                  </details>
                </article>

                <article className="dash-modal-general-card dash-fix-advanced-card">
                  <div>
                    <p className="name">고급 설정</p>
                    <p className="desc">대부분은 열지 않아도 돼요</p>
                    <div className="dash-fix-meta-row">
                      <span className={`dash-fix-pill ${fixBypassActive ? "warn" : ""}`}>
                        임시 설정 {fixBypassActive ? "켜짐" : "꺼짐"}
                      </span>
                      <span className="dash-fix-pill">
                        자동 해제 {fixBypassActive ? `${Math.ceil(fixBypassRemaining / 60000)}분 후` : "사용 안 함"}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="ov0-btn ghost"
                    onClick={() => setFixAdvancedOpen((prev) => !prev)}
                  >
                    {fixAdvancedOpen ? "닫기" : "열기"}
                  </button>
                </article>

                {fixAdvancedOpen ? (
                  <article className="dash-modal-general-card dash-fix-advanced-panel">
                    <div className="dash-fix-advanced-row">
                      <div>
                        <p className="name">기기 확인 잠시 건너뛰기</p>
                        <p className="desc">브라우저 기기 인증이 계속 실패할 때만 잠깐 사용해요, 코드: dangerouslyDisableDeviceAuth</p>
                      </div>
                      <Toggle
                        checked={Boolean(fixAdvanced.disableDeviceAuth)}
                        onChange={(next) => onToggleAdvancedBypass("disableDeviceAuth", next)}
                        ariaLabel="기기 확인 잠시 건너뛰기 토글"
                        disabled={fixRunning}
                      />
                    </div>
                    <div className="dash-fix-advanced-row">
                      <div>
                        <p className="name">프록시 주소 보조 허용</p>
                        <p className="desc">중간 프록시 주소 때문에 연결이 막힐 때만 사용해요, 코드: dangerouslyAllowHostHeaderOriginFallback</p>
                      </div>
                      <Toggle
                        checked={Boolean(fixAdvanced.allowHostHeaderOriginFallback)}
                        onChange={(next) => onToggleAdvancedBypass("allowHostHeaderOriginFallback", next)}
                        ariaLabel="프록시 주소 보조 허용 토글"
                        disabled={fixRunning}
                      />
                    </div>
                    <div className="dash-fix-inline-actions">
                      <button type="button" className="ov0-btn primary flat" onClick={() => void onApplyAdvancedBypass()} disabled={fixRunning}>
                        임시 설정 적용
                      </button>
                      <button
                        type="button"
                        className="ov0-btn ghost"
                        onClick={() => {
                          setFixAdvanced({
                            disableDeviceAuth: false,
                            allowHostHeaderOriginFallback: false,
                          });
                          void runFix({
                            applyAdvancedBypass: true,
                            overrideOptions: fixOptions,
                            overrideAdvancedBypass: {
                              disableDeviceAuth: false,
                              allowHostHeaderOriginFallback: false,
                            },
                          });
                        }}
                        disabled={fixRunning}
                      >
                        임시 설정 모두 끄기
                      </button>
                    </div>
                    <div className="dash-fix-danger-line">
                      <AlertTriangle size={14} />
                      <span>강제 수리는 기본 복구에 포함되지 않으며 일부 설정을 정리하면서 바꿀 수 있어요</span>
                      <button type="button" className="ov0-btn ghost danger" onClick={() => void onRunDoctorRepair()} disabled={fixRunning}>
                        강제 수리 실행
                      </button>
                    </div>
                  </article>
                ) : null}

                {fixConfirmation ? (
                  <article className="dash-modal-general-card dash-fix-confirm-card">
                    <div>
                      <p className="name">
                        <ShieldAlert size={14} /> {fixConfirmationCopy.title}
                      </p>
                      <p className="desc">{fixConfirmation.message || fixConfirmationCopy.description}</p>

                      {fixConfirmation.type === "origin_allow" ? (
                        <>
                          <p className="dash-fix-confirm-origin">{fixConfirmation.origin}</p>
                          <label className="dash-fix-check">
                            <input
                              type="checkbox"
                              checked={fixConfirmRememberOrigin}
                              onChange={(event) => setFixConfirmRememberOrigin(event.target.checked)}
                            />
                            <span>다음부터 같은 주소면 다시 묻지 않기</span>
                          </label>
                        </>
                      ) : null}

                      {fixConfirmation.type === "device_select" ? (
                        <div className="dash-fix-device-select">
                          <label>
                            다시 연결할 기기
                            <select
                              value={fixSelectedDeviceId}
                              onChange={(event) => {
                                const selected = (fixConfirmation.candidates || []).find(
                                  (item) => String(item.id) === event.target.value
                                );
                                setFixSelectedDeviceId(event.target.value);
                                if (selected?.role) setFixSelectedDeviceRole(String(selected.role));
                              }}
                            >
                              {(fixConfirmation.candidates || []).map((item) => (
                                <option key={item.id} value={item.id}>
                                  {item.id} ({item.role || "operator"})
                                </option>
                              ))}
                            </select>
                          </label>
                          <p className="dash-fix-helper-copy">잘 모르겠다면 가장 위에 보이는 최근 항목으로 먼저 시도하면 돼요</p>
                        </div>
                      ) : null}

                      {fixConfirmation.type === "pairing_approve" ? (
                        <div className="dash-fix-pending-list">
                          {(fixConfirmation.pending || []).map((item) => (
                            <p key={`${item.id}-${item.createdAt || ""}`}>
                              {item.id} · {item.origin || "origin 없음"} · {item.ip || "ip 없음"}
                            </p>
                          ))}
                          <p className="dash-fix-helper-copy">내가 방금 연 브라우저가 맞을 때만 승인하세요</p>
                        </div>
                      ) : null}
                    </div>
                    <div className="dash-fix-inline-actions">
                      <button type="button" className="ov0-btn ghost" onClick={onRejectConfirmation} disabled={fixRunning}>
                        닫기
                      </button>
                      <button
                        type="button"
                        className="ov0-btn primary flat"
                        onClick={() => void onApproveConfirmation()}
                        disabled={fixRunning || (fixConfirmation.type === "device_select" && !fixSelectedDeviceId)}
                      >
                        {fixConfirmationCopy.approveLabel}
                      </button>
                    </div>
                  </article>
                ) : null}

                {fixError ? <p className="error-text">{fixError}</p> : null}
                {fixLoading && !fixState ? <p>문제 해결 상태를 불러오는 중</p> : null}

                {fixResult ? (
                  <article className="dash-modal-general-card dash-fix-result-card">
                    <div>
                      <div className="dash-fix-result-head">
                        <p className="name">최근 복구 결과</p>
                        <span className={`dash-fix-pill ${fixResultTone}`}>{normalizeFixStatus(fixResult.status)}</span>
                      </div>
                      <p className="desc">{fixResult.summaryKo || "-"}</p>
                      <div className="dash-fix-meta-row">
                        <span className="dash-fix-pill">{normalizeFixCategory(fixResult.category)}</span>
                        <span className="dash-fix-pill">최근 연결 {formatDateTime(fixState?.lastGatewayConnectedAt)}</span>
                      </div>
                      {fixResult?.dashboardUrl ? (
                        <p className="dash-fix-dashboard-link">
                          <a href={fixResult.dashboardUrl} target="_blank" rel="noreferrer">
                            새 접속 주소 열기
                          </a>
                        </p>
                      ) : null}
                      <p className="dash-fix-subline">
                        마지막 복구 시각 {formatDateTime(fixState?.lastRecover?.at)}
                      </p>
                    </div>

                    {Array.isArray(fixResult.nextActions) && fixResult.nextActions.length > 0 ? (
                      <div className="dash-fix-next-actions">
                        <p>다음 단계</p>
                        {fixResult.nextActions.map((item, index) => (
                          <span key={`${index}-${item}`}>{index + 1}. {item}</span>
                        ))}
                      </div>
                    ) : null}

                    {(fixResult.steps || []).length > 0 ? (
                      <details className="dash-fix-details">
                        <summary>진행 내용 보기</summary>
                        <div className="dash-fix-timeline">
                          {(fixResult.steps || []).map((step) => (
                            <div key={step.id} className={`dash-fix-step ${step.status || "info"}`}>
                              <div className="dash-fix-step-head">
                                <strong>{step.title}</strong>
                                <span>{normalizeFixStepStatus(step.status)}</span>
                              </div>
                              {step.message ? <p>{step.message}</p> : null}
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </article>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
