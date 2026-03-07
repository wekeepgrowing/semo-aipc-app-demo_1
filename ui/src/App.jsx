import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowRight,
  ChevronLeft,
  FileText,
  Home,
  Info,
  LoaderCircle,
  MessageSquare,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Settings,
  X,
} from "lucide-react";
import OnboardingModal from "./onboarding/OnboardingModal";
import SettingsModal from "./components/SettingsModal";
import WebResearchRunView from "./components/WebResearchRunView";
import { fetchApiJson } from "./lib/http";
import { buildResultHandoffPrompt } from "./lib/webResearchRunUtils";

const APP_TABS = [
  {
    id: "home",
    name: "홈",
    icon: Home,
    keywords: [
      "메인",
      "대시보드",
      "시작",
      "슬라이드",
      "웹사이트",
      "앱 개발",
      "디자인",
      "웹 리서치",
      "리서치",
      "문서 찾기",
      "문서 요약",
      "워크플로 예약",
      "시장 스캔",
      "데이터 정리",
      "인사이트 차트",
      "문서 초안",
      "보이스 브리프",
      "코파일럿",
    ],
  },
  {
    id: "chat",
    name: "대화",
    icon: MessageSquare,
    keywords: ["채팅", "메시지", "대화 기록", "히스토리", "질문"],
  },
  {
    id: "runs",
    name: "실행",
    icon: Play,
    keywords: ["런", "워크플로", "실행 결과", "태스크", "작업", "wbs"],
  },
  {
    id: "skills",
    name: "스킬",
    icon: Puzzle,
    keywords: ["에이전트", "자동화", "리서치 에이전트", "요약 에이전트", "플래너"],
  },
  {
    id: "monitor",
    name: "모니터",
    icon: Monitor,
    keywords: ["모니터링", "상태", "메트릭", "토큰", "시스템"],
  },
];

const SETTINGS_SEARCH_ITEM = {
  id: "settings",
  name: "설정",
  keywords: ["환경설정", "api", "모델", "연결", "구성"],
};

const HOME_TYPING_PLACEHOLDER = "작업을 할당하거나 무엇이든 질문하세요";
const HOME_RESEARCH_MODE_STORAGE_KEY = "semo-home-web-research-enabled";
const CHAT_ATTACHMENT_LIMIT = 4;
const CHAT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const CHAT_ATTACHMENT_FALLBACK_PROMPT = "첨부 파일을 확인해줘";
const ATTACHMENT_FEATURE_COMING_SOON_MESSAGE = "첨부 파일 기능은 추후 적용 예정이에요";

const RUN_STATUS_COLOR = {
  queued: "#94a3b8",
  running: "#22c55e",
  paused: "#facc15",
  completed: "#94a3b8",
  failed: "#b91c1c",
};

const RUN_STATUS_LABEL = {
  queued: "대기 중",
  running: "실행 중",
  paused: "일시 중지",
  completed: "완료",
  failed: "실패",
};

function formatAttachmentSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)}MB`;
  if (size >= 1024) return `${Math.max(1, Math.round(size / 1024))}KB`;
  return `${size}B`;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const raw = typeof reader.result === "string" ? reader.result : "";
      const base64 = raw.includes(",") ? raw.split(",")[1] : raw;
      if (!base64) {
        reject(new Error(`${file?.name || "첨부 파일"}을 읽지 못했어요`));
        return;
      }
      resolve(base64);
    };
    reader.onerror = () => reject(new Error(`${file?.name || "첨부 파일"}을 읽지 못했어요`));
    reader.readAsDataURL(file);
  });
}

async function buildUploadAttachments(fileList) {
  const files = Array.from(fileList || []).filter(Boolean).slice(0, CHAT_ATTACHMENT_LIMIT);
  const attachments = [];
  for (const file of files) {
    if (file.size > CHAT_ATTACHMENT_MAX_BYTES) {
      throw new Error(`${file.name} 파일은 10MB 이하만 첨부할 수 있어요`);
    }
    const data = await readFileAsBase64(file);
    attachments.push({
      id: `${file.name}-${file.lastModified}-${file.size}`,
      type: "file",
      filename: file.name || "attachment",
      mime: file.type || "application/octet-stream",
      size: file.size,
      data,
    });
  }
  return attachments;
}

function buildAttachmentPreview(attachment, index = 0) {
  if (!attachment || typeof attachment !== "object") return null;
  return {
    id: String(attachment.id || `attachment-${index}`),
    filename: String(attachment.filename || attachment.name || "attachment"),
    size: Number(attachment.size) || 0,
    mime: String(attachment.mime || attachment.mimeType || "application/octet-stream"),
    url: typeof attachment.url === "string" ? attachment.url : "",
  };
}

function createOptimisticChatMessage({ text = "", attachments = [] }) {
  return {
    id: `optimistic-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: "user",
    type: "text",
    text: String(text || ""),
    attachments: Array.isArray(attachments) ? attachments.map((item, index) => buildAttachmentPreview(item, index)).filter(Boolean) : [],
    ts: Date.now(),
  };
}

function AttachmentChipList({ attachments = [], onRemove = null }) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  return (
    <div className="dash-attachment-list">
      {attachments.map((attachment, index) => {
        const preview = buildAttachmentPreview(attachment, index);
        if (!preview) return null;
        return (
          <div key={preview.id} className="dash-attachment-chip">
            <div className="dash-attachment-chip-icon">
              <FileText size={15} />
            </div>
            <div className="dash-attachment-chip-copy">
              <strong>{preview.filename}</strong>
              <span>{formatAttachmentSize(preview.size)}</span>
            </div>
            {typeof onRemove === "function" ? (
              <button type="button" className="dash-attachment-chip-remove" onClick={() => onRemove(preview.id)} aria-label={`${preview.filename} 제거`}>
                <X size={14} />
              </button>
            ) : preview.url ? (
              <a href={preview.url} target="_blank" rel="noreferrer" className="dash-attachment-chip-link">
                보기
              </a>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function getRunStatusClassName(status) {
  if (status === "queued" || status === "running" || status === "paused" || status === "completed" || status === "failed") {
    return `status-${status}`;
  }
  return "status-idle";
}

function getSyncStateLabel(state) {
  if (state === "connected") return "실시간 연결";
  if (state === "reconnecting") return "재연결 중";
  if (state === "polling") return "";
  return "동기화 대기";
}

const ROLE_BADGE_CLASS = {
  AI: "ai",
  Human: "person",
  "Review Needed": "review",
};

const ROLE_ACTION_LABEL = {
  AI: "AI 실행",
  Human: "담당자 지정",
  "Review Needed": "검토 필요/리뷰 요청",
};

const HOME_FEATURE_DEFAULTS = [
  {
    id: "knowledgeMap",
    canonicalId: "ontology",
    name: "기억 구조화",
    description: "관계 중심으로 기억을 구조화해요",
  },
  {
    id: "memoryAutoImprove",
    canonicalId: "self-improving-loop",
    name: "자동 기억 개선",
    description: "기록 품질을 자동으로 개선해요",
  },
  {
    id: "proactiveCheck",
    canonicalId: "proactive",
    name: "먼저 알려주기",
    description: "주기적으로 점검하고 먼저 알려줘요",
  },
  {
    id: "skillFinder",
    canonicalId: "find-skills",
    name: "스킬 찾기",
    description: "필요한 스킬을 찾아서 활성화해요",
  },
];

function normalizeHomeFeatureStatus(status) {
  if (!status || typeof status !== "object") {
    return {
      source: "none",
      supported: null,
      confirmedEnabled: false,
      lastAppliedAt: null,
      errorCode: null,
      lastError: null,
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
  };
}

function normalizeHomeFeatures(items) {
  const byId = new Map(
    HOME_FEATURE_DEFAULTS.map((row) => [
      row.id,
      {
        ...row,
        enabled: false,
        status: normalizeHomeFeatureStatus(null),
      },
    ])
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
      status: normalizeHomeFeatureStatus(item?.status),
    });
  }

  return HOME_FEATURE_DEFAULTS.map((row) => byId.get(row.id));
}

function resolveHomeFeatureBadge(status, pending) {
  if (pending) return "적용 중";
  if (status?.errorCode === "feature_contract_unsupported") return "업그레이드 필요";
  if (status?.lastError) return "오류";
  if (status?.supported === false) return "미지원";
  if (status?.confirmedEnabled) return "활성";
  if (status?.supported === true) return "비활성";
  return "확인 대기";
}

const SKILL_SETUP_LABEL = {
  ready: "사용 가능",
  needs_env: "환경 변수 필요",
  needs_oauth: "OAuth 연결 필요",
  install_failed: "설치 실패",
};

function normalizeSkillItem(item) {
  return {
    id: String(item?.id || ""),
    name: String(item?.name || item?.id || "스킬"),
    description: String(item?.description || ""),
    enabled: Boolean(item?.enabled),
    source: item?.source === "user" ? "user" : "default",
    defaultInstalled: Boolean(item?.defaultInstalled),
    setupState:
      item?.setupState === "needs_env" || item?.setupState === "needs_oauth" || item?.setupState === "install_failed"
        ? item.setupState
        : "ready",
    setupHint: item?.setupHint ? String(item.setupHint) : "",
  };
}

function getSkillSetupLabel(skill) {
  return SKILL_SETUP_LABEL[skill?.setupState] || SKILL_SETUP_LABEL.ready;
}

function getSkillSetupTone(skill) {
  if (skill?.setupState === "install_failed") return "error";
  if (skill?.setupState === "needs_env" || skill?.setupState === "needs_oauth") return "warning";
  return "ready";
}

function toTaskRole(task) {
  const role = String(task?.role || "").trim();
  if (role === "Human" || role === "Review Needed" || role === "AI") return role;
  if (task?.assigneeType === "person") return "Human";
  return "AI";
}

function groupedTasksByPhase(run) {
  const tasks = Array.isArray(run?.tasks) ? run.tasks : [];
  const phaseRows = Array.isArray(run?.wbs?.phases) ? run.wbs.phases : [];
  if (phaseRows.length > 0) {
    return phaseRows.map((phase, index) => ({
      id: phase.id || `phase-${index + 1}`,
      title: phase.title || `Phase ${index + 1}`,
      index: phase.index || index + 1,
      tasks: tasks.filter((task) => String(task.phaseId || "") === String(phase.id || "")),
    }));
  }

  const groups = [];
  for (const task of tasks) {
    const phaseId = String(task.phaseId || "phase-1");
    let group = groups.find((row) => row.id === phaseId);
    if (!group) {
      group = {
        id: phaseId,
        title: task.phaseTitle || "실행 단계",
        index: groups.length + 1,
        tasks: [],
      };
      groups.push(group);
    }
    group.tasks.push(task);
  }
  return groups;
}

function normalizeHashTab(hash) {
  const value = String(hash || "").replace(/^#/, "").toLowerCase();
  return APP_TABS.some((tab) => tab.id === value) ? value : "home";
}

function useHashTab() {
  const [activeTab, setActiveTab] = useState(() => (typeof window === "undefined" ? "home" : normalizeHashTab(window.location.hash)));

  useEffect(() => {
    const onHashChange = () => setActiveTab(normalizeHashTab(window.location.hash));
    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const selectTab = (nextTab) => {
    const normalized = normalizeHashTab(`#${nextTab}`);
    const nextHash = `#${normalized}`;
    if (window.location.hash === nextHash) {
      setActiveTab(normalized);
      return;
    }
    window.location.hash = nextHash;
  };

  return [activeTab, selectTab];
}

function useOnboardingState() {
  const [state, setState] = useState({
    loading: true,
    configured: false,
    onboardingInProgress: false,
    gatewayRunning: false,
    mode: "gui",
    interactiveAuthInProgress: false,
    lastErrorCode: null,
    activeSessionId: null,
    activeProviderId: null,
    activeMethodId: null,
    interactivePhase: null,
  });

  useEffect(() => {
    let timeout;
    let cancelled = false;

    const load = async () => {
      try {
        const json = await fetchApiJson("/api/ui/onboarding/state");
        if (!cancelled) {
          setState({
            loading: false,
            configured: Boolean(json.configured),
            onboardingInProgress: Boolean(json.onboardingInProgress),
            gatewayRunning: Boolean(json.gatewayRunning),
            mode: json.mode || "gui",
            interactiveAuthInProgress: Boolean(json.interactiveAuthInProgress),
            lastErrorCode: json.lastErrorCode || null,
            activeSessionId: json.activeSessionId || null,
            activeProviderId: json.activeProviderId || null,
            activeMethodId: json.activeMethodId || null,
            interactivePhase: json.interactivePhase || null,
          });
        }
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, loading: false }));
      } finally {
        if (!cancelled) timeout = setTimeout(load, 1000);
      }
    };

    load();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, []);

  return state;
}

function useMetrics(enabled) {
  const [metrics, setMetrics] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let timeout;
    let cancelled = false;

    const poll = async () => {
      try {
        const json = await fetchApiJson("/api/ui/system/metrics");
        if (!cancelled && json?.ok) setMetrics(json);
      } catch {
        // ignore poll errors
      } finally {
        if (!cancelled) timeout = setTimeout(poll, 1200);
      }
    };

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [enabled]);

  return metrics;
}

function toDateText(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value)) return "-";
  return new Date(value).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function runProgressFromStatus(status) {
  if (status === "completed") return 100;
  if (status === "failed") return 100;
  if (status === "queued") return 18;
  return 62;
}

const RUN_TITLE_OVERRIDES_STORAGE_KEY = "semo.runTitleOverrides.v1";

function readRunTitleOverrides() {
  if (typeof window === "undefined" || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(RUN_TITLE_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeRunTitleOverrides(overrides) {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const entries = Object.entries(overrides && typeof overrides === "object" ? overrides : {}).filter(
      ([, value]) => typeof value === "string" && value.trim()
    );
    if (entries.length === 0) {
      window.localStorage.removeItem(RUN_TITLE_OVERRIDES_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(RUN_TITLE_OVERRIDES_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Ignore storage write failures and keep the in-memory flow usable.
  }
}

function getRunTitleOverride(runId) {
  const value = readRunTitleOverrides()[String(runId || "")];
  return typeof value === "string" ? value.trim() : "";
}

function persistRunTitleOverride(runId, title) {
  const runKey = String(runId || "").trim();
  if (!runKey) return;
  const nextTitle = String(title || "").trim();
  const overrides = readRunTitleOverrides();
  if (nextTitle) overrides[runKey] = nextTitle;
  else delete overrides[runKey];
  writeRunTitleOverrides(overrides);
}

function isLegacyGuiBlockedError(error) {
  if (!error) return false;
  const payloadError = String(error?.payload?.error || "").trim().toLowerCase();
  const message = String(error?.message || "").trim().toLowerCase();
  return payloadError === "legacy gui path blocked" || message.includes("legacy gui path blocked");
}

function getRunTitle(run) {
  const overrideTitle = getRunTitleOverride(run?.id);
  if (overrideTitle) return overrideTitle;
  const title = String(run?.title || "").trim();
  if (run?.titleCustomized && title) return title;
  const prompt = String(run?.prompt || "").trim();
  if (title && title !== "새 실행") return title;
  if (prompt) return prompt.slice(0, 72);
  if (title) return title;
  return "새 실행";
}

function sortRunsByUpdatedAt(items = []) {
  return [...items].sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0));
}

function normalizeSearchQuery(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function toSearchTokens(value) {
  const normalized = normalizeSearchQuery(value);
  return normalized ? normalized.split(" ").filter(Boolean) : [];
}

function buildSearchIndex(parts = []) {
  return normalizeSearchQuery(parts.filter(Boolean).join(" "));
}

function matchesSearchTokens(index, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return true;
  return tokens.every((token) => index.includes(token));
}

function buildSidebarItemSearchIndex(item) {
  return buildSearchIndex([item?.id, item?.name, ...(Array.isArray(item?.keywords) ? item.keywords : [])]);
}

function getChatRunLastMessage(run) {
  if (typeof run?.lastMessage === "string" && run.lastMessage.trim()) {
    return run.lastMessage.trim();
  }
  const messages = Array.isArray(run?.messages) ? run.messages : [];
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  if (typeof lastMessage?.text === "string" && lastMessage.text.trim()) {
    return lastMessage.text.trim();
  }
  const logs = Array.isArray(run?.logs) ? run.logs : [];
  const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
  return String(lastLog?.message || "").trim();
}

function buildChatRunSearchIndex(run) {
  if (typeof run?.searchText === "string" && run.searchText.trim()) {
    return normalizeSearchQuery(run.searchText);
  }
  const messages = Array.isArray(run?.messages) ? run.messages.map((message) => String(message?.text || "")) : [];
  const logs = Array.isArray(run?.logs) ? run.logs.map((log) => String(log?.message || "")) : [];
  return buildSearchIndex([getRunTitle(run), run?.prompt, getChatRunLastMessage(run), ...messages, ...logs]);
}

function normalizeChatSidebarRun(run, fallback = null) {
  const base = fallback && typeof fallback === "object" ? fallback : {};
  const next = run && typeof run === "object" ? run : {};
  const logs = Array.isArray(next.logs) ? next.logs : Array.isArray(base.logs) ? base.logs : [];
  const messages = Array.isArray(next.messages) ? next.messages : Array.isArray(base.messages) ? base.messages : [];
  const prompt = typeof next.prompt === "string" ? next.prompt : typeof base.prompt === "string" ? base.prompt : "";
  const merged = {
    ...base,
    ...next,
    logs,
    messages,
    prompt,
  };
  const lastMessage = getChatRunLastMessage(merged);
  return {
    ...merged,
    lastMessage,
    searchText: buildChatRunSearchIndex({ ...merged, lastMessage, searchText: "" }),
  };
}

function mergeChatSidebarRuns(items = [], previousItems = []) {
  const previousById = new Map((Array.isArray(previousItems) ? previousItems : []).map((item) => [item.id, item]));
  return sortRunsByUpdatedAt(
    (Array.isArray(items) ? items : []).map((item) => normalizeChatSidebarRun(item, previousById.get(item.id)))
  );
}

function getChatRunSearchPreview(run, query) {
  const tokens = toSearchTokens(query);
  if (tokens.length === 0) return "";
  const messages = Array.isArray(run?.messages) ? run.messages.map((message) => String(message?.text || "")) : [];
  const logs = Array.isArray(run?.logs) ? run.logs.map((log) => String(log?.message || "")) : [];
  const candidates = [String(run?.prompt || ""), ...messages, ...logs, getChatRunLastMessage(run)]
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    const index = normalizeSearchQuery(candidate);
    if (!matchesSearchTokens(index, tokens)) continue;
    const lower = candidate.toLowerCase();
    const matchToken = tokens.find((token) => lower.includes(token)) || tokens[0];
    const matchIndex = Math.max(0, lower.indexOf(matchToken));
    const start = Math.max(0, matchIndex - 18);
    const end = Math.min(candidate.length, matchIndex + matchToken.length + 42);
    return `${start > 0 ? "..." : ""}${candidate.slice(start, end)}${end < candidate.length ? "..." : ""}`;
  }

  return "";
}

function Sidebar({
  collapsed,
  onToggle,
  onExpand,
  activeTab,
  onSelect,
  onOpenSettings,
  historyMode = "",
  historyItems = [],
  historyLoading = false,
  historyError = "",
  activeHistoryId = "",
  onSelectHistoryItem,
  onRenameHistoryItem,
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [pendingSearchFocus, setPendingSearchFocus] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [editingRunId, setEditingRunId] = useState("");
  const [editingTitle, setEditingTitle] = useState("");
  const [renameError, setRenameError] = useState("");
  const [renamePending, setRenamePending] = useState(false);
  const searchInputRef = useRef(null);
  const renameInputRef = useRef(null);
  const isHistoryMode = historyMode === "chat" || historyMode === "runs";
  const canRenameHistory = historyMode === "chat" && typeof onRenameHistoryItem === "function";
  const historySearchPlaceholder = historyMode === "runs" ? "실행 검색" : "대화 검색";
  const historyEmptyLabel = historyMode === "runs" ? "실행하면 여기에 보여요" : "대화를 시작하면 여기에 보여요";
  const lockSidebarToggle = activeTab === "chat" || activeTab === "runs";
  const searchTokens = toSearchTokens(searchQuery);
  const filteredTabs = APP_TABS.filter((tab) => matchesSearchTokens(buildSidebarItemSearchIndex(tab), searchTokens));
  const filteredHistoryItems = historyItems.filter((item) => matchesSearchTokens(buildChatRunSearchIndex(item), searchTokens));
  const showSettingsShortcut = searchTokens.length === 0 || matchesSearchTokens(buildSidebarItemSearchIndex(SETTINGS_SEARCH_ITEM), searchTokens);

  useEffect(() => {
    setSearchQuery("");
  }, [historyMode]);

  useEffect(() => {
    if (!collapsed && pendingSearchFocus) {
      const raf = window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
      setPendingSearchFocus(false);
      return () => window.cancelAnimationFrame(raf);
    }
    return undefined;
  }, [collapsed, pendingSearchFocus]);

  const handleCollapsedSearchClick = () => {
    setPendingSearchFocus(true);
    if (typeof onExpand === "function") onExpand();
  };

  useEffect(() => {
    if (!contextMenu) return undefined;

    const closeMenu = () => setContextMenu(null);
    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeMenu();
    };

    // Right-click opens the menu, so closing on the global contextmenu event
    // would immediately dismiss the menu we just rendered.
    window.addEventListener("click", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!editingRunId) return undefined;
    const raf = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [editingRunId]);

  useEffect(() => {
    if (collapsed || !canRenameHistory) {
      setContextMenu(null);
      setEditingRunId("");
      setEditingTitle("");
      setRenameError("");
      setRenamePending(false);
    }
  }, [canRenameHistory, collapsed]);

  const openHistoryContextMenu = (event, run) => {
    if (!canRenameHistory) return;
    event.preventDefault();
    const menuWidth = 148;
    const menuHeight = 54;
    const margin = 10;
    const maxLeft = Math.max(margin, window.innerWidth - menuWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - menuHeight - margin);
    setContextMenu({
      runId: run.id,
      x: Math.min(event.clientX, maxLeft),
      y: Math.min(event.clientY, maxTop),
    });
  };

  const startRenameRun = (run) => {
    setContextMenu(null);
    setEditingRunId(run.id);
    setEditingTitle(getRunTitle(run));
    setRenameError("");
  };

  const cancelRename = () => {
    if (renamePending) return;
    setEditingRunId("");
    setEditingTitle("");
    setRenameError("");
  };

  const submitRename = async () => {
    const runId = editingRunId;
    const nextTitle = editingTitle.trim();
    if (!runId || renamePending) return;
    if (!nextTitle) {
      setRenameError("제목을 입력하세요");
      return;
    }
    try {
      setRenamePending(true);
      setRenameError("");
      if (typeof onRenameHistoryItem === "function") {
        await onRenameHistoryItem(runId, nextTitle);
      }
      setEditingRunId("");
      setEditingTitle("");
    } catch (error) {
      setRenameError(error.message || "제목을 변경하지 못했어요");
    } finally {
      setRenamePending(false);
    }
  };

  return (
    <aside className={`dash-sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="dash-side-main">
        <div className="dash-side-header">
          <div className="dash-brand">
            <div className={`dash-avatar ${collapsed ? "centered" : ""}`}>S</div>
            <span>SEMO</span>
          </div>
          {!lockSidebarToggle ? (
            <button className="dash-icon-btn" onClick={onToggle} aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"}>
              {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          ) : null}
        </div>

        {collapsed ? (
          <button type="button" className="dash-search-icon-btn" onClick={handleCollapsedSearchClick} aria-label="검색 열기">
            <Search size={16} />
          </button>
        ) : (
          <label className="dash-search">
            <Search size={16} />
            <input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={isHistoryMode ? historySearchPlaceholder : "기능 검색"}
              aria-label={isHistoryMode ? historySearchPlaceholder : "사이드바 검색"}
            />
          </label>
        )}

        <nav className="dash-side-nav">
          {isHistoryMode ? (
            <>
              <div className="dash-side-chat-head">
                <button type="button" className="dash-side-history-back" onClick={() => onSelect("home")} aria-label="메인 메뉴로 돌아가기">
                  <ChevronLeft size={16} />
                  <span>메인 메뉴</span>
                </button>
              </div>
              {!collapsed && historyLoading && historyItems.length === 0 ? <p className="dash-side-muted">불러오는 중</p> : null}
              {!collapsed && historyError ? <p className="error-text">{historyError}</p> : null}
              {!collapsed && searchTokens.length > 0 && !historyLoading ? (
                <p className="dash-side-muted">검색 결과 {filteredHistoryItems.length}개</p>
              ) : null}
              <ul className="dash-side-history-list">
                {filteredHistoryItems.map((item) => {
                  const isEditing = canRenameHistory && editingRunId === item.id;
                  const matchPreview = searchTokens.length > 0 ? getChatRunSearchPreview(item, searchQuery) : "";
                  const metaText =
                    historyMode === "runs"
                      ? `${RUN_STATUS_LABEL[item.status] || item.status || "실행"} · ${toDateText(item.updatedAt)}`
                      : toDateText(item.updatedAt);
                  return (
                    <li key={item.id}>
                      {isEditing ? (
                        <form
                          className={`dash-side-history-edit ${activeHistoryId === item.id ? "active" : ""}`}
                          onSubmit={(event) => {
                            event.preventDefault();
                            void submitRename();
                          }}
                        >
                          <input
                            ref={renameInputRef}
                            value={editingTitle}
                            maxLength={72}
                            disabled={renamePending}
                            onChange={(event) => setEditingTitle(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                event.preventDefault();
                                cancelRename();
                              }
                            }}
                            placeholder="대화 제목"
                            aria-label="대화 제목 수정"
                          />
                          <div className="dash-side-history-edit-actions">
                            <button type="submit" className="dash-side-history-edit-btn" disabled={renamePending}>
                              {renamePending ? "저장 중" : "저장"}
                            </button>
                            <button type="button" className="dash-side-history-edit-btn ghost" onClick={cancelRename} disabled={renamePending}>
                              취소
                            </button>
                          </div>
                          {renameError ? <p className="dash-side-history-error">{renameError}</p> : null}
                        </form>
                      ) : (
                        <button
                          type="button"
                          className={`dash-side-history-item ${activeHistoryId === item.id ? "active" : ""}`}
                          onClick={() => {
                            setContextMenu(null);
                            if (typeof onSelectHistoryItem === "function") onSelectHistoryItem(item.id);
                          }}
                          onMouseDown={(event) => {
                            if (event.button === 2) openHistoryContextMenu(event, item);
                          }}
                          onContextMenu={(event) => openHistoryContextMenu(event, item)}
                        >
                          <strong>{getRunTitle(item)}</strong>
                          <small>{metaText}</small>
                          {matchPreview ? <span className="dash-side-history-snippet">{matchPreview}</span> : null}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {!collapsed && !historyLoading && filteredHistoryItems.length === 0 ? (
                <p className="dash-side-muted">{searchTokens.length > 0 ? "검색 결과를 찾지 못했어요" : historyEmptyLabel}</p>
              ) : null}
              {contextMenu && canRenameHistory ? (
                <div className="dash-side-context-menu" style={{ top: contextMenu.y, left: contextMenu.x }} role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      const targetRun = historyItems.find((item) => item.id === contextMenu.runId);
                      if (targetRun) startRenameRun(targetRun);
                    }}
                  >
                    제목 수정
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <p className="dash-side-label">메인 메뉴</p>
              <ul className="dash-menu">
                {filteredTabs.map((tab) => {
                  const Icon = tab.icon;
                  const active = activeTab === tab.id;
                  return (
                    <li key={tab.id}>
                      <button className={`dash-menu-item ${active ? "active" : ""}`} onClick={() => onSelect(tab.id)} aria-current={active ? "page" : undefined}>
                        <Icon size={18} />
                        <span>{tab.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {searchTokens.length > 0 && filteredTabs.length === 0 && !showSettingsShortcut ? (
                <p className="dash-side-muted">검색 결과를 찾지 못했어요</p>
              ) : null}
            </>
          )}
        </nav>
      </div>

      <div className="dash-side-settings">
        {showSettingsShortcut ? (
          <>
            <p className="dash-side-label">설정</p>
            <button className="dash-menu-item" onClick={onOpenSettings}>
              <Settings size={18} />
              <span>설정</span>
            </button>
          </>
        ) : null}
      </div>
    </aside>
  );
}

function FeatureControlsSection({
  title = "실행 기능",
  subtitle = "스킬과 별개로 Semo AI 동작 방식을 바꾸는 토글",
  className = "",
  featuresLoaded = false,
  features = [],
  featuresConfigured = false,
  featurePendingMap = {},
  featureError = "",
  onToggleFeature = null,
}) {
  if (!Array.isArray(features) || features.length === 0) return null;

  return (
    <section className={`dash-home-feature-panel dash-skill-feature-panel ${className}`.trim()}>
      <div className="dash-skill-feature-head">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>

      {!featuresLoaded ? <p className="dash-page-subtitle dash-page-subtitle-small">Semo AI 기능 상태를 확인하고 있어요</p> : null}
      {featuresLoaded && !featuresConfigured ? (
        <p className="dash-page-subtitle dash-page-subtitle-small">Semo AI를 연결하면 기능 토글을 쓸 수 있어요</p>
      ) : null}

      <div className="dash-home-feature-list dash-skill-feature-list">
        {features.map((feature) => {
          const pending = Boolean(featurePendingMap[feature.id]);
          const tooltipId = `feature-tooltip-${feature.id}`;
          const disabled = pending || !featuresConfigured || feature.status?.supported === false;
          const badge = resolveHomeFeatureBadge(feature.status, pending);
          return (
            <article
              key={feature.id}
              className={`dash-home-feature-pill ${feature.enabled ? "is-on" : ""} ${pending ? "is-pending" : ""}`}
            >
              <div className="dash-home-feature-pill-main">
                <span className="dash-home-feature-pill-name">{feature.name}</span>
                <span className="dash-chat-muted">{badge}</span>
                <div className="dash-home-feature-info-wrap">
                  <button
                    type="button"
                    className="dash-home-feature-info-btn"
                    aria-label={`${feature.name} 설명`}
                    aria-describedby={tooltipId}
                  >
                    <Info size={17} />
                  </button>
                  <div id={tooltipId} role="tooltip" className="dash-home-feature-tooltip">
                    {feature.description}
                    <br />
                    공식 ID: {feature.canonicalId}
                    {feature.status?.lastError ? (
                      <>
                        <br />
                        오류: {feature.status.lastError}
                      </>
                    ) : null}
                  </div>
                </div>
              </div>
              <button
                type="button"
                className={`dash-home-feature-toggle ${feature.enabled ? "on" : ""}`}
                onClick={() => {
                  if (typeof onToggleFeature === "function" && !disabled) {
                    void onToggleFeature(feature.id, !feature.enabled);
                  }
                }}
                disabled={disabled}
                aria-label={`${feature.name} 토글`}
                aria-pressed={Boolean(feature.enabled)}
              >
                <span />
              </button>
            </article>
          );
        })}
      </div>
      {featureError ? <p className="error-text">{featureError}</p> : null}
    </section>
  );
}

function HomeResearchModeToggle({ enabled = false, onToggle }) {
  return (
    <section className="dash-home-feature-panel dash-home-research-toggle-panel">
      <div className="dash-home-feature-list dash-home-research-toggle-list">
        <div className={`dash-home-feature-pill dash-home-research-toggle ${enabled ? "is-on" : ""}`}>
          <div className="dash-home-feature-pill-main dash-home-research-toggle-main">
            <span className="dash-home-feature-pill-name">웹 리서치</span>
            <span className="dash-chat-muted">{enabled ? "ON" : "OFF"}</span>
          </div>
          <button
            type="button"
            className={`dash-home-feature-toggle ${enabled ? "on" : ""}`}
            onClick={() => {
              if (typeof onToggle === "function") onToggle(!enabled);
            }}
            aria-label="웹 리서치 모드 토글"
            aria-pressed={enabled}
          >
            <span />
          </button>
        </div>
      </div>
    </section>
  );
}

function HomePage({
  home,
  loading,
  error,
  onRefresh,
  onCreateConversation,
  onCreateResearchRun,
  onConversationCreated,
  onOpenChat,
  onOpenRun,
  researchModeEnabled = false,
  onToggleResearchMode = null,
  onBeginRouteTransition = null,
}) {
  const [prompt, setPrompt] = useState("");
  const [showInsights, setShowInsights] = useState(false);
  const [composeFocused, setComposeFocused] = useState(false);
  const [typedPlaceholder, setTypedPlaceholder] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState([]);
  const attachmentInputRef = useRef(null);

  useEffect(() => {
    let timeoutId;
    let index = 0;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      index += 1;
      setTypedPlaceholder(HOME_TYPING_PLACEHOLDER.slice(0, index));
      if (index >= HOME_TYPING_PLACEHOLDER.length) return;
      timeoutId = window.setTimeout(tick, 40);
    };

    timeoutId = window.setTimeout(tick, 260);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, []);

  useEffect(() => {
    if (Array.isArray(home?.recentRuns) && home.recentRuns.length > 0) {
      setShowInsights(true);
    }
  }, [home?.recentRuns]);

  const handleSubmit = async () => {
    if ((!prompt.trim() && attachments.length === 0) || submitting) return;

    setSubmitting(true);
    setSubmitError("");

    try {
      const promptText = prompt.trim() || (attachments.length > 0 ? CHAT_ATTACHMENT_FALLBACK_PROMPT : "");
      setShowInsights(true);
      if (researchModeEnabled && typeof onCreateResearchRun === "function") {
        const result = await onCreateResearchRun({
          prompt: promptText,
          sourceAction: "home_web_research",
          attachments,
        });
        if (result?.runId && typeof onOpenRun === "function") {
          if (typeof onBeginRouteTransition === "function") {
            onBeginRouteTransition("runs");
            await new Promise((resolve) => window.setTimeout(resolve, 170));
          }
          onOpenRun(result.runId);
        }
        setPrompt("");
        setAttachments([]);
      } else {
        const result = await onCreateConversation({
          prompt: promptText,
          sourceAction: "chat",
          attachments,
        });
        if (result?.conversation?.id && typeof onConversationCreated === "function") {
          if (typeof onBeginRouteTransition === "function") {
            onBeginRouteTransition("chat");
            await new Promise((resolve) => window.setTimeout(resolve, 170));
          }
          onConversationCreated(result.conversation.id);
        }
        setPrompt("");
        setAttachments([]);
      }
      await onRefresh();
    } catch (submitErr) {
      setSubmitError(submitErr.message || "실행을 시작하지 못했어요");
    } finally {
      setSubmitting(false);
    }
  };

  const handleSelectAttachments = async (event) => {
    const files = event.target.files;
    if (!files?.length) return;
    setAttachments([]);
    setSubmitError(ATTACHMENT_FEATURE_COMING_SOON_MESSAGE);
    event.target.value = "";
  };

  const handleRemoveAttachment = (attachmentId) => {
    setAttachments((prev) => prev.filter((item) => String(item.id) !== String(attachmentId)));
  };

  return (
    <div className={`dash-page dash-home-page dash-content-enter ${showInsights ? "is-expanded" : "is-focused"}`}>
      <section className="dash-home-hero">
        <h1 className="dash-page-title">무엇을 시작할까요?</h1>

        <div className="dash-compose-panel">
          <div className="dash-compose-input-wrap">
            <AttachmentChipList attachments={attachments} onRemove={handleRemoveAttachment} />
            {!prompt && !composeFocused && attachments.length === 0 ? (
              <div className="dash-typing-placeholder" aria-hidden="true">
                {typedPlaceholder}
              </div>
            ) : null}
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onFocus={() => setComposeFocused(true)}
              onBlur={() => setComposeFocused(false)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
              placeholder=""
            />
          </div>
          <div className="dash-compose-footer">
            <input
              ref={attachmentInputRef}
              className="dash-hidden-file-input"
              type="file"
              multiple
              onChange={handleSelectAttachments}
              aria-hidden="true"
              tabIndex={-1}
            />
            <button
              className="dash-compose-circle plus"
              type="button"
              aria-label="첨부 추가"
              onClick={() => {
                if (submitting) return;
                setAttachments([]);
                setSubmitError(ATTACHMENT_FEATURE_COMING_SOON_MESSAGE);
              }}
              disabled={submitting}
            >
              <Plus size={20} />
            </button>
            <button
              className="dash-compose-circle send"
              type="button"
              aria-label="요청 보내기"
              onClick={() => void handleSubmit()}
              disabled={(!prompt.trim() && attachments.length === 0) || submitting}
            >
              <ArrowUp size={20} />
            </button>
          </div>
        </div>

        {submitError ? <p className="error-text">{submitError}</p> : null}

        <HomeResearchModeToggle enabled={researchModeEnabled} onToggle={onToggleResearchMode} />
      </section>

      {showInsights ? (
        <section className="dash-home-insights">
          <div className="dash-section-head">
            <h2>최근 내역</h2>
            <button className="dash-link-btn" onClick={onOpenChat} disabled={loading}>
              더보기 <ArrowRight size={13} />
            </button>
          </div>

          {error ? <p className="error-text">{error}</p> : null}

          <div className="dash-recent-grid">
            {(home?.recentRuns || []).slice(0, 3).map((item) => {
              const color = RUN_STATUS_COLOR[item.status] || "#3b82f6";
              return (
                <button key={item.id} type="button" className="dash-card dash-recent-card-btn" onClick={() => onOpenRun(item.id)}>
                  <div className="dash-recent-title-row">
                    <span className="dash-dot" style={{ backgroundColor: color }} />
                    <strong>{getRunTitle(item)}</strong>
                  </div>
                  <p>
                    {RUN_STATUS_LABEL[item.status] || item.status} | {toDateText(item.updatedAt)}
                  </p>
                  <div className="dash-progress-track">
                    <span style={{ width: `${runProgressFromStatus(item.status)}%`, backgroundColor: color }} />
                  </div>
                </button>
              );
            })}
          </div>

          <h2 className="dash-section-title">오늘 실행</h2>
          <div className="dash-stats-grid">
            <article className="dash-stat-card">
              <strong>{home?.todayStats?.runsToday ?? 0}</strong>
              <p>오늘 실행</p>
            </article>
            <article className="dash-stat-card">
              <strong>{home?.todayStats?.alerts ?? 0}</strong>
              <p>알림</p>
            </article>
            <article className="dash-stat-card">
              <strong>{home?.todayStats?.successRate ?? 0}%</strong>
              <p>성공률</p>
            </article>
            <article className="dash-stat-card">
              <strong>{home?.todayStats?.tokenUsage ?? 0}</strong>
              <p>토큰 사용</p>
            </article>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function ChatPage({
  active,
  initialConversationId = "",
  onConversationSelected,
  onCreateConversation,
  onRunCreated,
}) {
  const [conversationDetail, setConversationDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [optimisticMessages, setOptimisticMessages] = useState([]);
  const threadRef = useRef(null);
  const threadEndRef = useRef(null);
  const attachmentInputRef = useRef(null);
  const shouldFollowThreadRef = useRef(true);
  const forceThreadScrollRef = useRef(false);
  const lastConversationIdRef = useRef("");

  const scrollThreadToBottom = useCallback((behavior = "smooth") => {
    const thread = threadRef.current;
    if (!thread) return;
    const nextBehavior = behavior === "auto" ? "auto" : "smooth";
    if (threadEndRef.current?.scrollIntoView) {
      threadEndRef.current.scrollIntoView({ block: "end", behavior: nextBehavior });
      return;
    }
    thread.scrollTo({ top: thread.scrollHeight, behavior: nextBehavior });
  }, []);

  const handleThreadScroll = useCallback(() => {
    const thread = threadRef.current;
    if (!thread) return;
    const distanceFromBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight;
    shouldFollowThreadRef.current = distanceFromBottom <= 96;
  }, []);

  const fetchConversation = useCallback(async (conversationId) => {
    if (!conversationId) {
      setConversationDetail(null);
      return null;
    }
    const json = await fetchApiJson(`/api/ui/runtime/conversations/${encodeURIComponent(conversationId)}`);
    setConversationDetail(json.conversation || null);
    return json.conversation || null;
  }, []);

  useEffect(() => {
    if (!active) return;
    if (!initialConversationId) {
      setConversationDetail(null);
      setOptimisticMessages([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchConversation(initialConversationId)
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message || "대화 상세를 불러오지 못했어요");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, fetchConversation, initialConversationId]);

  useEffect(() => {
    if (!active) return undefined;
    if (initialConversationId === lastConversationIdRef.current) return undefined;
    lastConversationIdRef.current = initialConversationId;
    setOptimisticMessages([]);
    shouldFollowThreadRef.current = true;
    const raf = window.requestAnimationFrame(() => {
      scrollThreadToBottom("auto");
    });
    return () => window.cancelAnimationFrame(raf);
  }, [active, initialConversationId, scrollThreadToBottom]);

  useEffect(() => {
    if (!active) return undefined;
    if (!forceThreadScrollRef.current && !shouldFollowThreadRef.current) return undefined;
    const raf = window.requestAnimationFrame(() => {
      scrollThreadToBottom(forceThreadScrollRef.current ? "smooth" : "auto");
      forceThreadScrollRef.current = false;
    });
    return () => window.cancelAnimationFrame(raf);
  }, [active, conversationDetail?.messages, conversationDetail?.followupQuestions, conversationDetail?.status, scrollThreadToBottom]);

  const applyConversationResponse = useCallback(
    async (json) => {
      setOptimisticMessages([]);
      if (json?.conversation) {
        setConversationDetail(json.conversation);
      }
      if (json?.conversation?.id && typeof onConversationSelected === "function") {
        onConversationSelected(json.conversation.id);
      }
      if (json?.transition?.state === "committed" && json.transition.runId && typeof onRunCreated === "function") {
        onRunCreated(json.transition.runId, json?.conversation?.id || "");
      }
    },
    [onConversationSelected, onRunCreated]
  );

  const sendConversationPayload = useCallback(
    async (payload) => {
      if (!conversationDetail?.id) return null;
      const json = await fetchApiJson(`/api/ui/runtime/conversations/${encodeURIComponent(conversationDetail.id)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await applyConversationResponse(json);
      return json;
    },
    [applyConversationResponse, conversationDetail?.id]
  );

  const handleSubmit = async () => {
    if ((!prompt.trim() && attachments.length === 0) || submitting) return;
    const draftPrompt = prompt;
    const nextPrompt = prompt.trim() || (attachments.length > 0 ? CHAT_ATTACHMENT_FALLBACK_PROMPT : "");
    const nextAttachments = attachments;
    const optimisticMessage = createOptimisticChatMessage({
      text: nextPrompt,
      attachments: nextAttachments,
    });
    forceThreadScrollRef.current = true;
    setOptimisticMessages((prev) => [...prev, optimisticMessage]);
    setPrompt("");
    setAttachments([]);
    setSubmitting(true);
    setSubmitError("");
    try {
      let json;
      if (conversationDetail?.id) {
        json = await sendConversationPayload({ text: nextPrompt, attachments: nextAttachments });
      } else {
        const create = typeof onCreateConversation === "function" ? onCreateConversation : async (nextPayload) => {
          return fetchApiJson("/api/ui/runtime/conversations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(nextPayload),
          });
        };
        json = await create({
          prompt: nextPrompt,
          sourceAction: "chat",
          attachments: nextAttachments,
        });
        await applyConversationResponse(json);
      }
      return json;
    } catch (submitErr) {
      setOptimisticMessages((prev) => prev.filter((item) => item.id !== optimisticMessage.id));
      setPrompt(draftPrompt);
      setAttachments(nextAttachments);
      setSubmitError(submitErr.message || "메시지를 보내지 못했어요");
      return null;
    } finally {
      setSubmitting(false);
    }
  };

  const handleCreateFreshConversation = () => {
    if (typeof onConversationSelected === "function") onConversationSelected("");
    setConversationDetail(null);
    setPrompt("");
    setAttachments([]);
    setOptimisticMessages([]);
    setError("");
    setSubmitError("");
    shouldFollowThreadRef.current = true;
    forceThreadScrollRef.current = false;
    lastConversationIdRef.current = "";
  };

  const handleSelectAttachments = async (event) => {
    const files = event.target.files;
    if (!files?.length) return;
    setAttachments([]);
    setSubmitError(ATTACHMENT_FEATURE_COMING_SOON_MESSAGE);
    event.target.value = "";
  };

  const handleRemoveAttachment = (attachmentId) => {
    setAttachments((prev) => prev.filter((item) => String(item.id) !== String(attachmentId)));
  };

  const activeConversation = conversationDetail || null;
  const messages = Array.isArray(activeConversation?.messages) ? activeConversation.messages : [];
  const renderMessages = [...messages, ...optimisticMessages];
  const showEmptyState = !activeConversation && optimisticMessages.length === 0 && !submitting;
  const showCommitLoader = activeConversation?.status === "committing";
  const showReplyPending = submitting && !showCommitLoader;
  const headTitle = activeConversation ? getRunTitle(activeConversation) : "새 대화";
  const headCopy = loading
    ? "대화를 불러오는 중이에요"
    : showCommitLoader
      ? "질문을 정리해서 실행 화면으로 넘기고 있어요"
      : activeConversation
        ? "Semo AI와 바로 연결된 일반 대화예요"
        : "원하는 작업이나 질문을 바로 보내면 일반 대화가 시작돼요";

  return (
    <div className="dash-page dash-chat-page dash-content-enter">
      <div className="dash-chat-layout dash-chat-layout-single">
        <section className="dash-chat-thread-panel dash-chat-thread-panel-single">
          <div className="dash-chat-thread-head">
            <div>
              <h2>{headTitle}</h2>
              <p className="dash-chat-head-copy">{headCopy}</p>
            </div>
            <div className="dash-chat-head-actions">
              <button type="button" className="dash-chat-new-btn compact" onClick={handleCreateFreshConversation}>
                <Plus size={15} />
                <span>새 대화</span>
              </button>
            </div>
          </div>

          {error ? <p className="error-text">{error}</p> : null}

          <div ref={threadRef} className="dash-chat-thread" onScroll={handleThreadScroll}>
            {showCommitLoader ? (
              <div className="dash-chat-loader" role="status" aria-live="polite">
                <div className="dash-chat-loader-badge">
                  <LoaderCircle size={16} className="dash-spin" />
                  <span>실행 준비 중</span>
                </div>
                <strong>질문 정리를 마쳤어요</strong>
                <p>run을 만들고 실행 화면으로 전환하고 있어요</p>
              </div>
            ) : null}

            {showEmptyState ? (
              <article className="dash-chat-message system">
                <div className="dash-chat-role">안내</div>
                <p>원하는 작업이나 질문을 바로 입력해 주세요, 일반 채팅처럼 바로 답변을 이어가요</p>
              </article>
            ) : null}

            {renderMessages.map((message) => (
              <article key={message.id || `${message.ts}-${message.text}`} className={`dash-chat-message ${message.role === "user" ? "user" : message.role === "system" ? "system" : "assistant"}`}>
                <div className="dash-chat-role">
                  {message.role === "user" ? "나" : message.role === "system" ? "안내" : "Semo"}
                  <span>{toDateText(message.ts)}</span>
                </div>
                <p>{message.text || "-"}</p>
                <AttachmentChipList attachments={message.attachments} />
              </article>
            ))}

            {showReplyPending ? (
              <article className="dash-chat-message assistant pending" aria-live="polite">
                <div className="dash-chat-role">
                  Semo
                  <span>입력 확인 중</span>
                </div>
                <div className="dash-chat-pending-dots" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              </article>
            ) : null}

            <div ref={threadEndRef} aria-hidden="true" />
          </div>

          <div className="dash-chat-composer">
            <input
              ref={attachmentInputRef}
              className="dash-hidden-file-input"
              type="file"
              multiple
              onChange={handleSelectAttachments}
              aria-hidden="true"
              tabIndex={-1}
            />
            <button
              type="button"
              className="dash-chat-attach"
              onClick={() => {
                setAttachments([]);
                setSubmitError(ATTACHMENT_FEATURE_COMING_SOON_MESSAGE);
              }}
              aria-label="첨부 추가"
              disabled={submitting || showCommitLoader}
            >
              <Plus size={18} />
            </button>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder={attachments.length > 0 ? "" : activeConversation ? "메시지를 입력하세요" : "예: 이번 주 회의록 핵심만 요약해줘"}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
            />
            <button
              type="button"
              className="dash-chat-send"
              onClick={() => void handleSubmit()}
              disabled={(!prompt.trim() && attachments.length === 0) || submitting || showCommitLoader}
            >
              {submitting ? "보내는 중" : "보내기"}
            </button>
          </div>

          <AttachmentChipList attachments={attachments} onRemove={handleRemoveAttachment} />

          {submitError ? <p className="error-text">{submitError}</p> : null}
        </section>
      </div>
    </div>
  );
}

function RunsPage({ active, initialRunId = "", sidebarRuns = [], onOpenResultInChat }) {
  const [runs, setRuns] = useState([]);
  const [activeRunId, setActiveRunId] = useState(() => String(initialRunId || ""));
  const [runDetail, setRunDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [wsState, setWsState] = useState("idle");
  const [runViewTab, setRunViewTab] = useState("overview");
  const [actionPending, setActionPending] = useState({});
  const [reviewNotes, setReviewNotes] = useState({});
  const [openResultChatPending, setOpenResultChatPending] = useState(false);
  const enableRunsWs = !import.meta.env.DEV || import.meta.env.VITE_ENABLE_RUNS_WS === "1";

  const fetchRuns = useCallback(async () => {
    const json = await fetchApiJson("/api/ui/runtime/runs");
    const nextRuns = Array.isArray(json.items) ? json.items : [];
    setRuns(nextRuns);
    if (!activeRunId && nextRuns.length > 0) setActiveRunId(nextRuns[0].id);
    if (activeRunId && !nextRuns.some((run) => run.id === activeRunId)) {
      setActiveRunId(nextRuns[0]?.id || activeRunId);
    }
  }, [activeRunId]);

  const fetchDetail = useCallback(async (runId) => {
    if (!runId) {
      setRunDetail(null);
      return;
    }
    const json = await fetchApiJson(`/api/ui/runtime/runs/${encodeURIComponent(runId)}`);
    setRunDetail(json.run || null);
  }, []);

  useEffect(() => {
    if (!initialRunId) return;
    setActiveRunId((prev) => (prev === initialRunId ? prev : initialRunId));
  }, [initialRunId]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError("");

    fetchRuns()
      .catch((loadError) => {
        if (!cancelled) setError(loadError.message || "실행 목록을 불러오지 못했어요");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [active, fetchRuns]);

  useEffect(() => {
    if (!active || !activeRunId) return;
    fetchDetail(activeRunId).catch((detailError) => {
      setError(detailError.message || "실행 상세를 불러오지 못했어요");
    });
  }, [active, activeRunId, fetchDetail]);

  useEffect(() => {
    if (!active || !enableRunsWs) return undefined;

    let socket;
    let reconnectTimer;
    let reconnectCount = 0;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const query = activeRunId ? `?runId=${encodeURIComponent(activeRunId)}` : "";
      socket = new WebSocket(`${protocol}//${window.location.host}/api/ui/runtime/runs/stream${query}`);
      setWsState("connecting");

      socket.onopen = () => {
        reconnectCount = 0;
        setWsState("connected");
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "snapshot") {
            if (Array.isArray(message.items)) setRuns(message.items);
            if (message.run) setRunDetail(message.run);
            return;
          }

          if (message.type === "run_updated" && message.run) {
            setRuns((prev) => {
              const next = [...prev];
              const index = next.findIndex((row) => row.id === message.run.id);
              if (index >= 0) next[index] = { ...next[index], ...message.run };
              else next.unshift(message.run);
              return next.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
            });
            if (message.run.id === activeRunId) {
              setRunDetail((prev) => ({ ...(prev || {}), ...message.run }));
            }
            return;
          }

          if (message.type === "task_updated" && message.runId === activeRunId) {
            setRunDetail((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                step: message.step ?? prev.step,
                steps: Array.isArray(message.steps) ? message.steps : prev.steps,
                tasks: Array.isArray(message.tasks) ? message.tasks : prev.tasks,
                wbs: message.wbs ?? prev.wbs,
                pauseState: message.pauseState ?? prev.pauseState,
                currentExecution: message.currentExecution ?? prev.currentExecution,
                artifacts: message.artifacts ?? prev.artifacts,
                executionTranscript: Array.isArray(message.executionTranscript) ? message.executionTranscript : prev.executionTranscript,
              };
            });
            return;
          }

          if (message.type === "log_appended" && message.runId === activeRunId) {
            setRunDetail((prev) => {
              if (!prev) return prev;
              const nextLogs = Array.isArray(prev.logs) ? [...prev.logs] : [];
              if (message.log) nextLogs.push(message.log);
              return { ...prev, logs: nextLogs.slice(-300) };
            });
            return;
          }

          if (message.type === "transcript_appended" && message.runId === activeRunId) {
            setRunDetail((prev) => {
              if (!prev) return prev;
              const nextTranscript = Array.isArray(prev.executionTranscript) ? [...prev.executionTranscript] : [];
              if (message.entry) nextTranscript.push(message.entry);
              return { ...prev, executionTranscript: nextTranscript.slice(-400) };
            });
            return;
          }

          if (message.type === "usage_updated" && message.runId === activeRunId) {
            setRunDetail((prev) => (prev ? { ...prev, usage: message.usage || prev.usage } : prev));
            return;
          }

          if (message.type === "error") {
            setError(message.message || "실시간 연결 중 오류가 발생했어요");
          }
        } catch {
          // ignore malformed payload
        }
      };

      socket.onerror = () => setWsState("error");
      socket.onclose = () => {
        if (disposed) return;
        setWsState("reconnecting");
        reconnectCount += 1;
        const delay = Math.min(10_000, 500 * 2 ** reconnectCount);
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimer);
      if (socket) {
        try {
          socket.close();
        } catch {
          // ignore close error
        }
      }
    };
  }, [active, activeRunId, enableRunsWs]);

  useEffect(() => {
    if (!active || enableRunsWs) return undefined;
    let timer;
    let cancelled = false;
    setWsState("polling");

    const poll = async () => {
      try {
        await fetchRuns();
        if (activeRunId) await fetchDetail(activeRunId);
        if (!cancelled) setWsState("polling");
      } catch (pollError) {
        if (!cancelled) {
          setWsState("error");
          setError(pollError.message || "실행 동기화에 실패했어요");
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 2000);
      }
    };

    poll();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, activeRunId, enableRunsWs, fetchDetail, fetchRuns]);

  const optimisticRun =
    runs.find((run) => run.id === activeRunId) ||
    (Array.isArray(sidebarRuns) ? sidebarRuns.find((run) => run.id === activeRunId || run.id === initialRunId) : null) ||
    null;
  const activeRun = runDetail || optimisticRun || null;
  const isUsecaseRun = Boolean(activeRun?.usecaseId);
  const steps = Array.isArray(activeRun?.steps) && activeRun.steps.length > 0 ? activeRun.steps : [];
  const groupedPhases = groupedTasksByPhase(activeRun);
  const logs = Array.isArray(activeRun?.logs) ? activeRun.logs : [];
  const pauseState = activeRun?.pauseState || null;
  const usage = activeRun?.usage || null;
  const resultPayload = activeRun?.artifacts?.result || null;
  const syncStateLabel = getSyncStateLabel(wsState);
  const overviewRows = activeRun?.normalizedInput && typeof activeRun.normalizedInput === "object" ? Object.entries(activeRun.normalizedInput) : [];
  const featureSnapshot = Array.isArray(activeRun?.executionFeatures) ? activeRun.executionFeatures : [];
  const isWebResearchRun = activeRun?.usecaseId === "web_research";
  const reviewTask = Array.isArray(activeRun?.tasks)
    ? activeRun.tasks.find((task) => String(task?.role || "") === "Review Needed") || null
    : null;
  const reviewNote = reviewTask ? reviewNotes[reviewTask.id] || "" : "";
  const approvePending = Boolean(reviewTask && actionPending[`${reviewTask.id}:review_approve`]);
  const requestChangesPending = Boolean(reviewTask && actionPending[`${reviewTask.id}:review_request_changes`]);
  const commentPending = Boolean(reviewTask && actionPending[`${reviewTask.id}:review_comment`]);

  const sendTaskAction = async (task, action, extra = {}) => {
    if (!activeRun?.id || !task?.id) return;
    const key = `${task.id}:${action}`;
    setActionPending((prev) => ({ ...prev, [key]: true }));
    try {
      const json = await fetchApiJson(`/api/ui/runtime/runs/${encodeURIComponent(activeRun.id)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          taskId: task.id,
          ...extra,
        }),
      });
      if (json?.run) setRunDetail(json.run);
    } catch (actionError) {
      setError(actionError.message || "액션 처리에 실패했어요");
    } finally {
      setActionPending((prev) => ({ ...prev, [key]: false }));
    }
  };

  const copyResult = async () => {
    if (!resultPayload) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(resultPayload, null, 2));
    } catch {
      setError("클립보드 복사에 실패했어요");
    }
  };

  const exportResult = () => {
    if (!resultPayload) return;
    const blob = new Blob([JSON.stringify(resultPayload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeRun?.id || "run"}-result.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const openResultInChat = async (payload) => {
    if (typeof onOpenResultInChat !== "function") return;
    setOpenResultChatPending(true);
    setError("");
    try {
      await onOpenResultInChat(payload);
    } catch (openError) {
      setError(openError.message || "대화 탭으로 넘기지 못했어요");
    } finally {
      setOpenResultChatPending(false);
    }
  };

  return (
    <div className="dash-page dash-runs-page dash-content-enter">
      {isWebResearchRun && activeRun ? (
        <WebResearchRunView
          run={activeRun}
          logs={logs}
          reviewTask={reviewTask}
          onApprove={() => {
            if (!reviewTask) return;
            void sendTaskAction(reviewTask, "review_approve", { comment: reviewNote });
          }}
          onRequestChanges={() => {
            if (!reviewTask) return;
            void sendTaskAction(reviewTask, "review_request_changes", { comment: reviewNote });
          }}
          onOpenInChat={openResultInChat}
          approvePending={approvePending}
          requestChangesPending={requestChangesPending}
          openInChatPending={openResultChatPending}
        />
      ) : (
        <section className="dash-run-detail-panel">
          {activeRun ? (
            <>
            <div className="dash-run-top">
              <h1>{activeRun.title}</h1>
              <div className={`dash-run-status ${getRunStatusClassName(activeRun.status)}`}>
                <span className="dash-dot" style={{ backgroundColor: RUN_STATUS_COLOR[activeRun.status] || "#9ca3af" }} />
                <span>{RUN_STATUS_LABEL[activeRun.status] || activeRun.status}</span>
                {syncStateLabel ? (
                  <>
                    <span>·</span>
                    <span>{syncStateLabel}</span>
                  </>
                ) : null}
              </div>
            </div>

            <div className="dash-run-subtabs">
              <button type="button" className={`dash-run-subtab ${runViewTab === "overview" ? "active" : ""}`} onClick={() => setRunViewTab("overview")}>
                Overview
              </button>
              <button type="button" className={`dash-run-subtab ${runViewTab === "wbs" ? "active" : ""}`} onClick={() => setRunViewTab("wbs")}>
                WBS
              </button>
              <button type="button" className={`dash-run-subtab ${runViewTab === "execute" ? "active" : ""}`} onClick={() => setRunViewTab("execute")}>
                Execution
              </button>
              <button type="button" className={`dash-run-subtab ${runViewTab === "result" ? "active" : ""}`} onClick={() => setRunViewTab("result")}>
                Result
              </button>
            </div>

            {runViewTab === "overview" ? (
              <>
                <div className="dash-run-overview-grid">
                  <article className="dash-run-overview-card">
                    <h3>원본 요청</h3>
                    <p>{activeRun.prompt || "입력 없음"}</p>
                  </article>
                  <article className="dash-run-overview-card">
                    <h3>작업 유형</h3>
                    <p>{activeRun.usecaseId || "일반 실행"}</p>
                  </article>
                  <article className="dash-run-overview-card">
                    <h3>연결된 planning</h3>
                    <p>{activeRun.originConversationId || "없음"}</p>
                  </article>
                </div>

                <div className="dash-run-feature-box">
                  <strong>고정된 Semo AI feature snapshot</strong>
                  <p>{featureSnapshot.length > 0 ? featureSnapshot.join(", ") : "고정된 feature 없음"}</p>
                </div>

                <h3>확정 입력 요약</h3>
                {overviewRows.length > 0 ? (
                  <div className="dash-run-summary-list">
                    {overviewRows.map(([key, value]) => (
                      <div key={key} className="dash-run-summary-row">
                        <span>{key}</span>
                        <strong>{Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value)}</strong>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="dash-run-empty">확정된 입력 요약이 아직 없어요</p>
                )}
              </>
            ) : null}

            {runViewTab === "wbs" ? (
              <>
                <h3>WBS 구조</h3>
                {isUsecaseRun ? (
                  groupedPhases.map((phase) => (
                    <div key={phase.id} className="dash-phase-block">
                      <h4>
                        {phase.index}. {phase.title}
                      </h4>
                      <div className="dash-task-list">
                        {phase.tasks.map((task) => {
                          const role = toTaskRole(task);
                          return (
                            <div key={task.id} className="dash-task-row is-wbs">
                              <div className="dash-task-left">
                                <input type="checkbox" checked={Boolean(task.done)} readOnly />
                                <p className={task.done ? "done" : ""}>{task.title || task.text}</p>
                              </div>
                              <span className={`dash-badge ${ROLE_BADGE_CLASS[role] || "ai"}`}>{role}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="dash-run-empty">WBS가 생성된 실행만 여기에서 구조를 보여줘요</p>
                )}
              </>
            ) : null}

            {runViewTab === "execute" ? (
              <>
                <h3>실행 단계</h3>
                <div className="dash-steps">
                  {steps.map((step) => (
                    <button key={`${step.index}-${step.label}`} className="dash-step-col" type="button">
                      <span className={`dash-step-box ${Number(activeRun.step || 1) === Number(step.index) ? "active" : ""}`}>{step.index}</span>
                      <small className="dash-step-label">{step.label || "단계"}</small>
                    </button>
                  ))}
                </div>

                {pauseState?.whyHuman ? <p className="dash-pause-reason">중단 사유: {pauseState.whyHuman}</p> : null}
                {pauseState ? (
                  <div className="dash-exec-controls">
                    <button type="button" className="dash-run-resume-btn" onClick={() => sendTaskAction({ id: pauseState.taskId || "resume" }, "resume")}>
                      자동 실행 재개
                    </button>
                  </div>
                ) : null}

                {groupedPhases.map((phase) => (
                  <div key={phase.id} className="dash-phase-block">
                    <h4>
                      {phase.index}. {phase.title}
                    </h4>
                    <div className="dash-task-list">
                      {phase.tasks.map((task) => {
                        const role = toTaskRole(task);
                        const note = reviewNotes[task.id] || "";
                        return (
                          <div key={task.id} className="dash-task-row is-exec">
                            <div className="dash-task-left">
                              <input type="checkbox" checked={Boolean(task.done)} readOnly />
                              <div className="dash-task-copy">
                                <p className={task.done ? "done" : ""}>{task.title || task.text}</p>
                                {role !== "AI" && task.whyHuman ? <small>{task.whyHuman}</small> : null}
                              </div>
                            </div>

                            <div className="dash-task-actions">
                              {role === "AI" ? (
                                <button
                                  type="button"
                                  className="dash-action-btn ai"
                                  onClick={() => sendTaskAction(task, "ai_execute")}
                                  disabled={task.status === "completed" || Boolean(actionPending[`${task.id}:ai_execute`])}
                                >
                                  AI 실행
                                </button>
                              ) : null}

                              {role === "Human" ? (
                                <button
                                  type="button"
                                  className="dash-action-btn person"
                                  onClick={() =>
                                    task.assignee === "담당자 지정"
                                      ? sendTaskAction(task, "assign_human", { assignee: "00님" })
                                      : sendTaskAction(task, "human_done")
                                  }
                                  disabled={task.status === "completed"}
                                >
                                  {task.assignee || ROLE_ACTION_LABEL[role]}
                                </button>
                              ) : null}

                              {role === "Review Needed" ? (
                                <div className="dash-review-panel">
                                  <button type="button" className="dash-action-btn review" disabled>
                                    검토 필요/리뷰 요청
                                  </button>
                                  <textarea
                                    value={note}
                                    onChange={(event) => setReviewNotes((prev) => ({ ...prev, [task.id]: event.target.value }))}
                                    placeholder="코멘트 입력"
                                  />
                                  <div className="dash-review-actions">
                                    <button type="button" onClick={() => sendTaskAction(task, "review_approve", { comment: note })}>
                                      승인
                                    </button>
                                    <button type="button" onClick={() => sendTaskAction(task, "review_request_changes", { comment: note })}>
                                      수정요청
                                    </button>
                                    <button type="button" onClick={() => sendTaskAction(task, "review_comment", { comment: note })}>
                                      코멘트
                                    </button>
                                  </div>
                                </div>
                              ) : null}

                              <span className={`dash-badge ${ROLE_BADGE_CLASS[role] || "ai"}`}>{role}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

                <div className="dash-log-box">
                  <h4>실행 로그</h4>
                  <div>
                    {logs.length === 0 ? <p>로그가 들어오면 여기에 보여요</p> : null}
                    {logs.map((log) => (
                      <p key={log.id || `${log.ts}-${log.message}`}>[{toDateText(log.ts)}] {log.message}</p>
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {runViewTab === "result" ? (
              <div className="dash-result-panel">
                <h4>결과 / 사용량</h4>
                {usage ? (
                  <p>
                    provider={usage.provider || "-"} · model={usage.model || "-"} · input={usage.inputTokens || 0} · output={usage.outputTokens || 0} · total=
                    {usage.totalTokens || 0}
                  </p>
                ) : null}
                {resultPayload ? <pre>{JSON.stringify(resultPayload, null, 2)}</pre> : <p>결과 생성 대기 중</p>}
                <div className="dash-result-actions">
                  <button type="button" onClick={copyResult} disabled={!resultPayload}>
                    결과 복사
                  </button>
                  <button type="button" onClick={exportResult} disabled={!resultPayload}>
                    JSON 내보내기
                  </button>
                </div>
              </div>
            ) : null}
            </>
          ) : (
            <p>왼쪽에서 실행을 선택해 보세요</p>
          )}
        </section>
      )}
    </div>
  );
}

function SkillsPage({
  active,
  skills = [],
  loading,
  error,
  pendingMap = {},
  onRefresh,
  onToggleSkill,
  onConfigureSkill,
  featuresLoaded = false,
  features = [],
  featuresConfigured = false,
  featurePendingMap = {},
  featureError = "",
  onToggleFeature = null,
}) {
  if (!active) return null;

  const normalizedSkills = Array.isArray(skills) ? skills.map(normalizeSkillItem) : [];
  const enabledCount = normalizedSkills.filter((skill) => skill.enabled).length;
  const defaultCount = normalizedSkills.filter((skill) => skill.defaultInstalled).length;

  return (
    <div className="dash-page dash-content-enter">
      <h1 className="dash-page-title dash-page-title-small">스킬</h1>
      <p className="dash-page-subtitle dash-page-subtitle-small">서비스에 기본 포함되거나 사용자가 설치한 실제 Semo AI 스킬</p>

      <article className="dash-skill-banner">
        <div>
          <h2>실제 설치 스킬</h2>
          <p>
            기본 포함 {defaultCount}개, 현재 활성 {enabledCount}개
          </p>
        </div>
        <button
          type="button"
          className="dash-action-btn ai dash-skill-refresh-btn"
          onClick={onRefresh}
          disabled={loading}
          aria-label={loading ? "스킬 새로고침 중" : "스킬 새로고침"}
          title={loading ? "새로고침 중" : "새로고침"}
        >
          <RefreshCw size={16} className={loading ? "dash-spin" : ""} />
        </button>
      </article>

      {error ? (
        <div className="dash-skill-message error">
          <Info size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      {!loading && normalizedSkills.length === 0 ? <div className="dash-skill-empty">스킬을 설치하면 여기에 보여요</div> : null}

      <FeatureControlsSection
        title="실행 기능"
        subtitle="스킬과 별개로 에이전트 동작 방식을 바꾸는 토글"
        featuresLoaded={featuresLoaded}
        features={features}
        featuresConfigured={featuresConfigured}
        featurePendingMap={featurePendingMap}
        featureError={featureError}
        onToggleFeature={onToggleFeature}
      />

      <div className="dash-skill-grid">
        {normalizedSkills.map((skill) => {
          const pending = Boolean(pendingMap[skill.id]);
          const setupTone = getSkillSetupTone(skill);
          return (
          <article key={skill.id} className="dash-skill-card">
            <header className="dash-skill-card-head">
              <div className="dash-skill-card-top">
                <div className="dash-skill-icon" />
                <div className="dash-skill-badges">
                  <span className={`dash-badge ${skill.source === "default" ? "ai" : "person"}`}>
                    {skill.source === "default" ? "기본 포함" : "사용자 설치"}
                  </span>
                  <span className={`dash-skill-state ${setupTone}`}>{getSkillSetupLabel(skill)}</span>
                </div>
              </div>
              <button
                type="button"
                className={`dash-skill-switch ${skill.enabled ? "on" : ""}`}
                onClick={() => onToggleSkill(skill)}
                disabled={pending}
                aria-label={`${skill.name} ${skill.enabled ? "비활성화" : "활성화"}`}
                title={skill.enabled ? "비활성화" : "활성화"}
              >
                <span />
              </button>
            </header>
            <h3>{skill.name}</h3>
            <p>{skill.description}</p>
            <div className="dash-skill-meta">
              <span>상태</span>
              <strong>{skill.enabled ? "활성" : "비활성"}</strong>
            </div>
            <div className="dash-skill-meta">
              <span>기본 포함</span>
              <strong>{skill.defaultInstalled ? "예" : "아니오"}</strong>
            </div>
            <div className="dash-skill-footer">
              {pending ? (
                <span className="dash-skill-inline">
                  <LoaderCircle size={14} className="dash-spin" />
                  적용 중
                </span>
              ) : null}
              {skill.setupState === "needs_env" || skill.setupState === "needs_oauth" ? (
                <button type="button" className="dash-skill-config-btn" onClick={() => onConfigureSkill?.(skill)}>
                  {skill.setupState === "needs_oauth" ? "연결 정보 설정" : "환경 변수 설정"}
                </button>
              ) : null}
              {skill.setupHint ? <small className={`dash-skill-hint ${setupTone}`}>{skill.setupHint}</small> : null}
            </div>
          </article>
          );
        })}
      </div>
    </div>
  );
}

function MonitorPage({ metrics, active, onboardingState }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({ totalTokens: 0, totalCostUsd: 0 });
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [expandedRunIdKeys, setExpandedRunIdKeys] = useState(() => new Set());
  const pageSize = 5;
  const runIdTruncateLength = 14;

  const loadUsage = useCallback(async () => {
    try {
      const json = await fetchApiJson("/api/ui/runtime/usage?limit=300");
      setRows(Array.isArray(json.rows) ? json.rows : []);
      setSummary(json.summary || { totalTokens: 0, totalCostUsd: 0 });
      setError("");
    } catch (usageError) {
      setError(usageError.message || "사용량 데이터를 불러오지 못했어요");
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    let timer;
    let cancelled = false;

    const poll = async () => {
      await loadUsage();
      if (!cancelled) {
        timer = window.setTimeout(poll, 3000);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, loadUsage]);

  const filtered = rows.filter((row) => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return true;
    return (
      String(row.runId || "").toLowerCase().includes(keyword) ||
      String(row.provider || "").toLowerCase().includes(keyword) ||
      String(row.model || "").toLowerCase().includes(keyword)
    );
  });

  useEffect(() => {
    setPage(1);
  }, [query]);

  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStartIndex = (currentPage - 1) * pageSize;
  const pageRows = filtered.slice(pageStartIndex, pageStartIndex + pageSize);
  const rangeStart = totalCount === 0 ? 0 : pageStartIndex + 1;
  const rangeEnd = totalCount === 0 ? 0 : pageStartIndex + pageRows.length;

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    setExpandedRunIdKeys(new Set());
  }, [query, currentPage]);

  const pageWindow = 5;
  let pageFirst = Math.max(1, currentPage - Math.floor(pageWindow / 2));
  let pageLast = Math.min(totalPages, pageFirst + pageWindow - 1);
  pageFirst = Math.max(1, pageLast - pageWindow + 1);
  const pageNumbers = Array.from({ length: pageLast - pageFirst + 1 }, (_, index) => pageFirst + index);

  const metricCards = [
    { label: "CPU", value: metrics?.cpuPercent ?? 0, unit: "%" },
    { label: "RAM", value: metrics?.memPercent ?? 0, unit: "%" },
    { label: "DISK", value: metrics?.diskPercent ?? 0, unit: "%" },
    {
      label: "NETWORK",
      value: typeof metrics?.rxBps === "number" ? Math.max(1, Math.round(metrics.rxBps / 1024)) : 0,
      unit: "KB/s",
    },
  ];

  const configured = Boolean(onboardingState?.configured);
  const gatewayRunning = Boolean(onboardingState?.gatewayRunning);
  const lastErrorCode = onboardingState?.lastErrorCode ? String(onboardingState.lastErrorCode) : "NONE";
  const stateCards = [
    {
      label: "Configured",
      value: configured ? "ON" : "OFF",
      tone: configured ? "ok" : "off",
      sub: "설정 완료 여부",
    },
    {
      label: "Gateway",
      value: gatewayRunning ? "RUNNING" : "STOPPED",
      tone: gatewayRunning ? "ok" : "off",
      sub: "Semo AI 프로세스 상태",
    },
    {
      label: "Last Error",
      value: lastErrorCode,
      tone: lastErrorCode === "NONE" ? "muted" : "danger",
      sub: "마지막 오류 코드",
    },
  ];
  const totalTokensValue = Number(summary.totalTokens || 0);
  const totalCostUsdValue = Number(summary.totalCostUsd || 0);
  const usageRowCount = Array.isArray(rows) ? rows.length : 0;
  const hasUsageData = usageRowCount > 0 || totalTokensValue > 0 || totalCostUsdValue > 0;
  const costPerThousandTokens =
    totalTokensValue > 0 ? `1K토큰당 $${((totalCostUsdValue / totalTokensValue) * 1000).toFixed(4)}` : "비용 데이터 집계 대기 중";
  const summaryStatus = error ? "degraded" : hasUsageData ? "live" : "idle";
  const summaryStatusLabel = error ? "지연" : hasUsageData ? "정상" : "대기";

  return (
    <div className="dash-page dash-content-enter">
      <div className="dash-monitor-top">
        <section className="dash-monitor-table">
          <div className="dash-monitor-head">
            <h2>사용 내역</h2>
            <label className="dash-inline-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="검색" />
            </label>
          </div>

          {error ? <p className="error-text">{error}</p> : null}

          <div className="dash-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>실행ID</th>
                  <th>Provider</th>
                  <th>모델</th>
                  <th>입력</th>
                  <th>출력</th>
                  <th>합계</th>
                  <th>비용(USD)</th>
                  <th>시각</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const rowKey = `${row.runId}-${row.ts}-${row.totalTokens}`;
                  const runId = String(row.runId || "-");
                  const canToggleRunId = runId.length > runIdTruncateLength;
                  const expanded = expandedRunIdKeys.has(rowKey);
                  const runIdPreview = canToggleRunId ? `${runId.slice(0, runIdTruncateLength)}...` : runId;
                  return (
                    <tr key={rowKey}>
                      <td className="dash-runid-cell">
                        <button
                          type="button"
                          className={`dash-runid-toggle ${expanded ? "expanded" : "truncated"} ${canToggleRunId ? "" : "plain"}`}
                          onClick={() => {
                            if (!canToggleRunId) return;
                            setExpandedRunIdKeys((prev) => {
                              const next = new Set(prev);
                              if (next.has(rowKey)) {
                                next.delete(rowKey);
                              } else {
                                next.add(rowKey);
                              }
                              return next;
                            });
                          }}
                          disabled={!canToggleRunId}
                          title={runId}
                          aria-label={expanded ? "실행 ID 접기" : "실행 ID 전체 보기"}
                        >
                          {expanded ? runId : runIdPreview}
                        </button>
                      </td>
                      <td>
                        <span className="dash-cell-ellipsis" title={String(row.provider || "-")}>
                          {row.provider || "-"}
                        </span>
                      </td>
                      <td>
                        <span className="dash-cell-ellipsis" title={String(row.model || "-")}>
                          {row.model || "-"}
                        </span>
                      </td>
                      <td>{row.inputTokens}</td>
                      <td>{row.outputTokens}</td>
                      <td>{row.totalTokens}</td>
                      <td>{Number(row.costUsd || 0).toFixed(6)}</td>
                      <td>
                        <span className="dash-cell-nowrap">{toDateText(row.ts)}</span>
                      </td>
                    </tr>
                  );
                })}
                {pageRows.length === 0 ? (
                  <tr>
                    <td className="dash-table-empty" colSpan={8}>
                      사용 내역이 쌓이면 여기에 보여요.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          <div className="dash-pagination">
            <p className="dash-pagination-info">
              {rangeStart}-{rangeEnd} / 총 {totalCount}건
            </p>
            <div className="dash-pagination-actions">
              <button
                type="button"
                className="dash-page-btn"
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                disabled={currentPage <= 1}
              >
                이전
              </button>
              {pageNumbers.map((pageNumber) => (
                <button
                  key={pageNumber}
                  type="button"
                  className={`dash-page-btn ${pageNumber === currentPage ? "active" : ""}`}
                  onClick={() => setPage(pageNumber)}
                >
                  {pageNumber}
                </button>
              ))}
              <button
                type="button"
                className="dash-page-btn"
                onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                disabled={currentPage >= totalPages}
              >
                다음
              </button>
            </div>
          </div>
        </section>

        <section className="dash-monitor-side" aria-label="사용량 집계 카드">
          <p className="dash-monitor-side-title">집계 스냅샷</p>
          <p className={`dash-monitor-side-status ${summaryStatus}`}>{summaryStatusLabel}</p>
          <p className="dash-monitor-side-label">집계 토큰</p>
          <strong className="dash-monitor-side-value">{totalTokensValue.toLocaleString("ko-KR")}</strong>
          <p className="dash-monitor-side-label">누적 비용</p>
          <strong className="dash-monitor-side-value">${totalCostUsdValue.toFixed(6)}</strong>
          <p className="dash-monitor-side-sub">수집 실행 {usageRowCount}건</p>
          <p className="dash-monitor-side-sub">{costPerThousandTokens}</p>
          <p className="dash-monitor-side-sub">{error ? "사용량 API 응답 지연이 감지됐어요" : "3초 간격으로 자동 갱신돼요"}</p>
        </section>
      </div>

      <section className="dash-monitor-metrics">
        {metricCards.map((card) => (
          <article key={card.label} className="dash-monitor-card">
            <h3>{card.label}</h3>
            <div className="dash-metric-value">
              <strong>{card.value}</strong>
              <span>{card.unit}</span>
            </div>
            <div className="dash-meter-track">
              <span style={{ width: `${Math.min(100, Number(card.value))}%` }} />
            </div>
          </article>
        ))}
      </section>

      <section className="dash-monitor-openclaw">
        {stateCards.map((card) => (
          <article key={card.label} className="dash-monitor-state-card">
            <h3>{card.label}</h3>
            <p className={`dash-monitor-state-value ${card.tone}`}>{card.value}</p>
            <p className="dash-monitor-state-sub">{card.sub}</p>
          </article>
        ))}
      </section>
    </div>
  );
}

function DashboardMain({ activeTab, onSelectTab, onboardingState }) {
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState("ai");
  const [settingsHighlightSkillId, setSettingsHighlightSkillId] = useState("");
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [usecases, setUsecases] = useState([]);
  const [skills, setSkills] = useState([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState("");
  const [skillPendingMap, setSkillPendingMap] = useState({});
  const [homeData, setHomeData] = useState({ recentRuns: [], todayStats: { runsToday: 0, alerts: 0, successRate: 0, tokenUsage: 0 } });
  const [homeLoading, setHomeLoading] = useState(false);
  const [homeError, setHomeError] = useState("");
  const [homeFeatures, setHomeFeatures] = useState(() => normalizeHomeFeatures(null));
  const [homeFeaturesLoaded, setHomeFeaturesLoaded] = useState(false);
  const [homeFeaturesConfigured, setHomeFeaturesConfigured] = useState(false);
  const [homeFeaturePendingMap, setHomeFeaturePendingMap] = useState({});
  const [homeFeatureError, setHomeFeatureError] = useState("");
  const [chatSidebarRuns, setChatSidebarRuns] = useState([]);
  const [chatSidebarLoading, setChatSidebarLoading] = useState(false);
  const [chatSidebarError, setChatSidebarError] = useState("");
  const [runSidebarRuns, setRunSidebarRuns] = useState([]);
  const [runSidebarLoading, setRunSidebarLoading] = useState(false);
  const [runSidebarError, setRunSidebarError] = useState("");
  const [homeResearchModeEnabled, setHomeResearchModeEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(HOME_RESEARCH_MODE_STORAGE_KEY) === "1";
  });
  const [routeTransition, setRouteTransition] = useState({ phase: "idle", target: "" });
  const chatSidebarLoadedRef = useRef(false);
  const runSidebarLoadedRef = useRef(false);
  const routeTransitionTimersRef = useRef([]);
  const metrics = useMetrics(activeTab === "monitor");

  const clearRouteTransitionTimers = useCallback(() => {
    routeTransitionTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
    routeTransitionTimersRef.current = [];
  }, []);

  useEffect(() => clearRouteTransitionTimers, [clearRouteTransitionTimers]);

  const beginRouteTransition = useCallback(
    (target) => {
      if (target !== "chat" && target !== "runs") return;
      clearRouteTransitionTimers();
      setRouteTransition({ phase: "launch", target });
      routeTransitionTimersRef.current = [
        window.setTimeout(() => {
          setRouteTransition({ phase: "settle", target });
        }, 170),
        window.setTimeout(() => {
          setRouteTransition({ phase: "idle", target: "" });
        }, 860),
      ];
    },
    [clearRouteTransitionTimers],
  );

  const openSettings = useCallback((tab = "ai", skillId = "") => {
    setSettingsInitialTab(tab);
    setSettingsHighlightSkillId(skillId || "");
    setSettingsOpen(true);
  }, []);

  const loadHome = useCallback(async () => {
    setHomeLoading(true);
    try {
      const json = await fetchApiJson("/api/ui/runtime/home");
      setHomeData({
        recentRuns: Array.isArray(json.recentRuns) ? json.recentRuns : [],
        todayStats: json.todayStats || { runsToday: 0, alerts: 0, successRate: 0, tokenUsage: 0 },
      });
      setHomeError("");
    } catch (loadError) {
      setHomeError(loadError.message || "홈 데이터를 불러오지 못했어요");
    } finally {
      setHomeLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "home") {
      void loadHome();
    }
  }, [activeTab, loadHome]);

  const loadUsecases = useCallback(async () => {
    try {
      const json = await fetchApiJson("/api/ui/runtime/usecases");
      setUsecases(Array.isArray(json.items) ? json.items : []);
    } catch {
      setUsecases([]);
    }
  }, []);

  const loadSkills = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setSkillsLoading(true);
    try {
      const json = await fetchApiJson("/api/ui/runtime/skills");
      setSkills(Array.isArray(json?.items) ? json.items.map(normalizeSkillItem) : []);
      setSkillsError("");
    } catch (loadError) {
      setSkillsError(loadError.message || "스킬 목록을 불러오지 못했어요");
    } finally {
      if (!silent) setSkillsLoading(false);
    }
  }, []);

  const loadHomeFeatures = useCallback(async () => {
    try {
      const json = await fetchApiJson("/api/ui/runtime/settings");
      setHomeFeatures(normalizeHomeFeatures(json?.features?.items));
      setHomeFeaturesLoaded(true);
      setHomeFeaturesConfigured(Boolean(json?.connected?.configured));
      setHomeFeatureError(json?.features?.ok === false && json?.features?.error ? String(json.features.error) : "");
    } catch (loadError) {
      setHomeFeaturesConfigured(false);
      setHomeFeatureError(loadError.message || "메인 토글 상태를 불러오지 못했어요");
    }
  }, []);

  useEffect(() => {
    if (activeTab === "home" || activeTab === "chat") {
      void loadUsecases();
    }
  }, [activeTab, loadUsecases]);

  useEffect(() => {
    if (activeTab === "skills") {
      void loadSkills();
    }
  }, [activeTab, loadSkills]);

  useEffect(() => {
    if (activeTab === "home" || activeTab === "chat") {
      void loadHomeFeatures();
    }
  }, [activeTab, loadHomeFeatures]);

  const onToggleHomeFeature = async (featureId, nextEnabled) => {
    setHomeFeatureError("");
    setHomeFeaturePendingMap((prev) => ({ ...prev, [featureId]: true }));

    try {
      const json = await fetchApiJson(`/api/ui/runtime/features/${encodeURIComponent(featureId)}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: Boolean(nextEnabled) }),
      });
      const nextFeature = json?.feature;
      if (nextFeature?.id === featureId) {
        setHomeFeatures((prev) =>
          prev.map((item) =>
            item.id === featureId
              ? {
                  ...item,
                  canonicalId: nextFeature.canonicalId ? String(nextFeature.canonicalId) : item.canonicalId,
                  name: nextFeature.name ? String(nextFeature.name) : item.name,
                  description: nextFeature.description ? String(nextFeature.description) : item.description,
                  enabled: Boolean(nextFeature.enabled),
                  status: normalizeHomeFeatureStatus(nextFeature.status),
                }
              : item
          )
        );
      } else {
        await loadHomeFeatures();
      }
    } catch (toggleError) {
      setHomeFeatureError(toggleError.message || "토글 적용에 실패했어요");
    } finally {
      setHomeFeaturePendingMap((prev) => ({ ...prev, [featureId]: false }));
    }
  };

  const toggleSkill = useCallback(
    async (skill) => {
      const skillId = String(skill?.id || "").trim();
      if (!skillId) return;
      setSkillsError("");
      setSkillPendingMap((prev) => ({ ...prev, [skillId]: true }));

      try {
        const json = await fetchApiJson(`/api/ui/runtime/skills/${encodeURIComponent(skillId)}/toggle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !Boolean(skill?.enabled) }),
        });
        const nextItem = json?.item ? normalizeSkillItem(json.item) : null;
        if (nextItem?.id === skillId) {
          setSkills((prev) => {
            const existing = prev.some((item) => item.id === skillId);
            if (!existing) return [...prev, nextItem];
            return prev.map((item) => (item.id === skillId ? nextItem : item));
          });
        } else {
          await loadSkills({ silent: true });
        }
      } catch (toggleError) {
        setSkillsError(toggleError.message || "스킬 상태 변경에 실패했어요");
      } finally {
        setSkillPendingMap((prev) => ({ ...prev, [skillId]: false }));
      }
    },
    [loadSkills]
  );

  const handleSkillEnvironmentSaved = useCallback(async () => {
    await loadSkills({ silent: activeTab !== "skills" });
  }, [activeTab, loadSkills]);

  const loadChatSidebar = useCallback(async ({ silent = false } = {}) => {
    if (!silent && !chatSidebarLoadedRef.current) {
      setChatSidebarLoading(true);
    }
    try {
      const json = await fetchApiJson("/api/ui/runtime/conversations");
      const rows = Array.isArray(json.items) ? json.items : [];
      setChatSidebarRuns((prev) => mergeChatSidebarRuns(rows, prev));
      setChatSidebarError("");
      chatSidebarLoadedRef.current = true;
      if (selectedConversationId && !rows.some((row) => row.id === selectedConversationId)) {
        setSelectedConversationId("");
      }
    } catch (loadError) {
      setChatSidebarError(loadError.message || "대화 기록을 불러오지 못했어요");
    } finally {
      if (!silent) setChatSidebarLoading(false);
    }
  }, [selectedConversationId]);

  const loadRunSidebar = useCallback(async ({ silent = false } = {}) => {
    if (!silent && !runSidebarLoadedRef.current) {
      setRunSidebarLoading(true);
    }
    try {
      const json = await fetchApiJson("/api/ui/runtime/runs");
      const rows = Array.isArray(json.items) ? json.items : [];
      setRunSidebarRuns((prev) => mergeChatSidebarRuns(rows, prev));
      setRunSidebarError("");
      runSidebarLoadedRef.current = true;
      setSelectedRunId((prev) => {
        if (prev && rows.some((row) => row.id === prev)) return prev;
        if (prev && rows.length === 0) return prev;
        return rows[0]?.id || prev || "";
      });
    } catch (loadError) {
      setRunSidebarError(loadError.message || "실행 기록을 불러오지 못했어요");
    } finally {
      if (!silent) setRunSidebarLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab !== "chat") return undefined;
    let cancelled = false;
    let timer;

    const tick = async (silent) => {
      if (cancelled) return;
      await loadChatSidebar({ silent });
      if (!cancelled) timer = window.setTimeout(() => void tick(true), 2500);
    };

    void tick(false);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeTab, loadChatSidebar]);

  useEffect(() => {
    if (activeTab !== "runs") return undefined;
    let cancelled = false;
    let timer;

    const tick = async (silent) => {
      if (cancelled) return;
      await loadRunSidebar({ silent });
      if (!cancelled) timer = window.setTimeout(() => void tick(true), 2500);
    };

    void tick(false);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeTab, loadRunSidebar]);

  useEffect(() => {
    if (activeTab === "chat" || activeTab === "runs") setCollapsed(false);
  }, [activeTab]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(HOME_RESEARCH_MODE_STORAGE_KEY, homeResearchModeEnabled ? "1" : "0");
  }, [homeResearchModeEnabled]);

  const createConversation = async (payloadOrPrompt, sourceAction = "home_input") => {
    const payload =
      payloadOrPrompt && typeof payloadOrPrompt === "object"
        ? payloadOrPrompt
        : { prompt: String(payloadOrPrompt || "").trim(), sourceAction };
    const json = await fetchApiJson("/api/ui/runtime/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (json?.conversation) {
      const nextRun = normalizeChatSidebarRun(json.conversation);
      setChatSidebarRuns((prev) =>
        sortRunsByUpdatedAt([nextRun, ...prev.filter((row) => row.id !== nextRun.id)])
      );
    }
    if (json?.conversation?.id) {
      setSelectedConversationId(String(json.conversation.id));
    }
    return json;
  };

  const openWebResearchResultInChat = async ({ title, markdown }) => {
    const reportTitle = String(title || "웹 리서치 결과").trim() || "웹 리서치 결과";
    const reportMarkdown = String(markdown || "").trim();
    const prompt = buildResultHandoffPrompt(reportTitle, reportMarkdown);
    const activeConversationId = String(selectedConversationId || "").trim();

    if (activeConversationId) {
      try {
        const json = await fetchApiJson(`/api/ui/runtime/conversations/${encodeURIComponent(activeConversationId)}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: prompt,
          }),
        });
        if (json?.conversation) {
          const nextRun = normalizeChatSidebarRun(json.conversation);
          setChatSidebarRuns((prev) =>
            sortRunsByUpdatedAt([nextRun, ...prev.filter((row) => row.id !== nextRun.id)])
          );
        }
        setSelectedConversationId(activeConversationId);
        onSelectTab("chat");
        return json;
      } catch (appendError) {
        console.warn("failed to append research result to existing chat session, creating a new conversation instead", appendError);
      }
    }

    const json = await createConversation({
      title: `${reportTitle} 후속 대화`,
      prompt,
      sourceAction: "web_research_result_handoff",
    });
    if (json?.conversation?.id) {
      setSelectedConversationId(String(json.conversation.id));
      onSelectTab("chat");
    }
    return json;
  };

  const createResearchRun = async (payloadOrPrompt, sourceAction = "home_web_research") => {
    const payload =
      payloadOrPrompt && typeof payloadOrPrompt === "object"
        ? { ...payloadOrPrompt, usecaseId: "web_research" }
        : { prompt: String(payloadOrPrompt || "").trim(), sourceAction, usecaseId: "web_research" };
    const json = await fetchApiJson("/api/ui/runtime/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (json?.runId) {
      const nextRunId = String(json.runId);
      setSelectedRunId(nextRunId);
      const seededRun = normalizeChatSidebarRun({
        id: nextRunId,
        title: payload.prompt || "새 실행",
        prompt: payload.prompt || "",
        usecaseId: "web_research",
        status: "queued",
        updatedAt: Date.now(),
        logs: [
          {
            id: `${nextRunId}:queued`,
            ts: Date.now(),
            message: "입력값을 정리하고 웹 리서치 실행을 준비하고 있어요",
          },
        ],
        executionTranscript: [],
        wbs: {
          depth: 2,
          phases: [],
        },
      });
      setRunSidebarRuns((prev) => sortRunsByUpdatedAt([seededRun, ...prev.filter((item) => item.id !== nextRunId)]));
    }
    return json;
  };

  const renameConversation = async (runId, title) => {
    const nextTitle = String(title || "").trim();
    try {
      const json = await fetchApiJson(`/api/ui/runtime/conversations/${encodeURIComponent(runId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: nextTitle }),
      });
      if (json?.conversation) {
        persistRunTitleOverride(runId, nextTitle);
        setChatSidebarRuns((prev) =>
          sortRunsByUpdatedAt(
            prev.map((row) => (row.id === runId ? { ...row, ...json.conversation, title: nextTitle, titleCustomized: true } : row))
          )
        );
      }
      return json;
    } catch (error) {
      if (!isLegacyGuiBlockedError(error)) throw error;
      persistRunTitleOverride(runId, nextTitle);
      const fallbackRun = {
        id: runId,
        title: nextTitle,
        titleCustomized: true,
        updatedAt: Date.now(),
      };
      setChatSidebarRuns((prev) =>
        sortRunsByUpdatedAt(
          prev.map((row) => (row.id === runId ? { ...row, ...fallbackRun } : row))
        )
      );
      return {
        ok: true,
        runId,
        run: fallbackRun,
        localFallback: true,
      };
    }
  };

  return (
    <>
      <div className="dash-shell">
        <Sidebar
          collapsed={collapsed}
          onToggle={() => setCollapsed((prev) => !prev)}
          onExpand={() => setCollapsed(false)}
          activeTab={activeTab}
          onSelect={onSelectTab}
          onOpenSettings={() => openSettings("ai")}
          historyMode={activeTab === "chat" ? "chat" : activeTab === "runs" ? "runs" : ""}
          historyItems={activeTab === "chat" ? chatSidebarRuns : runSidebarRuns}
          historyLoading={activeTab === "chat" ? chatSidebarLoading : runSidebarLoading}
          historyError={activeTab === "chat" ? chatSidebarError : runSidebarError}
          activeHistoryId={activeTab === "chat" ? selectedConversationId : selectedRunId}
          onSelectHistoryItem={(itemId) => {
            if (activeTab === "chat") {
              setSelectedConversationId(itemId);
              return;
            }
            setSelectedRunId(itemId);
            onSelectTab("runs");
          }}
          onRenameHistoryItem={activeTab === "chat" ? renameConversation : undefined}
        />

        <main
          className={[
            "dash-main",
            activeTab === "chat" ? "chat-mode" : "",
            routeTransition.phase !== "idle" ? "route-transition" : "",
            routeTransition.phase !== "idle" ? `route-${routeTransition.phase}` : "",
            routeTransition.target ? `route-to-${routeTransition.target}` : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {activeTab === "home" ? (
            <HomePage
              home={homeData}
              loading={homeLoading}
              error={homeError}
              onRefresh={loadHome}
              onCreateConversation={createConversation}
              onCreateResearchRun={createResearchRun}
              onOpenChat={() => onSelectTab("chat")}
              onOpenRun={(runId) => {
                setSelectedRunId(String(runId));
                onSelectTab("runs");
              }}
              onConversationCreated={(conversationId) => {
                setSelectedConversationId(conversationId);
                onSelectTab("chat");
              }}
              researchModeEnabled={homeResearchModeEnabled}
              onToggleResearchMode={setHomeResearchModeEnabled}
              onBeginRouteTransition={beginRouteTransition}
            />
          ) : null}
          {activeTab === "chat" ? (
            <ChatPage
              active={activeTab === "chat"}
              initialConversationId={selectedConversationId}
              onConversationSelected={setSelectedConversationId}
              onCreateConversation={createConversation}
              onRunCreated={(runId, conversationId = "") => {
                if (conversationId) setSelectedConversationId(conversationId);
                setSelectedRunId(runId);
                onSelectTab("runs");
              }}
            />
          ) : null}
          {activeTab === "runs" ? (
            <RunsPage
              active={activeTab === "runs"}
              initialRunId={selectedRunId}
              sidebarRuns={runSidebarRuns}
              onOpenResultInChat={openWebResearchResultInChat}
            />
          ) : null}
          {activeTab === "skills" ? (
            <SkillsPage
              active={activeTab === "skills"}
              skills={skills}
              loading={skillsLoading}
              error={skillsError}
              pendingMap={skillPendingMap}
              onRefresh={loadSkills}
              onToggleSkill={toggleSkill}
              onConfigureSkill={(skill) => openSettings("skill_env", skill?.id || "")}
              featuresLoaded={homeFeaturesLoaded}
              features={homeFeatures}
              featuresConfigured={homeFeaturesConfigured}
              featurePendingMap={homeFeaturePendingMap}
              featureError={homeFeatureError}
              onToggleFeature={onToggleHomeFeature}
            />
          ) : null}
          {activeTab === "monitor" ? <MonitorPage metrics={metrics} active={activeTab === "monitor"} onboardingState={onboardingState} /> : null}
        </main>
      </div>

      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialTab={settingsInitialTab}
        highlightSkillId={settingsHighlightSkillId}
        onSkillEnvironmentSaved={handleSkillEnvironmentSaved}
      />
    </>
  );
}

export default function App() {
  const onboardingState = useOnboardingState();
  const [activeTab, setActiveTab] = useHashTab();
  const [bootResolved, setBootResolved] = useState(false);
  const [requiresOnboarding, setRequiresOnboarding] = useState(false);
  const [onboardingExitRequested, setOnboardingExitRequested] = useState(false);

  useEffect(() => {
    if (onboardingState.loading) return;
    const required = !onboardingState.configured;
    setRequiresOnboarding(required);
    if (!bootResolved) setBootResolved(true);
    if (!required) setOnboardingExitRequested(true);
  }, [bootResolved, onboardingState.configured, onboardingState.loading]);

  if (onboardingState.loading) {
    return (
      <div className="page loading-page">
        <div className="loading-block">
          <p className="eyebrow">SEMO AI</p>
          <h1>커스텀 UI 게이트웨이를 불러오는 중</h1>
        </div>
      </div>
    );
  }

  if (!bootResolved) {
    return null;
  }

  if (requiresOnboarding && (!onboardingExitRequested || !onboardingState.configured)) {
    return (
      <div className="onboarding-overlay-page">
        <OnboardingModal
          stateSnapshot={onboardingState}
          onDone={() => {
            setOnboardingExitRequested(true);
            setActiveTab("home");
          }}
        />
      </div>
    );
  }

  return <DashboardMain activeTab={activeTab} onSelectTab={setActiveTab} onboardingState={onboardingState} />;
}
