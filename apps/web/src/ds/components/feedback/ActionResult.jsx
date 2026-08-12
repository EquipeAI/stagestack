import React from "react";
import { Button } from "../core/Button.jsx";
import { Callout } from "./Callout.jsx";

// A result that STAYS on the page. Toasts are for low-risk confirmations; an
// export, a bulk action, a publish, an import or a restore has an outcome the
// organizer has to be able to read after they have looked away — including
// what it did, what it did not do, and how to try again.
//
// Composes Callout so there is one visual language for "the app is telling you
// something", and one place that owns tone.

const TONES = {
  pending: "info",
  success: "success",
  partial: "attention",
  failed: "blocked"
};

const ICONS = {
  pending: "refresh-cw",
  success: "circle-check",
  partial: "triangle-alert",
  failed: "circle-alert"
};

export function ActionResult({
  status = "success",
  title,
  details,
  onRetry,
  retryLabel = "Try again",
  retryPending = false,
  onDismiss,
  dismissLabel = "Dismiss",
  actions,
  className = "",
  children,
  ...rest
}) {
  const lines = (details || []).filter(Boolean);
  const buttons = [];
  if (onRetry) {
    buttons.push(
      <Button key="retry" size="sm" disabled={retryPending} onClick={onRetry}>
        {retryPending ? "Retrying…" : retryLabel}
      </Button>
    );
  }
  if (actions) buttons.push(<React.Fragment key="actions">{actions}</React.Fragment>);
  if (onDismiss) {
    buttons.push(
      <Button key="dismiss" size="sm" variant="ghost" onClick={onDismiss}>
        {dismissLabel}
      </Button>
    );
  }
  return (
    <Callout
      tone={TONES[status] || "info"}
      icon={ICONS[status]}
      title={title}
      // Announced when it appears: the outcome is the whole point of the
      // component, and a screen reader must not have to go looking for it.
      role="status"
      aria-live="polite"
      className={["ss-action-result", className].filter(Boolean).join(" ")}
      actions={buttons.length > 0 ? buttons : undefined}
      {...rest}
    >
      {children}
      {lines.length > 0 ? (
        <ul className="ss-action-result__lines">
          {lines.map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      ) : null}
    </Callout>
  );
}
