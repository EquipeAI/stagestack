import * as React from "react";
// onChange is the group's value callback, not a DOM FormEvent handler.
export interface RadioGroupProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  name: string;
  options: Array<string | { value: string; label: string; description?: string }>;
  value?: string;
  onChange?: (value: string) => void;
  /** Lay options out horizontally. Only for 2–3 short labels. */
  row?: boolean;
  className?: string;
}
export declare function RadioGroup(props: RadioGroupProps): JSX.Element;
