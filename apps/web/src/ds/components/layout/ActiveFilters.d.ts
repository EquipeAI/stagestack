import * as React from "react";

export interface ActiveFilter {
  /** Stable key — usually `${field}:${value}`. */
  id: string;
  /** What the chip says, e.g. "Status: Accept queue". */
  label: React.ReactNode;
  /** Called when the organizer removes this one filter. */
  onRemove: () => void;
  /** Overrides the generated "Remove filter: …" accessible name. */
  removeLabel?: string;
}

export interface ActiveFiltersProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  /** Active filters only. Falsy entries are dropped; an empty row renders nothing. */
  chips: ReadonlyArray<ActiveFilter | null | undefined | false>;
  /** Group label, announced before the chips. */
  label?: string;
  /** Shown only when more than one filter is active. */
  onClearAll?: () => void;
  clearLabel?: string;
}

export declare function ActiveFilters(props: ActiveFiltersProps): JSX.Element | null;
