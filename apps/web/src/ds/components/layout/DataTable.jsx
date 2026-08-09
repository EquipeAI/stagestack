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
          return (
            <tr
              key={id}
              data-selected={selectedIds.indexOf(id) > -1}
              onClick={onRowClick ? function () { onRowClick(r); } : undefined}
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
