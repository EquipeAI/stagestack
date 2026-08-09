import * as React from "react";
export interface DataTableColumn {
  key?: string;
  header?: React.ReactNode;
  width?: number | string;
  align?: "left" | "right" | "center";
  /** Custom renderer; receives the row. */
  cell?: (row: any) => React.ReactNode;
}
export interface DataTableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  columns: DataTableColumn[];
  rows: any[];
  /** Ids of selected rows — renders the amber selected band. */
  selectedIds?: Array<string | number>;
  rowKey?: string;
  onRowClick?: (row: any) => void;
}
export declare function DataTable(props: DataTableProps): JSX.Element;
