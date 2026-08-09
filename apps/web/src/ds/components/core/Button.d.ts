import * as React from "react";
/**
 * @startingPoint section="Core" subtitle="Button variants, sizes and states" viewport="700x220"
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = ink fill (the one commit action on a view); brand = amber, reserved for marketing/public CTAs; secondary = default; ghost = toolbar/tertiary; danger = destructive. */
  variant?: "primary" | "brand" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  /** Lucide icon name rendered before the label. */
  iconLeft?: string;
  /** Lucide icon name rendered after the label. */
  iconRight?: string;
  fullWidth?: boolean;
  /** Render as another element, e.g. "a". */
  as?: keyof JSX.IntrinsicElements;
}
export declare function Button(props: ButtonProps): JSX.Element;
