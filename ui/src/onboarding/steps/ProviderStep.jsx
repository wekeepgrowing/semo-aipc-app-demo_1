import { Bot, Cloud, Cpu, Sparkles, Zap } from "lucide-react";

function providerMeta(provider) {
  const iconMap = {
    openai: Sparkles,
    anthropic: Bot,
    google: Zap,
    azure: Cloud,
    custom: Cpu,
  };
  const Icon = iconMap[provider.id] || Cpu;
  const methods = Array.isArray(provider.methods) ? provider.methods : [];
  const summary = typeof provider.modelSummary === "string" ? provider.modelSummary.trim() : "";
  const description = summary || (methods.length ? methods.slice(0, 2).map((method) => method.label).join(", ") : "기본 연결 방식");
  return { Icon, description };
}

export default function ProviderStep({ providers, selectedProviderId, onSelect }) {
  return (
    <div className="ov0-step">
      <div className="ov0-head">
        <h2>어떤 AI 서비스를 쓰나요?</h2>
        <p>연결할 AI 서비스를 골라주세요</p>
      </div>

      <div className="ov0-list ov0-provider-list" role="list" aria-label="서비스 목록">
        {providers.map((provider) => {
          const selected = provider.id === selectedProviderId;
          const { Icon, description } = providerMeta(provider);
          return (
            <button key={provider.id} type="button" className={`ov0-item ${selected ? "selected" : ""}`} onClick={() => onSelect(provider.id)}>
              <span
                className="ov0-item-icon"
                style={{
                  background: selected ? "var(--ov0-primary)" : "var(--ov0-secondary)",
                  color: selected ? "var(--ov0-primary-foreground)" : "var(--ov0-muted-foreground)",
                }}
              >
                <Icon size={18} />
              </span>
              <span className="ov0-item-body">
                <strong>{provider.label}</strong>
                <small>{description}</small>
              </span>
              <span className={`ov0-radio ${selected ? "selected" : ""}`}>{selected ? <span /> : null}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
