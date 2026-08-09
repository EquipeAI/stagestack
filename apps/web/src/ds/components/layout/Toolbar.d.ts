import * as React from "react";
export interface ToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Filters and search. */
  left?: React.ReactNode;
  /** View switches and bulk actions, pushed to the trailing edge. */
  right?: React.ReactNode;
  sunken?: boolean;
}
export declare function Toolbar(props: ToolbarProps): JSX.Element;
