import { Globe, Key, Settings } from "lucide-react";

function methodView(method) {
  const id = String(method?.id || "").toLowerCase();

  if (String(method?.mode || "") === "non_interactive") {
    return {
      Icon: Key,
      title: "키 직접 입력",
      description: "발급받은 API 키를 직접 붙여넣어요",
    };
  }

  if (id.includes("token")) {
    return {
      Icon: Settings,
      title: "설정 코드 사용",
      description: "서비스에서 받은 설정 코드를 사용해요",
    };
  }

  return {
    Icon: Globe,
    title: "간편 로그인",
    description: "브라우저에서 로그인하고 바로 연결돼요",
  };
}

export default function MethodStep({ provider, selectedMethodId, onSelect }) {
  if (!provider) {
    return (
      <div className="ov0-step">
        <p className="error-text">서비스를 먼저 선택해 주세요</p>
      </div>
    );
  }

  return (
    <div className="ov0-step">
      <div className="ov0-head">
        <h2>어떻게 연결할까요?</h2>
        <p>
          <strong>{provider.label}</strong>에 연결하는 방법을 선택해 주세요
        </p>
      </div>

      <div className="ov0-list" role="list" aria-label="연결 방식">
        {provider.methods.map((method) => {
          const selected = method.id === selectedMethodId;
          const { Icon, title, description } = methodView(method);
          return (
            <button key={method.id} type="button" className={`ov0-item ${selected ? "selected" : ""}`} onClick={() => onSelect(method.id)}>
              <span className="ov0-item-icon" style={{ background: selected ? "var(--ov0-primary)" : "#EBF0F8", color: selected ? "#fff" : "#111111" }}>
                <Icon size={18} />
              </span>
              <span className="ov0-item-body">
                <strong>{title}</strong>
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
