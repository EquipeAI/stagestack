import React from "react";
import { Icon } from "../core/Icon.jsx";

export function Select({ options = [], size = "md", className = "", children, ...rest }) {
  return (
    <span className="ss-selectwrap">
      <select className={["ss-select", "ss-input--" + size, className].filter(Boolean).join(" ")} {...rest}>
        {children || options.map(function (o, i) {
          const v = typeof o === "string" ? o : o.value;
          const l = typeof o === "string" ? o : o.label;
          return <option key={i} value={v}>{l}</option>;
        })}
      </select>
      <Icon name="chevron-down" size={14} />
    </span>
  );
}
