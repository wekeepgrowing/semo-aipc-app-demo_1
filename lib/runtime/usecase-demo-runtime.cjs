const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { RUN_SESSION_MODE_PER_RUN, createPerRunSessionKey } = require("./session-utils.cjs");
const { getAllUsecaseSkillRows, getUsecaseSkillRows } = require("./default-skills.cjs");
const {
  normalizeExecutionFeatures,
  normalizeExecutionFeaturesError,
  normalizeExecutionFeaturesStatus,
} = require("./feature-contract.cjs");

const execFileAsync = promisify(execFile);

const USECASE_DEFINITIONS = [
  {
    id: "web_research",
    name: "웹 리서치",
    description: "범위 확인→근거 수집→요약 비교→승인 보고서",
    promptPlaceholder: "예: 한국 SMB 대상 AI 업무 자동화 OS형 제품 경쟁 구도",
    outputType: "brief",
    form: [
      { id: "topic", label: "조사 주제", type: "text", required: true, placeholder: "조사 주제를 입력하세요" },
      {
        id: "targets",
        label: "비교 대상(쉼표 구분)",
        type: "text",
        required: true,
        placeholder: "예: Notion AI, Slack AI, Microsoft Copilot",
      },
      {
        id: "outputFormat",
        label: "출력 형식",
        type: "select",
        required: true,
        defaultValue: "1p_brief",
        options: [
          { value: "1p_brief", label: "1p 브리프" },
          { value: "comparison_table", label: "비교표 포함" },
          { value: "summary_only", label: "요약만" },
        ],
      },
      {
        id: "sourcePreference",
        label: "신뢰 소스 선호(쉼표 구분)",
        type: "text",
        required: false,
        defaultValue: "공식 문서,뉴스,리서치",
        placeholder: "예: 공식 문서,뉴스,리서치",
      },
    ],
    curatedSkills: getUsecaseSkillRows("web_research"),
    phases: [
      {
        id: "phase_scope",
        title: "범위 및 기준 확인",
        role: "Human",
        taskTitle: "사용자 요청 범위와 조사 기준 확정",
        whyHuman: "입력된 자연어 요청을 기준으로 조사 범위를 확정해요",
      },
      { id: "phase_collect", title: "데이터 및 링크 수집", role: "AI", taskTitle: "최신 근거 자료 수집 및 출처 신뢰도 검증" },
      { id: "phase_compare", title: "요약 및 비교", role: "AI", taskTitle: "핵심 이슈 비교표 및 요약 작성" },
      {
        id: "phase_report",
        title: "결과 승인 및 보고서 정리",
        role: "Review Needed",
        taskTitle: "정리된 리서치 결과 승인 및 보고서 확정",
        whyHuman: "최종 결과물 확정과 공유 전 승인이 필요해요",
      },
    ],
  },
  {
    id: "doc_summary",
    name: "문서 찾기/요약",
    description: "찾기→읽기→정리→할일화",
    promptPlaceholder: "예: 세모랩스 2주 데모 합격기준",
    outputType: "document_action",
    form: [
      {
        id: "scopePath",
        label: "문서 위치",
        type: "select",
        required: true,
        defaultValue: "project_dir",
        options: [
          { value: "local_folder", label: "로컬 폴더" },
          { value: "drive_folder", label: "드라이브 폴더" },
          { value: "project_dir", label: "프로젝트 디렉토리" },
        ],
      },
      {
        id: "keywords",
        label: "키워드/질문(쉼표 구분)",
        type: "text",
        required: true,
        placeholder: "예: VM 권한 이슈, 데모 합격 기준",
      },
      {
        id: "outputFormat",
        label: "출력",
        type: "select",
        required: true,
        defaultValue: "summary_decision_todo",
        options: [{ value: "summary_decision_todo", label: "요약 + 결정사항 + To-do" }],
      },
    ],
    curatedSkills: getUsecaseSkillRows("doc_summary"),
    phases: [
      { id: "phase_discover", title: "문서 탐색/선정", role: "AI", taskTitle: "관련 파일 검색·랭킹·후보 추출" },
      { id: "phase_extract", title: "핵심 추출", role: "AI", taskTitle: "요약/결정사항/리스크/To-do 추출" },
      {
        id: "phase_share",
        title: "액션화/공유",
        role: "Review Needed",
        taskTitle: "To-do 리스트 최종 확인 및 공유",
        whyHuman: "실행 우선순위와 담당 배정은 팀 판단이 필요해요",
      },
    ],
  },
];

const USECASE_MAP = new Map(USECASE_DEFINITIONS.map((item) => [item.id, item]));

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeUsecaseInput(definition, prompt, formInput = {}) {
  if (definition.id === "web_research") {
    const topic = String(formInput.topic || prompt || "").trim();
    const baseTargets = toList(formInput.targets);
    const targets = baseTargets.slice(0, 5);
    const outputFormatRaw = String(formInput.outputFormat || "1p_brief").trim();
    const outputFormat = ["1p_brief", "comparison_table", "summary_only"].includes(outputFormatRaw) ? outputFormatRaw : "1p_brief";
    const sourcePreference = toList(formInput.sourcePreference || "공식 문서,뉴스,리서치");
    return {
      topic: topic || "시장 경쟁 구도 분석",
      targets,
      outputFormat,
      sourcePreference: sourcePreference.length > 0 ? sourcePreference : ["공식 문서", "뉴스", "리서치"],
    };
  }

  const scopePathRaw = String(formInput.scopePath || "project_dir").trim();
  const scopePath = ["local_folder", "drive_folder", "project_dir"].includes(scopePathRaw) ? scopePathRaw : "project_dir";
  const keywords = toList(formInput.keywords || prompt || "핵심 문서");
  const outputFormat = "summary_decision_todo";
  return {
    scopePath,
    keywords: keywords.length > 0 ? keywords : ["핵심 문서"],
    outputFormat,
  };
}

function buildWbsFromDefinition(definition) {
  const phases = definition.phases.map((phase, phaseIndex) => {
    const taskId = crypto.randomUUID();
    return {
      id: phase.id,
      index: phaseIndex + 1,
      title: phase.title,
      role: phase.role,
      tasks: [
        {
          id: taskId,
          phaseId: phase.id,
          phaseTitle: phase.title,
          phaseIndex: phaseIndex + 1,
          index: 1,
          title: phase.taskTitle,
          text: phase.taskTitle,
          role: phase.role,
          status: "pending",
          done: false,
          whyHuman: phase.whyHuman || "",
          assignee: phase.role === "Human" ? "담당자 지정" : phase.role === "Review Needed" ? "검토 필요/리뷰 요청" : "AI 실행",
          assigneeType: phase.role === "Human" ? "person" : "ai",
          comments: [],
          review: phase.role === "Review Needed" ? { status: "pending", comments: [] } : null,
        },
      ],
    };
  });

  return {
    depth: 2,
    phases,
  };
}

function flattenTasks(wbs) {
  const tasks = [];
  for (const phase of wbs.phases || []) {
    for (const task of phase.tasks || []) {
      tasks.push(clone(task));
    }
  }
  return tasks;
}

function ensureTaskDefaults(task) {
  const role = String(task.role || "AI");
  return {
    ...task,
    id: String(task.id || crypto.randomUUID()),
    text: String(task.text || task.title || "작업"),
    title: String(task.title || task.text || "작업"),
    role,
    status: String(task.status || "pending"),
    done: Boolean(task.done || String(task.status || "") === "completed"),
    whyHuman: task.whyHuman ? String(task.whyHuman) : "",
    assignee: String(
      task.assignee ||
        (role === "Human" ? "담당자 지정" : role === "Review Needed" ? "검토 필요/리뷰 요청" : "AI 실행")
    ),
    assigneeType: String(task.assigneeType || (role === "Human" ? "person" : "ai")),
    comments: Array.isArray(task.comments) ? task.comments : [],
    review: task.review && typeof task.review === "object" ? task.review : role === "Review Needed" ? { status: "pending", comments: [] } : null,
  };
}

function deriveStepStatus(tasks, wbs, runStatus) {
  const phases = Array.isArray(wbs?.phases) ? wbs.phases : [];
  const stepRows = [];
  let currentStep = phases.length > 0 ? 1 : 0;
  let activeFound = false;

  for (const phase of phases) {
    const phaseTasks = tasks.filter((task) => String(task.phaseId) === String(phase.id));
    const allCompleted = phaseTasks.length > 0 && phaseTasks.every((task) => task.status === "completed");
    let status = "pending";
    if (allCompleted) {
      status = "completed";
    } else if (!activeFound) {
      status = runStatus === "completed" ? "completed" : "running";
      currentStep = Number(phase.index || stepRows.length + 1);
      activeFound = true;
    }
    stepRows.push({
      index: Number(phase.index || stepRows.length + 1),
      label: phase.title || `단계 ${stepRows.length + 1}`,
      status,
    });
  }

  if (!activeFound && stepRows.length > 0) {
    currentStep = stepRows[stepRows.length - 1].index;
  }

  return {
    step: currentStep || 1,
    steps: stepRows,
  };
}

function summarizeRun(run) {
  return {
    id: run.id,
    title: run.title,
    status: run.status,
    updatedAt: run.updatedAt,
    step: run.step,
    usecaseId: run.usecaseId || "",
  };
}

const GATEWAY_TASK_TIMEOUT_MS = 150_000;
const GATEWAY_TASK_GRACE_TIMEOUT_MS = 45_000;
const GATEWAY_HISTORY_POLL_INTERVAL_MS = 3_000;

function readPath(value, path) {
  if (!value || typeof value !== "object") return undefined;
  return String(path || "")
    .split(".")
    .reduce((acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined), value);
}

function readFirstValue(value, paths = []) {
  for (const path of paths) {
    const row = readPath(value, path);
    if (row !== undefined && row !== null) return row;
  }
  return undefined;
}

function readFirstArray(value, paths = []) {
  for (const path of paths) {
    const row = readPath(value, path);
    if (Array.isArray(row)) return row;
  }
  return null;
}

function toFiniteNumber(value, fallback = 0) {
  const number = Number(value);
  if (Number.isFinite(number)) return number;
  return Number.isFinite(Number(fallback)) ? Number(fallback) : 0;
}

function oneLine(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value, max = 1200) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

function normalizeGatewayAttachments(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const type = String(readFirstValue(item, ["type", "file.type"]) || "file")
        .trim()
        .toLowerCase();
      if (type && type !== "file") return null;
      const url = String(readFirstValue(item, ["url", "file.url", "content.url"]) || "").trim();
      const filename = String(readFirstValue(item, ["filename", "name", "file.filename", "content.filename"]) || "").trim();
      const mimeType = String(readFirstValue(item, ["mime", "mimeType", "file.mime", "content.mime"]) || "application/octet-stream").trim();
      const size = Number(readFirstValue(item, ["size", "file.size", "content.size"]));
      if (!url && !filename) return null;
      return {
        id: String(readFirstValue(item, ["id", "file.id"]) || `file-${index}-${crypto.randomUUID()}`),
        type: "file",
        url,
        filename: filename || "attachment",
        mime: mimeType || "application/octet-stream",
        size: Number.isFinite(size) && size >= 0 ? size : null,
      };
    })
    .filter(Boolean);
}

function extractGatewayText(message, payload) {
  const messageText = String(message?.text || "").trim();
  if (messageText) return messageText;
  const parts = Array.isArray(message?.content) ? message.content : [];
  const chunkText = parts
    .map((part) => String(part?.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (chunkText) return chunkText;
  const payloadText = String(
    readFirstValue(payload, [
      "text",
      "messageText",
      "result.text",
      "output.text",
      "error.message",
      "error.detail",
      "error",
      "reason",
      "stateReason",
    ]) || ""
  ).trim();
  return payloadText;
}

function normalizeGatewayExecutionState(raw) {
  const value = String(raw || "running").trim().toLowerCase();
  if (
    value === "final" ||
    value === "completed" ||
    value === "complete" ||
    value === "done" ||
    value === "success" ||
    value === "succeeded"
  ) {
    return "final";
  }
  if (
    value === "error" ||
    value === "aborted" ||
    value === "failed" ||
    value === "fail" ||
    value === "cancelled" ||
    value === "canceled"
  ) {
    return "error";
  }
  return "running";
}

function extractHistoryMessageText(message) {
  if (!message || typeof message !== "object") return "";
  const directText = String(readFirstValue(message, ["text", "value", "content.text", "content.value"]) || "").trim();
  if (directText) return directText;
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((part) => String(readFirstValue(part, ["text", "value", "content.text", "content.value"]) || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeHistoryMessage(message, index = 0) {
  const text = extractHistoryMessageText(message);
  if (!text) return null;
  const role = String(readFirstValue(message, ["role", "author.role", "message.role"]) || "assistant")
    .trim()
    .toLowerCase();
  const ts = Number(readFirstValue(message, ["ts", "timestamp", "createdAt", "created_at"]) || Date.now());
  return {
    id: String(readFirstValue(message, ["id", "message.id"]) || `gateway-history-${index}-${crypto.randomUUID()}`),
    role: role === "user" || role === "system" ? role : "assistant",
    ts: Number.isFinite(ts) ? ts : Date.now(),
    text,
  };
}

function extractHistoryMessages(payload) {
  const rows = readFirstArray(payload, ["messages", "items", "history.messages", "data.messages"]) || [];
  return rows.map((message, index) => normalizeHistoryMessage(message, index)).filter(Boolean);
}

function findAssistantReplyAfterBaseline(messages, baselineCount = 0, startedAt = 0) {
  const rows = Array.isArray(messages) ? messages : [];
  const startIndex = Math.max(0, Number.isFinite(Number(baselineCount)) ? Number(baselineCount) : 0);
  const recentRows = rows.slice(startIndex);
  const baselineReply = [...recentRows].reverse().find((message) => message.role === "assistant" || message.role === "system");
  if (baselineReply) return baselineReply;
  const threshold = Math.max(0, Number(startedAt) || 0) - 2_000;
  return [...rows]
    .reverse()
    .find((message) => (message.role === "assistant" || message.role === "system") && Number(message.ts || 0) >= threshold) || null;
}

function extractUrls(text) {
  const value = String(text || "");
  const regex = /https?:\/\/[^\s)\]}>"'`]+/gi;
  const found = [];
  let match;
  while ((match = regex.exec(value))) {
    found.push(match[0]);
  }
  return [...new Set(found)];
}

function extractBulletLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
    .filter(Boolean);
}

function extractFileCandidates(text) {
  const value = String(text || "");
  const regex = /[A-Za-z0-9._/\-]+\.(?:md|txt|pdf|docx?|pptx?|xlsx?|csv|json|yaml|yml)/g;
  const rows = [];
  let match;
  while ((match = regex.exec(value))) {
    rows.push(match[0]);
  }
  return [...new Set(rows)];
}

function firstParagraph(text) {
  const rows = String(text || "")
    .split(/\n{2,}/)
    .map((row) => row.trim())
    .filter(Boolean);
  return rows[0] || "";
}

function dedupeStrings(rows = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const value = oneLine(row);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeMarkdownText(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function stripMarkdownFormatting(value) {
  return String(value || "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
    .replace(/[`*_>#]/g, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sentenceSplit(value, limit = 3) {
  return String(value || "")
    .split(/(?<=[.!?。다])\s+|\n+/)
    .map((row) => stripMarkdownFormatting(row))
    .filter(Boolean)
    .slice(0, limit);
}

function escapeMarkdownCell(value) {
  return String(value || "")
    .replace(/\|/g, "\\|")
    .replace(/\r\n?/g, " ")
    .replace(/\n/g, " ")
    .trim();
}

function parseMarkdownLinks(value) {
  const text = normalizeMarkdownText(value);
  const links = [];
  const regex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match;
  while ((match = regex.exec(text))) {
    links.push({
      label: stripMarkdownFormatting(match[1]),
      url: match[2],
    });
  }
  return links;
}

function findMarkdownSection(markdown, headingLabels = []) {
  const lines = normalizeMarkdownText(markdown).split("\n");
  const normalizedLabels = headingLabels.map((label) => String(label || "").trim().toLowerCase()).filter(Boolean);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const heading = line.replace(/^#{1,6}\s*/, "").trim().toLowerCase();
    if (!line.startsWith("#")) continue;
    if (normalizedLabels.some((label) => heading.includes(label))) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return "";
  const body = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("#")) break;
    body.push(line);
  }
  return body.join("\n").trim();
}

function parseMarkdownBulletSection(markdown, headingLabels = []) {
  return findMarkdownSection(markdown, headingLabels)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line) || /^\d+[.)]\s+/.test(line))
    .map((line) => stripMarkdownFormatting(line.replace(/^[-*]\s+/, "").replace(/^\d+[.)]\s+/, "")))
    .filter(Boolean);
}

function parseMarkdownTableRows(markdown) {
  const lines = normalizeMarkdownText(markdown)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = 0; index < lines.length - 2; index += 1) {
    const headerLine = lines[index];
    const dividerLine = lines[index + 1];
    if (!headerLine.includes("|")) continue;
    if (!/^\|?[\s:-]+\|[\s|:-]*$/.test(dividerLine)) continue;
    const headers = headerLine
      .split("|")
      .map((cell) => stripMarkdownFormatting(cell))
      .filter(Boolean);
    if (headers.length < 2) continue;
    const rows = [];
    for (let cursor = index + 2; cursor < lines.length; cursor += 1) {
      const rowLine = lines[cursor];
      if (!rowLine.includes("|")) break;
      const cells = rowLine
        .split("|")
        .map((cell) => stripMarkdownFormatting(cell))
        .filter(Boolean);
      if (cells.length < 2) continue;
      rows.push(
        headers.reduce((acc, header, cellIndex) => {
          acc[header] = cells[cellIndex] || "";
          return acc;
        }, {})
      );
    }
    if (rows.length > 0) return rows;
  }
  return [];
}

function parseTavilySearchOutput(output) {
  const text = normalizeMarkdownText(output);
  const answerMatch = text.match(/##\s+Answer\s*([\s\S]*?)(?:\n---\n|\n##\s+Sources|$)/i);
  const answer = normalizeMarkdownText(answerMatch?.[1] || "");
  const sourcesSectionMatch = text.match(/##\s+Sources\s*([\s\S]*)$/i);
  const sourcesBlock = normalizeMarkdownText(sourcesSectionMatch?.[1] || "");
  const lines = sourcesBlock ? sourcesBlock.split("\n") : [];
  const sources = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const titleMatch = line.match(/^- \*\*(.+?)\*\*(?:\s+\(relevance:\s*([\d.]+)%\))?/i);
    if (titleMatch) {
      if (current) sources.push(current);
      current = {
        title: stripMarkdownFormatting(titleMatch[1]),
        url: "",
        snippet: "",
        relevance: titleMatch[2] ? Number(titleMatch[2]) : null,
      };
      continue;
    }
    if (!current) continue;
    if (!current.url && /^https?:\/\//i.test(line)) {
      current.url = line;
      continue;
    }
    current.snippet = current.snippet ? `${current.snippet} ${line}`.trim() : line;
  }

  if (current) sources.push(current);
  return {
    answer,
    sources: sources.filter((source) => source.title || source.url),
  };
}

function extractStructuredSourcesFromMarkdown(markdown) {
  const text = normalizeMarkdownText(markdown);
  const lines = text.split("\n");
  const sources = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^###\s+/.test(line)) {
      if (current && (current.title || current.url)) sources.push(current);
      const linkMatch = line.match(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
      current = {
        title: linkMatch ? stripMarkdownFormatting(linkMatch[1]) : stripMarkdownFormatting(line.replace(/^###\s+/, "")),
        url: linkMatch ? linkMatch[2] : "",
        snippet: "",
      };
      continue;
    }

    if (!current) continue;
    const lineLinkMatch = line.match(/^-\s*링크:\s*(https?:\/\/\S+)/i);
    if (lineLinkMatch) {
      current.url = lineLinkMatch[1];
      continue;
    }
    const snippetMatch = line.match(/^-\s*핵심 단서:\s*(.+)$/);
    if (snippetMatch) {
      current.snippet = current.snippet ? `${current.snippet} ${snippetMatch[1]}`.trim() : snippetMatch[1].trim();
      continue;
    }
    if (/^-\s*/.test(line) && !/^-\s*관련도:/i.test(line)) {
      current.snippet = current.snippet ? `${current.snippet} ${stripMarkdownFormatting(line)}`.trim() : stripMarkdownFormatting(line);
    }
  }

  if (current && (current.title || current.url)) sources.push(current);

  if (sources.length > 0) return sources;
  return parseMarkdownLinks(text).map((link) => ({
    title: link.label,
    url: link.url,
    snippet: "",
  }));
}

function buildTavilySearchQuery(input = {}) {
  const topicRaw = String(input.topic || "").trim();
  const isAppsInToss = /앱인토스|apps?\s*in\s*toss|토스\s*미니앱/i.test(topicRaw);
  const isRevenueQuestion = /매출|수익|얼마|벌어|revenue|monet/i.test(topicRaw);
  if (isAppsInToss && isRevenueQuestion) {
    return "토스 앱인토스 미니앱 플랫폼 매출 사례 수익화 개발자 인터뷰";
  }
  const topic = isAppsInToss ? `토스 앱인토스 미니앱 플랫폼 ${topicRaw}` : topicRaw;
  const targets = Array.isArray(input.targets) ? input.targets.filter(Boolean) : [];
  const sourcePreference = Array.isArray(input.sourcePreference) ? input.sourcePreference.filter(Boolean) : [];
  return [topic, targets.length > 0 ? `비교 대상 ${targets.join(", ")}` : "", sourcePreference.join(", "), "매출 수익화 실적 출시 사례"]
    .filter(Boolean)
    .join(" · ");
}

function extractRevenueMentions(value) {
  const text = String(value || "");
  const regex = /(?:월\s*매출\s*)?\d[\d,]*(?:\.\d+)?\s*(?:만원|억\s*원|억원|원|달러)/gi;
  const rows = [];
  let match;
  while ((match = regex.exec(text))) {
    rows.push(match[0].replace(/\s+/g, " ").trim());
  }
  return [...new Set(rows)];
}

function buildRevenueEvidenceRows(sources = []) {
  return (Array.isArray(sources) ? sources : [])
    .slice(0, 6)
    .map((source) => {
      const snippet = stripMarkdownFormatting(source?.snippet || "");
      const title = stripMarkdownFormatting(source?.title || source?.url || "출처");
      const moneyMentions = extractRevenueMentions(`${source?.title || ""} ${source?.snippet || ""}`);
      const finding = moneyMentions[0] || sentenceSplit(snippet, 1)[0] || "구체 금액은 추가 확인 필요";
      let takeaway = "초기 수익화와 유입 성과는 추가 확인이 더 필요해요";
      if (moneyMentions.length > 0) {
        takeaway = "실제 런칭 사례에서 수익화 규모가 확인돼요";
      } else if (/광고|결제|구독|in-app|수익화/i.test(snippet)) {
        takeaway = "광고·결제 등 수익화 방식 단서가 보여요";
      } else if (/사용자|유입|노출|플랫폼|입점/i.test(snippet)) {
        takeaway = "플랫폼 유입 규모와 배포 효율을 보여주는 근거예요";
      }
      return {
        source: title,
        finding,
        takeaway,
        url: String(source?.url || "").trim(),
        snippet,
      };
    })
    .filter((row) => row.source || row.finding);
}

function buildCollectedEvidenceMarkdown({ run, query, answer, sources }) {
  const input = run?.normalizedInput || {};
  const lines = [
    `# ${String(input.topic || run?.title || "웹 리서치")} 근거 수집`,
    "",
    "## 조사 개요",
    `- 주제: ${String(input.topic || run?.prompt || "웹 리서치").trim()}`,
    `- 비교 대상: ${Array.isArray(input.targets) && input.targets.length > 0 ? input.targets.join(" / ") : "명시되지 않음"}`,
    `- 검색 질의: ${query}`,
  ];

  if (answer) {
    lines.push("", "## Tavily 요약", answer);
  }

  lines.push("", "## 수집된 근거");
  if (Array.isArray(sources) && sources.length > 0) {
    sources.slice(0, 8).forEach((source, index) => {
      const title = stripMarkdownFormatting(source?.title || `근거 ${index + 1}`);
      const url = String(source?.url || "").trim();
      const snippet = stripMarkdownFormatting(source?.snippet || "");
      lines.push("", url ? `### ${index + 1}. [${title}](${url})` : `### ${index + 1}. ${title}`);
      if (url && !/\]\(https?:\/\//.test(lines[lines.length - 1])) lines.push(`- 링크: ${url}`);
      if (snippet) lines.push(`- 핵심 단서: ${snippet}`);
      if (source?.relevance) lines.push(`- 관련도: ${source.relevance}%`);
    });
  } else {
    lines.push("- 검색 결과를 아직 찾지 못했어요");
  }

  return lines.join("\n").trim();
}

function buildWebResearchDocumentMarkdown({ run, sections = [] }) {
  const input = run?.normalizedInput || {};
  const topic = String(input.topic || run?.title || "웹 리서치").trim() || "웹 리서치";
  const targets = Array.isArray(input.targets) ? input.targets.filter(Boolean) : [];
  const sourcePreference = Array.isArray(input.sourcePreference) ? input.sourcePreference.filter(Boolean) : [];
  const completedTexts = sections.map((section) => String(section?.content?.responseText || "")).filter(Boolean);
  const sourcePool = dedupeStrings(
    completedTexts.flatMap((text) => extractStructuredSourcesFromMarkdown(text).map((source) => JSON.stringify(source)))
  )
    .map((row) => {
    try {
      return JSON.parse(row);
    } catch {
      return null;
    }
    })
    .filter(Boolean);
  const tavilyAnswer = completedTexts
    .map((text) => findMarkdownSection(text, ["Tavily 요약"]) || parseTavilySearchOutput(text).answer)
    .find(Boolean);
  const evidenceRows = buildRevenueEvidenceRows(sourcePool);
  const insightBullets = dedupeStrings([
    ...extractRevenueMentions(`${tavilyAnswer || ""} ${completedTexts.join(" ")}`).map(
      (value) => `${value} 수준의 사례가 확인돼 수익화 가능성을 보여줘요`
    ),
    ...sentenceSplit(tavilyAnswer, 3),
    ...evidenceRows.slice(0, 3).map((row) => `${row.source}: ${row.takeaway}`),
  ]).slice(0, 4);
  const actionItems = dedupeStrings([
    "토스 공식 자료와 외부 기사 기준으로 실제 매출 사례를 한 번 더 교차검증해요",
    "입점 서비스별 수익화 방식(광고, 결제, 제휴)을 분리해 비교표를 다듬어요",
    "런칭 후 1주·1개월 기준의 유입·전환·매출 지표를 사례별로 정리해요",
  ]).slice(0, 5);

  const lines = [
    `# ${topic} 리서치 브리프`,
    "",
    "## 조사 개요",
    `- 주제: ${topic}`,
    `- 비교 대상: ${targets.length > 0 ? targets.join(" / ") : "특정 경쟁사 미지정, 관련 사례 중심 탐색"}`,
    `- 소스 선호: ${sourcePreference.length > 0 ? sourcePreference.join(", ") : "공식 문서, 뉴스, 리서치"}`,
    "",
    "## 핵심 결론",
  ];

  if (insightBullets.length > 0) {
    insightBullets.forEach((bullet) => lines.push(`- ${bullet}`));
  } else {
    lines.push("- 최신 근거를 더 확보하면 매출 범위와 수익화 구조를 더 정확하게 정리할 수 있어요");
  }

  lines.push("", "## 매출/수익화 근거");
  lines.push("| 출처 | 관찰 | 시사점 |");
  lines.push("| --- | --- | --- |");
  if (evidenceRows.length > 0) {
    evidenceRows.forEach((row) => {
      lines.push(`| ${escapeMarkdownCell(row.source)} | ${escapeMarkdownCell(row.finding)} | ${escapeMarkdownCell(row.takeaway)} |`);
    });
  } else {
    lines.push("| 근거 부족 | 구체 매출 수치 확인 필요 | 추가 검색과 공식 자료 교차검증 필요 |");
  }

  lines.push("", "## 해석");
  if (evidenceRows.length > 0) {
    lines.push(
      `- 현재 근거 기준으로는 ${topic} 관련 사례에서 실제 수익화가 발생하고 있으며, 특히 ${escapeMarkdownCell(
        evidenceRows[0]?.finding || "초기 매출"
      )} 같은 구체 사례가 확인돼요`
    );
  } else {
    lines.push("- 현재 확보된 자료는 플랫폼 규모와 유입 잠재력을 보여주지만, 개별 서비스 매출은 추가 확인이 더 필요해요");
  }
  lines.push("- 다만 사례별 수익 구조와 유지율은 출처마다 편차가 있어 공식 자료와 인터뷰·기사의 교차 검증이 필요해요");

  lines.push("", "## 다음 액션");
  actionItems.forEach((item, index) => {
    lines.push(`${index + 1}. ${item}`);
  });

  lines.push("", "## 근거 링크");
  if (sourcePool.length > 0) {
    sourcePool.slice(0, 8).forEach((source, index) => {
      const title = stripMarkdownFormatting(source?.title || `근거 ${index + 1}`);
      const url = String(source?.url || "").trim();
      const snippet = stripMarkdownFormatting(source?.snippet || "");
      if (url) {
        lines.push(`- [${title}](${url})`);
      } else {
        lines.push(`- ${title}`);
      }
      if (snippet) lines.push(`  - ${snippet}`);
    });
  } else {
    lines.push("- 확인 가능한 링크가 아직 없어요");
  }

  return lines.join("\n").trim();
}

function splitActionGroups(actions = []) {
  const rows = actions.slice(0, 9);
  const groups = [[], [], []];
  rows.forEach((action, index) => {
    groups[index % groups.length].push(action);
  });
  return groups;
}

function buildWebResearchComparisonRows(text, targets = []) {
  const markdownRows = parseMarkdownTableRows(text);
  if (markdownRows.length > 0) {
    return markdownRows.slice(0, 6).map((row, index) => {
      const values = Object.values(row).map((value) => stripMarkdownFormatting(value)).filter(Boolean);
      return {
        name: values[0] || `항목 ${index + 1}`,
        summary: truncateText(values.slice(1).join(" · ") || values[0] || "본문 응답 참고", 180),
      };
    });
  }

  const lines = String(text || "")
    .split("\n")
    .map((row) => row.trim())
    .filter(Boolean);

  if (!Array.isArray(targets) || targets.length === 0) {
    return buildRevenueEvidenceRows(
      extractUrls(text).map((url, index) => ({
        title: `근거 ${index + 1}`,
        url,
        snippet: "",
      }))
    )
      .slice(0, 4)
      .map((row) => ({
        name: row.source,
        summary: truncateText(row.finding || row.takeaway || "본문 응답 참고", 180),
      }));
  }

  return (Array.isArray(targets) ? targets : [])
    .slice(0, 6)
    .map((target) => {
      const lowered = String(target || "").toLowerCase();
      const matched = lines.find((row) => row.toLowerCase().includes(lowered));
      return {
        name: String(target || "비교 대상"),
        summary: truncateText(firstParagraph(matched || "") || "본문 응답 참고", 180),
      };
    });
}

function buildWebResearchRecommendation(summary, actions = [], targets = []) {
  const summaryLine = oneLine(summary);
  if (summaryLine) return truncateText(summaryLine, 280);
  if (actions.length > 0) return truncateText(`우선 ${actions[0]}부터 검증하는 방향을 권장해요`, 280);
  if (targets.length > 0) return truncateText(`${targets[0]}를 기준점으로 빠른 비교 검증을 권장해요`, 280);
  return "최신 근거를 기준으로 상위 후보를 좁힌 뒤 실행 항목을 우선순위화해요";
}

function buildWebResearchRoadmap({ topic, actions = [] }) {
  const stageLabels = ["근거 수집", "요약 및 비교", "실행 계획"];
  const groups = splitActionGroups(actions);
  const nodes = [
    {
      id: "root",
      position: { x: 40, y: 180 },
      data: { label: topic || "웹 리서치", tone: "root" },
      type: "default",
    },
  ];
  const edges = [];

  stageLabels.forEach((label, index) => {
    const stageId = `stage-${index + 1}`;
    const stageY = 40 + index * 170;
    nodes.push({
      id: stageId,
      position: { x: 320, y: stageY },
      data: { label, tone: "stage" },
      type: "default",
    });
    edges.push({
      id: `edge-root-${stageId}`,
      source: "root",
      target: stageId,
      type: "smoothstep",
    });

    const stageActions = groups[index].length > 0 ? groups[index] : [`${label} 후속 정리`];
    stageActions.slice(0, 3).forEach((action, actionIndex) => {
      const actionId = `${stageId}-action-${actionIndex + 1}`;
      nodes.push({
        id: actionId,
        position: { x: 620, y: stageY + actionIndex * 78 },
        data: { label: truncateText(action, 90), tone: "action" },
        type: "default",
      });
      edges.push({
        id: `edge-${stageId}-${actionId}`,
        source: stageId,
        target: actionId,
        type: "smoothstep",
      });
    });
  });

  return {
    direction: "LR",
    nodes,
    edges,
  };
}

function buildWebResearchReport({ run, sections = [], status = "draft", approvedAt = null, generatedAt = null }) {
  const input = run?.normalizedInput || {};
  const title = String(input.topic || run?.title || "웹 리서치").trim() || "웹 리서치";
  const targets = Array.isArray(input.targets) ? input.targets : [];
  const allText = sections.map((section) => String(section?.content?.responseText || "")).join("\n\n");
  const compareSection =
    sections
      .slice()
      .reverse()
      .find((section) => /요약|비교|브리프|brief/i.test(String(section?.title || ""))) || null;
  const documentMarkdown = normalizeMarkdownText(
    compareSection?.content?.responseText || buildWebResearchDocumentMarkdown({ run, sections })
  );
  const summaryBullets = parseMarkdownBulletSection(documentMarkdown, ["핵심 결론", "핵심 요약"]);
  const paragraphSummary = truncateText(
    summaryBullets.slice(0, 2).join(" ") ||
      stripMarkdownFormatting(findMarkdownSection(documentMarkdown, ["해석"])) ||
      firstParagraph(allText) ||
      firstParagraph(run?.prompt || "") ||
      "입력된 요구사항을 바탕으로 웹 리서치를 진행 중이에요",
    560
  );
  const actions = dedupeStrings(parseMarkdownBulletSection(documentMarkdown, ["다음 액션", "실행 가능한 액션", "액션 아이템"]))
    .slice(0, 8);
  const comparisonRows = buildWebResearchComparisonRows(documentMarkdown || allText, targets);
  const markdownSources = parseMarkdownLinks(documentMarkdown);
  const sources = (markdownSources.length > 0
    ? markdownSources
    : extractUrls(allText)
        .slice(0, 12)
        .map((url, index) => ({ label: `근거 ${index + 1}`, url })))
    .slice(0, 12);
  const recommendation = buildWebResearchRecommendation(
    paragraphSummary,
    actions,
    targets.length > 0 ? targets : comparisonRows.map((row) => row.name).filter(Boolean)
  );

  return {
    status: status === "approved" ? "approved" : "draft",
    title,
    summary: paragraphSummary,
    comparisonRows,
    recommendation,
    sources,
    actions: actions.length > 0 ? actions : ["핵심 후보를 좁히고 추가 검증 항목을 우선순위화해요"],
    documentMarkdown,
    generatedAt: Number(generatedAt || Date.now()),
    approvedAt: approvedAt ? Number(approvedAt) : null,
  };
}

function buildWebResearchArtifacts(base, run, sections = [], { approvedAt = null } = {}) {
  const previousReport = base?.report && typeof base.report === "object" ? base.report : null;
  const reportStatus = approvedAt || previousReport?.status === "approved" ? "approved" : "draft";
  const finalizedAt = approvedAt || previousReport?.approvedAt || null;
  const report = buildWebResearchReport({
    run,
    sections,
    status: reportStatus,
    approvedAt: finalizedAt,
    generatedAt: previousReport?.generatedAt || Date.now(),
  });

  return {
    ...(base && typeof base === "object" ? base : {}),
    type: "brief",
    exportable: true,
    sections,
    report,
    roadmap: buildWebResearchRoadmap({
      topic: report.title,
      actions: report.actions,
    }),
    result: {
      title: report.title,
      sources: report.sources,
      comparison: report.comparisonRows.map((row) => ({
        name: row.name,
        note: row.summary,
      })),
      brief: report.summary,
      actions: report.actions,
    },
    board: {
      items: report.actions.map((action, index) => ({
        id: `roadmap-${index + 1}`,
        title: action,
        status: report.status === "approved" ? "approved" : "todo",
      })),
    },
    updatedAt: Date.now(),
  };
}

class UsecaseDemoRuntime {
  constructor({
    runtimeStore,
    runtimeAdapter,
    runtimeWsBroker,
    timerStore,
    bindGatewayAlias = null,
    getExecutionEnv = null,
    getTavilySkillDir = null,
  }) {
    this.runtimeStore = runtimeStore;
    this.runtimeAdapter = runtimeAdapter;
    this.runtimeWsBroker = runtimeWsBroker;
    this.timerStore = timerStore;
    this.bindGatewayAlias = typeof bindGatewayAlias === "function" ? bindGatewayAlias : null;
    this.getExecutionEnv = typeof getExecutionEnv === "function" ? getExecutionEnv : () => ({ ...process.env });
    this.getTavilySkillDir = typeof getTavilySkillDir === "function" ? getTavilySkillDir : () => "";
  }

  listUsecases() {
    return USECASE_DEFINITIONS.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      promptPlaceholder: item.promptPlaceholder,
      form: clone(item.form),
      curatedSkills: clone(item.curatedSkills),
    }));
  }

  getCuratedSkillBundles() {
    return getAllUsecaseSkillRows().map((skill) => ({
      ...skill,
      enabled: Boolean(skill.enabled),
    }));
  }

  createUsecaseRun({
    prompt,
    usecaseId,
    formInput,
    sourceAction = "home_usecase",
    executionFeatures = [],
    sessionKey = "",
    originConversationId = "",
    attachments = [],
  }) {
    const definition = USECASE_MAP.get(String(usecaseId || ""));
    if (!definition) {
      return { ok: false, code: "invalid_input", error: "unsupported usecaseId" };
    }

    const normalizedInput = normalizeUsecaseInput(definition, prompt, formInput);
    const wbs = buildWbsFromDefinition(definition);
    const tasks = flattenTasks(wbs).map(ensureTaskDefaults);
    const runId = crypto.randomUUID();
    const now = Date.now();
    const initialTranscript = [];
    const normalizedAttachments = normalizeGatewayAttachments(attachments);

    if (definition.id === "web_research" && tasks[0]) {
      tasks[0] = {
        ...tasks[0],
        status: "completed",
        done: true,
        result: {
          capturedPrompt: String(prompt || ""),
          normalizedInput,
          completedAt: now,
        },
      };
      initialTranscript.push({
        id: crypto.randomUUID(),
        taskId: tasks[0].id,
        phaseId: tasks[0].phaseId,
        role: "human",
        kind: "input",
        text: String(prompt || normalizedInput.topic || "웹 리서치 요청"),
        ts: now,
      });
      initialTranscript.push({
        id: crypto.randomUUID(),
        taskId: tasks[0].id,
        phaseId: tasks[0].phaseId,
        role: "system",
        kind: "event",
        text:
          normalizedAttachments.length > 0
            ? `범위 및 기준 확인 단계를 완료하고 첨부 자료 ${normalizedAttachments.length}개를 포함해 웹 리서치 실행을 준비했어요`
            : "범위 및 기준 확인 단계를 완료하고 웹 리서치 실행을 준비했어요",
        ts: now + 1,
      });
    }

    const stepInfo = deriveStepStatus(tasks, wbs, "running");
    const initialArtifacts =
      definition.id === "web_research"
        ? buildWebResearchArtifacts(
            {
              usecaseId: definition.id,
              type: definition.outputType,
              title: `${definition.name} 결과`,
              sections: [],
              board: { items: [] },
              exportable: true,
              updatedAt: now,
            },
            {
              id: runId,
              title: String(prompt || definition.name || "새 실행").slice(0, 72),
              prompt: String(prompt || ""),
              normalizedInput,
            },
            []
          )
        : {
            usecaseId: definition.id,
            type: definition.outputType,
            title: `${definition.name} 결과`,
            sections: [],
            board: { items: [] },
            exportable: true,
            updatedAt: now,
          };

    const run = this.runtimeStore.upsertRun({
      id: runId,
      title: String(prompt || definition.name || "새 실행").slice(0, 72),
      prompt: String(prompt || ""),
      status: "running",
      sourceAction,
      sourceType: "openclaw",
      createdAt: now,
      updatedAt: now,
      step: stepInfo.step,
      steps: stepInfo.steps,
      tasks,
      logs: [],
      executionTranscript: initialTranscript,
      usage: {
        runId,
        provider: "openclaw",
        model: "gateway-rpc",
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        costUsd: 0,
        ts: now,
      },
      usecaseId: definition.id,
      normalizedInput,
      wbs,
      pauseState: null,
      currentExecution: null,
      sessionKey: String(sessionKey || "").trim() || createPerRunSessionKey(),
      sessionMode: RUN_SESSION_MODE_PER_RUN,
      originConversationId: String(originConversationId || "").trim(),
      executionFeatures: normalizeExecutionFeatures(executionFeatures),
      executionFeaturesLockedAt: now,
      executionFeaturesStatus: Array.isArray(executionFeatures) && executionFeatures.length > 0 ? "locked" : "none",
      executionFeaturesError: null,
      artifacts: initialArtifacts,
      attachments: normalizedAttachments,
    });

    const setupLog = this.appendLog(run.id, "info", "입력값 정규화 및 WBS(Depth 2) 생성을 완료했어요");
    const startLog = this.appendLog(run.id, "info", "실행 탭으로 전환되어 Semo AI 자동 실행을 시작해요");
    this.emitAll(run.id, { includeUsage: true, logEntries: [setupLog, startLog] });
    setTimeout(() => this.runAutoQueue(run.id), 120);

    return { ok: true, runId: run.id, status: run.status, run };
  }

  appendTranscript(runId, entry = {}) {
    const updated = this.runtimeStore.appendRunTranscript(runId, entry);
    return updated?.executionTranscript?.[updated.executionTranscript.length - 1] || null;
  }

  finalizeWebResearchArtifacts(runId, approvedAt = Date.now()) {
    const run = this.runtimeStore.getRun(runId);
    if (!run || run.usecaseId !== "web_research") return run?.artifacts || null;
    const base = run.artifacts && typeof run.artifacts === "object" ? clone(run.artifacts) : {};
    const sections = Array.isArray(base.sections) ? base.sections : [];
    return buildWebResearchArtifacts(base, run, sections, { approvedAt });
  }

  handleAction(runId, payload = {}) {
    const run = this.runtimeStore.getRun(runId);
    if (!run || !run.usecaseId) {
      return { ok: false, code: "invalid_input", error: "usecase run not found" };
    }

    const action = String(payload.action || "").trim();
    const taskId = String(payload.taskId || "").trim();
    const comment = String(payload.comment || "").trim();
    const assignee = String(payload.assignee || "").trim();

    if (!action) {
      return { ok: false, code: "invalid_input", error: "action is required" };
    }

    if (action === "resume") {
      this.clearPauseState(runId);
      const logEntry = this.appendLog(runId, "info", "자동 실행을 재개했어요");
      this.runAutoQueue(runId);
      this.emitAll(runId, { logEntries: [logEntry] });
      return { ok: true, run: this.runtimeStore.getRun(runId) };
    }

    const current = this.runtimeStore.getRun(runId);
    const tasks = Array.isArray(current?.tasks) ? current.tasks.map((task) => ensureTaskDefaults(task)) : [];
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) {
      return { ok: false, code: "invalid_input", error: "task not found" };
    }

    const task = tasks[index];

    if (action === "assign_human") {
      task.assignee = assignee || "담당자 지정";
      task.assigneeType = "person";
      task.status = task.status === "completed" ? "completed" : "paused";
      this.patchRunTasks(runId, tasks, {
        status: "paused",
        pauseState: {
          reason: "human",
          taskId: task.id,
          whyHuman: task.whyHuman || "담당자 확인이 필요해요",
        },
      });
      const logEntry = this.appendLog(runId, "info", `담당자를 ${task.assignee}으로 지정했어요`);
      this.emitAll(runId, { logEntries: [logEntry] });
      return { ok: true, run: this.runtimeStore.getRun(runId) };
    }

    if (action === "human_done") {
      task.status = "completed";
      task.done = true;
      task.result = { owner: task.assignee || "담당자", completedAt: Date.now() };
      this.patchRunTasks(runId, tasks, { pauseState: null, status: "running" });
      const logEntry = this.appendLog(runId, "info", `사람 작업 완료: ${task.title}`);
      this.emitAll(runId, { logEntries: [logEntry] });
      this.runAutoQueue(runId);
      return { ok: true, run: this.runtimeStore.getRun(runId) };
    }

    if (action === "review_comment") {
      task.comments = [...(Array.isArray(task.comments) ? task.comments : []), comment || "검토 코멘트"];
      task.review = {
        ...(task.review && typeof task.review === "object" ? task.review : { status: "pending", comments: [] }),
        comments: task.comments,
      };
      this.patchRunTasks(runId, tasks, {
        status: "paused",
        pauseState: {
          reason: "review",
          taskId: task.id,
          whyHuman: task.whyHuman || "검토 코멘트 확인이 필요해요",
        },
      });
      const logEntry = this.appendLog(runId, "info", `검토 코멘트 등록: ${comment || "코멘트"}`);
      this.emitAll(runId, { logEntries: [logEntry] });
      return { ok: true, run: this.runtimeStore.getRun(runId) };
    }

    if (action === "review_request_changes") {
      const correctiveTask = ensureTaskDefaults({
        id: crypto.randomUUID(),
        phaseId: task.phaseId,
        phaseTitle: task.phaseTitle,
        title: `${task.phaseTitle || "리뷰"} 수정 반영`,
        role: "AI",
        status: "pending",
        whyHuman: "",
        assignee: "AI 실행",
        assigneeType: "ai",
      });
      task.status = "pending";
      task.done = false;
      task.review = {
        ...(task.review && typeof task.review === "object" ? task.review : {}),
        status: "changes_requested",
        lastComment: comment || "수정 요청",
      };
      tasks.splice(index, 0, correctiveTask);
      this.syncWbsWithTasks(runId, tasks);
      this.patchRunTasks(runId, tasks, { pauseState: null, status: "running" });
      const logEntry = this.appendLog(runId, "info", `수정 요청 접수: ${comment || "수정 요청"}`);
      this.emitAll(runId, { logEntries: [logEntry] });
      this.runAutoQueue(runId);
      return { ok: true, run: this.runtimeStore.getRun(runId) };
    }

    if (action === "review_approve") {
      const approvedAt = Date.now();
      task.status = "completed";
      task.done = true;
      task.review = {
        ...(task.review && typeof task.review === "object" ? task.review : {}),
        status: "approved",
        approvedAt,
        comment: comment || "",
      };
      const approvedArtifacts = this.finalizeWebResearchArtifacts(runId, approvedAt);
      this.patchRunTasks(runId, tasks, { pauseState: null, status: "running", artifacts: approvedArtifacts });
      const logEntry = this.appendLog(runId, "info", "검토 승인 완료");
      const transcriptEntry =
        run.usecaseId === "web_research"
          ? this.appendTranscript(runId, {
              taskId: task.id,
              phaseId: task.phaseId,
              role: "system",
              kind: "event",
              text: comment ? `결과 보고서를 승인하고 정리했어요 · 메모: ${comment}` : "결과 보고서를 승인하고 정리했어요",
              ts: approvedAt,
            })
          : null;
      this.emitAll(runId, { logEntries: [logEntry], transcriptEntries: transcriptEntry ? [transcriptEntry] : [] });
      this.runAutoQueue(runId);
      return { ok: true, run: this.runtimeStore.getRun(runId) };
    }

    if (action === "ai_execute") {
      if (task.role !== "AI") {
        return { ok: false, code: "invalid_input", error: "ai_execute supports AI role only" };
      }
      this.executeAiTask(runId, task.id, { manual: true });
      return { ok: true, run: this.runtimeStore.getRun(runId) };
    }

    return { ok: false, code: "invalid_input", error: "unsupported action" };
  }

  handleGatewayEvent({ runId, gatewayRunId, state, message, payload }) {
    const run = this.runtimeStore.getRun(runId);
    if (!run || !run.usecaseId) return false;

    const currentExecution =
      run.currentExecution && typeof run.currentExecution === "object" ? run.currentExecution : null;
    if (!currentExecution?.taskId) return true;

    const normalizedState = normalizeGatewayExecutionState(state);
    const text = extractGatewayText(message, payload);
    const executionFeatures = normalizeExecutionFeatures(payload?.executionFeatures || payload?.execution_features || run.executionFeatures);
    const executionFeaturesError = normalizeExecutionFeaturesError(payload?.executionFeaturesError || payload?.execution_features_error);
    const executionFeaturesStatus =
      executionFeatures.length === 0
        ? executionFeaturesError
          ? "failed"
          : "none"
        : normalizeExecutionFeaturesStatus(
            payload?.executionFeaturesStatus || payload?.execution_features_status || (executionFeaturesError ? "failed" : run.executionFeaturesStatus || "locked")
          );

    this.runtimeStore.patchRun(runId, {
      executionFeatures,
      executionFeaturesLockedAt: run.executionFeaturesLockedAt || Date.now(),
      executionFeaturesStatus,
      executionFeaturesError,
      updatedAt: Date.now(),
    });

    let logEntry = null;
    if (text) {
      const lastLog = Array.isArray(run.logs) && run.logs.length > 0 ? String(run.logs[run.logs.length - 1]?.message || "") : "";
      if (oneLine(lastLog) !== oneLine(text)) {
        logEntry = this.appendLog(runId, normalizedState === "error" || normalizedState === "aborted" ? "error" : "info", text);
      }
    }

    if (normalizedState === "final") {
      this.completeAiTaskFromGateway(runId, currentExecution.taskId, {
        responseText: text,
        payload,
        gatewayRunId: gatewayRunId || currentExecution.gatewayRunId || null,
      });
      return true;
    }

    if (normalizedState === "error") {
      this.failAiTask(runId, currentExecution.taskId, text || "Semo AI 실행 중 오류가 발생했어요");
      return true;
    }

    this.runtimeStore.patchRun(runId, {
      currentExecution: {
        ...currentExecution,
        gatewayRunId: gatewayRunId || currentExecution.gatewayRunId || null,
        gatewayState: normalizedState,
        lastEventAt: Date.now(),
      },
      updatedAt: Date.now(),
    });
    const transcriptEntry =
      normalizedState !== "running"
        ? this.appendTranscript(runId, {
            taskId: currentExecution.taskId,
            phaseId: currentExecution.phaseId || "",
            role: "system",
            kind: "event",
            text: text || `Semo AI 상태 업데이트: ${normalizedState}`,
            ts: Date.now(),
          })
        : null;
    this.emitAll(runId, {
      logEntries: logEntry ? [logEntry] : [],
      transcriptEntries: transcriptEntry ? [transcriptEntry] : [],
    });
    return true;
  }

  clearTimers(runId) {
    const key = String(runId);
    const timers = this.timerStore.get(key);
    if (Array.isArray(timers)) {
      for (const timer of timers) clearTimeout(timer);
    }
    this.timerStore.delete(key);
  }

  clearPauseState(runId) {
    const run = this.runtimeStore.getRun(runId);
    if (!run) return;
    this.runtimeStore.patchRun(runId, {
      pauseState: null,
      status: run.status === "completed" ? "completed" : "running",
      updatedAt: Date.now(),
    });
    this.emitAll(runId);
  }

  runAutoQueue(runId) {
    const run = this.runtimeStore.getRun(runId);
    if (!run || !run.usecaseId) return;
    if (run.status === "completed" || run.status === "failed") return;

    const tasks = Array.isArray(run.tasks) ? run.tasks.map((task) => ensureTaskDefaults(task)) : [];
    const next = tasks.find((task) => task.status !== "completed");

    if (!next) {
      this.finalizeRun(runId);
      return;
    }

    if (next.role === "AI") {
      if (next.status === "running") return;
      this.executeAiTask(runId, next.id, { manual: false });
      return;
    }

    const reason = next.role === "Human" ? "human" : "review";
    const pausedTasks = tasks.map((task) => {
      if (task.id !== next.id) return task;
      return {
        ...task,
        status: "paused",
        done: false,
      };
    });
    this.patchRunTasks(runId, pausedTasks, {
      status: "paused",
      pauseState: {
        reason,
        taskId: next.id,
        whyHuman: next.whyHuman || "사람 검토가 필요해요",
      },
      currentExecution: null,
    });
    const logEntry = this.appendLog(runId, "info", `${next.role} 단계 도달: ${next.whyHuman || "검토 후 계속 진행해요"}`);
    const transcriptEntry = this.appendTranscript(runId, {
      taskId: next.id,
      phaseId: next.phaseId,
      role: "system",
      kind: "event",
      text: `${next.role} 단계 도달: ${next.title}`,
      ts: Date.now(),
    });
    this.emitAll(runId, { logEntries: [logEntry], transcriptEntries: [transcriptEntry] });
  }

  executeAiTask(runId, taskId, { manual = false } = {}) {
    const run = this.runtimeStore.getRun(runId);
    if (!run || !run.usecaseId) return;
    const tasks = Array.isArray(run.tasks) ? run.tasks.map((task) => ensureTaskDefaults(task)) : [];
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return;

    const target = tasks[index];
    if (target.role !== "AI") return;
    if (target.status === "running") return;

    this.clearTimers(runId);

    target.status = "running";
    target.done = false;
    tasks[index] = target;

    this.patchRunTasks(runId, tasks, {
      status: "running",
      pauseState: null,
      currentExecution: {
        taskId: target.id,
        phaseId: target.phaseId,
        label: target.title,
        status: "running",
        gatewayState: "dispatching",
        startedAt: Date.now(),
        trigger: manual ? "manual_ai_execute" : "auto_queue",
      },
    });
    const logEntry = this.appendLog(runId, "info", `AI 실행 시작: ${target.title}`);
    const transcriptEntry = this.appendTranscript(runId, {
      taskId: target.id,
      phaseId: target.phaseId,
      role: "system",
      kind: "event",
      text: `AI 실행 시작: ${target.title}`,
      ts: Date.now(),
    });
    this.emitAll(runId, { logEntries: [logEntry], transcriptEntries: [transcriptEntry] });
    void this.dispatchAiTask(runId, target.id);
  }

  async captureGatewayHistoryBaseline(sessionKey) {
    const gateway = this.runtimeAdapter?.chatGateway;
    if (!gateway || typeof gateway.history !== "function") return 0;
    const normalizedSessionKey = String(sessionKey || "").trim();
    if (!normalizedSessionKey) return 0;
    try {
      const history = await gateway.history({
        sessionKey: normalizedSessionKey,
        limit: 200,
      });
      return extractHistoryMessages(history).length;
    } catch {
      return 0;
    }
  }

  async syncAiTaskFromHistory(runId, taskId) {
    const run = this.runtimeStore.getRun(runId);
    if (!run || !run.usecaseId) return;
    if (run.currentExecution?.taskId !== taskId) return;

    const gateway = this.runtimeAdapter?.chatGateway;
    if (!gateway || typeof gateway.history !== "function") return;

    try {
      const history = await gateway.history({
        sessionKey: String(run.sessionKey || ""),
        limit: 200,
      });
      const messages = extractHistoryMessages(history);
      const assistantReply = findAssistantReplyAfterBaseline(
        messages,
        run.currentExecution?.historyBaselineCount || 0,
        run.currentExecution?.startedAt || 0
      );
      if (!assistantReply) return;

      const syncLog = this.appendLog(runId, "info", "Semo AI 이벤트 응답이 늦어서 history 기준으로 실행을 이어가요");
      const syncTranscript = this.appendTranscript(runId, {
        taskId,
        phaseId: run.currentExecution?.phaseId || "",
        role: "system",
        kind: "event",
        text: "Semo AI 이벤트 대신 history 응답을 동기화했어요",
        ts: Date.now(),
      });
      this.emitAll(runId, {
        logEntries: syncLog ? [syncLog] : [],
        transcriptEntries: syncTranscript ? [syncTranscript] : [],
      });
      this.completeAiTaskFromGateway(runId, taskId, {
        responseText: assistantReply.text,
        payload: {},
        gatewayRunId: run.currentExecution?.gatewayRunId || null,
      });
    } catch {
      // ignore transient history sync failures and keep waiting for the normal gateway event
    }
  }

  async dispatchAiTask(runId, taskId) {
    const run = this.runtimeStore.getRun(runId);
    if (!run || !run.usecaseId) return;
    const tasks = Array.isArray(run.tasks) ? run.tasks.map((task) => ensureTaskDefaults(task)) : [];
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return;
    const task = tasks[index];
    if (task.role !== "AI" || task.status !== "running") return;

    const definition = USECASE_MAP.get(run.usecaseId);
    if (!definition) {
      this.failAiTask(runId, taskId, "유즈케이스 정의를 찾을 수 없어요");
      return;
    }

    const runAttachments = normalizeGatewayAttachments(run.attachments);
    const localWebResearchReady = definition.id === "web_research" ? this.resolveLocalWebResearchSetup() : null;
    if (definition.id === "web_research" && localWebResearchReady?.ready && runAttachments.length === 0) {
      await this.dispatchLocalWebResearchTask(runId, task, run);
      return;
    }

    const historyBaselineCount = await this.captureGatewayHistoryBaseline(run.sessionKey);
    const taskPrompt = this.buildTaskPrompt(definition, run, task, tasks);
    const logEntry = this.appendLog(runId, "info", `Semo AI 요청 전송: ${task.title}`);
    const transcriptEntry = this.appendTranscript(runId, {
      taskId: task.id,
      phaseId: task.phaseId,
      role: "ai",
      kind: "task_prompt",
      text: taskPrompt,
      ts: Date.now(),
    });
    this.emitAll(runId, { logEntries: [logEntry], transcriptEntries: [transcriptEntry] });

    const sent = await this.runtimeAdapter.sendMessage({
      runId,
      prompt: taskPrompt,
      sourceAction: `usecase_${run.usecaseId}`,
      disableLocalFallback: true,
      attachments: runAttachments,
    });
    if (!sent.ok) {
      this.failAiTask(runId, taskId, sent.error || "Semo AI 요청 전송 실패");
      return;
    }
    if (sent.localFallback) {
      this.failAiTask(runId, taskId, "Semo AI 실행 경로를 사용할 수 없어 확인이 필요해요");
      return;
    }

    if (sent.gatewayRunId && sent.gatewayRunId !== runId && this.bindGatewayAlias) {
      this.bindGatewayAlias(sent.gatewayRunId, runId);
    }

    const latest = this.runtimeStore.getRun(runId);
    if (!latest || latest.currentExecution?.taskId !== taskId) return;
    this.runtimeStore.patchRun(runId, {
      sourceType: "openclaw",
      currentExecution: {
        ...latest.currentExecution,
        gatewayRunId: sent.gatewayRunId || runId,
        gatewayState: "waiting_gateway",
        historyBaselineCount,
      },
      updatedAt: Date.now(),
    });
    this.emitAll(runId);

    const historyPoll = setInterval(() => {
      void this.syncAiTaskFromHistory(runId, taskId);
    }, GATEWAY_HISTORY_POLL_INTERVAL_MS);
    const timeout = setTimeout(() => {
      this.handleGatewayTimeout(runId, taskId);
    }, GATEWAY_TASK_TIMEOUT_MS);
    this.timerStore.set(String(runId), [historyPoll, timeout]);
  }

  resolveLocalWebResearchSetup() {
    const env = this.getExecutionEnv();
    const tavilyApiKey = String(env?.TAVILY_API_KEY || "").trim();
    const skillDir = String(this.getTavilySkillDir() || "").trim();
    const scriptPath = skillDir ? path.join(skillDir, "scripts", "search.mjs") : "";
    return {
      ready: Boolean(tavilyApiKey && scriptPath && fs.existsSync(scriptPath)),
      env,
      skillDir,
      scriptPath,
    };
  }

  async runTavilySearch(query, options = {}) {
    const setup = this.resolveLocalWebResearchSetup();
    if (!setup.ready) {
      throw new Error("Tavily 스킬이 준비되지 않았어요. API 키 또는 스크립트 경로를 확인해 주세요");
    }
    const args = [
      setup.scriptPath,
      query,
      "-n",
      String(options.maxResults || 6),
    ];
    if (options.deep !== false) args.push("--deep");
    if (options.topic) args.push("--topic", String(options.topic));
    if (Number.isFinite(Number(options.days))) args.push("--days", String(Number(options.days)));

    const { stdout } = await execFileAsync(process.execPath, args, {
      env: setup.env,
      cwd: setup.skillDir,
      maxBuffer: 1024 * 1024 * 8,
    });
    return parseTavilySearchOutput(stdout);
  }

  async dispatchLocalWebResearchTask(runId, task, run) {
    const input = run?.normalizedInput || {};
    const searchQuery = buildTavilySearchQuery(input);
    const taskPrompt = this.buildTaskPrompt(USECASE_MAP.get(run.usecaseId), run, task, Array.isArray(run.tasks) ? run.tasks : []);
    const dispatchLog = this.appendLog(
      runId,
      "info",
      task.phaseId === "phase_collect"
        ? `Tavily 검색 실행: ${searchQuery}`
        : "수집된 근거를 바탕으로 리서치 문서를 정리하고 있어요"
    );
    const promptTranscript = this.appendTranscript(runId, {
      taskId: task.id,
      phaseId: task.phaseId,
      role: "ai",
      kind: "task_prompt",
      text: taskPrompt,
      ts: Date.now(),
    });
    this.emitAll(runId, { logEntries: [dispatchLog], transcriptEntries: [promptTranscript] });

    try {
      let responseText = "";
      let usagePayload = {
        usage: {
          provider: "tavily-search",
          model: task.phaseId === "phase_collect" ? "tavily-search" : "heuristic-web-research",
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
      };

      if (task.phaseId === "phase_collect") {
        const tavilyResult = await this.runTavilySearch(searchQuery, {
          deep: true,
          maxResults: 6,
          topic: /뉴스|최근|최신/i.test(searchQuery) ? "news" : "general",
        });
        responseText = buildCollectedEvidenceMarkdown({
          run,
          query: searchQuery,
          answer: tavilyResult.answer,
          sources: tavilyResult.sources,
        });
      } else {
        const sections = Array.isArray(run?.artifacts?.sections) ? run.artifacts.sections : [];
        responseText = buildWebResearchDocumentMarkdown({
          run,
          sections,
        });
      }

      this.completeAiTaskFromGateway(runId, task.id, {
        responseText,
        payload: usagePayload,
        gatewayRunId: null,
      });
    } catch (error) {
      this.failAiTask(runId, task.id, error.message || "Tavily 웹 리서치 실행에 실패했어요");
    }
  }

  handleGatewayTimeout(runId, taskId) {
    const run = this.runtimeStore.getRun(runId);
    if (!run || !run.usecaseId) return;
    if (run.currentExecution?.taskId !== taskId) return;
    void this.handleGatewayTimeoutRecovery(runId, taskId);
  }

  async handleGatewayTimeoutRecovery(runId, taskId) {
    const initial = this.runtimeStore.getRun(runId);
    if (!initial || !initial.usecaseId) return;
    if (initial.currentExecution?.taskId !== taskId) return;

    await this.syncAiTaskFromHistory(runId, taskId);

    let run = this.runtimeStore.getRun(runId);
    if (!run || !run.usecaseId) return;
    if (run.currentExecution?.taskId !== taskId) return;

    const currentExecution = run.currentExecution && typeof run.currentExecution === "object" ? run.currentExecution : null;
    if (currentExecution && !currentExecution.timeoutGraceApplied) {
      this.clearTimers(runId);
      this.runtimeStore.patchRun(runId, {
        currentExecution: {
          ...currentExecution,
          timeoutGraceApplied: true,
          gatewayState: "waiting_gateway_grace",
          lastEventAt: Date.now(),
        },
        updatedAt: Date.now(),
      });
      const graceLog = this.appendLog(runId, "info", "Semo AI 응답이 늦어 조금 더 기다리는 중이에요");
      const graceTranscript = this.appendTranscript(runId, {
        taskId,
        phaseId: currentExecution.phaseId || "",
        role: "system",
        kind: "event",
        text: "Semo AI 응답 지연으로 추가 대기 시간을 적용했어요",
        ts: Date.now(),
      });
      this.emitAll(runId, {
        logEntries: graceLog ? [graceLog] : [],
        transcriptEntries: graceTranscript ? [graceTranscript] : [],
      });
      const historyPoll = setInterval(() => {
        void this.syncAiTaskFromHistory(runId, taskId);
      }, GATEWAY_HISTORY_POLL_INTERVAL_MS);
      const timeout = setTimeout(() => {
        this.handleGatewayTimeout(runId, taskId);
      }, GATEWAY_TASK_GRACE_TIMEOUT_MS);
      this.timerStore.set(String(runId), [historyPoll, timeout]);
      return;
    }

    const tasks = Array.isArray(run.tasks) ? run.tasks.map((task) => ensureTaskDefaults(task)) : [];
    const targetTask = tasks.find((task) => task.id === taskId) || null;
    const definition = USECASE_MAP.get(run.usecaseId);
    const runAttachments = normalizeGatewayAttachments(run.attachments);
    const localWebResearchReady = definition?.id === "web_research" ? this.resolveLocalWebResearchSetup() : null;

    if (
      definition?.id === "web_research" &&
      targetTask &&
      localWebResearchReady?.ready &&
      runAttachments.length === 0 &&
      !currentExecution?.localFallbackApplied
    ) {
      this.clearTimers(runId);
      this.runtimeStore.patchRun(runId, {
        currentExecution: {
          ...(currentExecution || {}),
          taskId,
          phaseId: targetTask.phaseId,
          label: targetTask.title,
          gatewayState: "local_retry",
          localFallbackApplied: true,
          lastEventAt: Date.now(),
        },
        updatedAt: Date.now(),
      });
      const retryLog = this.appendLog(runId, "info", "Semo AI 응답이 늦어 Tavily 리서치 경로로 이어서 진행해요");
      const retryTranscript = this.appendTranscript(runId, {
        taskId,
        phaseId: targetTask.phaseId,
        role: "system",
        kind: "event",
        text: "Tavily 로컬 리서치 경로로 자동 전환했어요",
        ts: Date.now(),
      });
      this.emitAll(runId, {
        logEntries: retryLog ? [retryLog] : [],
        transcriptEntries: retryTranscript ? [retryTranscript] : [],
      });
      await this.dispatchLocalWebResearchTask(runId, targetTask, this.runtimeStore.getRun(runId) || run);
      return;
    }

    this.failAiTask(runId, taskId, "Semo AI 응답이 지연되어 확인이 필요해요");
  }

  failAiTask(runId, taskId, reason) {
    this.clearTimers(runId);
    const run = this.runtimeStore.getRun(runId);
    if (!run || !run.usecaseId) return;
    const tasks = Array.isArray(run.tasks) ? run.tasks.map((task) => ensureTaskDefaults(task)) : [];
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return;

    const task = tasks[index];
    task.status = "paused";
    task.done = false;
    task.result = {
      error: String(reason || "Semo AI 실행 실패"),
      failedAt: Date.now(),
    };
    tasks[index] = task;

    const whyHuman = truncateText(oneLine(reason || "Semo AI 실행 실패"), 120);
    this.patchRunTasks(runId, tasks, {
      status: "paused",
      pauseState: {
        reason: "error",
        taskId: task.id,
        whyHuman: whyHuman || "Semo AI 실행 실패 확인 필요",
      },
      currentExecution: null,
    });
    const logEntry = this.appendLog(runId, "error", `AI 실행 실패: ${reason || "unknown error"}`);
    const transcriptEntry = this.appendTranscript(runId, {
      taskId: task.id,
      phaseId: task.phaseId,
      role: "system",
      kind: "event",
      text: `AI 실행 실패: ${reason || "unknown error"}`,
      ts: Date.now(),
    });
    this.emitAll(runId, { logEntries: [logEntry], transcriptEntries: [transcriptEntry] });
  }

  completeAiTaskFromGateway(runId, taskId, { responseText, payload, gatewayRunId } = {}) {
    this.clearTimers(runId);
    const run = this.runtimeStore.getRun(runId);
    if (!run || !run.usecaseId) return;
    const tasks = Array.isArray(run.tasks) ? run.tasks.map((task) => ensureTaskDefaults(task)) : [];
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return;

    const task = tasks[index];
    task.status = "completed";
    task.done = true;
    const compact = truncateText(oneLine(responseText || ""), 320);
    task.result = {
      summary: compact || "Semo AI 응답 수신",
      responseText: String(responseText || ""),
      gatewayRunId: gatewayRunId || null,
      completedAt: Date.now(),
    };
    tasks[index] = task;

    const usage = this.mergeUsage(run, payload);
    const artifacts = this.mergeArtifacts(run, task, task.result);

    this.patchRunTasks(runId, tasks, {
      status: "running",
      pauseState: null,
      currentExecution: null,
      usage,
      artifacts,
    });

    if (usage && typeof usage === "object") {
      this.runtimeAdapter.appendUsage(usage);
    }
    const logEntry = this.appendLog(runId, "info", `AI 실행 완료: ${task.title}`);
    const transcriptEntry = this.appendTranscript(runId, {
      taskId: task.id,
      phaseId: task.phaseId,
      role: "ai",
      kind: "task_response",
      text: String(responseText || task.result?.summary || "응답 없음"),
      ts: Date.now(),
    });
    this.emitAll(runId, { includeUsage: true, logEntries: [logEntry], transcriptEntries: [transcriptEntry] });
    this.runAutoQueue(runId);
  }

  buildTaskPrompt(definition, run, task, tasks) {
    const completed = tasks
      .filter((row) => row.id !== task.id && row.status === "completed")
      .map((row, index) => {
        const summary = truncateText(row.result?.responseText || row.result?.summary || "", 420);
        return `${index + 1}. ${row.title}\n${summary || "- 결과 없음 -"}`;
      })
      .join("\n\n");
    const attachments = normalizeGatewayAttachments(run.attachments);
    const attachmentSummary =
      attachments.length > 0
        ? attachments
            .map((item, index) => `- 첨부 ${index + 1}: ${item.filename || item.url || "attachment"}${item.mime ? ` (${item.mime})` : ""}`)
            .join("\n")
        : "- 없음";

    if (definition.id === "web_research") {
      const input = run.normalizedInput || {};
      return [
        "당신은 SEMO 실행 탭의 유즈케이스 AI 실행기예요",
        `유즈케이스: ${definition.name}`,
        `현재 태스크: ${task.title}`,
        "",
        "[입력값]",
        `- 조사 주제: ${input.topic || run.prompt}`,
        `- 비교 대상: ${(input.targets || []).join(", ") || "미지정 (핵심 사례를 먼저 식별)"}`,
        `- 출력 형식: ${input.outputFormat || "-"}`,
        `- 신뢰 소스 선호: ${(input.sourcePreference || []).join(", ") || "-"}`,
        "",
        "[첨부 자료]",
        attachmentSummary,
        "",
        "[이미 완료된 태스크 결과]",
        completed || "- 없음",
        "",
        "[출력 지시]",
        "1) 웹 리서치가 필요하면 기본 web_search 대신 Tavily 검색 결과를 우선 사용하세요",
        "2) 최신 근거를 중심으로 정리하고 가능한 한 URL 출처를 포함하세요",
        "3) 핵심 요약, 매출/수익화 근거 표, 의사결정 시사점을 포함하세요",
        "4) 실행 가능한 액션 아이템을 목록으로 제시하세요",
        "5) 과장 없이 사실/추정은 구분해서 작성하세요",
      ].join("\n");
    }

    const input = run.normalizedInput || {};
    return [
      "당신은 SEMO 실행 탭의 유즈케이스 AI 실행기예요",
      `유즈케이스: ${definition.name}`,
      `현재 태스크: ${task.title}`,
      "",
      "[입력값]",
      `- 문서 범위: ${input.scopePath || "project_dir"}`,
      `- 키워드/질문: ${(input.keywords || []).join(", ") || run.prompt}`,
      `- 출력: ${input.outputFormat || "summary_decision_todo"}`,
      "",
      "[이미 완료된 태스크 결과]",
      completed || "- 없음",
      "",
      "[출력 지시]",
      "1) 문서 후보 Top N과 선택 근거를 제시하세요",
      "2) 핵심 요약, 결정사항, 리스크, To-do를 분리해서 작성하세요",
      "3) 파일명이 있다면 그대로 표기하세요",
      "4) 모호한 부분은 확인 필요 항목으로 표시하세요",
    ].join("\n");
  }

  mergeUsage(run, payload) {
    const base = run.usage && typeof run.usage === "object" ? run.usage : {};
    const inputTokens = toFiniteNumber(
      readFirstValue(payload, ["usage.inputTokens", "usage.promptTokens", "inputTokens", "tokens.input", "message.usage.inputTokens"]),
      base.inputTokens
    );
    const outputTokens = toFiniteNumber(
      readFirstValue(payload, ["usage.outputTokens", "usage.completionTokens", "outputTokens", "tokens.output", "message.usage.outputTokens"]),
      base.outputTokens
    );
    const rawTotal = toFiniteNumber(
      readFirstValue(payload, ["usage.totalTokens", "totalTokens", "tokens.total", "message.usage.totalTokens"]),
      inputTokens + outputTokens
    );
    const totalTokens = Math.max(rawTotal, inputTokens + outputTokens);
    const costUsd = toFiniteNumber(
      readFirstValue(payload, ["usage.costUsd", "costUsd", "cost.usd", "message.usage.costUsd"]),
      base.costUsd
    );
    const provider =
      String(readFirstValue(payload, ["usage.provider", "provider", "message.usage.provider"]) || base.provider || "openclaw") || "openclaw";
    const model =
      String(readFirstValue(payload, ["usage.model", "model", "message.usage.model"]) || base.model || "gateway-rpc") || "gateway-rpc";

    return {
      runId: run.id,
      provider,
      model,
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd: Number(costUsd.toFixed(6)),
      ts: Date.now(),
    };
  }

  mergeArtifacts(run, task, result) {
    const base = run.artifacts && typeof run.artifacts === "object" ? clone(run.artifacts) : { sections: [], board: { items: [] } };
    const nextSections = Array.isArray(base.sections) ? [...base.sections] : [];
    const responseText = String(result?.responseText || result?.summary || "");
    nextSections.push({
      taskId: task.id,
      title: task.title,
      content: {
        summary: String(result?.summary || ""),
        responseText,
      },
      ts: Date.now(),
    });

    if (run.usecaseId === "web_research") {
      return buildWebResearchArtifacts(base, run, nextSections);
    }

    const combinedText = nextSections.map((section) => String(section?.content?.responseText || "")).join("\n\n");
    const fileCandidates = extractFileCandidates(combinedText).slice(0, 10);
    const bullets = extractBulletLines(combinedText);
    const decisions = bullets.filter((line) => /(결정|decision|합의|확정)/i.test(line)).slice(0, 8);
    const risks = bullets.filter((line) => /(리스크|risk|주의|blocker|이슈)/i.test(line)).slice(0, 8);
    const todoRows = bullets
      .filter((line) => /(todo|to-do|할일|해야|action|조치|후속)/i.test(line))
      .slice(0, 12)
      .map((line, index) => ({
        id: `todo-${index + 1}`,
        text: line,
        owner: "담당자 지정",
        status: "open",
      }));

    return {
      ...base,
      type: "document_action",
      sections: nextSections,
      result: {
        candidates: fileCandidates.map((name) => ({
          name,
          reason: "Semo AI 응답에서 언급됨",
        })),
        summary: truncateText(firstParagraph(responseText || combinedText) || "문서 요약을 생성했어요", 1500),
        decisions: decisions.length > 0 ? decisions : ["결정사항은 본문 응답을 확인하세요"],
        risks: risks.length > 0 ? risks : ["리스크는 본문 응답을 확인하세요"],
        todos: todoRows.map((row) => ({
          text: row.text,
          owner: row.owner,
          status: row.status,
        })),
      },
      board: {
        items: todoRows.map((row) => ({
          id: row.id,
          title: row.text,
          status: "todo",
        })),
      },
      updatedAt: Date.now(),
    };
  }

  finalizeRun(runId) {
    const run = this.runtimeStore.getRun(runId);
    if (!run) return;
    const tasks = Array.isArray(run.tasks) ? run.tasks.map((task) => ensureTaskDefaults(task)) : [];
    const allDone = tasks.every((task) => task.status === "completed");
    if (!allDone) return;
    const finalizedArtifacts = run.usecaseId === "web_research" ? this.finalizeWebResearchArtifacts(runId, run.artifacts?.report?.approvedAt || Date.now()) : run.artifacts;
    this.patchRunTasks(runId, tasks, {
      status: "completed",
      pauseState: null,
      currentExecution: null,
      artifacts: finalizedArtifacts,
    });
    const logEntry = this.appendLog(runId, "info", "전체 유즈케이스 실행이 완료돼서 결과를 저장하거나 공유할 수 있어요");
    const transcriptEntry =
      run.usecaseId === "web_research"
        ? this.appendTranscript(runId, {
            role: "system",
            kind: "event",
            text: "웹 리서치 실행이 완료되어 결과물과 로드맵을 확인할 수 있어요",
            ts: Date.now(),
          })
        : null;
    this.emitAll(runId, {
      includeUsage: true,
      logEntries: [logEntry],
      transcriptEntries: transcriptEntry ? [transcriptEntry] : [],
    });
  }

  syncWbsWithTasks(runId, tasks) {
    const run = this.runtimeStore.getRun(runId);
    if (!run?.wbs || !Array.isArray(run.wbs.phases)) return;
    const phases = run.wbs.phases.map((phase) => ({
      ...phase,
      tasks: tasks.filter((task) => String(task.phaseId) === String(phase.id)).map((task) => clone(task)),
    }));
    this.runtimeStore.patchRun(runId, {
      wbs: {
        ...run.wbs,
        phases,
      },
      updatedAt: Date.now(),
    });
  }

  patchRunTasks(runId, tasks, extraPatch = {}) {
    const current = this.runtimeStore.getRun(runId);
    if (!current) return null;
    const normalizedTasks = tasks.map((task) => ensureTaskDefaults(task));
    this.syncWbsWithTasks(runId, normalizedTasks);

    const statusSeed = String(extraPatch.status || current.status || "running");
    const allCompleted = normalizedTasks.length > 0 && normalizedTasks.every((task) => task.status === "completed");
    const hasPaused = normalizedTasks.some((task) => task.status === "paused");
    const derivedStatus = allCompleted ? "completed" : hasPaused ? "paused" : statusSeed === "failed" ? "failed" : "running";
    const stepInfo = deriveStepStatus(normalizedTasks, current.wbs, derivedStatus);

    return this.runtimeStore.patchRun(runId, {
      tasks: normalizedTasks,
      step: stepInfo.step,
      steps: stepInfo.steps,
      status: derivedStatus,
      pauseState: Object.prototype.hasOwnProperty.call(extraPatch, "pauseState") ? extraPatch.pauseState : current.pauseState,
      currentExecution: Object.prototype.hasOwnProperty.call(extraPatch, "currentExecution")
        ? extraPatch.currentExecution
        : current.currentExecution,
      artifacts: Object.prototype.hasOwnProperty.call(extraPatch, "artifacts") ? extraPatch.artifacts : current.artifacts,
      usage: Object.prototype.hasOwnProperty.call(extraPatch, "usage") ? extraPatch.usage : current.usage,
      updatedAt: Date.now(),
    });
  }

  appendLog(runId, level, message) {
    const updated = this.runtimeStore.appendRunLog(runId, message, level);
    return updated?.logs?.[updated.logs.length - 1] || null;
  }

  emitAll(runId, { includeUsage = false, logEntries = [], transcriptEntries = [] } = {}) {
    const run = this.runtimeStore.getRun(runId);
    if (!run) return;

    this.runtimeWsBroker.broadcastRun(runId, {
      type: "run_updated",
      run: summarizeRun(run),
      ts: Date.now(),
    });
    this.runtimeWsBroker.broadcastRun(runId, {
      type: "task_updated",
      runId,
      step: run.step,
      steps: Array.isArray(run.steps) ? run.steps : [],
      tasks: Array.isArray(run.tasks) ? run.tasks : [],
      wbs: run.wbs || null,
      pauseState: run.pauseState || null,
      currentExecution: run.currentExecution || null,
      artifacts: run.artifacts || null,
      executionTranscript: Array.isArray(run.executionTranscript) ? run.executionTranscript : [],
      ts: Date.now(),
    });
    for (const logEntry of Array.isArray(logEntries) ? logEntries.filter(Boolean) : []) {
      this.runtimeWsBroker.broadcastRun(runId, {
        type: "log_appended",
        runId,
        log: logEntry,
        ts: Date.now(),
      });
    }
    for (const transcriptEntry of Array.isArray(transcriptEntries) ? transcriptEntries.filter(Boolean) : []) {
      this.runtimeWsBroker.broadcastRun(runId, {
        type: "transcript_appended",
        runId,
        entry: transcriptEntry,
        ts: Date.now(),
      });
    }
    if (includeUsage) {
      this.runtimeWsBroker.broadcastRun(runId, {
        type: "usage_updated",
        runId,
        usage: run.usage || null,
        ts: Date.now(),
      });
    }
    this.runtimeWsBroker.broadcastSnapshot({
      items: this.runtimeStore.listRuns(),
      runById: { [runId]: run },
    });
  }
}

module.exports = {
  USECASE_DEFINITIONS,
  USECASE_MAP,
  UsecaseDemoRuntime,
  buildWbsFromDefinition,
  getUsecaseDefinition: (usecaseId) => USECASE_MAP.get(String(usecaseId || "")) || null,
  normalizeUsecaseInput,
};
