import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Checkbox({ label, description, className = "", ...rest }) {
  return (
    <label className={["ss-check", className].filter(Boolean).join(" ")}>
      <input type="checkbox" {...rest} />
      <span className="ss-check__box"><Icon name="check" size={11} /></span>
      {label || description ? (
        <span className="ss-check__text">
          <span>{label}</span>
          {description ? <span className="ss-check__desc">{description}</span> : null}
        </span>
      ) : null}
    </label>
  );
}
