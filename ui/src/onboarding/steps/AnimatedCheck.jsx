import { useEffect, useState } from "react";

export default function AnimatedCheck({ size = 44, strokeWidth = 3, color = "var(--ov0-accent)", className = "" }) {
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      setTimeout(() => setDrawn(true), 30);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const pathLength = 22;

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M4 12.5L9 17.5L20 6.5"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={pathLength}
        strokeDashoffset={drawn ? 0 : pathLength}
        style={{ transition: drawn ? "stroke-dashoffset 0.45s cubic-bezier(0.4, 0, 0.2, 1)" : "none" }}
      />
    </svg>
  );
}
