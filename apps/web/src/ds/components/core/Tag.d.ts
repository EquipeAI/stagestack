import * as React from "react";
export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** CSS colour for the leading swatch — use the track/tag colour stored on the record. */
  color?: string;
  /** Renders a remove affordance when provided. */
  onRemove?: () => void;
}
export declare function Tag(props: TagProps): JSX.Element;
