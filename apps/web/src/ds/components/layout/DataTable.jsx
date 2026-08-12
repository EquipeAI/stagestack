import React from "react";

export function DataTable({ columns = [], rows = [], selectedIds = [], rowKey = "id", onRowClick, className = "", ...rest }) {
  // Every table in the app is wider than a phone: the header cells are
  // `white-space:nowrap` and a typical table carries 5-8 columns. Wrapping it
  // in its own scroll container is what keeps the *document* from scrolling
  // sideways — a horizontally-panning page breaks the sticky header, the tab
  // strip and the reader's place all at once.
  //
  // `tabIndex={0}` and role/aria-label make the scroller keyboard-reachable,
  // which is required of any scrollable region that is not otherwise focusable.
  return (
    <div
      className="ss-table-scroll scroll-x"
      tabIndex={0}
      role="region"
      aria-label={rest["aria-label"] || "Table"}
    >
    <table className={["ss-table", className].filter(Boolean).join(" ")} {...rest}>
      <thead>
        <tr>
          {columns.map(function (c, i) {
            return <th key={i} style={{ width: c.width, textAlign: c.align || "left" }}>{c.header}</th>;
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map(function (r, ri) {
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
                // been answered — navigating as well would take the organizer
                // somewhere they did not ask to go. Keyboard activation is
                // unaffected: it already requires focus on the row itself.
                if (e.target !== e.currentTarget && e.target.closest(
                  "a,button,input,select,textarea,label,[role='button'],[role='link']"
                )) return;
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
