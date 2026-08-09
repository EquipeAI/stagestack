import * as React from "react";
export interface ToastProps extends React.HTMLAttributes<HTMLDivElement> {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: string;
  /** Usually "Undo" or "View". */
  actionLabel?: string;
  onAction?: () => void;
}
export declare function Toast(props: ToastProps): JSX.Element;
