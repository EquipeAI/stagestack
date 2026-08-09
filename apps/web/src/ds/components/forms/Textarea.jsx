import React from "react";

export function Textarea({ invalid = false, rows = 4, className = "", ...rest }) {
  return (
    <textarea
      rows={rows}
      className={["ss-textarea", invalid ? "ss-textarea--invalid" : "", className].filter(Boolean).join(" ")}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}
