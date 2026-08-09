import React from "react";

export function Switch({ label, className = "", ...rest }) {
  return (
    <label className={["ss-switch", className].filter(Boolean).join(" ")}>
      <input type="checkbox" role="switch" {...rest} />
      <span className="ss-switch__track"><span className="ss-switch__thumb" /></span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}
