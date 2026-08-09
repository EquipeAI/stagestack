import * as React from "react";
export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Lucide icon name. */
  icon: string;
  /** Required accessible label — also used as the tooltip. */
  label: string;
  size?: "sm" | "md" | "lg";
  /** Adds a card background + border. Use in toolbars over tinted surfaces. */
  bordered?: boolean;
}
export declare function IconButton(props: IconButtonProps): JSX.Element;
