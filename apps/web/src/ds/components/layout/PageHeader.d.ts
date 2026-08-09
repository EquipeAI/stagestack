import * as React from "react";
export interface PageHeaderProps extends React.HTMLAttributes<HTMLElement> {
  title: React.ReactNode;
  description?: React.ReactNode;
  breadcrumbs?: Array<{ label: string; href?: string }>;
  /** Inline status next to the title — a StatusPill, a count, a slug. */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}
export declare function PageHeader(props: PageHeaderProps): JSX.Element;
