const crypto = require("crypto");
const { createPerRunSessionKey } = require("./session-utils.cjs");
const { USECASE_DEFINITIONS, getUsecaseDefinition } = require("./usecase-demo-runtime.cjs");

const MAX_FOLLOWUP_ROUNDS = 2;
const MAX_FOLLOWUP_QUESTIONS = 3;

function firstValue(payload, keys) {
  for (const key of keys) {
    const value = String(key || "")
      .split(".")
      .reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), payload);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function firstArray(payload, keys) {
  for (const key of keys) {
    const value = String(key || "")
      .split(".")
      .reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), payload);
    if (Array.isArray(value)) return value;
  }
  return null;
}

function inferUsecaseId(prompt = "") {
  const normalized = String(prompt || "").toLowerCase();
  if (/(문서|드라이브|drive|파일|요약|todo|to-do|결정사항|리스크|폴더)/i.test(normalized)) {
    return "doc_summary";
  }
  if (/(리서치|경쟁|비교|시장|트렌드|브리프|조사)/i.test(normalized)) {
    return "web_research";
  }
  return "";
}

function normalizeQuestions(questions = [], source = "template") {
  return (Array.isArray(questions) ? questions : [])
    .map((question) => ({
      id: String(question?.id || crypto.randomUUID()),
      label: String(question?.label || question?.id || "질문"),
      type: String(question?.type || "text"),
      required: Boolean(question?.required),
      placeholder: question?.placeholder ? String(question.placeholder) : "",
      helpText: question?.helpText ? String(question.helpText) : "",
      options: Array.isArray(question?.options)
        ? question.options
            .map((option) => ({
              value: String(option?.value || "").trim(),
              label: String(option?.label || option?.value || "").trim(),
            }))
            .filter((option) => option.value && option.label)
        : [],
      source,
    }))
    .slice(0, MAX_FOLLOWUP_QUESTIONS);
}

function normalizeAnswers(answers = {}) {
  const source = answers && typeof answers === "object" ? answers : {};
  const next = {};
  for (const [key, value] of Object.entries(source)) {
    const answerKey = String(key || "").trim();
    if (!answerKey) continue;
    if (value === null || value === undefined) continue;
    next[answerKey] = typeof value === "string" ? value.trim() : JSON.stringify(value);
  }
  return next;
}

function isAnswered(value) {
  return typeof value === "string" ? Boolean(value.trim()) : Boolean(value);
}

function deriveTemplateAnswersFromPrompt(definition, prompt) {
  if (!definition) return {};
  const value = String(prompt || "").trim();
  if (!value) return {};
  if (definition.id === "web_research") {
    return { topic: value };
  }
  if (definition.id === "doc_summary") {
    return { keywords: value };
  }
  return {};
}

function buildConversationAssistantText({ definition, suggestedUsecaseId, selectedUsecaseId, missingTemplateIds = [], justChanged = false }) {
  if (!definition) {
    return "원하는 작업을 한 문장으로 알려주시면 필요한 내용을 대화로 차례대로 정리해 드릴게요.";
  }
  const intro = justChanged
    ? `${definition.name} 기준으로 대화를 이어갈게요.`
    : `${definition.name} 작업을 도와드릴게요.`;
  const recommended = suggestedUsecaseId && suggestedUsecaseId === selectedUsecaseId ? "입력 내용을 바탕으로 이 유형으로 이해했어요." : "";
  const nextQuestion = missingTemplateIds.length > 0 ? "필요한 내용은 대화로 하나씩 확인할게요." : "추가 확인이 끝나면 바로 실행으로 넘길게요.";
  return [intro, recommended, nextQuestion].filter(Boolean).join(" ");
}

function normalizeLookupText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function buildQuestionPrompt(question, source = "template") {
  if (!question) return "추가로 필요한 내용을 알려주세요.";
  const label = String(question.label || "추가 정보").trim();
  const lead = source === "followup" ? `추가로 ${label} 알려주세요.` : `${label} 알려주세요.`;
  if (question.type === "select" && Array.isArray(question.options) && question.options.length > 0) {
    const optionLabels = question.options.map((option) => option.label).filter(Boolean).join(", ");
    return optionLabels ? `${lead} 선택지는 ${optionLabels}입니다.` : lead;
  }
  const placeholderValue = String(question.placeholder || "").trim();
  const placeholder = placeholderValue ? ` ${/^예[:：]/.test(placeholderValue) ? placeholderValue : `예: ${placeholderValue}`}` : "";
  return `${lead}${placeholder}`;
}

function getNextPendingQuestion(definition, missingTemplateIds = [], missingFollowupIds = [], followupQuestions = []) {
  if (definition && missingTemplateIds.length > 0) {
    const templateQuestion = (Array.isArray(definition.form) ? definition.form : []).find((question) =>
      missingTemplateIds.includes(String(question?.id || ""))
    );
    if (templateQuestion) return { question: templateQuestion, source: "template" };
  }
  if (missingFollowupIds.length > 0) {
    const followupQuestion = normalizeQuestions(followupQuestions, "followup").find((question) =>
      missingFollowupIds.includes(String(question?.id || ""))
    );
    if (followupQuestion) return { question: followupQuestion, source: "followup" };
  }
  return null;
}

function normalizeUserAnswerForQuestion(question, text) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (question?.type !== "select" || !Array.isArray(question?.options) || question.options.length === 0) {
    return value;
  }
  const normalizedValue = normalizeLookupText(value);
  const exactMatch = question.options.find((option) => {
    const optionValue = normalizeLookupText(option?.value);
    const optionLabel = normalizeLookupText(option?.label);
    return normalizedValue === optionValue || normalizedValue === optionLabel;
  });
  if (exactMatch?.value) return String(exactMatch.value);

  const fuzzyMatches = question.options.filter((option) => {
    const optionValue = normalizeLookupText(option?.value);
    const optionLabel = normalizeLookupText(option?.label);
    return (
      (optionValue && normalizedValue.includes(optionValue)) ||
      (optionLabel && normalizedValue.includes(optionLabel)) ||
      (optionValue && optionValue.includes(normalizedValue)) ||
      (optionLabel && optionLabel.includes(normalizedValue))
    );
  });
  if (fuzzyMatches.length === 1 && fuzzyMatches[0]?.value) {
    return String(fuzzyMatches[0].value);
  }
  return value;
}

function applyFreeformAnswerToPendingQuestion({
  definition,
  templateAnswers = {},
  followupAnswers = {},
  followupQuestions = [],
  missingTemplateIds = [],
  missingFollowupIds = [],
  userText = "",
}) {
  const nextPending = getNextPendingQuestion(definition, missingTemplateIds, missingFollowupIds, followupQuestions);
  if (!nextPending?.question) {
    return { consumed: false, templateAnswers, followupAnswers };
  }
  const answer = normalizeUserAnswerForQuestion(nextPending.question, userText);
  if (!answer) {
    return { consumed: false, templateAnswers, followupAnswers };
  }
  if (nextPending.source === "followup") {
    return {
      consumed: true,
      templateAnswers,
      followupAnswers: mergeObjects(followupAnswers, { [nextPending.question.id]: answer }),
    };
  }
  return {
    consumed: true,
    templateAnswers: mergeObjects(templateAnswers, { [nextPending.question.id]: answer }),
    followupAnswers,
  };
}

function buildMissingQuestionHint(definition, missingTemplateIds = [], missingFollowupIds = [], followupQuestions = []) {
  if (!definition) return "원하는 작업을 조금만 더 구체적으로 알려주세요.";
  const nextPending = getNextPendingQuestion(definition, missingTemplateIds, missingFollowupIds, followupQuestions);
  if (nextPending?.question) return buildQuestionPrompt(nextPending.question, nextPending.source);
  return "입력을 확인하고 있어요.";
}

function computeReadiness(conversation) {
  const definition = getUsecaseDefinition(conversation?.selectedUsecaseId);
  if (!definition) {
    return {
      state: conversation?.status === "failed" ? "failed" : "draft",
      canCommit: false,
      requiredAnswered: 0,
      totalRequired: 0,
      missingTemplateIds: [],
      missingFollowupIds: [],
      autoCommitPending: false,
    };
  }

  const templateAnswers = normalizeAnswers(conversation?.templateAnswers);
  const followupAnswers = normalizeAnswers(conversation?.followupAnswers);
  const templateQuestions = normalizeQuestions(definition.form, "template");
  const followupQuestions = normalizeQuestions(conversation?.followupQuestions, "followup");
  const missingTemplateIds = templateQuestions.filter((question) => question.required && !isAnswered(templateAnswers[question.id])).map((question) => question.id);
  const missingFollowupIds = followupQuestions.filter((question) => question.required && !isAnswered(followupAnswers[question.id])).map((question) => question.id);
  const totalRequired =
    templateQuestions.filter((question) => question.required).length + followupQuestions.filter((question) => question.required).length;
  const requiredAnswered = totalRequired - missingTemplateIds.length - missingFollowupIds.length;
  const committed = Boolean(conversation?.linkedRunId);
  const committing = String(conversation?.status || "") === "committing";
  const failed = String(conversation?.status || "") === "failed";
  const canCommit = !committed && !committing && missingTemplateIds.length === 0 && missingFollowupIds.length === 0;

  return {
    state: committed ? "committed" : failed ? "failed" : canCommit ? "ready" : "clarifying",
    canCommit,
    requiredAnswered,
    totalRequired,
    missingTemplateIds,
    missingFollowupIds,
    autoCommitPending: committing,
  };
}

function stripCodeFence(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return value;
}

function parseFollowupPayload(text) {
  const raw = stripCodeFence(text);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractHistoryMessages(payload) {
  const rows = firstArray(payload, ["messages", "items", "history.messages", "data.messages"]) || [];
  return rows
    .map((message) => ({
      role: String(firstValue(message, ["role", "author.role"]) || "").trim().toLowerCase(),
      text: String(
        firstValue(message, ["text", "content.0.text", "content.0.value", "content.text", "message.text", "message.content.0.text"]) || ""
      ).trim(),
    }))
    .filter((message) => message.text);
}

function mergeObjects(...values) {
  return values.reduce((acc, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ...acc, ...value };
    }
    return acc;
  }, {});
}

class PlanningConversationRuntime {
  constructor({ runtimeStore, runtimeAdapter, usecaseRuntime, featureToggleManager, chatGateway = null }) {
    this.runtimeStore = runtimeStore;
    this.runtimeAdapter = runtimeAdapter;
    this.usecaseRuntime = usecaseRuntime;
    this.featureToggleManager = featureToggleManager;
    this.chatGateway = chatGateway && typeof chatGateway.send === "function" ? chatGateway : null;
  }

  listConversations() {
    return this.runtimeStore.listConversations();
  }

  getConversation(conversationId) {
    return this.runtimeStore.getConversation(conversationId);
  }

  createConversation({ prompt, sourceAction = "chat", selectedUsecaseId = "" }) {
    const promptText = String(prompt || "").trim();
    const suggestedUsecaseId = inferUsecaseId(promptText);
    const effectiveUsecaseId = String(selectedUsecaseId || suggestedUsecaseId || "").trim();
    const definition = getUsecaseDefinition(effectiveUsecaseId);
    const templateAnswers = deriveTemplateAnswersFromPrompt(definition, promptText);
    const baseConversation = this.runtimeStore.createConversation({
      kind: "planning",
      title: promptText || "새 계획",
      prompt: promptText,
      sourceAction,
      sessionKey: createPerRunSessionKey(),
      suggestedUsecaseId,
      selectedUsecaseId: effectiveUsecaseId,
      templateAnswers,
      status: definition ? "clarifying" : "draft",
      messages: [
        {
          role: "user",
          type: "text",
          text: promptText,
        },
        {
          role: "assistant",
          type: "text",
          text: buildConversationAssistantText({
            definition,
            suggestedUsecaseId,
            selectedUsecaseId: effectiveUsecaseId,
            missingTemplateIds: [],
          }),
        },
      ],
    });
    const readiness = computeReadiness(baseConversation);
    const updated = this.runtimeStore.patchConversation(baseConversation.id, {
      readiness,
      status: readiness.state === "draft" ? "draft" : "clarifying",
    });
    let finalConversation = updated || baseConversation;
    let assistantMessage = (finalConversation?.messages || []).at(-1) || null;
    if (definition && readiness.missingTemplateIds.length > 0) {
      const nextPending = getNextPendingQuestion(definition, readiness.missingTemplateIds, [], []);
      if (nextPending?.question) {
        assistantMessage = {
          role: "assistant",
          type: "text",
          text: buildQuestionPrompt(nextPending.question, nextPending.source),
        };
        finalConversation = this.runtimeStore.appendConversationMessage(baseConversation.id, assistantMessage) || finalConversation;
      }
    }
    return {
      ok: true,
      conversation: finalConversation,
      assistantMessage,
      readiness,
      transition: { state: "idle", runId: null },
    };
  }

  updateConversation(conversationId, patch = {}) {
    const current = this.runtimeStore.getConversationRecord(conversationId);
    if (!current) return { ok: false, code: "invalid_input", error: "conversation not found" };

    const nextUsecaseId = patch?.selectedUsecaseId ? String(patch.selectedUsecaseId).trim() : "";
    if (nextUsecaseId && !getUsecaseDefinition(nextUsecaseId)) {
      return { ok: false, code: "invalid_input", error: "unsupported usecaseId" };
    }

    const nextDefinition = getUsecaseDefinition(nextUsecaseId);
    const nextTemplateAnswers = deriveTemplateAnswersFromPrompt(nextDefinition, current.prompt);
    const patched = this.runtimeStore.patchConversation(conversationId, {
      selectedUsecaseId: nextUsecaseId,
      templateAnswers: nextTemplateAnswers,
      followupQuestions: [],
      followupAnswers: {},
      normalizedInputPatch: {},
      followupRoundCount: 0,
      linkedRunId: "",
      lastError: null,
      status: nextDefinition ? "clarifying" : "draft",
    });
    const readiness = computeReadiness(patched);
    const finalized = this.runtimeStore.patchConversation(conversationId, {
      readiness,
      status: readiness.state === "draft" ? "draft" : "clarifying",
    });
    const assistantMessage = {
      role: "assistant",
      type: "text",
      text: buildConversationAssistantText({
        definition: nextDefinition,
        suggestedUsecaseId: current.suggestedUsecaseId,
        selectedUsecaseId: nextUsecaseId,
        missingTemplateIds: readiness.missingTemplateIds,
        justChanged: true,
      }),
    };
    const withMessage = this.runtimeStore.appendConversationMessage(conversationId, assistantMessage);
    let finalConversation = withMessage || finalized || patched;
    let lastAssistantMessage = assistantMessage;
    if (nextDefinition && readiness.missingTemplateIds.length > 0) {
      const nextPending = getNextPendingQuestion(nextDefinition, readiness.missingTemplateIds, [], []);
      if (nextPending?.question) {
        lastAssistantMessage = {
          role: "assistant",
          type: "text",
          text: buildQuestionPrompt(nextPending.question, nextPending.source),
        };
        finalConversation = this.runtimeStore.appendConversationMessage(conversationId, lastAssistantMessage) || finalConversation;
      }
    }
    return {
      ok: true,
      conversation: finalConversation,
      assistantMessage: lastAssistantMessage,
      readiness: computeReadiness(finalConversation),
      transition: { state: "idle", runId: null },
    };
  }

  async sendMessage(conversationId, payload = {}) {
    const current = this.runtimeStore.getConversationRecord(conversationId);
    if (!current) return { ok: false, code: "invalid_input", error: "conversation not found" };
    if (current.status === "committed" && current.linkedRunId) {
      return {
        ok: true,
        conversation: this.runtimeStore.getConversation(conversationId),
        assistantMessage: null,
        readiness: computeReadiness(current),
        transition: { state: "committed", runId: current.linkedRunId },
      };
    }

    const incomingTemplateAnswers = normalizeAnswers(payload.templateAnswers);
    const incomingFollowupAnswers = normalizeAnswers(payload.followupAnswers);
    const templateAnswers = mergeObjects(current.templateAnswers, incomingTemplateAnswers);
    const followupAnswers = mergeObjects(current.followupAnswers, incomingFollowupAnswers);
    const hasStructuredAnswerPayload = Object.keys(incomingTemplateAnswers).length > 0 || Object.keys(incomingFollowupAnswers).length > 0;
    const userText = String(payload.text || "").trim();
    let updated = this.runtimeStore.patchConversation(conversationId, {
      templateAnswers,
      followupAnswers,
      lastError: null,
      status: current.status === "failed" ? "clarifying" : current.status,
    });
    if (!updated) return { ok: false, code: "invalid_input", error: "conversation not found" };

    if (userText) {
      updated = this.runtimeStore.appendConversationMessage(conversationId, {
        role: "user",
        type: "text",
        text: userText,
      });
    }

    let definition = getUsecaseDefinition(updated?.selectedUsecaseId);
    const hadDefinitionBeforeMessage = Boolean(definition);
    if (!definition && userText) {
      const inferredUsecaseId = inferUsecaseId([updated?.prompt, userText].filter(Boolean).join(" "));
      if (inferredUsecaseId) {
        definition = getUsecaseDefinition(inferredUsecaseId);
        updated =
          this.runtimeStore.patchConversation(conversationId, {
            selectedUsecaseId: inferredUsecaseId,
            templateAnswers: mergeObjects(updated.templateAnswers, deriveTemplateAnswersFromPrompt(definition, [updated?.prompt, userText].filter(Boolean).join(" "))),
            status: "clarifying",
          }) || updated;
      }
    }

    let readiness = computeReadiness(updated);
    let assistantMessage = null;

    if (userText && definition && hadDefinitionBeforeMessage && !hasStructuredAnswerPayload) {
      const answered = applyFreeformAnswerToPendingQuestion({
        definition,
        templateAnswers: updated.templateAnswers,
        followupAnswers: updated.followupAnswers,
        followupQuestions: updated.followupQuestions,
        missingTemplateIds: readiness.missingTemplateIds,
        missingFollowupIds: readiness.missingFollowupIds,
        userText,
      });
      if (answered.consumed) {
        updated =
          this.runtimeStore.patchConversation(conversationId, {
            templateAnswers: answered.templateAnswers,
            followupAnswers: answered.followupAnswers,
          }) || updated;
        readiness = computeReadiness(updated);
      }
    }

    if (!definition) {
      assistantMessage = {
        role: "assistant",
        type: "text",
        text: "원하는 작업을 조금만 더 구체적으로 알려주시면 필요한 질문을 이어서 드릴게요.",
      };
      updated = this.runtimeStore.appendConversationMessage(conversationId, assistantMessage) || updated;
      readiness = computeReadiness(updated);
      updated = this.runtimeStore.patchConversation(conversationId, { readiness, status: readiness.state });
      return {
        ok: true,
        conversation: updated,
        assistantMessage,
        readiness,
        transition: { state: "idle", runId: null },
      };
    }

    if (readiness.missingTemplateIds.length > 0) {
      assistantMessage = {
        role: "assistant",
        type: "text",
        text: buildMissingQuestionHint(definition, readiness.missingTemplateIds, [], []),
      };
      updated = this.runtimeStore.appendConversationMessage(conversationId, assistantMessage) || updated;
      readiness = computeReadiness(updated);
      updated = this.runtimeStore.patchConversation(conversationId, { readiness, status: "clarifying" });
      return {
        ok: true,
        conversation: updated,
        assistantMessage,
        readiness,
        transition: { state: "idle", runId: null },
      };
    }

    if (readiness.missingFollowupIds.length > 0) {
      assistantMessage = {
        role: "assistant",
        type: "text",
        text: buildMissingQuestionHint(definition, [], readiness.missingFollowupIds, updated.followupQuestions),
      };
      updated = this.runtimeStore.appendConversationMessage(conversationId, assistantMessage) || updated;
      readiness = computeReadiness(updated);
      updated = this.runtimeStore.patchConversation(conversationId, { readiness, status: "clarifying" });
      return {
        ok: true,
        conversation: updated,
        assistantMessage,
        readiness,
        transition: { state: "idle", runId: null },
      };
    }

    if ((updated.followupRoundCount || 0) < MAX_FOLLOWUP_ROUNDS) {
      const followupResult = await this.requestOpenClawFollowups(updated);
      if (followupResult.questions.length > 0) {
        const followupIntroMessage = {
          role: "assistant",
          type: "text",
          text: followupResult.assistantText || "추가로 확인할 사항이 있어요. 아래 질문에 답하면 바로 실행으로 넘어갑니다.",
        };
        updated =
          this.runtimeStore.patchConversation(conversationId, {
            followupQuestions: followupResult.questions,
            followupAnswers: {},
            normalizedInputPatch: mergeObjects(updated.normalizedInputPatch, followupResult.normalizedInputPatch),
            followupRoundCount: Number(updated.followupRoundCount || 0) + 1,
            status: "clarifying",
          }) || updated;
        if (followupIntroMessage.text) {
          updated = this.runtimeStore.appendConversationMessage(conversationId, followupIntroMessage) || updated;
        }
        readiness = computeReadiness(updated);
        updated = this.runtimeStore.patchConversation(conversationId, { readiness, status: "clarifying" });
        const nextPending = getNextPendingQuestion(definition, [], readiness.missingFollowupIds, updated?.followupQuestions || []);
        if (nextPending?.question) {
          assistantMessage = {
            role: "assistant",
            type: "text",
            text: buildQuestionPrompt(nextPending.question, nextPending.source),
          };
          updated = this.runtimeStore.appendConversationMessage(conversationId, assistantMessage) || updated;
        } else {
          assistantMessage = followupIntroMessage;
        }
        return {
          ok: true,
          conversation: updated,
          assistantMessage,
          readiness,
          transition: { state: "idle", runId: null },
        };
      }
      if (followupResult.assistantText) {
        assistantMessage = {
          role: "assistant",
          type: "text",
          text: followupResult.assistantText,
        };
        updated = this.runtimeStore.appendConversationMessage(conversationId, assistantMessage) || updated;
      }
      if (followupResult.normalizedInputPatch && Object.keys(followupResult.normalizedInputPatch).length > 0) {
        updated =
          this.runtimeStore.patchConversation(conversationId, {
            normalizedInputPatch: mergeObjects(updated.normalizedInputPatch, followupResult.normalizedInputPatch),
          }) || updated;
      }
    }

    readiness = computeReadiness(updated);
    updated = this.runtimeStore.patchConversation(conversationId, {
      readiness,
      status: readiness.canCommit ? "ready" : "clarifying",
    }) || updated;

    if (readiness.canCommit) {
      return this.commitConversation(conversationId, { previousConversation: updated });
    }

    return {
      ok: true,
      conversation: updated,
      assistantMessage,
      readiness,
      transition: { state: "idle", runId: null },
    };
  }

  async commitConversation(conversationId, { previousConversation = null } = {}) {
    const current = previousConversation || this.runtimeStore.getConversationRecord(conversationId);
    if (!current) return { ok: false, code: "invalid_input", error: "conversation not found" };
    const readiness = computeReadiness(current);
    if (!readiness.canCommit) {
      const updated = this.runtimeStore.patchConversation(conversationId, {
        readiness,
        status: current.status === "failed" ? "failed" : "clarifying",
      });
      return {
        ok: false,
        code: "invalid_input",
        error: "conversation is not ready to commit",
        conversation: updated || current,
        readiness,
        transition: { state: "idle", runId: null },
      };
    }

    const committing = this.runtimeStore.patchConversation(conversationId, {
      status: "committing",
      readiness: {
        ...readiness,
        state: "ready",
        autoCommitPending: true,
      },
      lastError: null,
    });

    const executionFeatures = this.featureToggleManager.captureExecutionFeatures();
    const formInput = mergeObjects(
      normalizeAnswers(current.templateAnswers),
      normalizeAnswers(current.followupAnswers),
      current.normalizedInputPatch
    );
    const prompt = String(current.prompt || "").trim();
    const selectedUsecaseId = String(current.selectedUsecaseId || "").trim();
    let created;
    if (selectedUsecaseId) {
      created = this.usecaseRuntime.createUsecaseRun({
        prompt,
        usecaseId: selectedUsecaseId,
        formInput,
        sourceAction: "planning_commit",
        executionFeatures,
        sessionKey: current.sessionKey,
        originConversationId: conversationId,
      });
    } else {
      created = await this.runtimeAdapter.createRun({
        prompt,
        sourceAction: "planning_commit",
        executionFeatures,
        sessionKey: current.sessionKey,
        originConversationId: conversationId,
      });
    }

    if (!created?.ok || !created?.runId) {
      const lastError = {
        code: created?.code || "commit_failed",
        message: created?.error || "planning commit failed",
      };
      const failedReadiness = {
        ...readiness,
        state: "failed",
        autoCommitPending: false,
      };
      const failed = this.runtimeStore.patchConversation(conversationId, {
        status: "failed",
        readiness: failedReadiness,
        lastError,
      });
      return {
        ok: false,
        code: lastError.code,
        error: lastError.message,
        conversation: failed || committing || current,
        readiness: failedReadiness,
        transition: { state: "ready", runId: null },
      };
    }

    const committedReadiness = {
      ...readiness,
      state: "committed",
      autoCommitPending: false,
      canCommit: false,
    };
    const committed = this.runtimeStore.patchConversation(conversationId, {
      status: "committed",
      linkedRunId: created.runId,
      lastError: null,
      readiness: committedReadiness,
    });
    this.runtimeStore.appendConversationMessage(conversationId, {
      role: "system",
      type: "status",
      text: "질문 수집이 완료되어 실행 화면으로 전환했어요.",
      meta: { runId: created.runId },
    });
    return {
      ok: true,
      conversation: this.runtimeStore.getConversation(conversationId) || committed,
      assistantMessage: null,
      readiness: committedReadiness,
      transition: { state: "committed", runId: created.runId },
    };
  }

  async requestOpenClawFollowups(conversation) {
    if (!this.chatGateway || typeof this.chatGateway.history !== "function") {
      return {
        assistantText: "",
        questions: [],
        normalizedInputPatch: {},
        readyHint: true,
      };
    }

    const definition = getUsecaseDefinition(conversation?.selectedUsecaseId);
    if (!definition) {
      return {
        assistantText: "",
        questions: [],
        normalizedInputPatch: {},
        readyHint: true,
      };
    }

    const templateAnswers = normalizeAnswers(conversation?.templateAnswers);
    const followupAnswers = normalizeAnswers(conversation?.followupAnswers);
    const prompt = [
      "You are generating SEMO planning follow-up questions.",
      "Return JSON only.",
      JSON.stringify({
        assistantText: "한국어 한 문장 요약",
        followupQuestions: [
          {
            id: "snake_case_id",
            label: "질문 라벨",
            type: "text",
            required: true,
            placeholder: "한국어 placeholder",
          },
        ],
        normalizedInputPatch: {},
        readyHint: true,
      }),
      `Usecase: ${definition.id}`,
      `Prompt: ${String(conversation?.prompt || "")}`,
      `Template answers: ${JSON.stringify(templateAnswers)}`,
      `Existing followup answers: ${JSON.stringify(followupAnswers)}`,
      "Ask at most 3 essential questions only if they materially improve execution quality.",
      "If no more questions are needed, set followupQuestions to [] and readyHint to true.",
    ].join("\n");

    try {
      await this.chatGateway.send({
        sessionKey: conversation.sessionKey,
        message: prompt,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
      });
      const history = await this.chatGateway.history({
        sessionKey: conversation.sessionKey,
        limit: 12,
      });
      const messages = extractHistoryMessages(history);
      const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
      const parsed = parseFollowupPayload(lastAssistant?.text || "");
      if (!parsed) {
        return {
          assistantText: "",
          questions: [],
          normalizedInputPatch: {},
          readyHint: true,
        };
      }

      return {
        assistantText: typeof parsed.assistantText === "string" ? parsed.assistantText.trim() : "",
        questions: normalizeQuestions(parsed.followupQuestions, "followup"),
        normalizedInputPatch: parsed.normalizedInputPatch && typeof parsed.normalizedInputPatch === "object" ? parsed.normalizedInputPatch : {},
        readyHint: parsed.readyHint !== false,
      };
    } catch {
      return {
        assistantText: "",
        questions: [],
        normalizedInputPatch: {},
        readyHint: true,
      };
    }
  }
}

module.exports = {
  PlanningConversationRuntime,
  computeReadiness,
  inferUsecaseId,
};
