import * as React from "react";
export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: React.ReactNode;
  /** Second line under the label — consent copy, side effects of the toggle. */
  description?: React.ReactNode;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;
