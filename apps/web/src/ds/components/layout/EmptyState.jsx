import React from "react";
import { Icon } from "../core/Icon.jsx";

export function EmptyState({ icon = "inbox", title, description, action, className = "", ...rest }) {
  return (
    <div className={["ss-empty", className].filter(Boolean).join(" ")} {...rest}>
      <div className="ss-empty__icon"><Icon name={icon} size={20} /></div>
      <div className="ss-empty__title">{title}</div>
      {description ? <p className="ss-empty__desc">{description}</p> : null}
      {action ? <div style={{ marginTop: 4 }}>{action}</div> : null}
    </div>
  );
}
