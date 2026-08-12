import React from "react";

// Below this width a table stops being a table. `cardRow` is the caller's
// phone rendering of one row; without it the horizontal scroller below is kept,
// which is the right answer for genuinely tabular comparison views (review
// results) where the columns ARE the content.
const CARD_BREAKPOINT = 640;

/**
 * True while the viewport is narrower than `maxWidth`.
 *
 * `useSyncExternalStore` rather than an effect: the server snapshot is always
 * `false`, so SSR and hydration both render the table and React swaps to cards
 * on the first client pass — no hydration mismatch, and no flash of the wrong
 * rendering on a phone beyond the first paint. `matchMedia` is absent in some
 * test environments, so its absence reads as "not narrow" rather than throwing.
 */
function useNarrow(maxWidth) {
  const query = `(max-width: ${maxWidth}px)`;
  const subscribe = React.useCallback(
    function (notify) {
      if (typeof window === "undefined" || !window.matchMedia) return function () {};
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return function () {
        list.removeEventListener("change", notify);
      };
    },
    [query]
  );
  return React.useSyncExternalStore(
    subscribe,
    function () {
      if (typeof window === "undefined" || !window.matchMedia) return false;
      return window.matchMedia(query).matches;
    },
    function () {
      return false;
    }
  );
}

/** A click inside a row's own control has already been answered — navigating
 * as well would take the organizer somewhere they did not ask to go. */
function fromOwnControl(e) {
  return (
    e.target !== e.currentTarget &&
    e.target.closest("a,button,input,select,textarea,label,[role='button'],[role='link']") !== null
  );
}

export function DataTable({
  columns = [],
  rows = [],
  selectedIds = [],
  rowKey = "id",
  onRowClick,
  loading = false,
  skeletonRows = 5,
  loadingLabel = "Loading rows…",
  cardRow,
  cardBreakpoint = CARD_BREAKPOINT,
  className = "",
  ...rest
}) {
  const narrow = useNarrow(cardBreakpoint);
  const label = rest["aria-label"] || "Table";

  // A skeleton is decoration; the sentence is the accessible half. `aria-busy`
  // tells assistive tech the region is mid-update, and the status line says so
  // in words — a shimmer alone announces nothing at all.
  const status = loading ? (
    <p className="ss-table-status" role="status" aria-live="polite">
      {loadingLabel}
    </p>
  ) : null;

  if (loading && narrow && cardRow) {
    return (
      <div className="ss-cardlist" aria-busy="true" aria-label={label} role="group">
        {status}
        {Array.from({ length: skeletonRows }).map(function (_, i) {
          return <div key={i} className="ss-cardlist__card ss-skeleton-card" aria-hidden="true" />;
        })}
      </div>
    );
  }

  if (narrow && cardRow) {
    return (
      <ul className="ss-cardlist" aria-label={label}>
        {rows.map(function (r, ri) {
          const id = r[rowKey] != null ? r[rowKey] : ri;
          return (
            <li key={id} className="ss-cardlist__item">
              <div
                className="ss-cardlist__card"
                data-selected={selectedIds.indexOf(id) > -1}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={
                  onRowClick
                    ? function (e) {
                        if (fromOwnControl(e)) return;
                        onRowClick(r);
                      }
                    : undefined
                }
                onKeyDown={
                  onRowClick
                    ? function (e) {
                        if (e.target !== e.currentTarget) return;
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        onRowClick(r);
                      }
                    : undefined
                }
              >
                {cardRow(r)}
              </div>
            </li>
          );
        })}
      </ul>
    );
  }

  // Every table in the app is wider than a phone: the header cells are
  // `white-space:nowrap` and a typical table carries 5-8 columns. Wrapping it
  // in its own scroll container is what keeps the *document* from scrolling
  // sideways — a horizontally-panning page breaks the sticky header, the tab
  // strip and the reader's place all at once.
  //
  // `tabIndex={0}` and role/aria-label make the scroller keyboard-reachable,
  // which is required of any scrollable region that is not otherwise focusable.
  return (
    <div className="ss-table-scroll scroll-x" tabIndex={0} role="region" aria-label={label}>
    {status}
    <table
      className={["ss-table", className].filter(Boolean).join(" ")}
      aria-busy={loading ? "true" : undefined}
      {...rest}
    >
      <thead>
        <tr>
          {columns.map(function (c, i) {
            return <th key={i} style={{ width: c.width, textAlign: c.align || "left" }}>{c.header}</th>;
          })}
        </tr>
      </thead>
      <tbody>
        {loading
          ? Array.from({ length: skeletonRows }).map(function (_, ri) {
              return (
                // aria-hidden: the status line above already says what is
                // happening, and five rows of placeholder bars announced cell
                // by cell would bury it.
                <tr key={`skeleton-${ri}`} className="ss-table__skeleton-row" aria-hidden="true">
                  {columns.map(function (c, ci) {
                    return (
                      <td key={ci}>
                        <span className="ss-skeleton" />
                      </td>
                    );
                  })}
                </tr>
              );
            })
          : rows.map(function (r, ri) {
          const id = r[rowKey] != null ? r[rowKey] : ri;
          // A clickable row is reachable by Tab and activates on Enter/Space.
          // The row keeps its implicit `row` role — role="button" on a <tr>
          // would break the table's structure for assistive tech — so the
          // keyboard contract is carried by tabIndex plus the handler, and
          // only fires when the row itself has focus, never a control in a cell.
          return (
            <tr
              key={id}
              data-selected={selectedIds.indexOf(id) > -1}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? function (e) {
                // A row that opens a record still holds its own controls
                // (approve, manage, a link out). Those are the cell's job, not
                // the row's, and a click that reached one of them has already
                // been answered.  Keyboard activation is unaffected: it already
                // requires focus on the row itself.
                if (fromOwnControl(e)) return;
                onRowClick(r);
              } : undefined}
              onKeyDown={onRowClick ? function (e) {
                if (e.target !== e.currentTarget) return;
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                onRowClick(r);
              } : undefined}
              style={{ cursor: onRowClick ? "pointer" : undefined }}
            >
              {columns.map(function (c, ci) {
                return (
                  <td key={ci} style={{ textAlign: c.align || "left" }}>
                    {c.cell ? c.cell(r) : r[c.key]}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
    </div>
  );
}
