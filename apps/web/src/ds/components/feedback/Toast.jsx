import React from "react";
import { Icon } from "../core/Icon.jsx";

// `role="status"` is the default so a Toast rendered on its own announces
// itself. It comes before the spread deliberately: a host that already owns
// announcement (a viewport feeding one shared live region) passes
// `role={undefined}` so the same sentence is not read out twice.
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
