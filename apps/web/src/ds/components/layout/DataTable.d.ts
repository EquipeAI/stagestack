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
  /** True while the query behind the table is still undefined. Renders
   * skeleton rows plus an announced status sentence, never a bare spinner. */
  loading?: boolean;
  skeletonRows?: number;
  /** The sentence read out while loading — say what is loading. */
  loadingLabel?: string;
  /** The phone rendering of one row (W12). When present, viewports narrower
   * than `cardBreakpoint` render a card list instead of the scroller: primary
   * identity, the states that matter, one action. Selection, row activation
   * and the batch bar work identically in both renderings. Omit it to keep the
   * horizontal scroller, which is right for tabular comparison views. */
  cardRow?: (row: any) => React.ReactNode;
  cardBreakpoint?: number;
}
export declare function DataTable(props: DataTableProps): JSX.Element;
