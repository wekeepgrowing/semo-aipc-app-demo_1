import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronRight,
  Circle,
  Copy,
  Download,
  FileText,
  Loader2,
  MessageSquareText,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { buildReportMarkdown } from "../lib/webResearchRunUtils";

function formatTime(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value)) return "-";
  return new Date(value).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function normalizeInlineText(value, fallback = "-") {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
}

function truncateText(value, maxLength = 160) {
  const text = normalizeInlineText(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

function normalizeMultilineText(value, fallback = "") {
  const text = String(value || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  return text || fallback;
}

function getRoleMeta(role) {
  if (role === "Human") {
    return {
      label: "Human",
      icon: UserRound,
      tone: "human",
    };
  }

  if (role === "Review Needed") {
    return {
      label: "Review",
      icon: TriangleAlert,
      tone: "review",
    };
  }

  return {
    label: "AI",
    icon: Bot,
    tone: "ai",
  };
}

function getPhaseState({ phase, task, run, reviewTask }) {
  const status = String(task?.status || "pending");
  const isReviewStep = Boolean(reviewTask?.id) && reviewTask.id === task?.id;

  if (status === "completed") {
    return {
      key: "done",
      label: "완료",
      detailLabel: "작업이 완료됐어요",
      description: truncateText(task?.text || phase?.title || "단계를 완료했어요"),
    };
  }

  if (isReviewStep || task?.role === "Review Needed" || status === "paused") {
    return {
      key: "review",
      label: "검토",
      detailLabel: "승인 대기",
      description: "검토를 마치면 최종 결과를 확정해요",
    };
  }

  if (status === "running" || (Number(run?.step) === Number(phase?.index) && String(run?.status || "") === "running")) {
    return {
      key: "running",
      label: "진행중",
      detailLabel: "실행 중",
      description: truncateText(task?.text || phase?.title || "작업을 진행하고 있어요"),
    };
  }

  return {
    key: "pending",
    label: "대기",
    detailLabel: "대기 중",
    description: truncateText(task?.text || phase?.title || "이전 단계를 기다리고 있어요"),
  };
}

function buildTranscriptLog(entry) {
  const roleLabel =
    entry?.role === "human" ? "Human" : entry?.role === "system" ? "System" : "OpenClaw";
  const kindLabel =
    entry?.kind === "input"
      ? "입력"
      : entry?.kind === "task_prompt"
        ? "작업 지시"
        : entry?.kind === "task_response"
          ? "응답"
          : "이벤트";

  return `${roleLabel} ${kindLabel}: ${truncateText(entry?.text || "-", 180)}`;
}

function StepStatusBadge({ state }) {
  return <span className={`dash-run-monitor-status dash-run-monitor-status-${state.key}`}>{state.label}</span>;
}

function StepIcon({ stateKey }) {
  if (stateKey === "done") {
    return (
      <div className="dash-run-monitor-icon done">
        <Check size={16} strokeWidth={2.6} />
      </div>
    );
  }

  if (stateKey === "running") {
    return (
      <div className="dash-run-monitor-icon running">
        <Loader2 size={16} className="dash-spin" />
      </div>
    );
  }

  if (stateKey === "review") {
    return (
      <div className="dash-run-monitor-icon review">
        <TriangleAlert size={16} />
      </div>
    );
  }

  return (
    <div className="dash-run-monitor-icon pending">
      <Circle size={10} className="dash-run-monitor-icon-dot" />
    </div>
  );
}

function AnimatedDetail({ isVisible, children }) {
  const [shouldRender, setShouldRender] = useState(isVisible);
  const [isAnimating, setIsAnimating] = useState(false);
  const timeoutRef = useRef(null);

  useEffect(() => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);

    if (isVisible) {
      setShouldRender(true);
      timeoutRef.current = window.setTimeout(() => setIsAnimating(true), 20);
    } else {
      setIsAnimating(false);
      timeoutRef.current = window.setTimeout(() => setShouldRender(false), 260);
    }

    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, [isVisible]);

  if (!shouldRender) return null;

  return (
    <div
      className={`dash-run-monitor-detail ${isAnimating ? "is-visible" : "is-hidden"}`}
      aria-hidden={!isAnimating && !isVisible}
    >
      {children}
    </div>
  );
}

function AnimatedResultButton({ isVisible, onClick }) {
  const [shouldRender, setShouldRender] = useState(isVisible);
  const [isAnimating, setIsAnimating] = useState(false);
  const timeoutRef = useRef(null);

  useEffect(() => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);

    if (isVisible) {
      setShouldRender(true);
      timeoutRef.current = window.setTimeout(() => setIsAnimating(true), 20);
    } else {
      setIsAnimating(false);
      timeoutRef.current = window.setTimeout(() => setShouldRender(false), 260);
    }

    return () => {
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    };
  }, [isVisible]);

  if (!shouldRender) return null;

  return (
    <div className={`dash-run-monitor-result-cta ${isAnimating ? "is-visible" : "is-hidden"}`}>
      <button type="button" className="dash-run-monitor-primary-btn" onClick={onClick}>
        <FileText size={14} />
        <span>결과 확인</span>
        <ChevronRight size={14} />
      </button>
    </div>
  );
}

function MarkdownViewerModal({
  content,
  fileName,
  onClose,
  onCopy,
  onDownload,
  onOpenInChat,
  copyState,
  openInChatPending,
}) {
  const [activeTab, setActiveTab] = useState("preview");
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const backdropRef = useRef(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setIsVisible(true), 10);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const handleKey = (event) => {
      if (event.key === "Escape") handleClose();
    };

    document.addEventListener("keydown", handleKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.body.style.overflow = "";
    };
  }, []);

  const handleClose = () => {
    setIsClosing(true);
    setIsVisible(false);
    window.setTimeout(onClose, 220);
  };

  const lineCount = content.split("\n").length;
  const charCount = content.length;

  return (
    <div
      ref={backdropRef}
      className={`dash-run-md-modal-backdrop ${isVisible && !isClosing ? "is-visible" : ""}`}
      onClick={(event) => {
        if (event.target === backdropRef.current) handleClose();
      }}
    >
      <div className={`dash-run-md-modal ${isVisible && !isClosing ? "is-visible" : ""}`}>
        <div className="dash-run-md-modal-head">
          <div className="dash-run-md-modal-file">
            <div className="dash-run-md-modal-dots">
              <span />
              <span />
              <span />
            </div>
            <div className="dash-run-md-modal-file-name">
              <FileText size={14} />
              <span>{fileName}</span>
            </div>
          </div>

          <div className="dash-run-md-modal-head-actions">
            <div className="dash-run-md-modal-tabs" role="tablist" aria-label="Result preview tabs">
              <button
                type="button"
                className={activeTab === "preview" ? "active" : ""}
                onClick={() => setActiveTab("preview")}
              >
                Preview
              </button>
              <button
                type="button"
                className={activeTab === "raw" ? "active" : ""}
                onClick={() => setActiveTab("raw")}
              >
                Raw
              </button>
            </div>

            <button type="button" className="dash-run-md-modal-icon-btn" onClick={onCopy} title="복사">
              {copyState === "done" ? <Check size={15} /> : <Copy size={15} />}
            </button>
            <button type="button" className="dash-run-md-modal-icon-btn" onClick={onDownload} title="다운로드">
              <Download size={15} />
            </button>
            <button type="button" className="dash-run-md-modal-icon-btn" onClick={handleClose} title="닫기">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="dash-run-md-modal-body">
          {activeTab === "preview" ? (
            <div className="dash-run-md-preview">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          ) : (
            <pre className="dash-run-md-raw">{content}</pre>
          )}
        </div>

        <div className="dash-run-md-modal-foot">
          <div className="dash-run-md-modal-stats">
            <span>{lineCount} lines</span>
            <span>|</span>
            <span>{charCount.toLocaleString()} chars</span>
          </div>

          <div className="dash-run-md-modal-foot-actions">
            {typeof onOpenInChat === "function" ? (
              <button
                type="button"
                className="dash-run-monitor-secondary-btn"
                onClick={onOpenInChat}
                disabled={openInChatPending}
              >
                <MessageSquareText size={14} />
                <span>{openInChatPending ? "여는 중" : "대화 탭에서 열기"}</span>
              </button>
            ) : null}
            <button type="button" className="dash-run-monitor-primary-btn subtle" onClick={onDownload}>
              <Download size={14} />
              <span>.md 다운로드</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function WebResearchRunView({
  run,
  logs = [],
  reviewTask = null,
  onApprove,
  onRequestChanges,
  onOpenInChat,
  approvePending = false,
  requestChangesPending = false,
  openInChatPending = false,
}) {
  const phases = Array.isArray(run?.wbs?.phases) ? run.wbs.phases : [];
  const [copyState, setCopyState] = useState("idle");
  const [showResult, setShowResult] = useState(false);

  const executionRows = useMemo(() => {
    const logRows = (Array.isArray(logs) ? logs : []).map((log, index) => ({
      id: log?.id || `log-${index}-${log?.ts || 0}`,
      ts: Number(log?.ts || 0),
      text: truncateText(log?.message || "-", 220),
      tone: "event",
      taskId: null,
      phaseId: null,
    }));
    const transcriptRows = (Array.isArray(run?.executionTranscript) ? run.executionTranscript : []).map((entry, index) => ({
      id: entry?.id || `transcript-${index}-${entry?.ts || 0}`,
      ts: Number(entry?.ts || 0),
      text: buildTranscriptLog(entry),
      tone: entry?.role === "system" ? "system" : entry?.role === "human" ? "human" : "ai",
      taskId: entry?.taskId || null,
      phaseId: entry?.phaseId || null,
    }));

    return [...logRows, ...transcriptRows]
      .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
      .slice(-48);
  }, [logs, run?.executionTranscript]);

  const report = run?.artifacts?.report && typeof run.artifacts.report === "object" ? run.artifacts.report : null;
  const latestSectionText = useMemo(() => {
    const sections = Array.isArray(run?.artifacts?.sections) ? run.artifacts.sections : [];
    const latestSection = sections.length > 0 ? sections[sections.length - 1] : null;
    return normalizeMultilineText(latestSection?.content?.responseText || "");
  }, [run?.artifacts?.sections]);
  const reportTitle = normalizeInlineText(report?.title || run?.title || "웹 리서치 결과");
  const markdownTitle = `${reportTitle}.md`;
  const resultPhaseId = reviewTask?.phaseId || phases[phases.length - 1]?.id || "";
  const isApprovedResult = report?.status === "approved" || run?.status === "completed";
  const resultMarkdown = useMemo(() => {
    if (!isApprovedResult) return "";
    if (report?.documentMarkdown) return report.documentMarkdown;
    if (report) return buildReportMarkdown(report, reportTitle);
    return latestSectionText;
  }, [isApprovedResult, latestSectionText, report, reportTitle]);
  const hasApprovedResult = Boolean(resultMarkdown);
  const completedCount = useMemo(
    () =>
      phases.reduce((count, phase) => {
        const task = Array.isArray(phase?.tasks) && phase.tasks.length > 0 ? phase.tasks[0] : null;
        const state = getPhaseState({ phase, task, run, reviewTask });
        return state.key === "done" ? count + 1 : count;
      }, 0),
    [phases, reviewTask, run],
  );
  const progressPercent = phases.length > 0 ? (completedCount / phases.length) * 100 : 0;
  const latestExecutionRow = executionRows.length > 0 ? executionRows[executionRows.length - 1] : null;

  const handleCopyResult = async () => {
    if (!resultMarkdown) return;
    try {
      await navigator.clipboard.writeText(resultMarkdown);
      setCopyState("done");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  };

  const handleDownloadResult = () => {
    if (!resultMarkdown) return;
    const blob = new Blob([resultMarkdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = markdownTitle;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const handleOpenInChat = async () => {
    if (typeof onOpenInChat !== "function" || !hasApprovedResult) return;
    await onOpenInChat({
      title: reportTitle,
      markdown: resultMarkdown,
    });
  };

  return (
    <section className="dash-run-detail-panel dash-run-workflow-shell">
      <div className="dash-run-monitor">
        <header className="dash-run-monitor-head">
          <div className="dash-run-monitor-eyebrow">
            <div />
            <span>Process Monitor</span>
            <div />
          </div>
          <h1>웹 리서치 실행 현황</h1>
          <p>{normalizeInlineText(run?.title || run?.normalizedInput?.topic || "현재 실행 중인 리서치 런")}</p>
        </header>

        <div className="dash-run-monitor-progress">
          <div className="dash-run-monitor-progress-row">
            <span>Progress</span>
            <strong>
              {completedCount}/{phases.length || 0}
            </strong>
          </div>
          <div className="dash-run-monitor-progress-track">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
          {latestExecutionRow && !hasApprovedResult ? (
            <div className="dash-run-monitor-log-peek">
              <span>[{formatTime(latestExecutionRow.ts)}]</span>
              <p>{normalizeInlineText(latestExecutionRow.text)}</p>
            </div>
          ) : null}
        </div>

        <div className="dash-run-monitor-steps">
          {phases.map((phase, index) => {
            const task = Array.isArray(phase?.tasks) && phase.tasks.length > 0 ? phase.tasks[0] : null;
            const phaseState = getPhaseState({ phase, task, run, reviewTask });
            const roleMeta = getRoleMeta(task?.role);
            const RoleIcon = roleMeta.icon;
            const isLast = index === phases.length - 1;
            const phaseRows = executionRows
              .filter((row) => row.phaseId === phase.id || row.taskId === task?.id)
              .slice(-4);
            const detailRows =
              phaseRows.length > 0
                ? phaseRows
                : phaseState.key === "running" || phaseState.key === "review"
                  ? executionRows.slice(-4)
                  : [];
            const showDetail = phaseState.key === "running" || phaseState.key === "review";
            const showResultButton = hasApprovedResult && phase.id === resultPhaseId;

            return (
              <div key={phase.id || phase.index || index} className="dash-run-monitor-step">
                {!isLast ? <div className={`dash-run-monitor-connector ${phaseState.key === "done" ? "done" : ""}`} /> : null}

                <div className="dash-run-monitor-step-icon">
                  <StepIcon stateKey={phaseState.key} />
                </div>

                <div className={`dash-run-monitor-step-body ${isLast ? "is-last" : ""}`}>
                  <div className="dash-run-monitor-step-top">
                    <div className="dash-run-monitor-step-meta">
                      <span>Step {index + 1}</span>
                      <StepStatusBadge state={phaseState} />
                      <span className={`dash-run-monitor-role dash-run-monitor-role-${roleMeta.tone}`}>
                        <RoleIcon size={12} />
                        <span>{roleMeta.label}</span>
                      </span>
                    </div>
                  </div>

                  <h3>{phase.title || `단계 ${index + 1}`}</h3>
                  <p className="dash-run-monitor-step-description">{phaseState.description}</p>

                  <AnimatedDetail isVisible={showDetail}>
                    {phaseState.key === "review" ? (
                      <div className="dash-run-monitor-review-box">
                        <p>{phaseState.description}</p>
                        <div className="dash-run-monitor-review-actions">
                          {typeof onRequestChanges === "function" ? (
                            <button
                              type="button"
                              className="dash-run-monitor-secondary-btn"
                              onClick={onRequestChanges}
                              disabled={requestChangesPending}
                            >
                              {requestChangesPending ? "요청 중" : "수정 요청"}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            className="dash-run-monitor-primary-btn"
                            onClick={onApprove}
                            disabled={approvePending}
                          >
                            {approvePending ? "승인 중" : "승인 및 계속"}
                          </button>
                        </div>
                        {detailRows.length > 0 ? (
                          <div className="dash-run-monitor-detail-log">
                            {detailRows.map((row) => (
                              <p key={row.id}>
                                <span>[{formatTime(row.ts)}]</span> {normalizeInlineText(row.text)}
                              </p>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <div className="dash-run-monitor-detail-log">
                        {detailRows.length > 0 ? (
                          detailRows.map((row) => (
                            <p key={row.id}>
                              <span>[{formatTime(row.ts)}]</span> {normalizeInlineText(row.text)}
                            </p>
                          ))
                        ) : (
                          <p>{phaseState.description}</p>
                        )}
                      </div>
                    )}
                  </AnimatedDetail>

                  <AnimatedResultButton isVisible={showResultButton} onClick={() => setShowResult(true)} />
                </div>
              </div>
            );
          })}

          {phases.length === 0 ? <p className="dash-run-monitor-empty">단계 정보를 불러오는 중이에요</p> : null}
        </div>
      </div>

      {showResult && hasApprovedResult ? (
        <MarkdownViewerModal
          content={resultMarkdown}
          fileName={markdownTitle}
          onClose={() => setShowResult(false)}
          onCopy={handleCopyResult}
          onDownload={handleDownloadResult}
          onOpenInChat={handleOpenInChat}
          copyState={copyState}
          openInChatPending={openInChatPending}
        />
      ) : null}
    </section>
  );
}
