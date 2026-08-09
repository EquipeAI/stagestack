import * as React from "react";
export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Strings, or { value, label } pairs. */
  options?: Array<string | { value: string; label: string }>;
  size?: "sm" | "md" | "lg";
}
export declare function Select(props: SelectProps): JSX.Element;
