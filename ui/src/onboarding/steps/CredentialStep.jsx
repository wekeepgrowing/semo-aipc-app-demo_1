import { useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";

function fieldAutoComplete(fieldId) {
  const map = {
    openaiApiKey: "off",
    anthropicApiKey: "off",
    geminiApiKey: "off",
    xaiApiKey: "off",
    mistralApiKey: "off",
    openrouterApiKey: "off",
    kilocodeApiKey: "off",
    zaiApiKey: "off",
    qianfanApiKey: "off",
    minimaxApiKey: "off",
    moonshotApiKey: "off",
    volcengineApiKey: "off",
    byteplusApiKey: "off",
    aiGatewayApiKey: "off",
  };
  return map[fieldId] || "off";
}

function providerHint(providerLabel) {
  const lower = String(providerLabel || "").toLowerCase();
  if (lower.includes("openai")) return "OpenAI 공식 사이트 › API 설정 › 키 발급 메뉴에서 복사하세요";
  if (lower.includes("anthropic")) return "Anthropic Console › API Keys 메뉴에서 새 키를 발급해 복사하세요";
  if (lower.includes("google")) return "Google AI Studio › API keys 메뉴에서 키를 생성해 복사하세요";
  if (lower.includes("chutes")) return "Chutes 공식 사이트 › API Keys 메뉴에서 키 또는 코드를 확인하세요";
  if (lower.includes("xai")) return "xAI Console › API Keys 메뉴에서 새 키를 발급해 복사하세요";
  if (lower.includes("mistral")) return "Mistral Console › API Keys 메뉴에서 키를 생성해 복사하세요";
  if (lower.includes("openrouter")) return "OpenRouter 대시보드 › Keys 메뉴에서 키를 발급해 복사하세요";
  if (lower.includes("vercel")) return "Vercel AI Gateway › API Keys 메뉴에서 키를 발급해 복사하세요";
  return `${providerLabel} 공식 사이트 › API 설정 › 키 발급 메뉴에서 복사하세요`;
}

export default function CredentialStep({ providerLabel, method, credentials, onChange }) {
  const [visibleMap, setVisibleMap] = useState({});
  const fields = Array.isArray(method?.fields) ? method.fields : [];

  return (
    <div className="ov0-step">
      <div className="ov0-head">
        <h2>API 키를 입력해 주세요</h2>
        <p>
          <strong>{providerLabel}</strong> 대시보드에서 발급받은 키를 입력해 주세요
        </p>
      </div>

      <div className="ov0-form-list">
        {fields.map((field, index) => {
          const visible = Boolean(visibleMap[field.id]);
          return (
            <label key={field.id} className="ov0-field" htmlFor={`credential-${index}`}>
              <span>{field.label}</span>
              <div className="ov0-input-wrap">
                <input
                  id={`credential-${index}`}
                  type={visible ? "text" : field.type || "password"}
                  value={credentials[field.id] || ""}
                  onChange={(event) => onChange(field.id, event.target.value)}
                  placeholder={field.placeholder || ""}
                  autoComplete={fieldAutoComplete(field.id)}
                />
                {(field.type || "password") === "password" ? (
                  <button
                    type="button"
                    className="ov0-eye-btn"
                    onClick={() => {
                      setVisibleMap((prev) => ({ ...prev, [field.id]: !prev[field.id] }));
                    }}
                    aria-label={visible ? "키 숨기기" : "키 보기"}
                  >
                    {visible ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                ) : null}
              </div>
            </label>
          );
        })}
      </div>

      <div className="ov0-note">
        <KeyRound size={14} />
        <p>
          <strong>어디서 키를 받나요?</strong>
          <br />
          {providerHint(providerLabel)}
        </p>
      </div>
    </div>
  );
}
