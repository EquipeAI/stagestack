import * as React from "react";
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Semantic tone. `agent` (iris) is reserved for AI-assisted provenance. */
  tone?: "neutral" | "info" | "success" | "attention" | "blocked" | "brand" | "agent";
  size?: "sm" | "lg";
  /** Show the leading status dot. */
  dot?: boolean;
}
export declare function Badge(props: BadgeProps): JSX.Element;
