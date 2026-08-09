import React from "react";
import { Icon } from "../core/Icon.jsx";

const ICONS = {
  neutral: "circle-alert",
  info: "circle-alert",
  success: "circle-check",
  attention: "triangle-alert",
  blocked: "circle-alert",
  agent: "sparkles"
};

export function Callout({ tone = "info", title, icon, actions, className = "", children, ...rest }) {
  return (
    <div className={["ss-callout", "ss-callout--" + tone, className].filter(Boolean).join(" ")} {...rest}>
      <Icon name={icon || ICONS[tone] || "circle-alert"} size={16} style={{ marginTop: 2 }} />
      <div className="ss-callout__body">
        {title ? <div className="ss-callout__title">{title}</div> : null}
        {children ? <div>{children}</div> : null}
        {actions ? <div className="ss-callout__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
