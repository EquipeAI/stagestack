import React from "react";
import { Icon } from "./Icon.jsx";

export function Tag({ color, onRemove, className = "", children, ...rest }) {
  return (
    <span className={["ss-tag", className].filter(Boolean).join(" ")} {...rest}>
      {color ? <span className="ss-tag__swatch" style={{ background: color }} /> : null}
      {children}
      {onRemove ? (
        <button type="button" className="ss-tag__x" onClick={onRemove} aria-label="Remove">
          <Icon name="x" size={11} />
        </button>
      ) : null}
    </span>
  );
}
