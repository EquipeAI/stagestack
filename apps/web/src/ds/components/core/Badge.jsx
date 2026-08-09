import React from "react";

const TONES = {
  neutral: ["--status-neutral-bg", "--status-neutral-fg", "--status-neutral-dot"],
  info: ["--status-info-bg", "--status-info-fg", "--status-info-dot"],
  success: ["--status-success-bg", "--status-success-fg", "--status-success-dot"],
  attention: ["--status-attention-bg", "--status-attention-fg", "--status-attention-dot"],
  blocked: ["--status-blocked-bg", "--status-blocked-fg", "--status-blocked-dot"],
  brand: ["--status-brand-bg", "--status-brand-fg", "--status-brand-dot"],
  agent: ["--status-agent-bg", "--status-agent-fg", "--status-agent-dot"]
};

export function Badge({ tone = "neutral", size = "sm", dot = false, className = "", children, ...rest }) {
  const t = TONES[tone] || TONES.neutral;
  return (
    <span
      className={["ss-badge", size === "lg" ? "ss-badge--lg" : "", className].filter(Boolean).join(" ")}
      style={{ background: "var(" + t[0] + ")", color: "var(" + t[1] + ")" }}
      {...rest}
    >
      {dot ? <span className="ss-badge__dot" style={{ background: "var(" + t[2] + ")" }} /> : null}
      {children}
    </span>
  );
}
