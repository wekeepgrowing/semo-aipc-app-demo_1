import { ExternalLink, LoaderCircle } from "lucide-react";
import AnimatedCheck from "./AnimatedCheck";

function isSetupToken(method) {
  return String(method?.id || "").toLowerCase().includes("token");
}

export default function ConnectStep({
  method,
  providerLabel,
  status,
  error,
  onConnect,
  children = null,
  validationWarning = null,
  onRetryInput = null,
  onProceedAnyway = null,
}) {
  const interactive = method?.mode === "interactive_required";
  const oauthLike = interactive && !isSetupToken(method);
  const hasInteractivePanel = Boolean(children);

  return (
    <div className="ov0-step ov0-step-connect">
      <div className="ov0-head">
        <h2>{interactive ? (oauthLike ? "계정을 연결해 주세요" : "설정 토큰을 확인하고 있어요") : "연결을 확인하고 있어요"}</h2>
        <p>
          {interactive
            ? oauthLike
              ? `${providerLabel} 로그인 뒤에 자동으로 돌아와요`
              : `${providerLabel} 관리 콘솔에서 발급된 토큰으로 연결해요`
            : `입력한 키로 ${providerLabel} 연결을 확인해요`}
        </p>
      </div>

      <div className="ov0-connect-box">
        {status === "idle" ? (
          <button type="button" className="ov0-btn primary flat" onClick={onConnect}>
            {interactive ? (oauthLike ? <><ExternalLink size={16} />{providerLabel} 로그인</> : "토큰 확인하기") : "연결 확인하기"}
          </button>
        ) : null}

        {status === "connecting" ? (
          <>
            <LoaderCircle className="ov0-spin" size={30} />
            <p className="ov0-sub">연결을 확인하고 있어요</p>
          </>
        ) : null}

        {status === "interactive_pending" && !hasInteractivePanel ? (
          <>
            <LoaderCircle className="ov0-spin" size={30} />
            <p className="ov0-sub">인증 세션이 시작됐으니 아래에서 계정 연결을 완료해 주세요</p>
          </>
        ) : null}

        {status === "connected" ? (
          <>
            <AnimatedCheck />
            <p className="ov0-sub">{interactive ? (oauthLike ? "연결할 준비를 마쳤어요" : "토큰 확인을 마쳤어요") : "연결에 성공했어요"}</p>
          </>
        ) : null}
      </div>

      {validationWarning && !interactive ? (
        <div className="ov0-soft-warn">
          <p>
            [{validationWarning.code}] {validationWarning.message}
          </p>
          <div className="ov0-soft-warn-actions">
            <button type="button" className="ov0-btn ghost" onClick={onRetryInput}>
              다시 입력
            </button>
            <button type="button" className="ov0-btn primary flat" onClick={onProceedAnyway}>
              그래도 진행
            </button>
          </div>
        </div>
      ) : null}

      {error ? <p className="error-text">{error}</p> : null}

      {status === "interactive_pending" && hasInteractivePanel ? <div>{children}</div> : null}
    </div>
  );
}
