import * as React from "react";
export interface DescriptionListProps extends React.HTMLAttributes<HTMLDListElement> {
  items: Array<{ term: React.ReactNode; value: React.ReactNode }>;
  /** Stack term above value — for narrow side panels. */
  stacked?: boolean;
}
export declare function DescriptionList(props: DescriptionListProps): JSX.Element;
