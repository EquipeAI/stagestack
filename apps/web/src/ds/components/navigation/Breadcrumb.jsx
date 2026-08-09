import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Breadcrumb({ items = [], className = "", ...rest }) {
  return (
    <nav className={["ss-crumbs", className].filter(Boolean).join(" ")} aria-label="Breadcrumb" {...rest}>
      {items.map(function (c, i) {
        const last = i === items.length - 1;
        return (
          <React.Fragment key={i}>
            {i > 0 ? <Icon name="chevron-right" size={12} /> : null}
            {c.href && !last ? <a href={c.href}>{c.label}</a> : <span className={last ? "ss-crumbs__current" : ""}>{c.label}</span>}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
