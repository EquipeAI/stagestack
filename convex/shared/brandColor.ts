// The embed brand colour rule, expressed once.
//
// The backend has always refused anything but a hex value
// (`convex/model/embeds.ts`), while the console's own hint said "Any CSS color,
// e.g. rebeccapurple" — so the only way to learn the rule was to be refused by
// it. The pattern now lives here, and both the validator and the picker read
// it, alongside the contrast maths the console warns with.
//
// Pure: no ctx, no db, no DOM. Safe in a Convex isolate and in the browser.

/**
 * Hex only, and only the four lengths that are actually a colour: 3 or 6
 * digits, plus the 4/8 alpha forms.
 *
 * The rule this replaces was `{3,8}`, which also admitted 5- and 7-digit
 * values. Those are not CSS colours: a browser drops the declaration, and
 * `hexToRgb` below cannot parse them either — so they validated, saved, and
 * then rendered as nothing while the console showed no preview and no
 * contrast figure. Narrowing is deliberate (see the report): the 4- and 8-
 * digit alpha forms stay accepted exactly as before, and stored values are
 * untouched because this rule runs on write only — a legacy 5- or 7-digit
 * config keeps serving until someone saves that embed again, at which point
 * it is refused with the sentence below rather than silently kept broken.
 */
export const BRAND_COLOR_PATTERN =
  /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const BRAND_COLOR_RULE =
  "The brand color must be a hex value like #7c5cff.";

export function isBrandColor(value: string): boolean {
  return BRAND_COLOR_PATTERN.test(value.trim());
}

/** The embed's own card background, per DS token `--surface-card`, light and
 * dark. An embed is dropped into somebody else's page, so both are plausible
 * and the warning reports the WORSE of the two. */
export const EMBED_BACKGROUNDS = ["#FFFFFF", "#12161C"] as const;

/** #rgb / #rgba / #rrggbb / #rrggbbaa — exactly the lengths the validator
 * accepts, so anything that validates can also be previewed and measured.
 * Alpha is ignored for contrast: a translucent accent's real contrast depends
 * on what is behind it, which an embed on somebody else's page does not know.
 * Returns null for anything else. */
export function hexToRgb(
  value: string,
): { r: number; g: number; b: number } | null {
  const trimmed = value.trim();
  if (!BRAND_COLOR_PATTERN.test(trimmed)) return null;
  const hex = trimmed.slice(1);
  const digits =
    hex.length <= 4
      ? [...hex.slice(0, 3)].map((c) => c + c)
      : [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6)];
  const [r, g, b] = digits.map((pair) => Number.parseInt(pair, 16));
  if (r === undefined || g === undefined || b === undefined) return null;
  return { r, g, b };
}

/** WCAG 2.x relative luminance. */
function luminance(rgb: { r: number; g: number; b: number }): number {
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
  );
}

/** WCAG contrast ratio, 1–21. Null when either colour cannot be parsed. */
export function contrastRatio(a: string, b: string): number | null {
  const first = hexToRgb(a);
  const second = hexToRgb(b);
  if (first === null || second === null) return null;
  const light = Math.max(luminance(first), luminance(second));
  const dark = Math.min(luminance(first), luminance(second));
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG 2.2 non-text/large-text threshold — the accent colours chips, tags and
 * borders, not body copy, so 3:1 is the honest bar to hold it to. */
export const MIN_ACCENT_CONTRAST = 3;

export type BrandColorCheck = {
  /** Refuses the value outright — the same rule the backend enforces. */
  error: string | null;
  /** Legible but worth saying out loud. Never a block. */
  warning: string | null;
  /** Worst ratio across the light and dark embed backgrounds. */
  ratio: number | null;
};

export function checkBrandColor(value: string): BrandColorCheck {
  const trimmed = value.trim();
  if (trimmed === "") return { error: null, warning: null, ratio: null };
  if (!isBrandColor(trimmed)) {
    return { error: BRAND_COLOR_RULE, warning: null, ratio: null };
  }
  const ratios = EMBED_BACKGROUNDS.map((bg) => contrastRatio(trimmed, bg));
  if (ratios.some((r) => r === null)) {
    return { error: null, warning: null, ratio: null };
  }
  const worst = Math.min(...(ratios as Array<number>));
  const rounded = Math.round(worst * 10) / 10;
  return {
    error: null,
    ratio: rounded,
    warning:
      worst >= MIN_ACCENT_CONTRAST
        ? null
        : `Contrast ${rounded}:1 against an embed background — below the ${MIN_ACCENT_CONTRAST}:1 this needs to stay legible. It will still be saved; tags and chips in this colour may be hard to read on a light or dark host page.`,
  };
}
