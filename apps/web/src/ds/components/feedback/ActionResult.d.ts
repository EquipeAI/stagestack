import * as React from "react";

/** pending = running · success = everything asked for happened ·
 *  partial = some of it happened · failed = none of it happened. */
export type ActionResultStatus = "pending" | "success" | "partial" | "failed";

export interface ActionResultProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  status?: ActionResultStatus;
  /** What happened, in one line: "12 rows exported", "Import failed". */
  title?: React.ReactNode;
  /** The arithmetic: one line per count/exclusion. Falsy entries are dropped. */
  details?: ReadonlyArray<React.ReactNode>;
  /** Shown only when retrying is meaningful — never on a partial success that
   * would duplicate work. */
  onRetry?: () => void;
  retryLabel?: string;
  retryPending?: boolean;
  /** Persistent results are dismissible; without this they cannot be cleared. */
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Extra buttons (Undo, Open, Download again) between retry and dismiss. */
  actions?: React.ReactNode;
}

export declare function ActionResult(props: ActionResultProps): JSX.Element;
