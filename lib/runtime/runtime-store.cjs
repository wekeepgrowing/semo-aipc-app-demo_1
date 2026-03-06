const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { normalizeRunSessionMode } = require("./session-utils.cjs");
const { LEGACY_SEEDED_SKILL_IDS, getDefaultSkillRuntimeRows } = require("./default-skills.cjs");
const {
  FEATURE_IDS,
  normalizeExecutionFeatures,
  normalizeExecutionFeaturesError,
  normalizeExecutionFeaturesStatus,
  normalizeFeatureStatus,
} = require("./feature-contract.cjs");

const DEFAULT_STATE = {
  runs: {},
  conversations: {},
  skills: {},
  defaults: {
    defaultModel: null,
  },
  features: {
    knowledgeMap: false,
    memoryAutoImprove: false,
    proactiveCheck: false,
    skillFinder: false,
  },
  featureStatus: {
    knowledgeMap: { source: "none", supported: null, confirmedEnabled: false, lastAppliedAt: null, errorCode: null, lastError: null, details: null },
    memoryAutoImprove: { source: "none", supported: null, confirmedEnabled: false, lastAppliedAt: null, errorCode: null, lastError: null, details: null },
    proactiveCheck: { source: "none", supported: null, confirmedEnabled: false, lastAppliedAt: null, errorCode: null, lastError: null, details: null },
    skillFinder: { source: "none", supported: null, confirmedEnabled: false, lastAppliedAt: null, errorCode: null, lastError: null, details: null },
  },
};

const DEFAULT_SKILLS = getDefaultSkillRuntimeRows();

function normalizeFeatureFlags(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const next = {};
  for (const key of FEATURE_IDS) {
    next[key] = Boolean(source[key]);
  }
  return next;
}

function normalizeFeatureStatuses(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const next = {};
  for (const key of FEATURE_IDS) {
    next[key] = normalizeFeatureStatus(source[key]);
  }
  return next;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeNow() {
  return Date.now();
}

function normalizeOptionalTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
}

function createDefaultRunSteps() {
  return [
    { index: 1, label: "요청 분석", status: "running" },
    { index: 2, label: "자료 수집", status: "pending" },
    { index: 3, label: "초안 작성", status: "pending" },
    { index: 4, label: "검토", status: "pending" },
    { index: 5, label: "완료", status: "pending" },
  ];
}

function createDefaultRunTasks() {
  return [
    { id: crypto.randomUUID(), text: "요청 목적 파악", done: false, assignee: "AI 실행", assigneeType: "ai" },
    { id: crypto.randomUUID(), text: "참고 자료 수집", done: false, assignee: "AI 실행", assigneeType: "ai" },
    { id: crypto.randomUUID(), text: "결과 검토", done: false, assignee: "00님", assigneeType: "person" },
  ];
}

function createDefaultRunUsage() {
  return {
    provider: "unknown",
    model: "unknown",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

const CONVERSATION_STATUSES = new Set(["draft", "clarifying", "ready", "committing", "committed", "failed"]);
const CONVERSATION_MESSAGE_TYPES = new Set(["text", "status", "template", "followup", "summary"]);
const CONVERSATION_QUESTION_TYPES = new Set(["text", "textarea", "select"]);

function normalizeConversationStatus(value) {
  const next = String(value || "").trim().toLowerCase();
  return CONVERSATION_STATUSES.has(next) ? next : "draft";
}

function normalizeConversationQuestion(question) {
  const row = question && typeof question === "object" ? question : {};
  const options = Array.isArray(row.options)
    ? row.options
        .map((option) => ({
          value: String(option?.value || "").trim(),
          label: String(option?.label || option?.value || "").trim(),
        }))
        .filter((option) => option.value && option.label)
    : [];
  const type = String(row.type || "text").trim().toLowerCase();
  return {
    id: String(row.id || crypto.randomUUID()),
    label: String(row.label || row.id || "질문").trim() || "질문",
    type: CONVERSATION_QUESTION_TYPES.has(type) ? type : "text",
    required: Boolean(row.required),
    placeholder: row.placeholder ? String(row.placeholder) : "",
    helpText: row.helpText ? String(row.helpText) : "",
    source: row.source ? String(row.source) : "template",
    options,
  };
}

function normalizeConversationQuestions(raw) {
  return (Array.isArray(raw) ? raw : []).map(normalizeConversationQuestion);
}

function normalizeConversationAnswers(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const next = {};
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) continue;
    if (value === null || value === undefined) continue;
    next[normalizedKey] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return next;
}

function normalizeConversationMessage(message) {
  const row = message && typeof message === "object" ? message : {};
  const type = String(row.type || "text").trim().toLowerCase();
  return {
    id: String(row.id || crypto.randomUUID()),
    ts: Number(row.ts || safeNow()),
    role: String(row.role || "assistant").trim().toLowerCase() === "user" ? "user" : String(row.role || "assistant").trim().toLowerCase() === "system" ? "system" : "assistant",
    type: CONVERSATION_MESSAGE_TYPES.has(type) ? type : "text",
    text: String(row.text || ""),
    questions: normalizeConversationQuestions(row.questions),
    meta: row.meta && typeof row.meta === "object" ? row.meta : null,
  };
}

function normalizeConversationReadiness(raw) {
  const row = raw && typeof raw === "object" ? raw : {};
  return {
    state: String(row.state || "draft"),
    canCommit: Boolean(row.canCommit),
    requiredAnswered: Number.isFinite(Number(row.requiredAnswered)) ? Number(row.requiredAnswered) : 0,
    totalRequired: Number.isFinite(Number(row.totalRequired)) ? Number(row.totalRequired) : 0,
    missingTemplateIds: Array.isArray(row.missingTemplateIds) ? row.missingTemplateIds.map((item) => String(item || "").trim()).filter(Boolean) : [],
    missingFollowupIds: Array.isArray(row.missingFollowupIds) ? row.missingFollowupIds.map((item) => String(item || "").trim()).filter(Boolean) : [],
    autoCommitPending: Boolean(row.autoCommitPending),
  };
}

function normalizeConversationError(raw) {
  if (!raw || typeof raw !== "object") return null;
  const code = raw.code ? String(raw.code) : "";
  const message = raw.message ? String(raw.message) : raw.error ? String(raw.error) : "";
  if (!code && !message) return null;
  return {
    code: code || "conversation_error",
    message: message || "conversation request failed",
  };
}

function normalizeConversationRecord(conversation) {
  const row = conversation && typeof conversation === "object" ? conversation : {};
  const now = safeNow();
  const sessionKey = typeof row.sessionKey === "string" && row.sessionKey.trim() ? row.sessionKey.trim() : "";
  return {
    id: String(row.id || crypto.randomUUID()),
    kind: String(row.kind || "planning"),
    status: normalizeConversationStatus(row.status),
    title: String(row.title || row.prompt || "새 계획").trim() || "새 계획",
    prompt: String(row.prompt || ""),
    sourceAction: String(row.sourceAction || "chat"),
    createdAt: Number(row.createdAt || now),
    updatedAt: Number(row.updatedAt || now),
    sessionKey,
    suggestedUsecaseId: row.suggestedUsecaseId ? String(row.suggestedUsecaseId) : "",
    selectedUsecaseId: row.selectedUsecaseId ? String(row.selectedUsecaseId) : "",
    messages: (Array.isArray(row.messages) ? row.messages : []).map(normalizeConversationMessage),
    templateAnswers: normalizeConversationAnswers(row.templateAnswers),
    followupQuestions: normalizeConversationQuestions(row.followupQuestions),
    followupAnswers: normalizeConversationAnswers(row.followupAnswers),
    normalizedInputPatch: row.normalizedInputPatch && typeof row.normalizedInputPatch === "object" ? row.normalizedInputPatch : {},
    followupRoundCount: Number.isFinite(Number(row.followupRoundCount)) ? Number(row.followupRoundCount) : 0,
    readiness: normalizeConversationReadiness(row.readiness),
    linkedRunId: row.linkedRunId ? String(row.linkedRunId) : "",
    lastError: normalizeConversationError(row.lastError),
  };
}

function normalizeRunRecord(run) {
  const now = safeNow();
  const tasks = Array.isArray(run.tasks) ? run.tasks : [];
  const executionTranscript = Array.isArray(run.executionTranscript) ? run.executionTranscript : [];
  const sessionKey = typeof run.sessionKey === "string" && run.sessionKey.trim() ? run.sessionKey.trim() : "";
  const sessionMode = normalizeRunSessionMode(run.sessionMode, Boolean(sessionKey));
  const titleCustomized = Boolean(run.titleCustomized);
  const isDraft = Boolean(run.isDraft);
  const hasSubmittedPrompt = Boolean(run.hasSubmittedPrompt ?? String(run.prompt || "").trim());
  const executionFeatures = normalizeExecutionFeatures(run.executionFeatures);
  const executionFeaturesLockedAt = normalizeOptionalTimestamp(run.executionFeaturesLockedAt);
  const executionFeaturesError = normalizeExecutionFeaturesError(run.executionFeaturesError);
  const executionFeaturesDowngradedAt = normalizeOptionalTimestamp(run.executionFeaturesDowngradedAt);
  const executionFeaturesDowngradeReason = normalizeExecutionFeaturesError(run.executionFeaturesDowngradeReason);
  const executionFeaturesStatus =
    executionFeatures.length === 0
      ? executionFeaturesError
        ? "failed"
        : "none"
      : normalizeExecutionFeaturesStatus(run.executionFeaturesStatus || (executionFeaturesError ? "failed" : "locked"));
  return {
    id: String(run.id),
    title: String(run.title || (isDraft ? "새 대화" : "새 실행")),
    titleCustomized,
    isDraft,
    hasSubmittedPrompt,
    prompt: String(run.prompt || ""),
    status: String(run.status || "queued"),
    sourceAction: String(run.sourceAction || "home_input"),
    sourceType: String(run.sourceType || "local"),
    createdAt: Number(run.createdAt || now),
    updatedAt: Number(run.updatedAt || now),
    step: Number.isFinite(Number(run.step)) ? Number(run.step) : 1,
    steps: Array.isArray(run.steps) ? run.steps : [],
    tasks: tasks.map((task) => ({
      id: String(task?.id || crypto.randomUUID()),
      text: String(task?.text || task?.title || "작업 항목"),
      title: String(task?.title || task?.text || "작업 항목"),
      done: Boolean(task?.done ?? task?.status === "completed"),
      status: String(task?.status || (task?.done ? "completed" : "pending")),
      role: String(task?.role || "AI"),
      phaseId: String(task?.phaseId || ""),
      phaseTitle: String(task?.phaseTitle || ""),
      assignee: String(task?.assignee || (String(task?.role || "AI").toLowerCase() === "human" ? "담당자 지정" : "AI 실행")),
      assigneeType: String(task?.assigneeType || (String(task?.role || "AI").toLowerCase() === "human" ? "person" : "ai")),
      whyHuman: task?.whyHuman ? String(task.whyHuman) : "",
      result: task?.result && typeof task.result === "object" ? task.result : null,
      review: task?.review && typeof task.review === "object" ? task.review : null,
      comments: Array.isArray(task?.comments) ? task.comments : [],
    })),
    logs: Array.isArray(run.logs) ? run.logs : [],
    executionTranscript: executionTranscript
      .map((entry) => ({
        id: String(entry?.id || crypto.randomUUID()),
        taskId: entry?.taskId ? String(entry.taskId) : "",
        phaseId: entry?.phaseId ? String(entry.phaseId) : "",
        role:
          String(entry?.role || "").trim().toLowerCase() === "human"
            ? "human"
            : String(entry?.role || "").trim().toLowerCase() === "system"
              ? "system"
              : "ai",
        kind: String(entry?.kind || "event"),
        text: String(entry?.text || ""),
        ts: Number(entry?.ts || now),
      }))
      .slice(-400),
    usage: run.usage && typeof run.usage === "object" ? run.usage : null,
    usecaseId: run.usecaseId ? String(run.usecaseId) : "",
    normalizedInput: run.normalizedInput && typeof run.normalizedInput === "object" ? run.normalizedInput : null,
    wbs: run.wbs && typeof run.wbs === "object" ? run.wbs : null,
    pauseState: run.pauseState && typeof run.pauseState === "object" ? run.pauseState : null,
    currentExecution: run.currentExecution && typeof run.currentExecution === "object" ? run.currentExecution : null,
    artifacts: run.artifacts && typeof run.artifacts === "object" ? run.artifacts : null,
    originConversationId: run.originConversationId ? String(run.originConversationId) : "",
    executionFeatures,
    executionFeaturesLockedAt,
    executionFeaturesStatus,
    executionFeaturesError,
    executionFeaturesDowngradedAt,
    executionFeaturesDowngradeReason,
    sessionKey,
    sessionMode,
  };
}

function toPublicRun(run) {
  const normalized = normalizeRunRecord(run);
  const { sessionKey, ...rest } = normalized;
  return {
    ...rest,
    sessionMode: normalized.sessionMode,
    hasSessionKey: Boolean(sessionKey),
  };
}

function toPublicConversation(conversation) {
  const normalized = normalizeConversationRecord(conversation);
  const { sessionKey, ...rest } = normalized;
  return {
    ...rest,
    hasSessionKey: Boolean(sessionKey),
  };
}

class RuntimeStore {
  constructor({ dir }) {
    this.dir = dir;
    this.filePath = path.join(dir, "runtime-store.json");
    this.state = deepClone(DEFAULT_STATE);

    this.ensureDir();
    this.load();
    this.ensureSkillSeed();
    this.ensureFeatureSeed();
    this.save();
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  load() {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;

      this.state.runs = parsed.runs && typeof parsed.runs === "object" ? parsed.runs : {};
      this.state.conversations = parsed.conversations && typeof parsed.conversations === "object" ? parsed.conversations : {};
      this.state.skills = parsed.skills && typeof parsed.skills === "object" ? parsed.skills : {};
      for (const legacyId of LEGACY_SEEDED_SKILL_IDS) {
        delete this.state.skills[legacyId];
      }
      this.state.defaults = parsed.defaults && typeof parsed.defaults === "object" ? parsed.defaults : { defaultModel: null };
      this.state.features = normalizeFeatureFlags(parsed.features);
      this.state.featureStatus = normalizeFeatureStatuses(parsed.featureStatus);
    } catch (error) {
      console.error("runtime-store load failed:", error.message);
    }
  }

  save() {
    try {
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      console.error("runtime-store save failed:", error.message);
    }
  }

  ensureSkillSeed() {
    for (const skill of DEFAULT_SKILLS) {
      if (this.state.skills[skill.id]) continue;
      this.state.skills[skill.id] = { ...skill };
    }
  }

  ensureFeatureSeed() {
    this.state.features = normalizeFeatureFlags(this.state.features);
    this.state.featureStatus = normalizeFeatureStatuses(this.state.featureStatus);
  }

  createConversation({
    kind = "planning",
    title = "",
    prompt = "",
    sourceAction = "chat",
    sessionKey = "",
    suggestedUsecaseId = "",
    selectedUsecaseId = "",
    messages = [],
    templateAnswers = {},
    followupQuestions = [],
    followupAnswers = {},
    normalizedInputPatch = {},
    followupRoundCount = 0,
    readiness = null,
    linkedRunId = "",
    lastError = null,
    status = "draft",
  }) {
    const now = safeNow();
    const id = crypto.randomUUID();
    const conversation = normalizeConversationRecord({
      id,
      kind,
      title: String(title || prompt || "새 계획").slice(0, 72),
      prompt: String(prompt || ""),
      sourceAction,
      sessionKey,
      suggestedUsecaseId,
      selectedUsecaseId,
      messages,
      templateAnswers,
      followupQuestions,
      followupAnswers,
      normalizedInputPatch,
      followupRoundCount,
      readiness,
      linkedRunId,
      lastError,
      status,
      createdAt: now,
      updatedAt: now,
    });
    this.state.conversations[id] = conversation;
    this.save();
    return deepClone(toPublicConversation(conversation));
  }

  listConversations() {
    return Object.values(this.state.conversations)
      .map(normalizeConversationRecord)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((conversation) => {
        const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
        const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
        return {
          id: conversation.id,
          kind: conversation.kind,
          status: conversation.status,
          title: conversation.title,
          prompt: conversation.prompt,
          sourceAction: conversation.sourceAction,
          updatedAt: conversation.updatedAt,
          suggestedUsecaseId: conversation.suggestedUsecaseId,
          selectedUsecaseId: conversation.selectedUsecaseId,
          readiness: conversation.readiness,
          linkedRunId: conversation.linkedRunId,
          lastError: conversation.lastError,
          lastMessage: String(lastMessage?.text || ""),
          messages: messages.slice(-4),
        };
      });
  }

  getConversation(conversationId) {
    const conversation = this.state.conversations[String(conversationId)];
    if (!conversation) return null;
    return deepClone(toPublicConversation(conversation));
  }

  getConversationRecord(conversationId) {
    const conversation = this.state.conversations[String(conversationId)];
    if (!conversation) return null;
    return deepClone(normalizeConversationRecord(conversation));
  }

  upsertConversation(conversation) {
    if (!conversation || !conversation.id) return null;
    const current = this.state.conversations[String(conversation.id)] || {};
    const merged = normalizeConversationRecord({
      ...current,
      ...conversation,
      id: String(conversation.id),
      updatedAt: safeNow(),
    });
    this.state.conversations[merged.id] = merged;
    this.save();
    return deepClone(toPublicConversation(merged));
  }

  patchConversation(conversationId, patch) {
    const existing = this.state.conversations[String(conversationId)];
    if (!existing) return null;
    return this.upsertConversation({ ...existing, ...(patch && typeof patch === "object" ? patch : {}), id: conversationId });
  }

  appendConversationMessage(conversationId, message) {
    const existing = this.state.conversations[String(conversationId)];
    if (!existing) return null;
    const current = normalizeConversationRecord(existing);
    const nextMessages = [...(Array.isArray(current.messages) ? current.messages : []), normalizeConversationMessage(message)];
    return this.patchConversation(conversationId, {
      messages: nextMessages.slice(-200),
      updatedAt: safeNow(),
    });
  }

  createRun({
    prompt,
    sourceAction = "home_input",
    sourceType = "local",
    sessionKey = "",
    sessionMode = undefined,
    originConversationId = "",
    executionFeatures = [],
    executionFeaturesLockedAt = null,
    executionFeaturesStatus = undefined,
    executionFeaturesError = null,
    executionFeaturesDowngradedAt = null,
    executionFeaturesDowngradeReason = null,
    isDraft = false,
    hasSubmittedPrompt = undefined,
  }) {
    const now = safeNow();
    const id = crypto.randomUUID();
    const nextIsDraft = Boolean(isDraft);
    const nextPrompt = String(prompt || "");
    const nextHasSubmittedPrompt =
      typeof hasSubmittedPrompt === "boolean" ? hasSubmittedPrompt : !nextIsDraft && Boolean(nextPrompt.trim());
    const title = nextIsDraft ? "새 대화" : String(nextPrompt || "새 실행").slice(0, 46) || "새 실행";
    const normalizedExecutionFeatures = normalizeExecutionFeatures(executionFeatures);
    const executionSeed = nextIsDraft
      ? {
          step: 1,
          steps: [],
          tasks: [],
        logs: [],
        executionTranscript: [],
        usage: createDefaultRunUsage(),
      }
      : {
          step: 1,
          steps: createDefaultRunSteps(),
          tasks: createDefaultRunTasks(),
          logs: [{ id: crypto.randomUUID(), ts: now, level: "info", message: "요청이 접수됐어요" }],
          executionTranscript: [],
          usage: createDefaultRunUsage(),
        };

    const run = normalizeRunRecord({
      id,
      title,
      prompt: nextPrompt,
      sourceAction,
      sourceType,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      ...executionSeed,
      usecaseId: "",
      normalizedInput: null,
      wbs: null,
      pauseState: null,
      currentExecution: null,
      artifacts: null,
      originConversationId: String(originConversationId || "").trim(),
      executionFeatures: normalizedExecutionFeatures,
      executionFeaturesLockedAt:
        normalizedExecutionFeatures.length > 0
          ? Number.isFinite(Number(executionFeaturesLockedAt))
            ? Number(executionFeaturesLockedAt)
            : now
          : null,
      executionFeaturesStatus:
        executionFeaturesStatus ||
        (normalizedExecutionFeatures.length > 0 ? "locked" : executionFeaturesError ? "failed" : "none"),
      executionFeaturesError,
      executionFeaturesDowngradedAt: Number.isFinite(Number(executionFeaturesDowngradedAt))
        ? Number(executionFeaturesDowngradedAt)
        : null,
      executionFeaturesDowngradeReason,
      sessionKey,
      sessionMode,
      titleCustomized: false,
      isDraft: nextIsDraft,
      hasSubmittedPrompt: nextHasSubmittedPrompt,
    });

    this.state.runs[id] = run;
    this.save();
    return deepClone(toPublicRun(run));
  }

  listRuns() {
    return Object.values(this.state.runs)
      .map(normalizeRunRecord)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((run) => {
        const logs = Array.isArray(run.logs) ? run.logs : [];
        const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
        return {
          id: run.id,
          title: run.title,
          titleCustomized: run.titleCustomized,
          isDraft: run.isDraft,
          hasSubmittedPrompt: run.hasSubmittedPrompt,
          prompt: run.prompt,
          lastMessage: String(lastLog?.message || ""),
          status: run.status,
          updatedAt: run.updatedAt,
          step: run.step,
          usecaseId: run.usecaseId || "",
          originConversationId: run.originConversationId || "",
          executionFeatures: run.executionFeatures,
          executionFeaturesStatus: run.executionFeaturesStatus,
          executionFeaturesError: run.executionFeaturesError,
        };
      });
  }

  getRun(runId) {
    const run = this.state.runs[String(runId)];
    if (!run) return null;
    return deepClone(toPublicRun(run));
  }

  getRunRecord(runId) {
    const run = this.state.runs[String(runId)];
    if (!run) return null;
    return deepClone(normalizeRunRecord(run));
  }

  upsertRun(run) {
    if (!run || !run.id) return null;
    const current = this.state.runs[String(run.id)] || {};
    const incomingTitle = typeof run.title === "string" ? run.title.trim() : "";
    const incomingPrompt = typeof run.prompt === "string" ? run.prompt : "";
    const incomingTitleCustomized = typeof run.titleCustomized === "boolean" ? run.titleCustomized : undefined;
    const currentTitle = typeof current.title === "string" ? current.title.trim() : "";
    const currentPrompt = typeof current.prompt === "string" ? current.prompt : "";
    const currentTitleCustomized = Boolean(current.titleCustomized);
    const shouldKeepCurrentTitle =
      (currentTitleCustomized && incomingTitleCustomized !== true) ||
      (Boolean(currentTitle) && currentTitle !== "새 실행" && (!incomingTitle || incomingTitle === "새 실행"));
    const nextTitleCustomized =
      incomingTitleCustomized === undefined ? currentTitleCustomized : Boolean(incomingTitleCustomized);

    const merged = normalizeRunRecord({
      ...current,
      ...run,
      title: shouldKeepCurrentTitle ? currentTitle : incomingTitle || currentTitle || "새 실행",
      titleCustomized: shouldKeepCurrentTitle ? currentTitleCustomized : nextTitleCustomized,
      prompt: incomingPrompt || currentPrompt,
      updatedAt: safeNow(),
    });
    this.state.runs[merged.id] = merged;
    this.save();
    return deepClone(toPublicRun(merged));
  }

  patchRun(runId, patch) {
    const existing = this.state.runs[String(runId)];
    if (!existing) return null;
    return this.upsertRun({ ...existing, ...patch, id: runId });
  }

  renameRunTitle(runId, title) {
    const existing = this.state.runs[String(runId)];
    if (!existing) return null;
    const nextTitle = String(title || "").trim();
    if (!nextTitle) return null;
    const renamed = normalizeRunRecord({
      ...existing,
      id: runId,
      title: nextTitle,
      titleCustomized: true,
      updatedAt: safeNow(),
    });
    this.state.runs[String(runId)] = renamed;
    this.save();
    return deepClone(toPublicRun(renamed));
  }

  activateDraftRun(runId, { prompt, sourceAction = "chat", sourceType = "gateway" } = {}) {
    const existing = this.state.runs[String(runId)];
    if (!existing) return null;
    const nextPrompt = String(prompt || "").trim();
    if (!nextPrompt) return null;
    const activated = normalizeRunRecord({
      ...existing,
      id: runId,
      title: nextPrompt.slice(0, 72) || "새 대화",
      prompt: nextPrompt,
      sourceAction,
      sourceType,
      status: "running",
      step: 1,
      steps: createDefaultRunSteps(),
      tasks: createDefaultRunTasks(),
      logs: [],
      executionTranscript: [],
      usage: createDefaultRunUsage(),
      isDraft: false,
      hasSubmittedPrompt: true,
      updatedAt: safeNow(),
    });
    this.state.runs[String(runId)] = activated;
    this.save();
    return deepClone(toPublicRun(activated));
  }

  appendRunLog(runId, message, level = "info") {
    const existing = this.state.runs[String(runId)];
    if (!existing) return null;
    const nextLogs = Array.isArray(existing.logs) ? [...existing.logs] : [];
    nextLogs.push({ id: crypto.randomUUID(), ts: safeNow(), level, message: String(message || "") });
    if (nextLogs.length > 300) nextLogs.splice(0, nextLogs.length - 300);
    return this.patchRun(runId, { logs: nextLogs, updatedAt: safeNow() });
  }

  appendRunTranscript(runId, entry = {}) {
    const existing = this.state.runs[String(runId)];
    if (!existing) return null;
    const nextTranscript = Array.isArray(existing.executionTranscript) ? [...existing.executionTranscript] : [];
    nextTranscript.push({
      id: String(entry.id || crypto.randomUUID()),
      taskId: entry.taskId ? String(entry.taskId) : "",
      phaseId: entry.phaseId ? String(entry.phaseId) : "",
      role:
        String(entry.role || "").trim().toLowerCase() === "human"
          ? "human"
          : String(entry.role || "").trim().toLowerCase() === "system"
            ? "system"
            : "ai",
      kind: String(entry.kind || "event"),
      text: String(entry.text || ""),
      ts: Number(entry.ts || safeNow()),
    });
    if (nextTranscript.length > 400) nextTranscript.splice(0, nextTranscript.length - 400);
    return this.patchRun(runId, { executionTranscript: nextTranscript, updatedAt: safeNow() });
  }

  setRunTasks(runId, tasks) {
    return this.patchRun(runId, { tasks: Array.isArray(tasks) ? tasks : [] });
  }

  setRunSteps(runId, step, steps) {
    return this.patchRun(runId, {
      step: Number.isFinite(Number(step)) ? Number(step) : 1,
      steps: Array.isArray(steps) ? steps : [],
    });
  }

  setRunUsage(runId, usage) {
    return this.patchRun(runId, {
      usage: usage && typeof usage === "object" ? usage : null,
    });
  }

  setRunArtifacts(runId, artifacts) {
    return this.patchRun(runId, {
      artifacts: artifacts && typeof artifacts === "object" ? artifacts : null,
    });
  }

  setRunPauseState(runId, pauseState) {
    return this.patchRun(runId, {
      pauseState: pauseState && typeof pauseState === "object" ? pauseState : null,
    });
  }

  setRunCurrentExecution(runId, currentExecution) {
    return this.patchRun(runId, {
      currentExecution: currentExecution && typeof currentExecution === "object" ? currentExecution : null,
    });
  }

  setSkills(skills) {
    if (!Array.isArray(skills)) return this.listSkills();
    const next = {};
    for (const skill of skills) {
      if (!skill || !skill.id) continue;
      next[String(skill.id)] = {
        id: String(skill.id),
        name: String(skill.name || skill.id),
        description: String(skill.description || ""),
        enabled: Boolean(skill.enabled),
      };
    }
    if (Object.keys(next).length === 0) return this.listSkills();
    this.state.skills = next;
    this.save();
    return this.listSkills();
  }

  listSkills() {
    return Object.values(this.state.skills).map((skill) => ({ ...skill }));
  }

  toggleSkill(skillId, enabled) {
    const key = String(skillId);
    const current = this.state.skills[key] || {
      id: key,
      name: key,
      description: "",
      enabled: false,
    };
    current.enabled = Boolean(enabled);
    this.state.skills[key] = current;
    this.save();
    return { ...current };
  }

  setDefaultModel(model) {
    this.state.defaults.defaultModel = model ? String(model) : null;
    this.save();
  }

  getDefaultModel() {
    return this.state.defaults?.defaultModel || null;
  }

  getFeatureFlags() {
    this.state.features = normalizeFeatureFlags(this.state.features);
    return deepClone(this.state.features);
  }

  getFeatureStatus() {
    this.state.featureStatus = normalizeFeatureStatuses(this.state.featureStatus);
    return deepClone(this.state.featureStatus);
  }

  setFeatureEnabled(featureId, enabled) {
    const key = String(featureId || "");
    if (!FEATURE_IDS.includes(key)) return null;
    this.state.features = normalizeFeatureFlags(this.state.features);
    this.state.features[key] = Boolean(enabled);
    this.save();
    return this.state.features[key];
  }

  setFeatureStatus(featureId, patch = {}) {
    const key = String(featureId || "");
    if (!FEATURE_IDS.includes(key)) return null;
    const current = normalizeFeatureStatuses(this.state.featureStatus)[key];
    const merged = {
      ...current,
      ...(patch && typeof patch === "object" ? patch : {}),
    };
    const normalized = normalizeFeatureStatuses({ [key]: merged })[key];
    this.state.featureStatus = normalizeFeatureStatuses(this.state.featureStatus);
    this.state.featureStatus[key] = normalized;
    this.save();
    return deepClone(normalized);
  }
}

module.exports = {
  FEATURE_KEYS: FEATURE_IDS,
  RuntimeStore,
};
