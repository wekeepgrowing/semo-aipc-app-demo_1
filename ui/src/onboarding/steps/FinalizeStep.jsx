import { CircleCheck, Sparkles, ArrowRight } from "lucide-react";

export default function FinalizeStep({
  providerLabel,
  methodLabel,
  interactiveRequired,
  interactiveDone,
  isFinalizing = false,
  finalizeError = "",
  onFinalize,
  onRetry,
  children,
}) {
  if (interactiveRequired && !interactiveDone) {
    return (
      <div className="ov0-step">
        <div className="ov0-head">
          <h2>인증을 완료해 주세요</h2>
          <p>이 단계가 끝나면 최종 설정을 마무리할 수 있어요</p>
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="ov0-step">
      <div className="ov0-head">
        <h2>설정이 거의 끝났어요!</h2>
        <p>아래 내용을 확인하고 문제가 없다면 완료해 주세요</p>
      </div>

      <div className="ov0-summary">
        <div className="ov0-summary-row">
          <span>AI 서비스</span>
          <strong>{providerLabel}</strong>
        </div>
        <div className="ov0-divider" />
        <div className="ov0-summary-row">
          <span>연결 방식</span>
          <strong>{methodLabel}</strong>
        </div>
        <div className="ov0-divider" />
        <div className="ov0-summary-row">
          <span>연결 상태</span>
          <strong className="ok">
            <CircleCheck size={14} />정상
          </strong>
        </div>
      </div>

      <button type="button" className="ov0-btn primary wide" onClick={onFinalize} disabled={isFinalizing}>
        <Sparkles size={14} />
        {isFinalizing ? "게이트웨이 준비 확인 중" : "설정 완료하기"}
        <ArrowRight size={14} />
      </button>
      {finalizeError ? (
        <div className="ov0-inline-actions">
          <p className="error-text">{finalizeError}</p>
          {onRetry ? (
            <button type="button" className="ov0-btn ghost" onClick={onRetry}>
              다시 시도
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
