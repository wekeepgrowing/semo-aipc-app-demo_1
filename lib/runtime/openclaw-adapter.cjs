const crypto = require("crypto");
const { normalizeUsageRow } = require("./usage-ledger.cjs");
const {
  RUN_SESSION_MODE_PER_RUN,
  createPerRunSessionKey,
  normalizeRunSessionMode,
} = require("./session-utils.cjs");
const {
  normalizeExecutionFeatures,
  normalizeExecutionFeaturesError,
  normalizeExecutionFeaturesStatus,
} = require("./feature-contract.cjs");

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

function normalizeStatus(raw) {
  const value = String(raw || "").toLowerCase();
  if (value.includes("queue") || value === "pending") return "queued";
  if (value.includes("run") || value.includes("progress")) return "running";
  if (value.includes("done") || value.includes("success") || value.includes("complete")) return "completed";
  if (value.includes("fail") || value.includes("error")) return "failed";
  return "running";
}

function normalizeRunSummary(item) {
  const id = String(firstValue(item, ["id", "runId", "uuid"]) || crypto.randomUUID());
  const title = String(firstValue(item, ["title", "name", "prompt", "input.prompt"]) || "새 실행").slice(0, 72);
  const updatedAt = Number(firstValue(item, ["updatedAt", "updated_at", "ts", "timestamp"]) || Date.now());
  const summary = {
    id,
    title,
    prompt: String(firstValue(item, ["prompt", "input.prompt"]) || ""),
    lastMessage: String(firstValue(item, ["lastMessage", "last_message", "recentMessage", "summary.lastMessage"]) || ""),
    status: normalizeStatus(firstValue(item, ["status", "state"])),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
  };
  const executionFeatures = firstValue(item, ["executionFeatures", "execution_features", "featureSnapshot", "feature_snapshot"]);
  const executionFeaturesStatus = firstValue(item, ["executionFeaturesStatus", "execution_features_status"]);
  const executionFeaturesError = firstValue(item, ["executionFeaturesError", "execution_features_error"]);
  if (executionFeatures !== undefined) summary.executionFeatures = normalizeExecutionFeatures(executionFeatures);
  if (executionFeaturesStatus !== undefined) summary.executionFeaturesStatus = normalizeExecutionFeaturesStatus(executionFeaturesStatus);
  if (executionFeaturesError !== undefined) summary.executionFeaturesError = normalizeExecutionFeaturesError(executionFeaturesError);
  return summary;
}

function normalizeTask(task) {
  return {
    id: String(firstValue(task, ["id", "taskId"]) || crypto.randomUUID()),
    text: String(firstValue(task, ["text", "title", "name"]) || "작업 항목"),
    done: Boolean(firstValue(task, ["done", "completed", "isDone"])),
    assignee: String(firstValue(task, ["assignee", "owner", "actor"]) || "AI 실행"),
    assigneeType: String(firstValue(task, ["assigneeType", "ownerType"]) || "ai"),
  };
}

function normalizeLog(log) {
  return {
    id: String(firstValue(log, ["id"]) || crypto.randomUUID()),
    ts: Number(firstValue(log, ["ts", "timestamp"]) || Date.now()),
    level: String(firstValue(log, ["level", "severity"]) || "info"),
    message: String(firstValue(log, ["message", "text", "line"]) || ""),
  };
}

function normalizeStep(step, index) {
  return {
    index: Number(firstValue(step, ["index", "step", "order"]) || index + 1),
    label: String(firstValue(step, ["label", "name", "title"]) || `단계 ${index + 1}`),
    status: normalizeStatus(firstValue(step, ["status", "state"])),
  };
}

function normalizeRunDetail(payload, fallbackId) {
  const runPayload = firstValue(payload, ["run", "data.run"]) || payload || {};
  const summary = normalizeRunSummary({ ...runPayload, id: firstValue(runPayload, ["id", "runId"]) || fallbackId });

  const tasks = (firstArray(runPayload, ["tasks", "data.tasks"]) || []).map(normalizeTask);
  const logs = (firstArray(runPayload, ["logs", "events", "data.logs"]) || []).map(normalizeLog);
  const steps = (firstArray(runPayload, ["steps", "pipeline.steps"]) || []).map(normalizeStep);
  const step = Number(firstValue(runPayload, ["step", "currentStep", "pipeline.currentStep"]) || 1);

  const usage = normalizeUsageRow({
    runId: summary.id,
    provider: firstValue(runPayload, ["provider", "usage.provider"]) || "unknown",
    model: firstValue(runPayload, ["model", "usage.model"]) || "unknown",
    inputTokens: firstValue(runPayload, ["usage.inputTokens", "tokens.input", "inputTokens"]) || 0,
    outputTokens: firstValue(runPayload, ["usage.outputTokens", "tokens.output", "outputTokens"]) || 0,
    totalTokens: firstValue(runPayload, ["usage.totalTokens", "tokens.total", "totalTokens"]) || 0,
    costUsd: firstValue(runPayload, ["usage.costUsd", "cost.usd", "costUsd"]) || 0,
    ts: firstValue(runPayload, ["usage.ts", "ts", "timestamp"]) || Date.now(),
  });

  const detail = {
    ...summary,
    prompt: String(firstValue(runPayload, ["prompt", "input.prompt"]) || ""),
    sourceAction: String(firstValue(runPayload, ["sourceAction"]) || "home_input"),
    sourceType: String(firstValue(runPayload, ["sourceType"]) || "gateway"),
    createdAt: Number(firstValue(runPayload, ["createdAt", "created_at"]) || Date.now()),
    step: Number.isFinite(step) ? step : 1,
    steps,
    tasks,
    logs,
    usage,
  };
  const executionFeaturesLockedAt = firstValue(
    runPayload,
    ["executionFeaturesLockedAt", "execution_features_locked_at", "featureSnapshotLockedAt"]
  );
  if (executionFeaturesLockedAt !== undefined) {
    const lockedAt = Number(executionFeaturesLockedAt);
    detail.executionFeaturesLockedAt = Number.isFinite(lockedAt) ? lockedAt : null;
  }
  return detail;
}

function buildExecutionFeatureEnvelope(payload, requestedFeatures = []) {
  const executionFeatures = normalizeExecutionFeatures(
    firstValue(payload, ["executionFeatures", "execution_features", "featureSnapshot", "feature_snapshot"]) || requestedFeatures
  );
  const executionFeaturesStatus = normalizeExecutionFeaturesStatus(
    firstValue(payload, ["executionFeaturesStatus", "execution_features_status"]) || (executionFeatures.length > 0 ? "locked" : "none")
  );
  const executionFeaturesError = normalizeExecutionFeaturesError(
    firstValue(payload, ["executionFeaturesError", "execution_features_error"])
  );
  return {
    executionFeatures,
    executionFeaturesStatus,
    executionFeaturesError,
  };
}

function sameStringSet(left, right) {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  for (const item of right) {
    if (!seen.has(item)) return false;
  }
  return true;
}

function confirmExecutionFeatures(payload, requestedFeatures = []) {
  const envelope = buildExecutionFeatureEnvelope(payload, requestedFeatures);
  if (requestedFeatures.length === 0) {
    return {
      ok: true,
      ...envelope,
      executionFeaturesStatus: envelope.executionFeaturesError ? "failed" : "none",
    };
  }

  if (envelope.executionFeaturesError) {
    return {
      ok: false,
      code: envelope.executionFeaturesError.code || "feature_enforcement_failed",
      error: envelope.executionFeaturesError.message || "execution feature enforcement failed",
      ...envelope,
      executionFeaturesStatus: "failed",
    };
  }

  if (envelope.executionFeaturesStatus !== "enforced") {
    return {
      ok: false,
      code: "feature_confirmation_missing",
      error: "OpenClaw did not confirm execution feature enforcement",
      ...envelope,
      executionFeaturesStatus: "failed",
      executionFeaturesError: {
        code: "feature_confirmation_missing",
        message: "OpenClaw did not confirm execution feature enforcement",
        details: {
          requestedFeatures,
          receivedStatus: envelope.executionFeaturesStatus,
        },
      },
    };
  }

  if (!sameStringSet(envelope.executionFeatures, requestedFeatures)) {
    return {
      ok: false,
      code: "feature_state_mismatch",
      error: "OpenClaw confirmed a different execution feature set",
      ...envelope,
      executionFeaturesStatus: "failed",
      executionFeaturesError: {
        code: "feature_state_mismatch",
        message: "OpenClaw confirmed a different execution feature set",
        details: {
          requestedFeatures,
          confirmedFeatures: envelope.executionFeatures,
        },
      },
    };
  }

  return {
    ok: true,
    ...envelope,
  };
}

function shouldDowngradeToGeneralChat(result) {
  const code = String(result?.code || "").trim().toLowerCase();
  return (
    code === "feature_confirmation_missing" ||
    code === "feature_state_mismatch" ||
    code === "feature_disabled" ||
    code === "feature_unsupported" ||
    code === "contract_unavailable"
  );
}

function buildExecutionFeatureDowngradeReason(result, requestedFeatures = []) {
  const error = normalizeExecutionFeaturesError(result?.executionFeaturesError) || null;
  if (error) {
    return {
      ...error,
      details: {
        requestedFeatures,
        ...(error.details && typeof error.details === "object" ? error.details : {}),
      },
    };
  }
  return {
    code: String(result?.code || "feature_downgraded"),
    message: String(result?.error || "execution feature enforcement unavailable"),
    details: {
      requestedFeatures,
    },
  };
}

function buildGeneralChatDowngradeMessage(result) {
  const code = String(result?.code || "").trim().toLowerCase();
  if (code === "feature_state_mismatch") {
    return "실행 기능 상태가 일치하지 않아 일반 대화로 전환했어요";
  }
  if (code === "feature_disabled") {
    return "실행 기능이 비활성화되어 일반 대화로 전환했어요";
  }
  if (code === "feature_unsupported" || code === "contract_unavailable") {
    return "OpenClaw capability 계약을 확인할 수 없어 일반 대화로 전환했어요";
  }
  return "실행 기능 확인을 받지 못해 일반 대화로 전환했어요";
}

function makeInfoLog(message) {
  return {
    id: crypto.randomUUID(),
    ts: Date.now(),
    level: "info",
    message: String(message || ""),
  };
}

function resolveGatewaySession(runRecord, fallbackSessionKey) {
  const rawSessionKey = typeof runRecord?.sessionKey === "string" && runRecord.sessionKey.trim() ? runRecord.sessionKey.trim() : "";
  return {
    sessionKey: rawSessionKey || String(fallbackSessionKey || "agent:main:main"),
    sessionMode: normalizeRunSessionMode(runRecord?.sessionMode, Boolean(rawSessionKey)),
    hasSessionKey: Boolean(rawSessionKey),
  };
}

class OpenclawAdapter {
  constructor({ requestRaw, capabilities, store, usageLedger, allowLocalFallback = true, chatGateway = null }) {
    this.requestRaw = requestRaw;
    this.capabilities = capabilities;
    this.store = store;
    this.usageLedger = usageLedger;
    this.allowLocalFallback = allowLocalFallback;
    this.chatGateway = chatGateway;
    this.lastCapabilityProbe = 0;
  }

  async ensureCapabilities(force = false) {
    const now = Date.now();
    if (!force && now - this.lastCapabilityProbe < 30_000 && this.capabilities.lastProbeAt) return;
    try {
      await this.capabilities.probeAll({ requestRaw: this.requestRaw });
      this.lastCapabilityProbe = now;
    } catch {
      // ignore probe errors
    }
  }

  async createRun({ prompt, sourceAction, executionFeatures = [], sessionKey = "", originConversationId = "" }) {
    await this.ensureCapabilities();
    const normalizedExecutionFeatures = normalizeExecutionFeatures(executionFeatures);

    if (this.chatGateway && typeof this.chatGateway.send === "function") {
      const idempotencyKey = crypto.randomUUID();
      const nextSessionKey = String(sessionKey || "").trim() || createPerRunSessionKey();
      try {
        const sent = await this.chatGateway.send({
          sessionKey: nextSessionKey,
          message: prompt,
          idempotencyKey,
          deliver: false,
          executionFeatures: normalizedExecutionFeatures,
        });
        const confirmation = confirmExecutionFeatures(sent, normalizedExecutionFeatures);
        if (!confirmation.ok) {
          if (shouldDowngradeToGeneralChat(confirmation)) {
            const downgradedRunId = String(firstValue(sent, ["runId", "id"]) || idempotencyKey);
            const downgradeReason = buildExecutionFeatureDowngradeReason(confirmation, normalizedExecutionFeatures);
            const notice = buildGeneralChatDowngradeMessage(confirmation);
            const downgradedRun = this.store.upsertRun({
              id: downgradedRunId,
              title: String(prompt || "새 실행").slice(0, 72),
              prompt: String(prompt || ""),
              status: "running",
              sourceAction: String(sourceAction || "home_input"),
              sourceType: "gateway",
              sessionKey: nextSessionKey,
              sessionMode: RUN_SESSION_MODE_PER_RUN,
              originConversationId: String(originConversationId || "").trim(),
              createdAt: Date.now(),
              updatedAt: Date.now(),
              executionFeatures: [],
              executionFeaturesLockedAt: null,
              executionFeaturesStatus: "none",
              executionFeaturesError: null,
              executionFeaturesDowngradedAt: Date.now(),
              executionFeaturesDowngradeReason: downgradeReason,
              logs: [makeInfoLog(notice)],
            });
            return {
              ok: true,
              runId: downgradedRunId,
              status: "running",
              run: downgradedRun || null,
              sourceType: "gateway",
              localFallback: false,
              sessionMode: RUN_SESSION_MODE_PER_RUN,
              executionFeatures: [],
              executionFeaturesStatus: "none",
              executionFeaturesError: null,
              downgradedToGeneralChat: true,
            };
          }
          const failedRunId = String(firstValue(sent, ["runId", "id"]) || idempotencyKey);
          const failedRun = this.store.upsertRun({
            id: failedRunId,
            title: String(prompt || "새 실행").slice(0, 72),
            prompt: String(prompt || ""),
            status: "failed",
            sourceAction: String(sourceAction || "home_input"),
            sourceType: "gateway",
            sessionKey: nextSessionKey,
            sessionMode: RUN_SESSION_MODE_PER_RUN,
            originConversationId: String(originConversationId || "").trim(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            executionFeatures: confirmation.executionFeatures,
            executionFeaturesLockedAt: Date.now(),
            executionFeaturesStatus: confirmation.executionFeaturesStatus,
            executionFeaturesError: confirmation.executionFeaturesError,
          });
          return {
            ok: false,
            code: confirmation.code,
            error: confirmation.error,
            runId: failedRunId,
            run: failedRun || null,
            executionFeatures: confirmation.executionFeatures,
            executionFeaturesStatus: confirmation.executionFeaturesStatus,
            executionFeaturesError: confirmation.executionFeaturesError,
          };
        }
        const runId = String(firstValue(sent, ["runId", "id"]) || idempotencyKey);
        const run = this.store.upsertRun({
          id: runId,
          title: String(prompt || "새 실행").slice(0, 72),
          prompt: String(prompt || ""),
          status: "running",
          sourceAction: String(sourceAction || "home_input"),
          sourceType: "gateway",
          sessionKey: nextSessionKey,
          sessionMode: RUN_SESSION_MODE_PER_RUN,
          originConversationId: String(originConversationId || "").trim(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          executionFeatures: confirmation.executionFeatures,
          executionFeaturesLockedAt: Date.now(),
          executionFeaturesStatus: confirmation.executionFeaturesStatus,
          executionFeaturesError: confirmation.executionFeaturesError,
          executionFeaturesDowngradedAt: null,
          executionFeaturesDowngradeReason: null,
        });
        return {
          ok: true,
          runId,
          status: "running",
          run: run || null,
          sourceType: "gateway",
          localFallback: false,
          sessionMode: RUN_SESSION_MODE_PER_RUN,
          executionFeatures: confirmation.executionFeatures,
          executionFeaturesStatus: confirmation.executionFeaturesStatus,
          executionFeaturesError: confirmation.executionFeaturesError,
        };
      } catch (error) {
        return {
          ok: false,
          code: error?.code || "gateway_unavailable",
          error: error?.message || "failed to send chat request",
        };
      }
    }

    if (!this.allowLocalFallback) {
      return { ok: false, code: "feature_unavailable", error: "run create endpoint unavailable" };
    }

    const run = this.store.createRun({
      prompt,
      sourceAction,
      sourceType: "local",
      sessionKey,
      originConversationId,
      executionFeatures: normalizedExecutionFeatures,
      executionFeaturesLockedAt: Date.now(),
      executionFeaturesStatus: normalizedExecutionFeatures.length > 0 ? "locked" : "none",
    });
    return {
      ok: true,
      runId: run.id,
      status: run.status,
      run,
      localFallback: true,
    };
  }

  async sendMessage({ runId, prompt, sourceAction = "chat", disableLocalFallback = false, attachments = [] }) {
    await this.ensureCapabilities();
    const targetRunId = String(runId || "").trim();
    if (!targetRunId) {
      return { ok: false, code: "invalid_input", error: "runId is required" };
    }
    const existing = this.store.getRunRecord(targetRunId);
    if (!existing) {
      return { ok: false, code: "invalid_input", error: "run not found" };
    }
    if (!prompt || !String(prompt).trim()) {
      return { ok: false, code: "invalid_input", error: "prompt is required" };
    }

    const preferLocal = String(existing.sourceType || "").toLowerCase() === "local";
    const executionFeatures = normalizeExecutionFeatures(existing.executionFeatures);

    if (!preferLocal && this.chatGateway && typeof this.chatGateway.send === "function") {
      const idempotencyKey = crypto.randomUUID();
      const gatewaySession = resolveGatewaySession(existing, this.chatGateway.defaultSessionKey || "agent:main:main");
      try {
        const sent = await this.chatGateway.send({
          sessionKey: gatewaySession.sessionKey,
          message: String(prompt).trim(),
          idempotencyKey,
          deliver: false,
          attachments: Array.isArray(attachments) ? attachments : [],
          executionFeatures,
        });
        const confirmation = confirmExecutionFeatures(sent, executionFeatures);
        if (!confirmation.ok) {
          if (shouldDowngradeToGeneralChat(confirmation)) {
            const downgradeReason = buildExecutionFeatureDowngradeReason(confirmation, executionFeatures);
            const notice = buildGeneralChatDowngradeMessage(confirmation);
            const downgradedRun = this.store.patchRun(targetRunId, {
              status: "running",
              sourceAction: String(sourceAction || "chat"),
              sourceType: "gateway",
              sessionMode: gatewaySession.sessionMode,
              executionFeatures: [],
              executionFeaturesLockedAt: null,
              executionFeaturesStatus: "none",
              executionFeaturesError: null,
              executionFeaturesDowngradedAt: Date.now(),
              executionFeaturesDowngradeReason: downgradeReason,
              updatedAt: Date.now(),
            });
            const current = this.store.getRunRecord(targetRunId);
            const lastMessage = current?.logs?.[current.logs.length - 1]?.message || "";
            if (String(lastMessage).trim() !== notice) {
              this.store.appendRunLog(targetRunId, notice, "info");
            }
            const gatewayRunId = String(firstValue(sent, ["runId", "id"]) || "").trim();
            return {
              ok: true,
              runId: targetRunId,
              gatewayRunId: gatewayRunId || null,
              status: "running",
              sourceType: "gateway",
              localFallback: false,
              sessionMode: gatewaySession.sessionMode,
              hasSessionKey: gatewaySession.hasSessionKey,
              executionFeatures: [],
              executionFeaturesStatus: "none",
              executionFeaturesError: null,
              run: downgradedRun || this.store.getRun(targetRunId) || null,
              downgradedToGeneralChat: true,
            };
          }
          this.store.patchRun(targetRunId, {
            status: "failed",
            sourceAction: String(sourceAction || "chat"),
            sourceType: "gateway",
            sessionMode: gatewaySession.sessionMode,
            executionFeatures,
            executionFeaturesLockedAt: existing.executionFeaturesLockedAt || Date.now(),
            executionFeaturesStatus: confirmation.executionFeaturesStatus,
            executionFeaturesError: confirmation.executionFeaturesError,
            executionFeaturesDowngradedAt: null,
            executionFeaturesDowngradeReason: null,
            updatedAt: Date.now(),
          });
          return {
            ok: false,
            code: confirmation.code,
            error: confirmation.error,
            executionFeatures,
            executionFeaturesStatus: confirmation.executionFeaturesStatus,
            executionFeaturesError: confirmation.executionFeaturesError,
          };
        }
        const gatewayRunId = String(firstValue(sent, ["runId", "id"]) || "").trim();
        this.store.patchRun(targetRunId, {
          status: "running",
          sourceAction: String(sourceAction || "chat"),
          sourceType: "gateway",
          sessionMode: gatewaySession.sessionMode,
          executionFeatures: confirmation.executionFeatures,
          executionFeaturesLockedAt: confirmation.executionFeatures.length > 0 ? existing.executionFeaturesLockedAt || Date.now() : null,
          executionFeaturesStatus: confirmation.executionFeaturesStatus,
          executionFeaturesError: confirmation.executionFeaturesError,
          executionFeaturesDowngradedAt:
            confirmation.executionFeatures.length === 0 ? existing.executionFeaturesDowngradedAt || null : null,
          executionFeaturesDowngradeReason:
            confirmation.executionFeatures.length === 0 ? existing.executionFeaturesDowngradeReason || null : null,
          updatedAt: Date.now(),
        });
        return {
          ok: true,
          runId: targetRunId,
          gatewayRunId: gatewayRunId || null,
          status: "running",
          sourceType: "gateway",
          localFallback: false,
          sessionMode: gatewaySession.sessionMode,
          hasSessionKey: gatewaySession.hasSessionKey,
          executionFeatures: confirmation.executionFeatures,
          executionFeaturesStatus: confirmation.executionFeaturesStatus,
          executionFeaturesError: confirmation.executionFeaturesError,
        };
      } catch (error) {
        return {
          ok: false,
          code: error?.code || "gateway_unavailable",
          error: error?.message || "failed to send chat request",
        };
      }
    }

    const allowLocalFallback = this.allowLocalFallback && !Boolean(disableLocalFallback);

    if (!allowLocalFallback) {
      return { ok: false, code: "feature_unavailable", error: "chat send endpoint unavailable" };
    }

    this.store.patchRun(targetRunId, {
      status: "running",
      sourceAction: String(sourceAction || "chat"),
      sourceType: "local",
      executionFeatures,
      executionFeaturesLockedAt: existing.executionFeaturesLockedAt || Date.now(),
      executionFeaturesStatus: executionFeatures.length > 0 ? "locked" : "none",
      updatedAt: Date.now(),
    });
    return {
      ok: true,
      runId: targetRunId,
      gatewayRunId: null,
      status: "running",
      sourceType: "local",
      localFallback: true,
    };
  }

  async listRuns() {
    await this.ensureCapabilities();
    const cap = this.capabilities.get("runsList");

    if (cap) {
      try {
        const result = await this.requestRaw({ method: cap.method, path: cap.path, timeoutMs: 3000 });
        if (!result || Number(result.status) < 200 || Number(result.status) >= 300) {
          throw new Error("run list failed");
        }
        if (!result || typeof result.body !== "object" || result.body === null) {
          throw new Error("invalid runs list payload");
        }
        const items = firstArray(result.body, ["items", "runs", "data.items", "data.runs"]) || [];
        const normalized = items.map(normalizeRunSummary);
        for (const item of normalized) {
          const current = this.store.getRun(item.id);
          if (String(current?.sourceType || "").toLowerCase() === "local") continue;
          this.store.upsertRun({ ...item, sourceType: "gateway" });
        }
        return { ok: true, items: this.store.listRuns() };
      } catch {
        // fallback below
      }
    }

    if (!this.allowLocalFallback) {
      return { ok: false, code: "feature_unavailable", error: "run list endpoint unavailable" };
    }

    return { ok: true, items: this.store.listRuns(), localFallback: true };
  }

  async getRun(runId) {
    const local = this.store.getRun(runId);
    if (Boolean(local?.isDraft) && !local?.hasSubmittedPrompt) {
      return { ok: true, run: local, localFallback: true };
    }
    if (String(local?.sourceType || "").toLowerCase() === "local") {
      return { ok: true, run: local, localFallback: true };
    }

    await this.ensureCapabilities();
    const cap = this.capabilities.get("runDetail");

    if (cap) {
      try {
        const path = cap.path.replace(":id", encodeURIComponent(String(runId)));
        const result = await this.requestRaw({ method: cap.method, path, timeoutMs: 3000 });
        if (!result || Number(result.status) < 200 || Number(result.status) >= 300) {
          throw new Error("run detail failed");
        }
        if (!result || typeof result.body !== "object" || result.body === null) {
          throw new Error("invalid run detail payload");
        }
        const run = normalizeRunDetail(result.body, runId);
        const mergedRun = this.store.upsertRun(run);
        return { ok: true, run: mergedRun || this.store.getRun(runId) || run };
      } catch {
        // fallback below
      }
    }

    const run = this.store.getRun(runId);
    if (!run) {
      return { ok: false, code: "invalid_input", error: "run not found" };
    }
    return { ok: true, run, localFallback: true };
  }

  async listSkills() {
    await this.ensureCapabilities();
    const cap = this.capabilities.get("skillsList");

    if (cap) {
      try {
        const result = await this.requestRaw({ method: cap.method, path: cap.path, timeoutMs: 3000 });
        if (!result || Number(result.status) < 200 || Number(result.status) >= 300) {
          throw new Error("skills list failed");
        }
        if (!result || typeof result.body !== "object" || result.body === null) {
          throw new Error("invalid skills payload");
        }
        const rows = firstArray(result.body, ["items", "skills", "data.items", "data.skills"]) || [];
        const normalized = rows.map((item) => ({
          id: String(firstValue(item, ["id", "slug", "name"]) || crypto.randomUUID()),
          name: String(firstValue(item, ["name", "title"]) || "스킬"),
          description: String(firstValue(item, ["description", "summary"]) || ""),
          enabled: Boolean(firstValue(item, ["enabled", "installed", "active"])),
        }));
        this.store.setSkills(normalized);
        return { ok: true, items: this.store.listSkills() };
      } catch {
        // fallback below
      }
    }

    if (!this.allowLocalFallback) {
      return { ok: false, code: "feature_unavailable", error: "skills endpoint unavailable" };
    }

    return { ok: true, items: this.store.listSkills(), localFallback: true };
  }

  async toggleSkill(skillId, enabled, { disableLocalFallback = false } = {}) {
    await this.ensureCapabilities();
    const cap = this.capabilities.get("skillsToggle");
    const allowLocalFallback = this.allowLocalFallback && !Boolean(disableLocalFallback);

    if (cap) {
      try {
        const path = cap.path.replace(":id", encodeURIComponent(String(skillId)));
        const result = await this.requestRaw({
          method: cap.method,
          path,
          body: { enabled: Boolean(enabled) },
          timeoutMs: 3000,
        });
        if (!result || Number(result.status) < 200 || Number(result.status) >= 300) {
          throw new Error("skill toggle failed");
        }
      } catch {
        if (!allowLocalFallback) {
          return { ok: false, code: "feature_unavailable", error: "skill toggle endpoint unavailable" };
        }
      }
    }

    if (!cap && !allowLocalFallback) {
      return { ok: false, code: "feature_unavailable", error: "skill toggle endpoint unavailable" };
    }

    const item = this.store.toggleSkill(skillId, enabled);
    return { ok: true, item, localFallback: !cap };
  }

  appendUsage(row) {
    return this.usageLedger.append(row);
  }

  queryUsage(filters) {
    return this.usageLedger.query(filters);
  }
}

module.exports = {
  OpenclawAdapter,
};
