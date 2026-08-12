import React from "react";
import { Icon } from "../core/Icon.jsx";

// The active-filter row (W12). Every operational table narrows itself the same
// way, so the row that says WHICH narrowing is in force looks the same too —
// one removable chip per active filter, plus a way out of all of them.
//
// It states filters that are already in effect; it is not the picker. A chip
// therefore always carries a removal: a filter the organizer cannot see how to
// undo is the thing that makes a short list read as missing data.
//
// Renders nothing when no filter is active, so a caller can mount it
// unconditionally without leaving an empty band above every table.

export function ActiveFilters({
  chips = [],
  label = "Active filters",
  onClearAll,
  clearLabel = "Clear all",
  className = "",
  ...rest
}) {
  const live = chips.filter(Boolean);
  if (live.length === 0) return null;
  return (
    <div
      className={["ss-activefilters", className].filter(Boolean).join(" ")}
      role="group"
      aria-label={label}
      {...rest}
    >
      <span className="ss-activefilters__label">{label}</span>
      {live.map(function (chip) {
        // The removal label repeats the filter's own words: "Remove filter"
        // alone is useless in a list of six identical buttons.
        const text = chip.removeLabel || `Remove filter: ${chip.label}`;
        return (
          <span key={chip.id} className="ss-activefilter">
            <span className="ss-activefilter__label">{chip.label}</span>
            <button
              type="button"
              className="ss-activefilter__remove"
              aria-label={text}
              onClick={chip.onRemove}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        );
      })}
      {onClearAll && live.length > 1 ? (
        <button type="button" className="ss-activefilters__clear" onClick={onClearAll}>
          {clearLabel}
        </button>
      ) : null}
    </div>
  );
}
