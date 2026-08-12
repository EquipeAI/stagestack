import React from "react";

// A switch with no accessible name is announced as "switch, on" — the setting
// it controls is invisible to anyone not looking at the row it sits in. One of
// three namings is required:
//
//   label              visible text rendered beside the track
//   aria-label         when the visible name is a heading/row title elsewhere
//   aria-labelledby    same, pointing at that element's id
//
// The .d.ts makes an unnamed switch a type error; this is the runtime backstop
// for JS call sites and for a name that is only empty at runtime (a template
// literal over missing data). It reports and renders — a control that vanished
// because its label was blank would be a worse accessibility outcome than an
// unnamed one.
function isNamed(label, rest) {
  if (typeof label === "string") return label.trim().length > 0;
  if (label !== undefined && label !== null && label !== false) return true;
  const aria = rest["aria-label"];
  if (typeof aria === "string" && aria.trim().length > 0) return true;
  const by = rest["aria-labelledby"];
  return typeof by === "string" && by.trim().length > 0;
}

function isDev() {
  try {
    return typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production";
  } catch {
    return false;
  }
}

export function Switch({ label, className = "", ...rest }) {
  if (!isNamed(label, rest) && isDev()) {
    // eslint-disable-next-line no-console
    console.error(
      "Switch: no accessible name. Pass `label`, or `aria-label`/`aria-labelledby` " +
        "naming the requirement or setting this switch controls — not its state.",
    );
  }
  return (
    <label className={["ss-switch", className].filter(Boolean).join(" ")}>
      <input type="checkbox" role="switch" {...rest} />
      <span className="ss-switch__track"><span className="ss-switch__thumb" /></span>
      {label ? <span>{label}</span> : null}
    </label>
  );
}
