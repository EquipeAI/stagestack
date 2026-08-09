import * as React from "react";
export interface CalloutProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: "neutral" | "info" | "success" | "attention" | "blocked" | "agent";
  title?: React.ReactNode;
  /** Override the tone's default Lucide icon. */
  icon?: string;
  /** Buttons under the message — usually the fix for the condition described. */
  actions?: React.ReactNode;
}
export declare function Callout(props: CalloutProps): JSX.Element;
