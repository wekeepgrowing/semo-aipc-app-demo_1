import { ExternalLink, LoaderCircle } from "lucide-react";
import AnimatedCheck from "./AnimatedCheck";

function isSetupToken(method) {
  return String(method?.id || "").toLowerCase().includes("token");
}

export default function ConnectStep({ method, providerLabel, status, error, onConnect }) {
  const interactive = method?.mode === "interactive_required";
  const oauthLike = interactive && !isSetupToken(method);

  return (
    <div className="ov0-step ov0-step-connect">
      <div className="ov0-head">
        <h2>{interactive ? (oauthLike ? "계정을 연결해 주세요" : "설정 토큰을 확인하고 있어요") : "연결을 확인하고 있어요"}</h2>
        <p>
          {interactive
            ? oauthLike
              ? `${providerLabel} 로그인 화면으로 이동합니다. 로그인 후 자동으로 돌아옵니다.`
              : `${providerLabel} 관리 콘솔에서 발급된 토큰으로 연결합니다.`
            : `입력한 키로 ${providerLabel}에 접속을 확인합니다.`}
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
            <p className="ov0-sub">연결을 확인하고 있어요...</p>
          </>
        ) : null}

        {status === "connected" ? (
          <>
            <AnimatedCheck />
            <p className="ov0-sub">{interactive ? (oauthLike ? "연결 준비가 완료되었어요." : "토큰 확인이 완료되었어요.") : "연결에 성공했어요!"}</p>
          </>
        ) : null}
      </div>

      {error ? <p className="error-text">{error}</p> : null}
    </div>
  );
}
