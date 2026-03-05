import { useEffect, useMemo, useState } from "react";
import { Bot, Settings2, X } from "lucide-react";

const TABS = [
  { id: "ai", label: "AI 서비스", icon: Bot },
  { id: "general", label: "일반", icon: Settings2 },
];

const INITIAL_SERVICES = [
  { id: "openai", name: "OpenAI", description: "GPT-4o, GPT-4o-mini", enabled: false, apiKey: "" },
  { id: "anthropic", name: "Anthropic", description: "Claude 4 Sonnet, Opus", enabled: false, apiKey: "" },
  { id: "google", name: "Google AI", description: "Gemini Pro, Gemini Flash", enabled: false, apiKey: "" },
  { id: "perplexity", name: "Perplexity", description: "웹 검색 + AI", enabled: false, apiKey: "" },
];

function Toggle({ checked, onChange, ariaLabel }) {
  return (
    <button
      type="button"
      className={`dash-modal-switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
      aria-label={ariaLabel}
    >
      <span />
    </button>
  );
}

export default function SettingsModal({ open, onOpenChange }) {
  const [activeTab, setActiveTab] = useState("ai");
  const [services, setServices] = useState(INITIAL_SERVICES);
  const [notifications, setNotifications] = useState(true);
  const [autoRun, setAutoRun] = useState(false);
  const [defaultModel, setDefaultModel] = useState("gpt-4o");

  useEffect(() => {
    if (!open) return undefined;
    const onKeydown = (event) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [open, onOpenChange]);

  const servicesById = useMemo(() => {
    const map = {};
    services.forEach((service) => {
      map[service.id] = service;
    });
    return map;
  }, [services]);

  if (!open) return null;

  const toggleService = (id) => {
    setServices((prev) => prev.map((service) => (service.id === id ? { ...service, enabled: !service.enabled } : service)));
  };

  const updateApiKey = (id, apiKey) => {
    setServices((prev) => prev.map((service) => (service.id === id ? { ...service, apiKey } : service)));
  };

  return (
    <div className="dash-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onOpenChange(false)}>
      <section className="dash-modal" role="dialog" aria-modal="true" aria-label="설정">
        <button className="dash-modal-close" aria-label="설정 닫기" onClick={() => onOpenChange(false)}>
          <X size={16} />
        </button>

        <div className="dash-modal-layout">
          <aside className="dash-modal-sidebar">
            <h2>설정</h2>
            <nav>
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const active = tab.id === activeTab;
                return (
                  <button
                    key={tab.id}
                    className={`dash-modal-tab ${active ? "active" : ""}`}
                    onClick={() => setActiveTab(tab.id)}
                  >
                    <Icon size={16} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>

          <div className="dash-modal-content">
            {activeTab === "ai" ? (
              <div className="dash-modal-stack">
                <header>
                  <h3>AI 서비스</h3>
                  <p>AI 서비스 연결 및 모델을 설정합니다</p>
                </header>

                <div className="dash-modal-field">
                  <label htmlFor="default-model">기본 모델</label>
                  <select id="default-model" value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)}>
                    <option value="gpt-4o">GPT-4o</option>
                    <option value="gpt-4o-mini">GPT-4o-mini</option>
                    <option value="claude-sonnet">Claude 4 Sonnet</option>
                    <option value="gemini-pro">Gemini Pro</option>
                  </select>
                </div>

                <div className="dash-modal-service-list">
                  <p className="dash-modal-sub">연결된 서비스</p>
                  {INITIAL_SERVICES.map((service) => {
                    const item = servicesById[service.id];
                    return (
                      <article key={service.id} className="dash-modal-service-card">
                        <div className="dash-modal-service-head">
                          <div>
                            <p className="name">{service.name}</p>
                            <p className="desc">{service.description}</p>
                          </div>
                          <Toggle checked={Boolean(item?.enabled)} onChange={() => toggleService(service.id)} ariaLabel={`${service.name} 토글`} />
                        </div>
                        {item?.enabled ? (
                          <div className="dash-modal-field compact">
                            <input
                              type="password"
                              value={item.apiKey}
                              onChange={(event) => updateApiKey(service.id, event.target.value)}
                              placeholder="API 키 (sk-...)"
                            />
                          </div>
                        ) : null}
                      </article>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {activeTab === "general" ? (
              <div className="dash-modal-stack">
                <header>
                  <h3>일반</h3>
                  <p>시스템 환경을 설정합니다</p>
                </header>

                <article className="dash-modal-general-card">
                  <div>
                    <p className="name">알림</p>
                    <p className="desc">실행 완료 시 알림을 받습니다</p>
                  </div>
                  <Toggle checked={notifications} onChange={setNotifications} ariaLabel="알림 토글" />
                </article>

                <article className="dash-modal-general-card">
                  <div>
                    <p className="name">자동 실행</p>
                    <p className="desc">스케줄에 따라 태스크를 자동 실행합니다</p>
                  </div>
                  <Toggle checked={autoRun} onChange={setAutoRun} ariaLabel="자동 실행 토글" />
                </article>

                <div className="dash-modal-field">
                  <label htmlFor="webhook-url">웹훅 URL</label>
                  <input id="webhook-url" type="text" placeholder="https://example.com/webhook" />
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
