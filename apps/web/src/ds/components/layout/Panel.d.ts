import * as React from "react";
/**
 * @startingPoint section="Layout" subtitle="Collapsible section with a title, subtitle and meta slot" viewport="700x300"
 */
export interface PanelProps
  extends Omit<React.DetailsHTMLAttributes<HTMLDetailsElement>, "open"> {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right-aligned summary content — a count, a status pill, a meter. */
  meta?: React.ReactNode;
  /** Uncontrolled: the reader owns open/closed after first paint. */
  defaultOpen?: boolean;
}
/** Collapsible section built on native <details>/<summary>. */
export declare function Panel(props: PanelProps): JSX.Element;
