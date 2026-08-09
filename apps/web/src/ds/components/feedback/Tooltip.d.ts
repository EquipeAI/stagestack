import * as React from "react";
export interface TooltipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Short, sentence-case, no period. */
  label: React.ReactNode;
}
export declare function Tooltip(props: TooltipProps): JSX.Element;
