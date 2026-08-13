import * as React from "react";

export interface CommandPaletteItem {
  /** Unique across every group — it is what `onSelect` reports back. */
  id: string;
  label: string;
  /** Trailing detail: a state, a group name, a route. */
  hint?: string;
  icon?: string;
}

export interface CommandPaletteGroup {
  id: string;
  label: string;
  items: Array<CommandPaletteItem>;
}

export interface CommandPaletteProps {
  open?: boolean;
  id?: string;
  /** Dialog heading — also the palette's accessible name. */
  title?: React.ReactNode;
  /** Accessible name of the field and the results list. */
  label?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  /** Keyboard hint drawn in the field, e.g. "⌘K". */
  shortcut?: string;
  groups?: Array<CommandPaletteGroup>;
  /** One sentence about the current answer, rendered under the field. */
  status?: React.ReactNode;
  emptyLabel?: React.ReactNode;
  onSelect?: (id: string) => void;
  onClose?: () => void;
  footer?: React.ReactNode;
}

export declare function CommandPalette(props: CommandPaletteProps): JSX.Element;
