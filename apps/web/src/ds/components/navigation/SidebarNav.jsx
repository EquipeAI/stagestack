import React from "react";
import { Icon } from "../core/Icon.jsx";

export function SidebarNav({ header, groups = [], activeId, onSelect, footer, className = "", ...rest }) {
  return (
    <nav className={["ss-sidebar", className].filter(Boolean).join(" ")} {...rest}>
      {header ? <div className="ss-sidebar__head">{header}</div> : null}
      <div className="ss-sidebar__scroll">
        {groups.map(function (g, gi) {
          return (
            <div key={gi}>
              {g.label ? <div className="ss-sidebar__group">{g.label}</div> : null}
              {g.items.map(function (it) {
                return (
                  <button
                    type="button"
                    key={it.id}
                    className="ss-navitem"
                    data-active={activeId === it.id}
                    onClick={function () { if (onSelect) onSelect(it.id); }}
                  >
                    {it.icon ? <Icon name={it.icon} size={15} /> : null}
                    <span>{it.label}</span>
                    {it.count != null ? <span className="ss-navitem__count">{it.count}</span> : null}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      {footer ? <div style={{ padding: "10px 10px 14px" }}>{footer}</div> : null}
    </nav>
  );
}
