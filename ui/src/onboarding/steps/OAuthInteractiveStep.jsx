import { Copy, ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchApiJson } from "../../lib/http";

const POLL_INTERVAL_MS = 700;
const FINAL_STATES = new Set(["configured", "failed", "cancelled", "timeout"]);
const FAILURE_STATES = new Set(["failed", "cancelled", "timeout"]);

const STATE_LABELS = {
  starting: "인증 세션 준비 중",
  auth_url_ready: "브라우저 로그인 대기",
  awaiting_redirect_input: "리디렉트 URL 입력 필요",
  auth_completed: "인증 완료",
  finalizing: "설정 마무리 중",
  configured: "설정 완료",
  failed: "인증 실패",
  cancelled: "인증 취소",
  timeout: "시간 초과",
};

function toHttpUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

function formatFailureMessage(status) {
  if (!status) return "인증 세션이 종료됐어요";
  const code = status.lastErrorCode || (status.state === "timeout" ? "timeout" : "cli_failed");
  const message = status.lastMessage || "인증 세션이 종료됐어요";
  return `[${code}] ${message}`;
}

function normalizeInteractiveError(error, fallbackMessage) {
  const code = typeof error?.code === "string" ? error.code : "gateway_unavailable";
  const message = typeof error?.message === "string" ? error.message : "";
  if (
    (code === "invalid_input" && /interactive session not found/i.test(message)) ||
    (code === "gateway_unavailable" && /interactive session is no longer active/i.test(message))
  ) {
    return {
      code: "interactive_session_expired",
      message: "[interactive_session_expired] 인증 세션이 만료돼서 다시 연결해 주세요",
    };
  }
  return {
    code,
    message: message || fallbackMessage,
  };
}

function shouldTreatConfiguredStatusAsSuccess(status) {
  if (!status || !status.configured) return false;
  if (status.requiresRedirectInput) return false;
  return status.state === "finalizing" || status.state === "auth_completed" || status.state === "configured";
}

export default function OAuthInteractiveStep({
  title,
  subtitle,
  sessionId,
  onExit,
  onCancel,
  showCancel = true,
  headLabel,
  phaseLabel = "인증 상태",
  stepLabel = "진행",
}) {
  const [status, setStatus] = useState(null);
  const [redirectUrl, setRedirectUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [inputError, setInputError] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const doneRef = useRef(false);
  const copyTimerRef = useRef(null);
  const lastStatusRef = useRef(null);

  const stateText = useMemo(() => STATE_LABELS[status?.state] || status?.state || "상태 확인 중", [status?.state]);

  useEffect(() => {
    lastStatusRef.current = status;
  }, [status]);

  useEffect(() => {
    if (!sessionId) return undefined;
    doneRef.current = false;
    lastStatusRef.current = null;

    let cancelled = false;
    let timer = null;

    const checkGlobalConfiguredState = async () => {
      try {
        const onboarding = await fetchApiJson("/api/ui/onboarding/state");
        return Boolean(onboarding?.configured && !onboarding?.interactiveAuthInProgress);
      } catch {
        return false;
      }
    };

    const poll = async () => {
      if (cancelled || doneRef.current) return;
      try {
        const json = await fetchApiJson(`/api/ui/onboarding/auth/${sessionId}/status`);
        if (cancelled || doneRef.current) return;
        const nextAuthUrl = toHttpUrl(json.authUrl);
        const nextStatus = nextAuthUrl === json.authUrl ? json : { ...json, authUrl: nextAuthUrl };
        setStatus(nextStatus);
        lastStatusRef.current = nextStatus;

        if (nextStatus.state === "configured") {
          doneRef.current = true;
          onExit?.({ ok: true });
          return;
        }

        if (shouldTreatConfiguredStatusAsSuccess(nextStatus)) {
          doneRef.current = true;
          onExit?.({ ok: true });
          return;
        }

        if (FAILURE_STATES.has(nextStatus.state)) {
          doneRef.current = true;
          onExit?.({
            ok: false,
            code: nextStatus.lastErrorCode || (nextStatus.state === "timeout" ? "timeout" : "cli_failed"),
            message: formatFailureMessage(nextStatus),
          });
          return;
        }

        if (!FINAL_STATES.has(nextStatus.state)) {
          timer = window.setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (error) {
        if (cancelled || doneRef.current) return;
        const normalized = normalizeInteractiveError(error, "인증 상태 조회에 실패했어요");
        const lastKnownStatus = lastStatusRef.current;
        const canRecoverFromConfiguredState =
          normalized.code === "interactive_session_expired" ||
          lastKnownStatus?.state === "finalizing" ||
          lastKnownStatus?.state === "auth_completed";

        if (canRecoverFromConfiguredState) {
          const configured = await checkGlobalConfiguredState();
          if (!cancelled && configured) {
            doneRef.current = true;
            onExit?.({ ok: true });
            return;
          }
        }

        doneRef.current = true;
        onExit?.({
          ok: false,
          code: normalized.code,
          message: normalized.message,
        });
      }
    };

    poll();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [onExit, sessionId]);

  useEffect(
    () => () => {
      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    []
  );

  const handleOpenAuth = () => {
    const authUrl = toHttpUrl(status?.authUrl);
    if (!authUrl) return;
    window.open(authUrl, "_blank", "noopener,noreferrer");
  };

  const handleSubmitRedirect = async () => {
    const value = redirectUrl.trim();
    if (!value) {
      setInputError("리디렉트 URL을 입력해 주세요");
      return;
    }

    try {
      setSubmitting(true);
      setInputError("");
      await fetchApiJson(`/api/ui/onboarding/auth/${sessionId}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: value }),
      });
      setRedirectUrl("");
    } catch (error) {
      const normalized = normalizeInteractiveError(error, "리디렉트 URL 전달에 실패했어요");
      setInputError(normalized.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyAuthUrl = async () => {
    const authUrl = toHttpUrl(status?.authUrl);
    if (!authUrl) return;
    try {
      await navigator.clipboard.writeText(authUrl);
      setCopyMessage("복사됐어요");
    } catch {
      setCopyMessage("복사에 실패했어요");
    }
    if (copyTimerRef.current) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => setCopyMessage(""), 1800);
  };

  const handleCancel = async () => {
    try {
      await fetchApiJson(`/api/ui/onboarding/auth/${sessionId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
    } catch {
      // ignore cancellation errors
    }
    onCancel?.();
  };

  const authUrl = toHttpUrl(status?.authUrl);

  return (
    <div className="ov0-step">
      <div className="ov0-head">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>

      <div className="ov0-auth-panel">
        <div className="ov0-auth-top">
          <strong>{headLabel || "브라우저 인증"}</strong>
          {status?.state !== "configured" ? <Loader2 size={16} className="ov0-spin" /> : null}
        </div>

        <p className="ov0-auth-desc">
          {authUrl
            ? "인증 링크가 준비됐으니 버튼을 눌러 로그인해 주세요"
            : "인증 링크를 준비하고 있으니 잠시만 기다려 주세요"}
        </p>

        {authUrl ? (
          <div className="ov0-auth-actions">
            <button type="button" className="ov0-btn primary flat" onClick={handleOpenAuth}>
              <ExternalLink size={16} />
              인증 페이지 열기
            </button>
            <div className="ov0-auth-copy-wrap">
              <button type="button" className="ov0-auth-copy-btn" onClick={handleCopyAuthUrl} aria-label="인증 URL 복사">
                <Copy size={16} />
              </button>
              {copyMessage ? (
                <span className="ov0-auth-copy-state" role="status" aria-live="polite">
                  {copyMessage}
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        {status?.requiresRedirectInput ? (
          <div className="ov0-auth-input-block">
            <label htmlFor="oauth-redirect-url">리디렉트 URL 입력</label>
            <div className="ov0-auth-input-row">
              <input
                id="oauth-redirect-url"
                type="url"
                value={redirectUrl}
                onChange={(event) => setRedirectUrl(event.target.value)}
                placeholder="https://...redirect..."
              />
              <button type="button" className="ov0-btn primary flat" onClick={handleSubmitRedirect} disabled={submitting}>
                {submitting ? "전송 중" : "전송"}
              </button>
            </div>
            <p className="ov0-auth-help">로그인 완료 후 브라우저 주소창의 URL을 붙여넣어 주세요</p>
          </div>
        ) : null}
      </div>

      <p className="status-text ov0-status">
        {stepLabel}: <strong>{stateText}</strong>
        {status?.lastMessage ? ` · ${phaseLabel}: ${status.lastMessage}` : ""}
      </p>

      {inputError ? <p className="error-text">{inputError}</p> : null}

      {showCancel ? (
        <div className="ov0-inline-actions">
          <button type="button" className="ov0-btn ghost danger" onClick={handleCancel}>
            인증 취소
          </button>
        </div>
      ) : null}
    </div>
  );
}
