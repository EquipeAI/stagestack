import * as React from "react";
export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
  htmlFor?: string;
  /** Adds the red asterisk. CFP forms mark required, not optional. */
  required?: boolean;
  /** Adds a muted "Optional" marker. Use in organizer settings, not in the CFP. */
  optional?: boolean;
  /** Helper text under the control. Replaced by `error` when present. */
  hint?: React.ReactNode;
  error?: React.ReactNode;
}
export declare function Field(props: FieldProps): JSX.Element;
