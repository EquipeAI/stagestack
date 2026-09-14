import * as React from "react";

export interface MenuButtonItem {
  id: string;
  label: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
}

export interface MenuButtonProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  /** Trigger text. A non-string label falls back to a "More actions" name. */
  label?: React.ReactNode;
  /** The TRIGGER's accessible name. Pass it when the label is a value (a view
   * name, a selection) that does not say what the menu is. */
  "aria-label"?: string;
  icon?: string;
  iconRight?: string;
  variant?: "primary" | "brand" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  align?: "start" | "end";
  width?: string;
  disabled?: boolean;
  /** Falsy entries are dropped, so callers can inline conditions. */
  items: ReadonlyArray<MenuButtonItem | null | undefined | false>;
}

export declare function MenuButton(props: MenuButtonProps): JSX.Element;
