import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

function formatApiError(payload, fallback = "요청을 처리하지 못했어요") {
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

function formatValidationWarning(payload, fallback = "키를 확인하지 못했지만 그래도 진행할 수 있어요") {
  if (!payload || typeof payload !== "object") {
    return { code: "validation_unavailable", message: fallback };
  }
  return {
    code: payload.code || "validation_unavailable",
    message: payload.message || fallback,
  };
}

export default function OnboardingModal({ onDone, stateSnapshot = null }) {
  const [loading, setLoading] = useState(true);
  const [optionsError, setOptionsError] = useState("");
  const [options, setOptions] = useState(null);

  const [step, setStep] = useState(0);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [selectedMethodId, setSelectedMethodId] = useState("");
  const [credentials, setCredentials] = useState({});

  const [connectStatus, setConnectStatus] = useState("idle");
  const [connectError, setConnectError] = useState("");
  const [keyValidationWarning, setKeyValidationWarning] = useState(null);
  const [interactiveSessionId, setInteractiveSessionId] = useState("");
  const [interactiveDone, setInteractiveDone] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [finalizeError, setFinalizeError] = useState("");

  const hasInitializedSelectionRef = useRef(false);
  const restoredSessionRef = useRef("");

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

        const providers = Array.isArray(json.providers) ? json.providers : [];
        if (!hasInitializedSelectionRef.current) {
          const snapshotProviderId = typeof stateSnapshot?.activeProviderId === "string" ? stateSnapshot.activeProviderId : "";
          const preferredProviderId = [snapshotProviderId, providers[0]?.id].find((candidate) =>
            providers.some((provider) => provider.id === candidate)
          );
          const nextProvider = providers.find((provider) => provider.id === preferredProviderId) || providers[0] || null;
          if (nextProvider) {
            const snapshotMethodId = typeof stateSnapshot?.activeMethodId === "string" ? stateSnapshot.activeMethodId : "";
            const preferredMethodId = [snapshotMethodId, nextProvider.methods?.[0]?.id].find((candidate) =>
              nextProvider.methods?.some((method) => method.id === candidate)
            );
            setSelectedProviderId(nextProvider.id);
            setSelectedMethodId(preferredMethodId || "");
          }
          hasInitializedSelectionRef.current = true;
        } else if (selectedProviderId && !providers.some((provider) => provider.id === selectedProviderId)) {
          const fallbackProvider = providers[0] || null;
          setSelectedProviderId(fallbackProvider?.id || "");
          setSelectedMethodId(fallbackProvider?.methods?.[0]?.id || "");
        }
      } catch (error) {
        if (!cancelled) {
          setOptionsError(error.message || "온보딩 옵션을 불러오지 못했어요");
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

  useEffect(() => {
    if (!options || loading) return;
    const snapshotSessionId = typeof stateSnapshot?.activeSessionId === "string" ? stateSnapshot.activeSessionId : "";
    if (!snapshotSessionId) return;
    if (interactiveSessionId === snapshotSessionId || restoredSessionRef.current === snapshotSessionId) return;
    restoredSessionRef.current = snapshotSessionId;

    const stateProviderId = typeof stateSnapshot?.activeProviderId === "string" ? stateSnapshot.activeProviderId : "";
    const restoredProvider = options.providers?.find((provider) => provider.id === stateProviderId) || options.providers?.[0] || null;
    const preferredMethodId =
      typeof stateSnapshot?.activeMethodId === "string" ? stateSnapshot.activeMethodId : restoredProvider?.methods?.[0]?.id;
    const restoredMethod = restoredProvider?.methods?.find((method) => method.id === preferredMethodId) || null;
    const restoredInteractiveWithoutCredential = restoredMethod?.mode === "interactive_required" && !needsCredential(restoredMethod);
    const restoredConnectStep = restoredInteractiveWithoutCredential ? 2 : 3;

    setInteractiveSessionId(snapshotSessionId);
    if (stateSnapshot.interactivePhase === "configured") {
      setConnectStatus("connected");
      setInteractiveDone(true);
      setStep(restoredConnectStep);
    } else {
      setConnectStatus("interactive_pending");
      setInteractiveDone(false);
      setStep(restoredConnectStep);
    }
  }, [
    interactiveSessionId,
    loading,
    options,
    stateSnapshot?.activeMethodId,
    stateSnapshot?.activeProviderId,
    stateSnapshot?.activeSessionId,
    stateSnapshot?.interactivePhase,
  ]);

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
  const interactiveWithoutCredential = interactiveRequired && !credentialRequired;
  const connectStepIndex = interactiveWithoutCredential ? 2 : 3;
  const finalizeStepIndex = interactiveWithoutCredential ? 3 : 4;
  const connected = connectStatus === "connected";

  const canNext = useMemo(() => {
    switch (step) {
      case 0:
        return Boolean(selectedProviderId);
      case 1:
        return Boolean(selectedMethodId);
      case 2:
        if (credentialRequired) return validateCredential(selectedMethod, credentials);
        if (interactiveWithoutCredential) return connected;
        return true;
      case 3:
        if (interactiveWithoutCredential) return true;
        return connected;
      case 4:
        return !interactiveWithoutCredential;
      default:
        return false;
    }
  }, [step, selectedProviderId, selectedMethodId, selectedMethod, credentials, connected, credentialRequired, interactiveWithoutCredential]);

  const resetProgress = useCallback(() => {
    setConnectStatus("idle");
    setConnectError("");
    setKeyValidationWarning(null);
    setInteractiveSessionId("");
    setInteractiveDone(false);
    setIsFinalizing(false);
    setFinalizeError("");
  }, []);

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
    if (keyValidationWarning) setKeyValidationWarning(null);
  };

  const onInteractiveExit = useCallback(
    (result) => {
      if (result?.ok) {
        setConnectStatus("connected");
        setInteractiveDone(true);
        setKeyValidationWarning(null);
        setConnectError("");
        setInteractiveSessionId("");
        return;
      }

      setInteractiveSessionId("");
      setInteractiveDone(false);
      setConnectStatus("idle");
      setKeyValidationWarning(null);
      setConnectError(result?.message || `[${result?.code || "cli_failed"}] 인증에 실패했어요`);
      setStep(connectStepIndex);
    },
    [connectStepIndex]
  );

  const onInteractiveCancel = useCallback(() => {
    setInteractiveSessionId("");
    setInteractiveDone(false);
    setConnectStatus("idle");
    setKeyValidationWarning(null);
    setConnectError("[interactive_cancelled] 인증이 취소됐어요");
    setStep(connectStepIndex);
  }, [connectStepIndex]);

  const onConnectApply = async ({ skipKeyValidation = false } = {}) => {
    if (!selectedProvider || !selectedMethod) return;

    setConnectStatus("connecting");
    setConnectError("");
    setFinalizeError("");
    setInteractiveSessionId("");
    setInteractiveDone(false);

    if (selectedMethod.mode === "non_interactive" && !skipKeyValidation) {
      try {
        const validation = await fetchApiJson("/api/ui/onboarding/validate-key", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            providerId: selectedProvider.id,
            methodId: selectedMethod.id,
            credentials,
          }),
        });

        if (!validation.valid && validation.canProceed) {
          setConnectStatus("idle");
          setKeyValidationWarning(formatValidationWarning(validation));
          return;
        }

        setKeyValidationWarning(null);
      } catch (error) {
        setConnectStatus("idle");
        setKeyValidationWarning(
          formatValidationWarning({
            code: error.code || "validation_unavailable",
            message: error.message || "키를 확인하지 못했지만 그래도 진행할 수 있어요",
          })
        );
        return;
      }
    } else {
      setKeyValidationWarning(null);
    }

    try {
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
        setKeyValidationWarning(null);
        return;
      }

      if (json.status === "interactive_required" && json.sessionId) {
        setConnectStatus("interactive_pending");
        setInteractiveSessionId(json.sessionId);
        return;
      }

      throw new Error("알 수 없는 응답 상태예요");
    } catch (error) {
      setConnectStatus("idle");
      setConnectError(error.message || "설정 적용에 실패했어요");
    }
  };

  const handleNext = () => {
    if (step === 1 && !credentialRequired) {
      if (interactiveWithoutCredential) {
        setStep(2);
        return;
      }
      setStep(3);
      void onConnectApply();
      return;
    }
    if (step === 2 && credentialRequired) {
      setStep(3);
      void onConnectApply();
      return;
    }
    if (step === 2 && interactiveWithoutCredential) {
      setStep(3);
      return;
    }
    if (step < 4) setStep(step + 1);
  };

  const handleBack = () => {
    if (step === connectStepIndex && !credentialRequired) {
      setStep(1);
      resetProgress();
      return;
    }

    if (step > 0) {
      if (step === connectStepIndex) setKeyValidationWarning(null);
      setStep(step - 1);
      if (step === 4 && !interactiveWithoutCredential) setConnectStatus("idle");
    }
  };

  const triggerDone = async () => {
    setIsFinalizing(true);
    setFinalizeError("");
    if (interactiveRequired && step === finalizeStepIndex) {
      setConnectError("");
    }

    try {
      for (let i = 0; i < 30; i += 1) {
        const json = await fetchApiJson("/api/ui/onboarding/state");
        if (json.configured && json.gatewayRunning) {
          if (typeof onDone === "function") {
            onDone();
            return;
          }
          window.location.reload();
          return;
        }

        if (json.lastErrorCode) {
          throw new Error(`[${json.lastErrorCode}] 설정 상태를 확인하는 중 오류가 발생했어요`);
        }

        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }

      throw new Error("[timeout] 게이트웨이 준비 확인이 지연되고 있어 다시 시도해 주세요");
    } catch (error) {
      const message = error.message || "설정 완료 확인에 실패했어요";
      setFinalizeError(message);
      if (interactiveRequired && step === finalizeStepIndex) {
        setConnectError(message);
      }
    } finally {
      setIsFinalizing(false);
    }
  };

  const isLastNavStep = step === finalizeStepIndex;

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
                {step === 2 && interactiveWithoutCredential ? (
                  <ConnectStep
                    method={selectedMethod}
                    providerLabel={providerLabel}
                    status={connectStatus}
                    error={connectError}
                    onConnect={onConnectApply}
                    validationWarning={null}
                    onRetryInput={null}
                    onProceedAnyway={null}
                  >
                    {interactiveRequired && interactiveSessionId && connectStatus === "interactive_pending" ? (
                      <OAuthInteractiveStep
                        title="브라우저 인증"
                        subtitle="이 단계에서 로그인 인증을 완료해 주세요"
                        sessionId={interactiveSessionId}
                        headLabel="브라우저 인증"
                        onExit={onInteractiveExit}
                        onCancel={onInteractiveCancel}
                        phaseLabel="인증 상태"
                        stepLabel="진행"
                      />
                    ) : null}
                  </ConnectStep>
                ) : null}
                {step === 3 && !interactiveWithoutCredential ? (
                  <ConnectStep
                    method={selectedMethod}
                    providerLabel={providerLabel}
                    status={connectStatus}
                    error={connectError}
                    onConnect={onConnectApply}
                    validationWarning={selectedMethod?.mode === "non_interactive" ? keyValidationWarning : null}
                    onRetryInput={() => {
                      setKeyValidationWarning(null);
                      setStep(2);
                    }}
                    onProceedAnyway={() => void onConnectApply({ skipKeyValidation: true })}
                  >
                    {interactiveRequired && interactiveSessionId && connectStatus === "interactive_pending" ? (
                      <OAuthInteractiveStep
                        title="브라우저 인증"
                        subtitle="이 단계에서 로그인 인증을 완료해 주세요"
                        sessionId={interactiveSessionId}
                        headLabel="브라우저 인증"
                        onExit={onInteractiveExit}
                        onCancel={onInteractiveCancel}
                        phaseLabel="인증 상태"
                        stepLabel="진행"
                      />
                    ) : null}
                  </ConnectStep>
                ) : null}
                {step === finalizeStepIndex ? (
                  <FinalizeStep
                    providerLabel={providerLabel}
                    methodLabel={methodLabel}
                    interactiveRequired={interactiveRequired}
                    interactiveDone={interactiveDone}
                    isFinalizing={isFinalizing}
                    finalizeError={finalizeError}
                    onFinalize={triggerDone}
                    onRetry={triggerDone}
                  />
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
