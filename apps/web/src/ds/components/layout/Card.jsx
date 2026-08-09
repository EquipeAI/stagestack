import React from "react";

export function Card({ title, subtitle, actions, footer, variant = "default", padded = true, className = "", children, ...rest }) {
  const cls = ["ss-card", variant !== "default" ? "ss-card--" + variant : "", className].filter(Boolean).join(" ");
  return (
    <section className={cls} {...rest}>
      {title || actions ? (
        <header className="ss-card__header">
          <div>
            <div className="ss-card__title">{title}</div>
            {subtitle ? <div className="ss-table__sub" style={{ marginTop: 2 }}>{subtitle}</div> : null}
          </div>
          {actions ? <div style={{ display: "flex", gap: "var(--space-2)" }}>{actions}</div> : null}
        </header>
      ) : null}
      {padded ? <div className="ss-card__body">{children}</div> : children}
      {footer ? <footer className="ss-card__footer">{footer}</footer> : null}
    </section>
  );
}
