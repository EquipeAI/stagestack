import * as React from "react";
export interface TabItem { id: string; label: string; icon?: string; count?: number | string }
export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  tabs: TabItem[];
  value?: string;
  onChange?: (id: string) => void;
  /** underline = page-level sections · pill = compact in-panel switch. */
  variant?: "underline" | "pill";
}
export declare function Tabs(props: TabsProps): JSX.Element;
