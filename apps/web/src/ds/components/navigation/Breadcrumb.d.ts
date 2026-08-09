import * as React from "react";
export interface BreadcrumbProps extends React.HTMLAttributes<HTMLElement> {
  items: Array<{ label: string; href?: string }>;
}
export declare function Breadcrumb(props: BreadcrumbProps): JSX.Element;
