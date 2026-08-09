import React from "react";

export function Logo({ size = 22, wordmark = true, tone = "default", className = "", ...rest }) {
  const ink = tone === "inverse" ? "var(--gray-25)" : "var(--gray-900)";
  const amber = "var(--amber-400)";
  const s = size * 1.18;
  return (
    <span className={["ss-logo", className].filter(Boolean).join(" ")} style={{ fontSize: size, color: ink }} {...rest}>
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="2" y="15.5" width="20" height="4.5" rx="1.25" fill={ink} />
        <rect x="4.75" y="9.25" width="14.5" height="4.5" rx="1.25" fill={ink} />
        <rect x="7.5" y="3" width="9" height="4.5" rx="1.25" fill={amber} />
      </svg>
      {wordmark ? <span style={{ letterSpacing: "-0.02em" }}>StageStack</span> : null}
    </span>
  );
}
