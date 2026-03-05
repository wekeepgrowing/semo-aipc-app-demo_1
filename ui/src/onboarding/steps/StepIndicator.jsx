import { Check } from "lucide-react";

export default function StepIndicator({ steps, currentStep }) {
  return (
    <div className="ov0-indicator" aria-label="온보딩 단계">
      {steps.map((label, index) => {
        const done = index < currentStep;
        const current = index === currentStep;
        return (
          <div key={label} className="ov0-indicator-node">
            <div aria-label={label} title={label} className={`ov0-indicator-dot ${done ? "done" : ""} ${current ? "current" : ""}`}>
              {done ? <Check size={12} /> : index + 1}
            </div>
            {index < steps.length - 1 ? <div className={`ov0-indicator-line ${done ? "done" : ""}`} /> : null}
          </div>
        );
      })}
    </div>
  );
}
