import * as React from "react";
export interface LogoProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Wordmark font-size in px; the mark scales with it. Minimum 16. */
  size?: number;
  /** Set false for the mark alone (favicons, collapsed sidebar). */
  wordmark?: boolean;
  tone?: "default" | "inverse";
}
export declare function Logo(props: LogoProps): JSX.Element;
