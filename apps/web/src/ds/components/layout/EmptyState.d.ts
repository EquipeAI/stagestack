import * as React from "react";
export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Lucide icon name. */
  icon?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}
export declare function EmptyState(props: EmptyStateProps): JSX.Element;
