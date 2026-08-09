import React from "react";
import { Icon } from "../core/Icon.jsx";

// A field's error used to be an unlinked sibling <span>: visible, but silent
// to a screen reader, which is how a CFP submitter could be stuck on a step
// with no idea what was wrong. The message now carries a generated id, the
// control is pointed at it with aria-describedby, and role="alert" makes it
// speak the moment it appears.
//
// The wiring is done here rather than at the ~30 call sites so that every
// existing <Field label hint> gets it for free and no call site has to invent
// ids. A single element child is cloned; anything else (a fragment, several
// controls) is left untouched, which is the pre-existing behaviour.
//
// A grouped control (a radio group, a list of checkboxes) is not a labelable
// element, so the <label for> that names an <input> names nothing at all: the
// group is pointed back at the label with aria-labelledby instead.
const GROUP_ROLES = ["group", "radiogroup"];

function wire(children, messageId, invalid, labelId) {
  if (!React.isValidElement(children)) return children;
  const grouped = GROUP_ROLES.includes(children.props.role);
  if (messageId === undefined && !grouped) return children;
  const existing = children.props["aria-describedby"];
  return React.cloneElement(children, {
    ...(messageId === undefined
      ? null
      : { "aria-describedby": [existing, messageId].filter(Boolean).join(" ") }),
    ...(grouped && labelId !== undefined && children.props["aria-labelledby"] === undefined
      ? { "aria-labelledby": labelId }
      : null),
    // Only set when there is an error: an explicit `undefined` here would
    // override an `invalid` prop the call site passed to the control itself.
    ...(invalid && messageId !== undefined && children.props["aria-invalid"] === undefined
      ? { "aria-invalid": true }
      : null)
  });
}

export function Field({ label, htmlFor, required, optional, hint, error, className = "", children, ...rest }) {
  const uid = React.useId();
  const messageId = error ? uid + "-error" : hint ? uid + "-hint" : undefined;
  const labelId = label ? uid + "-label" : undefined;
  return (
    <div className={["ss-field", className].filter(Boolean).join(" ")} {...rest}>
      {label ? (
        <label className="ss-field__label" id={labelId} htmlFor={htmlFor}>
          {label}
          {required ? <span className="ss-field__req">*</span> : null}
          {optional ? <span className="ss-field__opt">Optional</span> : null}
        </label>
      ) : null}
      {wire(children, messageId, Boolean(error), labelId)}
      {error ? (
        <span className="ss-field__error" id={messageId} role="alert"><Icon name="circle-alert" size={12} />{error}</span>
      ) : hint ? (
        <span className="ss-field__hint" id={messageId}>{hint}</span>
      ) : null}
    </div>
  );
}
