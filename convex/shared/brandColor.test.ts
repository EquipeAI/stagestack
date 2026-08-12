import { describe, expect, test } from "vitest";
import {
  BRAND_COLOR_RULE,
  checkBrandColor,
  contrastRatio,
  hexToRgb,
  isBrandColor,
} from "./brandColor";

// W5: the embed console's picker and `convex/model/embeds.ts` now read one
// rule. These tests pin the rule and the contrast warning's honesty — it warns,
// it never blocks.

describe("brand colour validation", () => {
  test("accepts exactly the four hex lengths that are a colour", () => {
    for (const value of ["#abc", "#abcd", "#7c5cff", "#7c5cffcc", " #FFF "]) {
      expect(isBrandColor(value)).toBe(true);
      // Anything that validates can also be parsed, previewed and measured.
      expect(hexToRgb(value)).not.toBeNull();
    }
  });

  test("rejects the 5- and 7-digit values the old {3,8} rule let through", () => {
    // Not CSS colours: the browser drops them and hexToRgb cannot read them,
    // so they used to save and then render as nothing.
    for (const value of ["#12345", "#1234567"]) {
      expect(isBrandColor(value)).toBe(false);
      expect(hexToRgb(value)).toBeNull();
      expect(checkBrandColor(value).error).toBe(BRAND_COLOR_RULE);
    }
  });

  test("rejects non-hex values outright", () => {
    for (const value of ["rebeccapurple", "rgb(1,2,3)", "#gg0000", "#12", "#"]) {
      expect(isBrandColor(value)).toBe(false);
    }
  });

  test("a non-hex value is refused with the backend's own sentence", () => {
    expect(checkBrandColor("rebeccapurple")).toEqual({
      error: BRAND_COLOR_RULE,
      warning: null,
      ratio: null,
    });
  });

  test("an empty value is neither an error nor a warning — the accent is optional", () => {
    expect(checkBrandColor("   ")).toEqual({
      error: null,
      warning: null,
      ratio: null,
    });
  });
});

describe("contrast", () => {
  test("black on white is the maximum ratio, identical colours the minimum", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#7c5cff", "#7c5cff")).toBeCloseTo(1, 5);
    expect(contrastRatio("nope", "#ffffff")).toBeNull();
    // Alpha is ignored, so #rrggbbaa measures as its opaque #rrggbb.
    expect(contrastRatio("#000000ff", "#ffffff")).toBeCloseTo(21, 5);
  });

  test("a colour that disappears on one of the two surfaces warns, but is still allowed", () => {
    const check = checkBrandColor("#DDDDDD");
    expect(check.error).toBeNull();
    expect(check.warning).toContain("below the 3:1");
    expect(check.ratio).not.toBeNull();
    expect(check.ratio ?? 0).toBeLessThan(3);
  });

  test("a colour legible on both a light and a dark host page draws no warning", () => {
    // Deep violet on white is ~7:1; it is still ~3:1 on the dark surface.
    const check = checkBrandColor("#6B4EFF");
    expect(check.warning).toBeNull();
    expect(check.error).toBeNull();
  });
});
