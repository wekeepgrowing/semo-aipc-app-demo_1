import { useMemo, useState } from "react";
import { Bot, CheckCircle2, CircleDashed, LoaderCircle, TriangleAlert, UserRound } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { buildReportMarkdown, buildReportShareText } from "../lib/webResearchRunUtils";

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
      label: "인간",
      icon: UserRound,
      tone: "human",
    };
  }

  if (role === "Review Needed") {
    return {
      label: "검토 필요",
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
      key: "completed",
      label: "완료",
      icon: CheckCircle2,
      description: truncateText(task?.text || "단계가 완료됐어요"),
    };
  }

  if (isReviewStep || task?.role === "Review Needed" || status === "paused") {
    return {
      key: "review",
      label: "검토 필요",
      icon: TriangleAlert,
      description: "진행하려면 승인이 필요해요",
    };
  }

  if (status === "running" || (Number(run?.step) === Number(phase?.index) && String(run?.status || "") === "running")) {
    return {
      key: "running",
      label: "처리 중",
      icon: LoaderCircle,
      description: truncateText(task?.text || "작업을 진행하고 있어요"),
    };
  }

  return {
    key: "pending",
    label: "대기",
    icon: CircleDashed,
    description: truncateText(task?.text || "이전 단계를 기다리고 있어요"),
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
  const executionRows = useMemo(() => {
    const logRows = (Array.isArray(logs) ? logs : []).map((log, index) => ({
      id: log?.id || `log-${index}-${log?.ts || 0}`,
      ts: Number(log?.ts || 0),
      text: truncateText(log?.message || "-", 180),
      tone: "event",
    }));
    const transcriptRows = (Array.isArray(run?.executionTranscript) ? run.executionTranscript : []).map((entry, index) => ({
      id: entry?.id || `transcript-${index}-${entry?.ts || 0}`,
      ts: Number(entry?.ts || 0),
      text: buildTranscriptLog(entry),
      tone: entry?.role === "system" ? "system" : entry?.role === "human" ? "human" : "ai",
    }));

    return [...logRows, ...transcriptRows]
      .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0))
      .slice(-36);
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
  const shareText = useMemo(() => {
    if (report?.documentMarkdown) return report.documentMarkdown;
    if (report) return buildReportShareText(report, reportTitle);
    return latestSectionText || reportTitle;
  }, [latestSectionText, report, reportTitle]);
  const isApprovedResult = report?.status === "approved" || run?.status === "completed";
  const resultMarkdown = useMemo(() => {
    if (!isApprovedResult) return "";
    if (report?.documentMarkdown) return report.documentMarkdown;
    if (report) return buildReportMarkdown(report, reportTitle);
    return latestSectionText;
  }, [isApprovedResult, latestSectionText, report, reportTitle]);
  const hasApprovedResult = Boolean(resultMarkdown);

  const handleCopyResult = async () => {
    if (!shareText) return;
    try {
      await navigator.clipboard.writeText(shareText);
      setCopyState("done");
      window.setTimeout(() => setCopyState("idle"), 1600);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 1600);
    }
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
      <div className="dash-run-workflow-grid">
        <article className="dash-run-log-card">
          <div className="dash-run-stage-card-head">
            <h2>실행 로그</h2>
          </div>

          <div className="dash-run-log-body">
            {executionRows.length === 0 ? <p className="dash-run-log-empty">실행이 시작되면 로그가 여기에 쌓여요</p> : null}
            {executionRows.map((row) => (
              <p key={row.id} className={`dash-run-log-line ${row.tone}`}>
                <span>[{formatTime(row.ts)}]</span> {normalizeInlineText(row.text)}
              </p>
            ))}
          </div>
        </article>

        <div className="dash-run-side-stack">
          <article className="dash-run-wbs-card">
            <div className="dash-run-stage-card-head">
              <h2>워크플로 단계(WBS)</h2>
              <span className="dash-run-depth-chip">깊이: {run?.wbs?.depth || 2}</span>
            </div>

            <div className="dash-run-wbs-list">
              {phases.map((phase) => {
                const task = Array.isArray(phase?.tasks) && phase.tasks.length > 0 ? phase.tasks[0] : null;
                const phaseState = getPhaseState({ phase, task, run, reviewTask });
                const roleMeta = getRoleMeta(task?.role);
                const RoleIcon = roleMeta.icon;
                const StateIcon = phaseState.icon;
                const isReviewStep = phaseState.key === "review" && reviewTask?.id === task?.id;

                return (
                  <article key={phase.id || phase.index} className={`dash-run-wbs-item ${phaseState.key}`}>
                    <div className="dash-run-wbs-state">
                      <StateIcon size={22} className={phaseState.key === "running" ? "dash-spin" : ""} />
                    </div>

                    <div className="dash-run-wbs-copy">
                      <div className="dash-run-wbs-title-row">
                        <h3>{phase.title || `단계 ${phase.index}`}</h3>
                        <span className={`dash-run-wbs-badge ${roleMeta.tone}`}>
                          <RoleIcon size={13} />
                          <span>{roleMeta.label}</span>
                        </span>
                      </div>

                      {isReviewStep ? (
                        <div className="dash-run-wbs-review-box">
                          <p>{phaseState.description}</p>
                          <div className="dash-run-wbs-review-actions">
                            {typeof onRequestChanges === "function" ? (
                              <button
                                type="button"
                                className="dash-run-secondary-btn"
                                onClick={onRequestChanges}
                                disabled={requestChangesPending}
                              >
                                {requestChangesPending ? "요청 중" : "수정 요청"}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className="dash-run-primary-btn"
                              onClick={onApprove}
                              disabled={approvePending}
                            >
                              {approvePending ? "승인 중" : "승인 및 계속"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className={`dash-run-wbs-caption ${phaseState.key}`}>{phaseState.description}</p>
                      )}

                      {hasApprovedResult && phase.id === resultPhaseId ? (
                        <div className="dash-run-md-doc">
                          <div className="dash-run-md-doc-head">
                            <div className="dash-run-md-doc-meta">
                              <strong>{markdownTitle}</strong>
                              <span>Markdown document</span>
                            </div>
                            <div className="dash-run-md-doc-actions">
                              {typeof onOpenInChat === "function" ? (
                                <button
                                  type="button"
                                  className="dash-run-secondary-btn dash-run-md-copy-btn"
                                  onClick={handleOpenInChat}
                                  disabled={openInChatPending}
                                >
                                  {openInChatPending ? "여는 중" : "대화 탭에서 열기"}
                                </button>
                              ) : null}
                              <button type="button" className="dash-run-secondary-btn dash-run-md-copy-btn" onClick={handleCopyResult}>
                                {copyState === "done" ? "복사됨" : copyState === "error" ? "복사 실패" : "MD 복사"}
                              </button>
                            </div>
                          </div>

                          <div className="dash-run-md-doc-body">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={{
                                a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
                              }}
                            >
                              {resultMarkdown}
                            </ReactMarkdown>
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })}

              {phases.length === 0 ? <p className="dash-run-log-empty">단계 정보를 불러오는 중이에요</p> : null}
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
