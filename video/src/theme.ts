// StageStack brand tokens, lifted from apps/web/src/ds/tokens so the video
// and the product can never drift apart.
import { loadFont } from "@remotion/fonts";
import { staticFile } from "remotion";

export const FPS = 30;
export const W = 1920;
export const H = 1080;

/** seconds -> frames */
export const s = (n: number) => Math.round(n * FPS);

export const c = {
  // Cool graphite neutrals
  gray0: "#FFFFFF",
  gray50: "#F5F7F9",
  gray100: "#ECEFF3",
  gray200: "#DDE2E9",
  gray400: "#9AA3B2",
  gray500: "#6C7585",
  gray700: "#38404D",
  gray800: "#232A34",
  gray900: "#131920",
  gray950: "#0A0E14",

  // Spotlight amber — the brand
  amber300: "#FFC44D",
  amber400: "#FFAF1A",
  amber500: "#F0930A",
  amber700: "#8F5104",

  jade400: "#17B67C",
  jade500: "#0E9265",
  rust500: "#E03E3E",
  beam500: "#1F63F5",
  iris500: "#7C5CFC",
  ember500: "#E06A0B",
} as const;

export const font = {
  display: "Instrument Sans, system-ui, sans-serif",
  body: "Geist, system-ui, sans-serif",
  mono: "Geist Mono, ui-monospace, monospace",
};

// Variable woff2 faces, self-hosted in public/fonts (copied from the app).
export const fontsReady = Promise.all([
  loadFont({
    family: "Instrument Sans",
    url: staticFile("fonts/instrument-sans-latin-wght-normal.woff2"),
    format: "woff2",
    weight: "400 700",
    display: "block",
  }),
  loadFont({
    family: "Geist",
    url: staticFile("fonts/geist-latin-wght-normal.woff2"),
    format: "woff2",
    weight: "100 900",
    display: "block",
  }),
  loadFont({
    family: "Geist Mono",
    url: staticFile("fonts/geist-mono-latin-wght-normal.woff2"),
    format: "woff2",
    weight: "100 900",
    display: "block",
  }),
]);
