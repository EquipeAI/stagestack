import React from "react";
import { IconButton } from "../core/IconButton.jsx";

export function Dialog({ open = true, title, description, width = 480, onClose, footer, className = "", children, ...rest }) {
  if (!open) return null;
  return (
    <div className="ss-dialog__scrim" onClick={onClose}>
      <div
        className={["ss-dialog", className].filter(Boolean).join(" ")}
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        onClick={function (e) { e.stopPropagation(); }}
        {...rest}
      >
        <header className="ss-dialog__header">
          <div style={{ flex: 1 }}>
            <div className="ss-dialog__title">{title}</div>
            {description ? <p className="ss-dialog__desc">{description}</p> : null}
          </div>
          {onClose ? <IconButton icon="x" label="Close" size="sm" onClick={onClose} /> : null}
        </header>
        {children ? <div className="ss-dialog__body">{children}</div> : null}
        {footer ? <footer className="ss-dialog__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}
