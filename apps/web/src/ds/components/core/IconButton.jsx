import React from "react";
import { Icon } from "./Icon.jsx";

export function IconButton({ icon, label, size = "md", bordered = false, className = "", ...rest }) {
  const cls = ["ss-iconbtn", "ss-iconbtn--" + size, bordered ? "ss-iconbtn--bordered" : "", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" aria-label={label} title={label} className={cls} {...rest}>
      <Icon name={icon} size={size === "lg" ? 18 : size === "sm" ? 14 : 16} />
    </button>
  );
}
