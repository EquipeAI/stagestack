import * as React from "react";

type SwitchBase = Omit<React.InputHTMLAttributes<HTMLInputElement>, "aria-label" | "aria-labelledby">;

/**
 * A switch must carry an accessible name, so at least one of these three is
 * required and an unnamed `<Switch />` is a type error rather than a control a
 * screen reader reads as "switch, on".
 *
 *   label            visible text rendered beside the track
 *   aria-label       the name lives in nearby copy; keep the visible text
 *                    inside the value (WCAG 2.5.3 Label in Name)
 *   aria-labelledby  same, pointing at the id already rendering that name
 *
 * Combining `label` with `aria-label`/`aria-labelledby` is allowed: a row whose
 * switch reads "Active" needs the requirement's name in the accessible name.
 */
type SwitchNamed =
  | { label: React.ReactNode; "aria-label"?: string; "aria-labelledby"?: string }
  | { label?: React.ReactNode; "aria-label": string; "aria-labelledby"?: string }
  | { label?: React.ReactNode; "aria-label"?: string; "aria-labelledby": string };

export type SwitchProps = SwitchBase & SwitchNamed;
export declare function Switch(props: SwitchProps): JSX.Element;
