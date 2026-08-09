import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Toast({ title, description, icon = "circle-check", actionLabel, onAction, className = "", ...rest }) {
  return (
    <div className={["ss-toast", className].filter(Boolean).join(" ")} role="status" {...rest}>
      <Icon name={icon} size={16} style={{ marginTop: 2, color: "var(--amber-300)" }} />
      <div style={{ minWidth: 0 }}>
        <div className="ss-toast__title">{title}</div>
        {description ? <div className="ss-toast__desc">{description}</div> : null}
      </div>
      {actionLabel ? <button type="button" className="ss-toast__action" onClick={onAction}>{actionLabel}</button> : null}
    </div>
  );
}
