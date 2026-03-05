import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { fetchApiJson } from "../lib/http";
import ProviderStep from "./steps/ProviderStep";
import MethodStep from "./steps/MethodStep";
import CredentialStep from "./steps/CredentialStep";
import ApplyingStep from "./steps/ApplyingStep";
import ConnectStep from "./steps/ConnectStep";
import FinalizeStep from "./steps/FinalizeStep";
import OAuthInteractiveStep from "./steps/OAuthInteractiveStep";
import StepIndicator from "./steps/StepIndicator";

const RESET_SCOPE_DEFAULT = "none";
const STEP_LABELS = ["서비스", "연결 방식", "인증", "적용", "확인"];

function formatApiError(payload, fallback = "요청 처리에 실패했습니다.") {
  if (!payload || typeof payload !== "object") return fallback;
  if (payload.code && payload.error) return `[${payload.code}] ${payload.error}`;
  if (payload.error) return payload.error;
  return fallback;
}

function needsCredential(method) {
  return Boolean(Array.isArray(method?.requiredFields) && method.requiredFields.length > 0);
}

function validateCredential(method, credentials) {
  if (!needsCredential(method)) return true;
  return method.requiredFields.every((field) => String(credentials[field] || "").trim().length > 0);
}

export default function OnboardingModal({ onDone }) {
  const [loading, setLoading] = useState(true);
  const [optionsError, setOptionsError] = useState("");
  const [options, setOptions] = useState(null);

  const [step, setStep] = useState(0);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedMethodId, setSelectedMethodId] = useState("");
  const [credentials, setCredentials] = useState({});

  const [connectStatus, setConnectStatus] = useState("idle");
  const [connectError, setConnectError] = useState("");
  const [interactiveSessionId, setInteractiveSessionId] = useState("");
  const [interactiveDone, setInteractiveDone] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadOptions = async () => {
      try {
        setLoading(true);
        setOptionsError("");

        const json = await fetchApiJson("/api/ui/onboarding/options");
        if (!json.ok) throw new Error(formatApiError(json));
        if (cancelled) return;

        setOptions(json);
        const firstProvider = json.providers?.[0];
        if (firstProvider) {
          setSelectedProviderId(firstProvider.id);
          setSelectedMethodId(firstProvider.methods?.[0]?.id || "");
        }
      } catch (error) {
        if (!cancelled) {
          setOptionsError(error.message || "온보딩 옵션을 불러오지 못했습니다.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadOptions();

    return () => {
      cancelled = true;
    };
  }, []);

  const selectedProvider = useMemo(() => options?.providers?.find((provider) => provider.id === selectedProviderId) || null, [options, selectedProviderId]);
  const selectedMethod = useMemo(() => selectedProvider?.methods?.find((method) => method.id === selectedMethodId) || null, [selectedProvider, selectedMethodId]);

  useEffect(() => {
    if (!selectedProvider) return;
    if (!selectedMethod || !selectedProvider.methods.some((method) => method.id === selectedMethodId)) {
      setSelectedMethodId(selectedProvider.methods?.[0]?.id || "");
    }
  }, [selectedProvider, selectedMethod, selectedMethodId]);

  const providerLabel = selectedProvider?.label || "";
  const methodLabel = selectedMethod?.label || "";
  const credentialRequired = needsCredential(selectedMethod);
  const interactiveRequired = selectedMethod?.mode === "interactive_required";
  const connected = connectStatus === "connected";

  const canNext = useMemo(() => {
    switch (step) {
      case 0:
        return Boolean(selectedProviderId);
      case 1:
        return Boolean(selectedMethodId);
      case 2:
        return validateCredential(selectedMethod, credentials);
      case 3:
        return connected;
      case 4:
        return true;
      default:
        return false;
    }
  }, [step, selectedProviderId, selectedMethodId, selectedMethod, credentials, connected]);

  const resetProgress = () => {
    setConnectStatus("idle");
    setConnectError("");
    setInteractiveSessionId("");
    setInteractiveDone(false);
  };

  const onProviderSelect = (providerId) => {
    setSelectedProviderId(providerId);
    const provider = options?.providers?.find((entry) => entry.id === providerId);
    setSelectedMethodId(provider?.methods?.[0]?.id || "");
    setCredentials({});
    resetProgress();
  };

  const onMethodSelect = (methodId) => {
    setSelectedMethodId(methodId);
    resetProgress();
  };

  const onCredentialChange = (field, value) => {
    setCredentials((prev) => ({ ...prev, [field]: value }));
  };

  const onConnectApply = async () => {
    if (!selectedProvider || !selectedMethod) return;

    try {
      setConnectStatus("connecting");
      setConnectError("");
      setInteractiveSessionId("");
      setInteractiveDone(false);

      const json = await fetchApiJson("/api/ui/onboarding/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId: selectedProvider.id,
          methodId: selectedMethod.id,
          credentials,
          options: {
            resetScope: RESET_SCOPE_DEFAULT,
          },
        }),
      });

      if (json.status === "configured") {
        setConnectStatus("connected");
        setInteractiveDone(true);
        return;
      }

      if (json.status === "interactive_required" && json.sessionId) {
        setConnectStatus("connected");
        setInteractiveSessionId(json.sessionId);
        return;
      }

      throw new Error("알 수 없는 응답 상태입니다.");
    } catch (error) {
      setConnectStatus("idle");
      setConnectError(error.message || "설정 적용에 실패했습니다.");
    }
  };

  const onInteractiveCancel = async () => {
    if (!interactiveSessionId) return;

    try {
      await fetchApiJson("/api/ui/onboarding/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: interactiveSessionId }),
      });
    } catch {
      // ignore cancellation errors
    }

    setInteractiveSessionId("");
    setInteractiveDone(false);
    setConnectStatus("idle");
    setConnectError("[interactive_cancelled] 인증이 취소되었습니다.");
    setStep(3);
  };

  const onInteractiveExit = (result) => {
    if (result?.ok) {
      setInteractiveDone(true);
      setConnectError("");
      return;
    }

    setInteractiveSessionId("");
    setInteractiveDone(false);
    setConnectStatus("idle");
    setConnectError(result?.message || `[${result?.code || "cli_failed"}] 인증에 실패했습니다.`);
    setStep(3);
  };

  const handleNext = () => {
    if (step === 1 && !credentialRequired) {
      setStep(3);
      void onConnectApply();
      return;
    }
    if (step === 2 && credentialRequired) {
      setStep(3);
      void onConnectApply();
      return;
    }
    if (step < 4) setStep(step + 1);
  };

  const handleBack = () => {
    if (step === 3 && !credentialRequired) {
      setStep(1);
      resetProgress();
      return;
    }

    if (step > 0) {
      setStep(step - 1);
      if (step === 4) setConnectStatus("idle");
    }
  };

  const triggerDone = () => {
    if (typeof onDone === "function") {
      onDone();
      return;
    }
    window.location.reload();
  };

  const isLastNavStep = step === 4;

  return (
    <section className="onboarding-modal-wrap" aria-live="polite">
      <div className="ov0-root">
        <div className="ov0-card">
          {loading ? <ApplyingStep /> : null}

          {!loading && optionsError ? (
            <div className="ov0-step">
              <p className="error-text">{optionsError}</p>
              <button type="button" className="ov0-btn primary" onClick={() => window.location.reload()}>
                다시 시도
              </button>
            </div>
          ) : null}

          {!loading && !optionsError ? (
            <>
              <div className="ov0-indicator-wrap">
                <StepIndicator steps={STEP_LABELS} currentStep={step} />
              </div>

              <div key={step} className="ov0-step-stage">
                {step === 0 ? <ProviderStep providers={options?.providers || []} selectedProviderId={selectedProviderId} onSelect={onProviderSelect} /> : null}
                {step === 1 ? <MethodStep provider={selectedProvider} selectedMethodId={selectedMethodId} onSelect={onMethodSelect} /> : null}
                {step === 2 && credentialRequired ? (
                  <CredentialStep providerLabel={providerLabel} method={selectedMethod} credentials={credentials} onChange={onCredentialChange} />
                ) : null}
                {step === 3 ? (
                  <ConnectStep method={selectedMethod} providerLabel={providerLabel} status={connectStatus} error={connectError} onConnect={onConnectApply} />
                ) : null}
                {step === 4 ? (
                  <FinalizeStep
                    providerLabel={providerLabel}
                    methodLabel={methodLabel}
                    interactiveRequired={interactiveRequired}
                    interactiveDone={interactiveDone}
                    onFinalize={triggerDone}
                  >
                    {interactiveRequired && interactiveSessionId ? (
                      <OAuthInteractiveStep
                        title="인증 세션"
                        subtitle="아래 세션을 완료한 뒤 설정 완료를 진행해 주세요."
                        wsPath={`/api/ui/onboarding/auth/${interactiveSessionId}`}
                        headLabel={`/api/ui/onboarding/auth/${interactiveSessionId}`}
                        onExit={onInteractiveExit}
                        onCancel={onInteractiveCancel}
                        phaseLabel="인증 상태"
                        stepLabel="진행"
                      />
                    ) : null}
                  </FinalizeStep>
                ) : null}
              </div>

              {!isLastNavStep ? (
                <div className="ov0-nav">
                  <button type="button" className="ov0-btn ghost" onClick={handleBack} disabled={step === 0}>
                    <ArrowLeft size={16} />
                    이전
                  </button>
                  <button type="button" className="ov0-btn primary" onClick={handleNext} disabled={!canNext}>
                    다음
                    <ArrowRight size={16} />
                  </button>
                </div>
              ) : null}

              {isLastNavStep ? (
                <div className="ov0-nav single">
                  <button type="button" className="ov0-btn ghost" onClick={handleBack}>
                    <ArrowLeft size={16} />
                    이전
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>

        <p className="ov0-branding">SEMO</p>
      </div>
    </section>
  );
}
