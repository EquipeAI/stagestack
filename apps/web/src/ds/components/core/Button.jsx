import React from "react";
import { Icon } from "./Icon.jsx";

export function Button({
  variant = "secondary",
  size = "md",
  iconLeft,
  iconRight,
  fullWidth = false,
  as = "button",
  className = "",
  children,
  ...rest
}) {
  const Tag = as;
  const cls = ["ss-btn", "ss-btn--" + variant, "ss-btn--" + size, fullWidth ? "ss-btn--full" : "", className]
    .filter(Boolean)
    .join(" ");
  const glyph = size === "lg" ? 18 : size === "sm" ? 14 : 16;
  return (
    <Tag className={cls} {...rest}>
      {iconLeft ? <Icon name={iconLeft} size={glyph} /> : null}
      {children}
      {iconRight ? <Icon name={iconRight} size={glyph} /> : null}
    </Tag>
  );
}
