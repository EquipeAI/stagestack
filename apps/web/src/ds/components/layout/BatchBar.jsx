import React from "react";
import { Button } from "../core/Button.jsx";

// The bar that appears the moment rows are selected (W12). Promoted out of
// the proposals table, where it was written first, because the statement it
// makes is the same on every operational surface: how many rows are ticked,
// how many of them this action can actually act on, which ones it cannot and
// why, and how to stop.
//
// The arithmetic is NOT computed here. `count`, `eligible` and `exclusions`
// come from the same shared producer the backend mutation enforces
// (convex/shared/bulkDecisions.ts, convex/shared/bulkOutreach.ts), so the
// sentence before the click and the outcome after it cannot disagree.
//
// Held out of flow and pinned to the viewport bottom, with a spacer so the
// last row of the table stays reachable underneath it.

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

export function BatchBar({
  count,
  noun = "row",
  nounPlural,
  eligible,
  exclusions = [],
  summary,
  actions,
  onClear,
  clearLabel = "Clear",
  label = "Bulk actions",
  className = "",
  children,
  ...rest
}) {
  const many = nounPlural || `${noun}s`;
  const excluded = (exclusions || []).filter(Boolean);
  // A bar can arm several actions with DIFFERENT eligibility rules — staging a
  // decision and releasing one do not accept the same statuses. A single
  // "N eligible" would then be true of at most one button, so `eligible` also
  // takes one entry per rule and the bar names each: "6 selected · 4 stageable
  // · 2 releasable".
  const eligibility =
    typeof eligible === "number"
      ? ` · ${eligible} eligible`
      : Array.isArray(eligible)
        ? eligible.map((part) => ` · ${part.count} ${part.label}`).join("")
        : "";
  return (
    <>
      <div className="ss-batchbar__spacer" aria-hidden="true" />
      <div
        className={["ss-batchbar", className].filter(Boolean).join(" ")}
        role="region"
        aria-label={label}
        {...rest}
      >
        <span className="ss-batchbar__counts">
          <span className="ss-batchbar__count">
            {plural(count, noun, many)} selected
            {eligibility}
          </span>
          {excluded.length > 0 ? (
            <span className="ss-batchbar__excluded">
              {excluded.map((item) => `${item.count} ${item.reason}`).join(" · ")}
            </span>
          ) : null}
          {summary ? <span className="ss-batchbar__summary">{summary}</span> : null}
        </span>
        {actions}
        {children}
        <span className="ss-batchbar__spring" />
        {onClear ? (
          <Button size="sm" variant="ghost" onClick={onClear}>
            {clearLabel}
          </Button>
        ) : null}
      </div>
    </>
  );
}
