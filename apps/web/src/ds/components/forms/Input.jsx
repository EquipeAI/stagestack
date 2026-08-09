import React from "react";
import { Icon } from "../core/Icon.jsx";

/**
 * Mobile keyboard defaults per input type.
 *
 * On a phone the `type` attribute alone is not enough. iOS will happily
 * autocapitalise and autocorrect an email address, a URL or a social handle —
 * so "alvaro" is submitted as "Alvaro", and a pasted URL picks up a capital.
 * These are silent data-corruption bugs that only ever happen on touch
 * devices, and the fix is per-type hints rather than per-call-site vigilance.
 *
 * `inputMode` picks the on-screen key layout (an @ and a . for email, digits
 * for numeric); `enterKeyHint` labels the return key so it says "Go"/"Search"
 * instead of a generic newline arrow.
 *
 * Every value here is a *default*: an explicit prop on the call site still
 * wins, because `...rest` is spread after these.
 */
const TYPE_DEFAULTS = {
  email: {
    inputMode: "email",
    autoCapitalize: "none",
    autoCorrect: "off",
    spellCheck: false,
  },
  url: {
    inputMode: "url",
    autoCapitalize: "none",
    autoCorrect: "off",
    spellCheck: false,
  },
  tel: { inputMode: "tel" },
  number: { inputMode: "decimal" },
  search: { inputMode: "search", enterKeyHint: "search", autoCorrect: "off" },
  password: { autoCapitalize: "none", autoCorrect: "off", spellCheck: false },
};

export function Input({ size = "md", icon, suffix, invalid = false, className = "", ...rest }) {
  const typeDefaults = TYPE_DEFAULTS[rest.type] || null;
  const input = (
    <input
      className={["ss-input", "ss-input--" + size, invalid ? "ss-input--invalid" : "", className].filter(Boolean).join(" ")}
      aria-invalid={invalid || undefined}
      {...typeDefaults}
      {...rest}
    />
  );
  if (!icon && !suffix) return input;
  return (
    <span className={["ss-inputwrap", icon ? "ss-inputwrap--icon" : ""].filter(Boolean).join(" ")}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {input}
      {suffix ? <span className="ss-inputwrap__suffix">{suffix}</span> : null}
    </span>
  );
}
