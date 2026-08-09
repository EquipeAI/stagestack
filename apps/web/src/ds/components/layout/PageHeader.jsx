import React from "react";
import { Icon } from "../core/Icon.jsx";

export function PageHeader({ title, description, breadcrumbs = [], actions, meta, className = "", ...rest }) {
  return (
    <header className={["ss-pageheader", className].filter(Boolean).join(" ")} {...rest}>
      {breadcrumbs.length ? (
        <nav className="ss-pageheader__crumbs" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {breadcrumbs.map(function (c, i) {
            return (
              <React.Fragment key={i}>
                {i > 0 ? <Icon name="chevron-right" size={12} /> : null}
                {c.href ? <a href={c.href} style={{ color: "inherit" }}>{c.label}</a> : <span>{c.label}</span>}
              </React.Fragment>
            );
          })}
        </nav>
      ) : null}
      <div className="ss-pageheader__row">
        <div>
          <h1 className="ss-pageheader__title">{title}{meta}</h1>
          {description ? <p className="ss-pageheader__desc">{description}</p> : null}
        </div>
        {actions ? <div className="ss-pageheader__actions">{actions}</div> : null}
      </div>
    </header>
  );
}
