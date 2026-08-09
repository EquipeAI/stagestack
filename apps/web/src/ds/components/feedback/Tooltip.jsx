import React from "react";

export function Tooltip({ label, className = "", children, ...rest }) {
  return (
    <span className={["ss-tooltip", className].filter(Boolean).join(" ")} tabIndex={0} {...rest}>
      {children}
      <span className="ss-tooltip__bubble" role="tooltip">{label}</span>
    </span>
  );
}
