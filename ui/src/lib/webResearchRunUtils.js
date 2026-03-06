import { MarkerType } from "@xyflow/react";

const ROADMAP_TONE_STYLES = {
  root: {
    background: "#ffffff",
    border: "1px solid #cbd5e1",
    color: "#0f172a",
    borderRadius: 18,
    boxShadow: "0 12px 28px rgba(15, 23, 42, 0.08)",
    padding: "14px 18px",
    fontSize: 13,
    width: 180,
  },
  stage: {
    background: "linear-gradient(135deg, #ecfeff, #eef2ff)",
    border: "1px solid #7dd3fc",
    color: "#0f172a",
    borderRadius: 18,
    boxShadow: "0 14px 32px rgba(14, 116, 144, 0.12)",
    padding: "16px 18px",
    fontSize: 13,
    width: 190,
  },
  action: {
    background: "#f8fafc",
    border: "1px solid #d8e1ee",
    color: "#334155",
    borderRadius: 16,
    boxShadow: "0 10px 24px rgba(148, 163, 184, 0.12)",
    padding: "14px 16px",
    fontSize: 12,
    width: 210,
  },
};

function fallbackRoadmap(title = "웹 리서치") {
  return {
    direction: "LR",
    nodes: [
      { id: "root", position: { x: 32, y: 180 }, data: { label: title, tone: "root" } },
      { id: "stage-1", position: { x: 300, y: 48 }, data: { label: "근거 수집", tone: "stage" } },
      { id: "stage-2", position: { x: 300, y: 192 }, data: { label: "요약 및 비교", tone: "stage" } },
      { id: "stage-3", position: { x: 300, y: 336 }, data: { label: "실행 계획", tone: "stage" } },
      { id: "action-1", position: { x: 590, y: 48 }, data: { label: "핵심 출처 후보 정리", tone: "action" } },
      { id: "action-2", position: { x: 590, y: 192 }, data: { label: "비교 포인트 정리", tone: "action" } },
      { id: "action-3", position: { x: 590, y: 336 }, data: { label: "후속 액션 우선순위화", tone: "action" } },
    ],
    edges: [
      { id: "edge-root-1", source: "root", target: "stage-1" },
      { id: "edge-root-2", source: "root", target: "stage-2" },
      { id: "edge-root-3", source: "root", target: "stage-3" },
      { id: "edge-stage-1", source: "stage-1", target: "action-1" },
      { id: "edge-stage-2", source: "stage-2", target: "action-2" },
      { id: "edge-stage-3", source: "stage-3", target: "action-3" },
    ],
  };
}

export function normalizeRoadmapGraph(roadmap, title = "웹 리서치") {
  const source =
    roadmap && Array.isArray(roadmap.nodes) && roadmap.nodes.length > 0 && Array.isArray(roadmap.edges)
      ? roadmap
      : fallbackRoadmap(title);

  return {
    direction: source.direction || "LR",
    nodes: source.nodes.map((node, index) => {
      const tone = node?.data?.tone || (index === 0 ? "root" : index <= 3 ? "stage" : "action");
      return {
        ...node,
        position: node?.position || { x: 40 + index * 120, y: 40 + index * 60 },
        data: {
          ...node?.data,
          label: String(node?.data?.label || `단계 ${index + 1}`),
          tone,
        },
        style: ROADMAP_TONE_STYLES[tone] || ROADMAP_TONE_STYLES.action,
        draggable: false,
        selectable: false,
      };
    }),
    edges: source.edges.map((edge) => ({
      ...edge,
      type: edge?.type || "smoothstep",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "#94a3b8",
      },
      style: {
        stroke: "#c7d2e4",
        strokeWidth: 1.6,
      },
      selectable: false,
    })),
  };
}

export function buildReportShareText(report, fallbackTitle = "웹 리서치 결과") {
  const safeReport = report && typeof report === "object" ? report : {};
  if (safeReport.documentMarkdown) {
    return String(safeReport.documentMarkdown).trim();
  }
  const lines = [
    safeReport.title ? String(safeReport.title) : fallbackTitle,
    "",
    "요약",
    String(safeReport.summary || "요약 없음"),
  ];

  const comparisonRows = Array.isArray(safeReport.comparisonRows) ? safeReport.comparisonRows : [];
  if (comparisonRows.length > 0) {
    lines.push("", "비교");
    comparisonRows.forEach((row) => {
      lines.push(`- ${String(row?.name || "항목")}: ${String(row?.summary || "-")}`);
    });
  }

  if (safeReport.recommendation) {
    lines.push("", "추천", String(safeReport.recommendation));
  }

  const actions = Array.isArray(safeReport.actions) ? safeReport.actions : [];
  if (actions.length > 0) {
    lines.push("", "다음 액션");
    actions.forEach((action) => lines.push(`- ${String(action)}`));
  }

  const sources = Array.isArray(safeReport.sources) ? safeReport.sources : [];
  if (sources.length > 0) {
    lines.push("", "근거 링크");
    sources.forEach((source) => lines.push(`- ${String(source?.label || "출처")}: ${String(source?.url || "")}`));
  }

  return lines.join("\n").trim();
}

export function buildReportMarkdown(report, fallbackTitle = "웹 리서치 결과") {
  const safeReport = report && typeof report === "object" ? report : {};
  const lines = [`# ${safeReport.title ? String(safeReport.title) : fallbackTitle}`];

  if (safeReport.summary) {
    lines.push("", "## 요약", String(safeReport.summary));
  }

  const comparisonRows = Array.isArray(safeReport.comparisonRows) ? safeReport.comparisonRows : [];
  if (comparisonRows.length > 0) {
    lines.push("", "## 비교 포인트");
    comparisonRows.forEach((row) => {
      lines.push("", `### ${String(row?.name || "항목")}`, String(row?.summary || "-"));
    });
  }

  if (safeReport.recommendation) {
    lines.push("", "## 추천", String(safeReport.recommendation));
  }

  const actions = Array.isArray(safeReport.actions) ? safeReport.actions : [];
  if (actions.length > 0) {
    lines.push("", "## 다음 액션");
    actions.forEach((action) => lines.push(`- ${String(action)}`));
  }

  const sources = Array.isArray(safeReport.sources) ? safeReport.sources : [];
  if (sources.length > 0) {
    lines.push("", "## 근거 링크");
    sources.forEach((source) => {
      const label = String(source?.label || "출처");
      const url = String(source?.url || "").trim();
      lines.push(url ? `- [${label}](${url})` : `- ${label}`);
    });
  }

  return lines.join("\n").trim();
}

export function buildResultHandoffPrompt(title = "웹 리서치 결과", markdown = "") {
  const safeTitle = String(title || "웹 리서치 결과").trim() || "웹 리서치 결과";
  const safeMarkdown = String(markdown || "").trim();

  return [
    "승인된 웹 리서치 결과 문서",
    "이후 대화의 기준 컨텍스트로 사용",
    '아직 사용자의 새 질문은 없으니 지금은 "리서치 결과 불러옴, 이어서 질문해 주세요"라고만 짧게 답변',
    "",
    `문서 제목: ${safeTitle}`,
    "",
    "---",
    "",
    safeMarkdown || `# ${safeTitle}`,
  ]
    .join("\n")
    .trim();
}
