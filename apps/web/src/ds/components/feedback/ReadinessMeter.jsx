import React from "react";

const TONE_VAR = {
  ready: "--jade-500",
  attention: "--ember-500",
  blocked: "--rust-500",
  neutral: "--gray-300"
};

export function ReadinessMeter({ label, segments = [], total, showValue = true, className = "", ...rest }) {
  const sum = total != null ? total : segments.reduce(function (a, s) { return a + s.value; }, 0) || 1;
  const done = segments.filter(function (s) { return s.tone === "ready"; }).reduce(function (a, s) { return a + s.value; }, 0);
  return (
    <div className={["ss-meter", className].filter(Boolean).join(" ")} {...rest}>
      {label || showValue ? (
        <div className="ss-meter__head">
          <span>{label}</span>
          {showValue ? <span className="ss-meter__value">{done}/{sum}</span> : null}
        </div>
      ) : null}
      <div className="ss-meter__track">
        {segments.map(function (s, i) {
          return (
            <span
              key={i}
              className="ss-meter__seg"
              title={s.label}
              style={{ width: (s.value / sum) * 100 + "%", background: "var(" + (TONE_VAR[s.tone] || TONE_VAR.neutral) + ")" }}
            />
          );
        })}
      </div>
    </div>
  );
}
