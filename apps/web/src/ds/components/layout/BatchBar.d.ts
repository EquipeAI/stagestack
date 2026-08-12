import * as React from "react";

/** One reason a selected row cannot take part, and how many are in it. The
 * shape `convex/shared/bulkDecisions.ts` and `convex/shared/bulkOutreach.ts`
 * both produce — never re-derived in a route. */
export interface BatchExclusion {
  count: number;
  /** In the organizer's words: "already released — correct it individually". */
  reason: string;
}

export interface BatchBarProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "children"> {
  /** Rows the organizer ticked. */
  count: number;
  /** What a row IS here: "proposal", "contact". Pluralised by adding s. */
  noun?: string;
  nounPlural?: string;
  /** How many of the selection this action can act on. Omit when every
   * selected row is always eligible.
   *
   * When the bar arms several actions with DIFFERENT eligibility rules, pass
   * one entry per rule instead of a number — a single count would be a claim
   * about the wrong button. Each label is a word, not a sentence:
   * `[{ label: 'stageable', count: 4 }, { label: 'releasable', count: 2 }]`. */
  eligible?: number | ReadonlyArray<{ label: string; count: number }>;
  /** Why the rest cannot take part, straight from the producer. */
  exclusions?: ReadonlyArray<BatchExclusion>;
  /** One extra sentence: the expected result, or the rule in force. */
  summary?: React.ReactNode;
  /** The action buttons. Two or three; anything more belongs in a menu. */
  actions?: React.ReactNode;
  children?: React.ReactNode;
  onClear?: () => void;
  clearLabel?: string;
  /** Region label — override when a page can show two bars. */
  label?: string;
}

export declare function BatchBar(props: BatchBarProps): JSX.Element;
