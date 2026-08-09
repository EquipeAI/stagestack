import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Field({ label, htmlFor, required, optional, hint, error, className = "", children, ...rest }) {
  return (
    <div className={["ss-field", className].filter(Boolean).join(" ")} {...rest}>
      {label ? (
        <label className="ss-field__label" htmlFor={htmlFor}>
          {label}
          {required ? <span className="ss-field__req">*</span> : null}
          {optional ? <span className="ss-field__opt">Optional</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <span className="ss-field__error"><Icon name="circle-alert" size={12} />{error}</span>
      ) : hint ? (
        <span className="ss-field__hint">{hint}</span>
      ) : null}
    </div>
  );
}
