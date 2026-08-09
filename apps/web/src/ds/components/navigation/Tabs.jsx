import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Tabs({ tabs = [], value, onChange, variant = "underline", className = "", ...rest }) {
  return (
    <div className={["ss-tabs", variant === "pill" ? "ss-tabs--pill" : "", className].filter(Boolean).join(" ")} role="tablist" {...rest}>
      {tabs.map(function (t) {
        return (
          <button
            type="button"
            key={t.id}
            role="tab"
            className="ss-tab"
            data-active={value === t.id}
            aria-selected={value === t.id}
            onClick={function () { if (onChange) onChange(t.id); }}
          >
            {t.icon ? <Icon name={t.icon} size={14} /> : null}
            {t.label}
            {t.count != null ? <span className="ss-tab__count">{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
