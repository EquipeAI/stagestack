import React from "react";

export function DataTable({ columns = [], rows = [], selectedIds = [], rowKey = "id", onRowClick, className = "", ...rest }) {
  return (
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
              onClick={onRowClick ? function () { onRowClick(r); } : undefined}
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
  );
}
