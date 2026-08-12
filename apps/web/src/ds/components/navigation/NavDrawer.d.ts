import * as React from "react";
import type { SidebarNavItem } from "./SidebarNav";

export interface NavDrawerProps {
  open?: boolean;
  /** Named surface — the drawer is a modal dialog and needs a name. */
  title: React.ReactNode;
  /** DOM id for the drawer surface, so the opener can point aria-controls at it. */
  id?: string;
  groups: Array<{ label?: string; items: SidebarNavItem[] }>;
  activeId?: string;
  onSelect?: (id: string) => void;
  onClose?: () => void;
  footer?: React.ReactNode;
}
export declare function NavDrawer(props: NavDrawerProps): JSX.Element | null;
