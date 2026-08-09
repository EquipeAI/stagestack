import * as React from "react";
/**
 * @startingPoint section="Layout" subtitle="Card shells: default, raised, interactive" viewport="700x300"
 */
export interface CardProps extends React.HTMLAttributes<HTMLElement> {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right-aligned header controls. */
  actions?: React.ReactNode;
  /** Footer band — right-aligned buttons on a canvas-tinted strip. */
  footer?: React.ReactNode;
  /** flat = no shadow (inside another card); raised = md shadow; interactive = hover lift. */
  variant?: "default" | "flat" | "raised" | "interactive";
  /** Set false when the child is a table or list that owns its own padding. */
  padded?: boolean;
}
export declare function Card(props: CardProps): JSX.Element;
