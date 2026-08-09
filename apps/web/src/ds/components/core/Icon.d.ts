import * as React from "react";
export interface IconProps extends React.SVGAttributes<SVGSVGElement> {
  /** Lucide icon name, e.g. "calendar-days". Must exist in ICONS (mirrors assets/icons/). */
  name: string;
  /** Square px size. 14 in dense tables, 16 default, 20 in page headers. */
  size?: number;
  /** Default 1.75 — Lucide ships 2, lightened for dense UI. */
  strokeWidth?: number;
}
/** Monochrome Lucide glyph, inline SVG, always inherits currentColor. */
export declare function Icon(props: IconProps): JSX.Element;
export declare const ICONS: Record<string, string>;
