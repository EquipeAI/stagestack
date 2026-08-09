import * as React from "react";
export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  size?: "sm" | "md" | "lg";
  /** Lucide icon rendered inside the leading edge. */
  icon?: string;
  /** Trailing hint inside the control, e.g. a character count or unit. */
  suffix?: React.ReactNode;
  invalid?: boolean;
}
export declare function Input(props: InputProps): JSX.Element;
