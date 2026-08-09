import * as React from "react";
export interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** A StageStack workflow state, written exactly as it appears in the product, e.g. "Awaiting Response". */
  status: string;
  size?: "sm" | "lg";
  /** Escape hatch — overrides the mapped tone. Avoid. */
  tone?: "neutral" | "info" | "success" | "attention" | "blocked" | "brand" | "agent";
}
export declare function StatusPill(props: StatusPillProps): JSX.Element;
export declare const STATUS_TONES: Record<string, string>;
