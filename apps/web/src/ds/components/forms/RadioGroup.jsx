import React from "react";

export function RadioGroup({ name, options = [], value, onChange, row = false, className = "", ...rest }) {
  return (
    // Unknown props land on the group, never on the individual inputs: a
    // radio group is described, named and marked invalid as one control, the
    // way <Field> wires it, and per-input copies would be announced N times.
    <div className={["ss-radiogroup", row ? "ss-radiogroup--row" : "", className].filter(Boolean).join(" ")} role="radiogroup" {...rest}>
      {options.map(function (o, i) {
        const v = typeof o === "string" ? o : o.value;
        const l = typeof o === "string" ? o : o.label;
        const d = typeof o === "string" ? null : o.description;
        return (
          <label className="ss-check" key={i}>
            <input
              type="radio"
              name={name}
              value={v}
              checked={value === v}
              onChange={function () { if (onChange) onChange(v); }}
            />
            <span className="ss-check__box ss-check__box--radio">
              <span style={{ width: 7, height: 7, borderRadius: 99, background: "currentColor" }} />
            </span>
            <span className="ss-check__text">
              <span>{l}</span>
              {d ? <span className="ss-check__desc">{d}</span> : null}
            </span>
          </label>
        );
      })}
    </div>
  );
}
