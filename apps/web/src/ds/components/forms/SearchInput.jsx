import React from "react";
import { Icon } from "../core/Icon.jsx";

export function SearchInput({ shortcut, size = "sm", className = "", ...rest }) {
  return (
    <span className={["ss-search", className].filter(Boolean).join(" ")}>
      <Icon name="search" size={14} />
      <input type="search" className={["ss-input", "ss-input--" + size].join(" ")} {...rest} />
      {shortcut ? <kbd>{shortcut}</kbd> : null}
    </span>
  );
}
