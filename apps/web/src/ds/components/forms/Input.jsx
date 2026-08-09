import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Input({ size = "md", icon, suffix, invalid = false, className = "", ...rest }) {
  const input = (
    <input
      className={["ss-input", "ss-input--" + size, invalid ? "ss-input--invalid" : "", className].filter(Boolean).join(" ")}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
  if (!icon && !suffix) return input;
  return (
    <span className={["ss-inputwrap", icon ? "ss-inputwrap--icon" : ""].filter(Boolean).join(" ")}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {input}
      {suffix ? <span className="ss-inputwrap__suffix">{suffix}</span> : null}
    </span>
  );
}
