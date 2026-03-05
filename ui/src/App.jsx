import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Ellipsis,
  Home,
  Monitor,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Puzzle,
  Search,
  Send,
  Settings,
} from "lucide-react";
import OnboardingModal from "./onboarding/OnboardingModal";
import SettingsModal from "./components/SettingsModal";
import { fetchApiJson } from "./lib/http";

const APP_TABS = [
  { id: "home", name: "홈", icon: Home },
  { id: "runs", name: "실행", icon: Play },
  { id: "skills", name: "스킬", icon: Puzzle },
  { id: "monitor", name: "모니터", icon: Monitor },
];

const HOME_ACTIONS = ["웹 리서치", "문서 요약", "데이터 분석"];

const HOME_RECENTS = [
  { id: 1, title: "경쟁사 SaaS 분석 보고서", status: "실행중", duration: "2시간 32분", progress: 65, hex: "#3b82f6" },
  { id: 2, title: "경쟁사 SaaS 분석 보고서", status: "실행중", duration: "2시간 32분", progress: 20, hex: "#2dd4bf" },
  { id: 3, title: "경쟁사 SaaS 분석 보고서", status: "실행중", duration: "2시간 32분", progress: 85, hex: "#fb7185" },
];

const HOME_STATS = [
  { label: "오늘 실행 관련", value: "12" },
  { label: "알림", value: "3" },
  { label: "성공률", value: "94%" },
  { label: "토큰 사용", value: "2.4K" },
];

const RUN_LIST = [
  { id: 1, title: "경쟁사 SaaS 분석", status: "running" },
  { id: 2, title: "고객 인터뷰 요약", status: "completed" },
  { id: 3, title: "마케팅 채널 ROI", status: "running" },
  { id: 4, title: "제품 로드맵", status: "completed" },
];

const RUN_STATUS_COLOR = {
  running: "#22c55e",
  completed: "#a78bfa",
  failed: "#ef4444",
};

const RUN_STATUS_LABEL = {
  running: "실행중",
  completed: "완료",
  failed: "실패",
};

const RUN_STEPS = [1, 2, 3, 4, 5];

const RUN_TASKS = [
  { id: 1, text: "고객 인터뷰 요약고객 인터뷰 요약고객 인터뷰 요약", done: false, assignee: "AI 실행", assigneeType: "ai" },
  { id: 2, text: "고객 인터뷰 요약고객 인터뷰 요약", done: false, assignee: "AI 실행", assigneeType: "ai" },
  { id: 3, text: "고객 인터뷰 요약고객 인터뷰 요약고객 인터뷰 요약고객 인터뷰 요약", done: false, assignee: "00님", assigneeType: "person" },
  { id: 4, text: "고객 인터뷰 요약", done: false, assignee: "00님", assigneeType: "person" },
  { id: 5, text: "고객 인터뷰 요약", done: false, assignee: "AI 실행", assigneeType: "ai" },
];

const RUN_LOGS = [
  "[12:30:01] 데이터 수집 단계 시작...",
  "[12:31:15] API 호출 완료 - 200 OK",
  "[12:32:45] 데이터 파싱 진행중...",
  "[12:35:00] 분석 모델 로딩...",
  "[12:37:22] 중간 결과 저장 완료",
];

const SKILL_CARDS = [
  { id: 1, name: "스킬명이 적히는 란", description: "설명이 적혀있는 란 설명이 적혀있는 란설명이 적혀있는 란설명이 적혀있는 란", enabled: false },
  { id: 2, name: "스킬명이 적히는 란", description: "설명이 적혀있는 란 설명이 적혀있는 란설명이 적혀있는 란설명이 적혀있는 란", enabled: false },
  { id: 3, name: "스킬명이 적히는 란", description: "설명이 적혀있는 란 설명이 적혀있는 란설명이 적혀있는 란설명이 적혀있는 란", enabled: false },
  { id: 4, name: "스킬명이 적히는 란", description: "설명이 적혀있는 란 설명이 적혀있는 란설명이 적혀있는 란설명이 적혀있는 란", enabled: false },
  { id: 5, name: "스킬명이 적히는 란", description: "설명이 적혀있는 란 설명이 적혀있는 란설명이 적혀있는 란설명이 적혀있는 란", enabled: false },
  { id: 6, name: "스킬명이 적히는 란", description: "설명이 적혀있는 란 설명이 적혀있는 란설명이 적혀있는 란설명이 적혀있는 란", enabled: true },
];

const MONITOR_ROWS = [
  {
    id: 1,
    product: "The Lean Startup",
    author: "Eric Ries",
    genre: "Business",
    genreBg: "#dbeafe",
    genreText: "#1d4ed8",
    stock: "20 items",
    publisher: "Crown Business",
    price: "$15.99",
  },
  {
    id: 2,
    product: "Rich Dad Poor Dad",
    author: "Robert T. Kiyosaki",
    genre: "Personal Finance",
    genreBg: "#ede9fe",
    genreText: "#7c3aed",
    stock: "35 items",
    publisher: "Plata Publishing",
    price: "$12.99",
  },
  {
    id: 3,
    product: "1984",
    author: "George Orwell",
    genre: "Novel",
    genreBg: "#dcfce7",
    genreText: "#15803d",
    stock: "50 items",
    publisher: "Harcourt Brace Jovanovich",
    price: "$9.99",
  },
  {
    id: 4,
    product: "The Intelligent Investor",
    author: "Benjamin Graham",
    genre: "Personal Finance",
    genreBg: "#ede9fe",
    genreText: "#7c3aed",
    stock: "30 items",
    publisher: "HarperBusiness",
    price: "$19.99",
  },
  {
    id: 5,
    product: "To Kill a Mockingbird",
    author: "Harper Lee",
    genre: "Novel",
    genreBg: "#dcfce7",
    genreText: "#15803d",
    stock: "40 items",
    publisher: "J.B. Lippincott & Co.",
    price: "$7.99",
  },
];

function normalizeHashTab(hash) {
  const value = String(hash || "").replace(/^#/, "").toLowerCase();
  return APP_TABS.some((tab) => tab.id === value) ? value : "home";
}

function useHashTab() {
  const [activeTab, setActiveTab] = useState(() => (typeof window === "undefined" ? "home" : normalizeHashTab(window.location.hash)));

  useEffect(() => {
    const onHashChange = () => setActiveTab(normalizeHashTab(window.location.hash));
    onHashChange();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const selectTab = (nextTab) => {
    const normalized = normalizeHashTab(`#${nextTab}`);
    const nextHash = `#${normalized}`;
    if (window.location.hash === nextHash) {
      setActiveTab(normalized);
      return;
    }
    window.location.hash = nextHash;
  };

  return [activeTab, selectTab];
}

function useOnboardingState() {
  const [state, setState] = useState({
    loading: true,
    configured: false,
    onboardingInProgress: false,
    gatewayRunning: false,
    mode: "gui",
    interactiveAuthInProgress: false,
    lastErrorCode: null,
  });

  useEffect(() => {
    let timeout;
    let cancelled = false;

    const load = async () => {
      try {
        const json = await fetchApiJson("/api/ui/onboarding/state");
        if (!cancelled) {
          setState({
            loading: false,
            configured: Boolean(json.configured),
            onboardingInProgress: Boolean(json.onboardingInProgress),
            gatewayRunning: Boolean(json.gatewayRunning),
            mode: json.mode || "gui",
            interactiveAuthInProgress: Boolean(json.interactiveAuthInProgress),
            lastErrorCode: json.lastErrorCode || null,
          });
        }
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, loading: false }));
      } finally {
        if (!cancelled) timeout = setTimeout(load, 2000);
      }
    };

    load();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, []);

  return state;
}

function useMetrics(enabled) {
  const [metrics, setMetrics] = useState(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let timeout;
    let cancelled = false;

    const poll = async () => {
      try {
        const json = await fetchApiJson("/api/ui/system/metrics");
        if (!cancelled && json?.ok) setMetrics(json);
      } catch {
        // ignore poll errors
      } finally {
        if (!cancelled) timeout = setTimeout(poll, 1200);
      }
    };

    poll();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [enabled]);

  return metrics;
}

function Sidebar({ collapsed, onToggle, activeTab, onSelect, onOpenSettings }) {
  return (
    <aside className={`dash-sidebar ${collapsed ? "collapsed" : ""}`}>
      <div>
        <div className="dash-side-header">
          {collapsed ? (
            <div className="dash-avatar centered">S</div>
          ) : (
            <div className="dash-brand">
              <div className="dash-avatar">S</div>
              <span>SEMO</span>
            </div>
          )}

          {!collapsed ? (
            <button className="dash-icon-btn" onClick={onToggle} aria-label="사이드바 접기">
              <PanelLeftClose size={16} />
            </button>
          ) : null}
        </div>

        {collapsed ? (
          <div className="dash-side-toggle-row">
            <button className="dash-icon-btn" onClick={onToggle} aria-label="사이드바 펼치기">
              <PanelLeftOpen size={16} />
            </button>
          </div>
        ) : null}

        {!collapsed ? (
          <label className="dash-search">
            <Search size={16} />
            <input type="text" placeholder="검색" />
          </label>
        ) : null}

        <nav className="dash-side-nav">
          {!collapsed ? <p className="dash-side-label">메인 메뉴</p> : null}
          <ul className="dash-menu">
            {APP_TABS.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <li key={tab.id}>
                  <button className={`dash-menu-item ${active ? "active" : ""}`} onClick={() => onSelect(tab.id)} aria-current={active ? "page" : undefined}>
                    <Icon size={18} />
                    {!collapsed ? <span>{tab.name}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>

      <div className="dash-side-settings">
        {!collapsed ? <p className="dash-side-label">설정</p> : null}
        <button className="dash-menu-item" onClick={onOpenSettings}>
          <Settings size={18} />
          {!collapsed ? <span>설정</span> : null}
        </button>
      </div>
    </aside>
  );
}

function HomePage() {
  const [prompt, setPrompt] = useState("");

  return (
    <div className="dash-page dash-home-page dash-content-enter">
      <h1 className="dash-page-title">무엇을 시작할까요?</h1>
      <p className="dash-page-subtitle">목표를 입력하면 AI가 실행 가능한 프로젝트로 변환합니다</p>

      <div className="dash-input-row">
        <input value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="예: 다음 주 경쟁사 분석 보고서 초안 잡아줘" />
        <button className="dash-icon-btn subtle" aria-label="요청 보내기">
          <Send size={15} />
        </button>
      </div>

      <div className="dash-action-row">
        {HOME_ACTIONS.map((action) => (
          <button key={action} className="dash-pill-btn" onClick={() => setPrompt(action)}>
            {action}
          </button>
        ))}
      </div>

      <div className="dash-section-head">
        <h2>최근 내역</h2>
        <button className="dash-link-btn">
          더보기 <ArrowRight size={13} />
        </button>
      </div>

      <div className="dash-recent-grid">
        {HOME_RECENTS.map((item) => (
          <article key={item.id} className="dash-card">
            <div className="dash-recent-title-row">
              <span className="dash-dot" style={{ backgroundColor: item.hex }} />
              <strong>{item.title}</strong>
            </div>
            <p>
              {item.status} | {item.duration}
            </p>
            <div className="dash-progress-track">
              <span style={{ width: `${item.progress}%`, backgroundColor: item.hex }} />
            </div>
          </article>
        ))}
      </div>

      <h2 className="dash-section-title">오늘 실행</h2>
      <div className="dash-stats-grid">
        {HOME_STATS.map((stat) => (
          <article key={stat.label} className="dash-stat-card">
            <strong>{stat.value}</strong>
            <p>{stat.label}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function RunsPage() {
  const [activeRunId, setActiveRunId] = useState(1);
  const [activeStep, setActiveStep] = useState(3);
  const [tasks, setTasks] = useState(RUN_TASKS);

  const activeRun = RUN_LIST.find((run) => run.id === activeRunId);

  const toggleTaskDone = (taskId) => {
    setTasks((prev) => prev.map((task) => (task.id === taskId ? { ...task, done: !task.done } : task)));
  };

  return (
    <div className="dash-page dash-runs-page dash-content-enter">
      <aside className="dash-run-list-panel">
        <h2>실행 목록</h2>
        <ul>
          {RUN_LIST.map((run) => (
            <li key={run.id}>
              <button className={`dash-run-item ${activeRunId === run.id ? "active" : ""}`} onClick={() => setActiveRunId(run.id)}>
                <span className="dash-run-item-icon" />
                <span>{run.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="dash-run-detail-panel">
        {activeRun ? (
          <>
            <div className="dash-run-top">
              <h1>{activeRun.title}</h1>
              <div className="dash-run-status">
                <span className="dash-dot" style={{ backgroundColor: RUN_STATUS_COLOR[activeRun.status] }} />
                <span>{RUN_STATUS_LABEL[activeRun.status]}</span>
              </div>
            </div>

            <h3>실행 단계</h3>
            <div className="dash-steps">
              {RUN_STEPS.map((step) => (
                <button key={step} className="dash-step-col" onClick={() => setActiveStep(step)}>
                  <span className={`dash-step-box ${activeStep === step ? "active" : ""}`}>{step}</span>
                  <small className="dash-step-label">단계 이름</small>
                </button>
              ))}
            </div>

            <h3>태스크</h3>
            <div className="dash-task-list">
              {tasks.map((task) => (
                <div key={task.id} className="dash-task-row">
                  <div className="dash-task-left">
                    <input type="checkbox" checked={task.done} onChange={() => toggleTaskDone(task.id)} />
                    <p className={task.done ? "done" : ""}>{task.text}</p>
                  </div>
                  <span className={`dash-badge ${task.assigneeType}`}>{task.assignee}</span>
                </div>
              ))}
            </div>

            <div className="dash-log-box">
              <h4>로그 내용</h4>
              <div>
                {RUN_LOGS.map((log) => (
                  <p key={log}>{log}</p>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}

function SkillsPage() {
  const [skills, setSkills] = useState(SKILL_CARDS);

  const toggleSkill = (skillId) => {
    setSkills((prev) => prev.map((skill) => (skill.id === skillId ? { ...skill, enabled: !skill.enabled } : skill)));
  };

  return (
    <div className="dash-page dash-content-enter">
      <h1 className="dash-page-title dash-page-title-small">스킬</h1>
      <p className="dash-page-subtitle dash-page-subtitle-small">OS 능력을 확장하는 스토어</p>

      <article className="dash-skill-banner">
        <div>
          <h2>더 많은 스킬 탐색하기</h2>
          <p>커뮤니티 스킬 및 확장 패키지</p>
        </div>
        <ArrowRight size={18} />
      </article>

      <div className="dash-skill-grid">
        {skills.map((skill) => (
          <article key={skill.id} className="dash-skill-card">
            <header>
              <div className="dash-skill-icon" />
              <button className={`dash-skill-switch ${skill.enabled ? "on" : ""}`} onClick={() => toggleSkill(skill.id)} aria-label={`${skill.name} 토글`}>
                <span />
              </button>
            </header>
            <h3>{skill.name}</h3>
            <p>{skill.description}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function MonitorPage({ metrics }) {
  const [query, setQuery] = useState("");

  const filtered = MONITOR_ROWS.filter(
    (row) =>
      row.product.toLowerCase().includes(query.toLowerCase()) ||
      row.genre.toLowerCase().includes(query.toLowerCase()) ||
      row.publisher.toLowerCase().includes(query.toLowerCase())
  );

  const metricCards = [
    { label: "CPU", value: metrics?.cpuPercent ?? 42, unit: "%" },
    { label: "RAM", value: metrics?.memPercent ?? 67, unit: "%" },
    { label: "DISK", value: metrics?.diskPercent ?? 55, unit: "%" },
    { label: "NETWORK", value: typeof metrics?.rxBps === "number" ? Math.max(1, Math.round(metrics.rxBps / 1024)) : 23, unit: "KB/s" },
  ];

  return (
    <div className="dash-page dash-content-enter">
      <div className="dash-monitor-top">
        <section className="dash-monitor-table">
          <div className="dash-monitor-head">
            <h2>사용내역</h2>
            <label className="dash-inline-search">
              <Search size={14} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="검색" />
            </label>
          </div>

          <div className="dash-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>상품</th>
                  <th>분류</th>
                  <th>재고</th>
                  <th>출판사</th>
                  <th>가격</th>
                  <th>작업</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <div className="dash-product-cell">
                        <div className="dash-thumb" />
                        <div>
                          <strong>{row.product}</strong>
                          <p>{row.author}</p>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className="dash-tag" style={{ backgroundColor: row.genreBg, color: row.genreText }}>
                        {row.genre}
                      </span>
                    </td>
                    <td>{row.stock}</td>
                    <td>{row.publisher}</td>
                    <td>{row.price}</td>
                    <td>
                      <button className="dash-icon-btn subtle">
                        <Ellipsis size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="dash-monitor-side">사용량 관련</section>
      </div>

      <section className="dash-monitor-metrics">
        {metricCards.map((card) => (
          <article key={card.label} className="dash-monitor-card">
            <h3>{card.label}</h3>
            <div className="dash-metric-value">
              <strong>{card.value}</strong>
              <span>{card.unit}</span>
            </div>
            <div className="dash-meter-track">
              <span style={{ width: `${Math.min(100, Number(card.value))}%` }} />
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}

function DashboardMain({ activeTab, onSelectTab }) {
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const metrics = useMetrics(activeTab === "monitor");

  return (
    <>
      <div className="dash-shell">
        <Sidebar
          collapsed={collapsed}
          onToggle={() => setCollapsed((prev) => !prev)}
          activeTab={activeTab}
          onSelect={onSelectTab}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <main className="dash-main">
          {activeTab === "home" ? <HomePage /> : null}
          {activeTab === "runs" ? <RunsPage /> : null}
          {activeTab === "skills" ? <SkillsPage /> : null}
          {activeTab === "monitor" ? <MonitorPage metrics={metrics} /> : null}
        </main>
      </div>

      <SettingsModal open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

export default function App() {
  const onboardingState = useOnboardingState();
  const [activeTab, setActiveTab] = useHashTab();
  const [dashboardUnlocked, setDashboardUnlocked] = useState(false);
  const [leavingOnboarding, setLeavingOnboarding] = useState(false);

  useEffect(() => {
    if (onboardingState.configured) setDashboardUnlocked(true);
  }, [onboardingState.configured]);

  const handleOnboardingDone = () => {
    setLeavingOnboarding(true);
    window.setTimeout(() => {
      setDashboardUnlocked(true);
      setLeavingOnboarding(false);
    }, 420);
  };

  if (onboardingState.loading) {
    return (
      <div className="page loading-page">
        <div className="loading-block">
          <p className="eyebrow">SEMO OpenClaw</p>
          <h1>커스텀 UI 게이트웨이를 불러오는 중...</h1>
        </div>
      </div>
    );
  }

  if (!onboardingState.configured && !dashboardUnlocked) {
    return (
      <div className={`onboarding-overlay-page ${leavingOnboarding ? "leaving" : ""}`}>
        <OnboardingModal onDone={handleOnboardingDone} />
      </div>
    );
  }

  return <DashboardMain activeTab={activeTab} onSelectTab={setActiveTab} />;
}
