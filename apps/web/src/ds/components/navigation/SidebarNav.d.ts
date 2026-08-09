import * as React from "react";
export interface SidebarNavItem {
  id: string;
  label: string;
  /** Lucide icon name. */
  icon?: string;
  /** Trailing count, mono, tabular. */
  count?: number | string;
}
export interface SidebarNavProps extends React.HTMLAttributes<HTMLElement> {
  /** Event switcher / logo block at the top. */
  header?: React.ReactNode;
  groups: Array<{ label?: string; items: SidebarNavItem[] }>;
  activeId?: string;
  onSelect?: (id: string) => void;
  footer?: React.ReactNode;
}
export declare function SidebarNav(props: SidebarNavProps): JSX.Element;
