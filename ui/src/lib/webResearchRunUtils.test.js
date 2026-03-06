import { describe, expect, it } from "vitest";
import { buildReportShareText, buildResultHandoffPrompt, normalizeRoadmapGraph } from "./webResearchRunUtils";

describe("normalizeRoadmapGraph", () => {
  it("builds a fallback roadmap when graph data is missing", () => {
    const graph = normalizeRoadmapGraph(null, "AI 자동화 도구");

    expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
    expect(graph.edges.length).toBeGreaterThanOrEqual(3);
    expect(graph.nodes[0].data.label).toContain("AI 자동화 도구");
  });

  it("preserves existing graph labels while decorating nodes", () => {
    const graph = normalizeRoadmapGraph(
      {
        direction: "LR",
        nodes: [{ id: "root", position: { x: 0, y: 0 }, data: { label: "시장 조사", tone: "root" } }],
        edges: [],
      },
      "fallback"
    );

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0].data.label).toBe("시장 조사");
    expect(graph.nodes[0].style).toBeTruthy();
  });
});

describe("buildReportShareText", () => {
  it("serializes the report into a readable share payload", () => {
    const text = buildReportShareText({
      title: "시장 개요: AI 자동화 도구",
      summary: "중소기업용 자동화 도구는 노코드 플랫폼 중심으로 확장 중이에요",
      comparisonRows: [{ name: "Zapier", summary: "연동 생태계가 넓어요" }],
      recommendation: "빠른 구축은 Zapier가 유리해요",
      actions: ["핵심 후보 3개 추가 검증"],
      sources: [{ label: "근거 1", url: "https://example.com" }],
    });

    expect(text).toContain("시장 개요: AI 자동화 도구");
    expect(text).toContain("비교");
    expect(text).toContain("Zapier");
    expect(text).toContain("https://example.com");
  });
});

describe("buildResultHandoffPrompt", () => {
  it("wraps the markdown result in a concise chat handoff prompt", () => {
    const prompt = buildResultHandoffPrompt("시장 조사", "# 시장 조사\n\n## 요약\n내용");

    expect(prompt).toContain("승인된 웹 리서치 결과 문서");
    expect(prompt).toContain('리서치 결과 불러옴, 이어서 질문해 주세요');
    expect(prompt).toContain("문서 제목: 시장 조사");
    expect(prompt).toContain("# 시장 조사");
  });
});
