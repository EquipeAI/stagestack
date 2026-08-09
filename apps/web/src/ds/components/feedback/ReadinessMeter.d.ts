import * as React from "react";
export interface ReadinessSegment {
  /** Count of items in this state. */
  value: number;
  tone: "ready" | "attention" | "blocked" | "neutral";
  /** Hover title, e.g. "3 overdue tasks". */
  label?: string;
}
export interface ReadinessMeterProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
  segments: ReadinessSegment[];
  /** Denominator override when segments don't cover everything. */
  total?: number;
  showValue?: boolean;
}
export declare function ReadinessMeter(props: ReadinessMeterProps): JSX.Element;
