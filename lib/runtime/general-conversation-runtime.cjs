const crypto = require("crypto");
const { createPerRunSessionKey } = require("./session-utils.cjs");

const HISTORY_POLL_ATTEMPTS = 12;
const HISTORY_POLL_DELAY_MS = 500;

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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createChatReadiness(state = "ready") {
  return {
    state: state === "failed" ? "failed" : "ready",
    canCommit: false,
    requiredAnswered: 0,
    totalRequired: 0,
    missingTemplateIds: [],
    missingFollowupIds: [],
    autoCommitPending: false,
  };
}

function extractMessageText(message) {
  if (typeof message === "string") return message.trim();
  if (!message || typeof message !== "object") return "";
  if (typeof message.text === "string" && message.text.trim()) return message.text.trim();

  const content = Array.isArray(message.content) ? message.content : [];
  const fragments = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const candidate = firstValue(part, ["text", "value", "content.text", "content.value"]);
    if (typeof candidate === "string" && candidate.trim()) fragments.push(candidate.trim());
  }
  return fragments.join("\n").trim();
}

function normalizeAttachmentPart(part, index = 0) {
  if (!part || typeof part !== "object") return null;
  const type = String(firstValue(part, ["type", "file.type"]) || "file")
    .trim()
    .toLowerCase();
  if (type && type !== "file") return null;
  const url = String(firstValue(part, ["url", "file.url", "content.url"]) || "").trim();
  const filename = String(firstValue(part, ["filename", "name", "file.filename", "content.filename"]) || "").trim();
  const mimeType = String(firstValue(part, ["mime", "mimeType", "file.mime", "content.mime"]) || "application/octet-stream").trim();
  const size = Number(firstValue(part, ["size", "file.size", "content.size"]));
  if (!url && !filename) return null;
  return {
    id: String(firstValue(part, ["id", "file.id"]) || `file-${index}-${crypto.randomUUID()}`),
    type: "file",
    url,
    filename: filename || "attachment",
    mime: mimeType || "application/octet-stream",
    size: Number.isFinite(size) && size >= 0 ? size : null,
  };
}

function extractMessageAttachments(message) {
  if (!message || typeof message !== "object") return [];
  const attachmentParts = [];
  const directAttachments = Array.isArray(message.attachments) ? message.attachments : [];
  for (const item of directAttachments) attachmentParts.push(item);
  const contentParts = Array.isArray(message.content) ? message.content : [];
  for (const part of contentParts) {
    const partType = String(firstValue(part, ["type"]) || "").trim().toLowerCase();
    if (partType === "file") attachmentParts.push(part);
  }
  return attachmentParts.map((part, index) => normalizeAttachmentPart(part, index)).filter(Boolean);
}

function normalizeHistoryMessage(message, index = 0) {
  const role = String(firstValue(message, ["role", "author.role", "message.role"]) || "assistant")
    .trim()
    .toLowerCase();
  const text = extractMessageText(message);
  const attachments = extractMessageAttachments(message);
  if (!text && attachments.length === 0) return null;
  const ts = Number(firstValue(message, ["ts", "timestamp", "createdAt", "created_at"]) || Date.now());
  return {
    id: String(firstValue(message, ["id", "message.id"]) || `history-${index}-${crypto.randomUUID()}`),
    ts: Number.isFinite(ts) ? ts : Date.now(),
    role: role === "user" || role === "system" ? role : "assistant",
    type: role === "system" ? "status" : "text",
    text,
    attachments,
  };
}

function extractHistoryMessages(payload) {
  const rows = firstArray(payload, ["messages", "items", "history.messages", "data.messages"]) || [];
  return rows.map((message, index) => normalizeHistoryMessage(message, index)).filter(Boolean);
}

function extractDirectAssistantMessage(payload) {
  if (!payload || typeof payload !== "object") return null;

  const directObject =
    firstValue(payload, ["message", "assistantMessage", "data.message", "data.assistantMessage"]) ||
    firstArray(payload, ["messages", "items"])?.find((message) => {
      const role = String(firstValue(message, ["role", "author.role"]) || "").trim().toLowerCase();
      return role === "assistant" || role === "system";
    }) ||
    null;

  if (directObject) {
    const normalized = normalizeHistoryMessage(directObject, 0);
    if (normalized) return normalized;
  }

  const text = String(firstValue(payload, ["assistantText", "reply", "text", "data.reply", "data.text"]) || "").trim();
  if (!text) return null;
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    role: "assistant",
    type: "text",
    text,
  };
}

function hasFreshAssistantReply(messages, localMessageCount) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  if (messages.length > localMessageCount) {
    const lastMessage = messages[messages.length - 1];
    return lastMessage && lastMessage.role !== "user";
  }
  return false;
}

function normalizeGatewayAttachments(raw) {
  return (Array.isArray(raw) ? raw : []).map((item, index) => normalizeAttachmentPart(item, index)).filter(Boolean);
}

function mergeHistoryWithLocalAttachments(historyMessages, localMessages) {
  const history = Array.isArray(historyMessages) ? historyMessages : [];
  const locals = Array.isArray(localMessages) ? localMessages : [];
  if (history.length === 0 || locals.length === 0) return history;

  const localUserMessages = locals.filter(
    (message) =>
      String(message?.role || "").trim().toLowerCase() === "user" &&
      Array.isArray(message?.attachments) &&
      message.attachments.length > 0
  );
  if (localUserMessages.length === 0) return history;

  const usedIndexes = new Set();
  return history.map((message) => {
    if (!message || message.role !== "user" || (Array.isArray(message.attachments) && message.attachments.length > 0)) {
      return message;
    }
    const matchIndex = localUserMessages.findIndex((localMessage, index) => {
      if (usedIndexes.has(index)) return false;
      return String(localMessage?.text || "").trim() === String(message?.text || "").trim();
    });
    if (matchIndex === -1) return message;
    usedIndexes.add(matchIndex);
    return {
      ...message,
      attachments: localUserMessages[matchIndex].attachments,
    };
  });
}

function mergeConversationHistory(localMessages, historyMessages) {
  const local = Array.isArray(localMessages) ? localMessages.filter(Boolean) : [];
  const history = mergeHistoryWithLocalAttachments(historyMessages, local);
  if (history.length === 0) return local;

  const merged = [...local];
  for (const message of history) {
    if (!message) continue;
    const nextText = String(message.text || "").trim();
    const nextAttachments = JSON.stringify(Array.isArray(message.attachments) ? message.attachments : []);
    const existingIndex = merged.findIndex((row) => {
      return (
        String(row?.role || "") === String(message.role || "") &&
        String(row?.type || "") === String(message.type || "") &&
        String(row?.text || "").trim() === nextText &&
        JSON.stringify(Array.isArray(row?.attachments) ? row.attachments : []) === nextAttachments
      );
    });
    if (existingIndex === -1) {
      merged.push(message);
      continue;
    }
    if ((!Array.isArray(merged[existingIndex]?.attachments) || merged[existingIndex].attachments.length === 0) && nextAttachments !== "[]") {
      merged[existingIndex] = {
        ...merged[existingIndex],
        attachments: message.attachments,
      };
    }
  }

  return merged.slice(-200);
}

function toConversationError(error) {
  const message = String(error?.message || error?.error || "").trim() || "Semo AI 응답을 받지 못했어요.";
  const code = String(error?.code || "chat_request_failed").trim() || "chat_request_failed";
  return {
    code,
    message,
  };
}

class GeneralConversationRuntime {
  constructor({ runtimeStore, chatGateway = null }) {
    this.runtimeStore = runtimeStore;
    this.chatGateway = chatGateway && typeof chatGateway.send === "function" ? chatGateway : null;
  }

  listConversations() {
    return this.runtimeStore.listConversations().filter((conversation) => String(conversation?.kind || "") === "chat");
  }

  getConversation(conversationId) {
    const conversation = this.runtimeStore.getConversation(conversationId);
    if (!conversation || String(conversation.kind || "") !== "chat") return null;
    return conversation;
  }

  getConversationRecord(conversationId) {
    const conversation = this.runtimeStore.getConversationRecord(conversationId);
    if (!conversation || String(conversation.kind || "") !== "chat") return null;
    return conversation;
  }

  updateConversation(conversationId) {
    const conversation = this.getConversation(conversationId);
    if (!conversation) return { ok: false, code: "invalid_input", error: "conversation not found" };
    return {
      ok: true,
      conversation,
      assistantMessage: null,
      readiness: createChatReadiness(conversation.status),
      transition: { state: "idle", runId: null },
    };
  }

  async createConversation({ prompt, title = "", sourceAction = "chat", attachments = [] }) {
    const normalizedAttachments = normalizeGatewayAttachments(attachments);
    const promptText = String(prompt || "").trim() || (normalizedAttachments.length > 0 ? "첨부 파일을 확인해줘" : "");
    if (!promptText && normalizedAttachments.length === 0) {
      return { ok: false, code: "invalid_input", error: "prompt or attachments are required" };
    }

    const created = this.runtimeStore.createConversation({
      kind: "chat",
      title: String(title || "").trim() || promptText.slice(0, 72) || normalizedAttachments[0]?.filename || "새 대화",
      prompt: promptText,
      sourceAction,
      sessionKey: createPerRunSessionKey(),
      readiness: createChatReadiness("ready"),
      status: "ready",
      messages: [
        {
          role: "user",
          type: "text",
          text: promptText,
          attachments: normalizedAttachments,
        },
      ],
    });

    return this.#exchange(created.id, promptText, normalizedAttachments);
  }

  async sendMessage(conversationId, payload = {}) {
    const conversation = this.getConversationRecord(conversationId);
    if (!conversation) return { ok: false, code: "invalid_input", error: "conversation not found" };

    const normalizedAttachments = normalizeGatewayAttachments(payload?.attachments);
    const userText = String(payload?.text || "").trim() || (normalizedAttachments.length > 0 ? "첨부 파일을 확인해줘" : "");
    if (!userText && normalizedAttachments.length === 0) {
      return { ok: false, code: "invalid_input", error: "text or attachments are required" };
    }

    this.runtimeStore.patchConversation(conversationId, {
      lastError: null,
      readiness: createChatReadiness("ready"),
      status: "ready",
    });
    this.runtimeStore.appendConversationMessage(conversationId, {
      role: "user",
      type: "text",
      text: userText,
      attachments: normalizedAttachments,
    });

    return this.#exchange(conversationId, userText, normalizedAttachments);
  }

  async #exchange(conversationId, userText, attachments = []) {
    const conversation = this.getConversationRecord(conversationId);
    if (!conversation) return { ok: false, code: "invalid_input", error: "conversation not found" };
    if (!this.chatGateway || typeof this.chatGateway.history !== "function") {
      return this.#finalizeFailure(conversation, {
        code: "gateway_unavailable",
        message: "Semo AI 채팅 게이트웨이를 사용할 수 없어요.",
      });
    }

    try {
      const sent = await this.chatGateway.send({
        sessionKey: conversation.sessionKey,
        message: userText,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        attachments,
      });
      return this.#syncFromGateway(conversationId, sent);
    } catch (error) {
      return this.#finalizeFailure(conversation, error);
    }
  }

  async #syncFromGateway(conversationId, sendPayload) {
    const current = this.getConversationRecord(conversationId);
    if (!current) return { ok: false, code: "invalid_input", error: "conversation not found" };

    const localMessageCount = Array.isArray(current.messages) ? current.messages.length : 0;
    const directAssistantMessage = extractDirectAssistantMessage(sendPayload);
    let historyMessages = [];

    for (let attempt = 0; attempt < HISTORY_POLL_ATTEMPTS; attempt += 1) {
      const history = await this.chatGateway.history({
        sessionKey: current.sessionKey,
        limit: 200,
      });
      historyMessages = mergeConversationHistory(current.messages, extractHistoryMessages(history));
      if (hasFreshAssistantReply(historyMessages, localMessageCount) || historyMessages.length >= localMessageCount + 2) {
        break;
      }
      if (attempt < HISTORY_POLL_ATTEMPTS - 1) await wait(HISTORY_POLL_DELAY_MS);
    }

    let assistantMessage = null;
    let updated = current;
    if (historyMessages.length > 0) {
      updated =
        this.runtimeStore.patchConversation(conversationId, {
          messages: historyMessages,
          lastError: null,
          readiness: createChatReadiness("ready"),
          status: "ready",
        }) || current;
      assistantMessage = [...historyMessages].reverse().find((message) => message.role === "assistant" || message.role === "system") || null;
    } else if (directAssistantMessage) {
      updated =
        this.runtimeStore.appendConversationMessage(conversationId, directAssistantMessage) ||
        this.runtimeStore.getConversation(conversationId) ||
        current;
      updated =
        this.runtimeStore.patchConversation(conversationId, {
          lastError: null,
          readiness: createChatReadiness("ready"),
          status: "ready",
        }) || updated;
      assistantMessage = directAssistantMessage;
    }

    if (!assistantMessage) {
      return this.#finalizeFailure(current, {
        code: "assistant_reply_missing",
        message: "Semo AI 응답을 아직 받지 못했어요. 잠시 후 다시 시도해 주세요.",
      });
    }

    return {
      ok: true,
      conversation: updated,
      assistantMessage,
      readiness: createChatReadiness("ready"),
      transition: { state: "idle", runId: null },
    };
  }

  #finalizeFailure(conversation, error) {
    const normalizedError = toConversationError(error);
    const statusMessage = {
      role: "system",
      type: "status",
      text: normalizedError.message,
    };
    const appended = this.runtimeStore.appendConversationMessage(conversation.id, statusMessage) || this.getConversation(conversation.id) || conversation;
    const updated =
      this.runtimeStore.patchConversation(conversation.id, {
        lastError: normalizedError,
        readiness: createChatReadiness("failed"),
        status: "failed",
      }) || appended;
    return {
      ok: true,
      conversation: updated,
      assistantMessage: statusMessage,
      readiness: createChatReadiness("failed"),
      transition: { state: "idle", runId: null },
    };
  }
}

module.exports = {
  GeneralConversationRuntime,
};
