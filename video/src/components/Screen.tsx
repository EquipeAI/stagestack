// A screenshot presented inside a floating browser window, with a slow push
// toward a region of interest.
//
// Every capture is 3840x2160 — exactly 2x the 1920x1080 comp — so `focus` is
// expressed in normalized 0..1 coordinates of the source image and the maths
// stays resolution independent.

import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { c, font } from "../theme";

export type Focus = {
  /** centre of the region of interest, 0..1 of the source image */
  x: number;
  y: number;
  /** how much of the source width to show. 1 = whole page, 0.4 = tight */
  w: number;
};

const WHOLE: Focus = { x: 0.5, y: 0.5, w: 1 };

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

export const Screen: React.FC<{
  shot: string;
  /** where the push starts (defaults to the full page) */
  from?: Focus;
  /** where the push ends */
  to?: Focus;
  durationInFrames: number;
  /** browser chrome URL text; omit to hide the chrome entirely */
  url?: string;
  /** subtle continuous drift even when from/to match */
  drift?: boolean;
  /** overrides for non-16:9 cuts (social) */
  cardWidth?: number;
  marginTop?: number;
}> = ({
  shot,
  from = WHOLE,
  to,
  durationInFrames,
  url,
  drift = true,
  cardWidth = 1600,
  marginTop = 44,
}) => {
  const frame = useCurrentFrame();
  // With no explicit `to`, the image itself must not move at all: even a 3%
  // push into a full page shaves the sidebar labels down to "LLECT" and
  // "EPARE", which reads as a broken capture. The beat is kept alive by
  // drifting the browser card instead — see `cardScale` below.
  const end = to ?? from;
  const cardDrift = drift && !to;

  // Scale is inverse of how much width we show.
  const scaleAt = (f: Focus) => 1 / f.w;
  // Keep the focus point far enough from the edges that the zoom can never
  // pull empty space into frame.
  const clamp = (f: Focus, axis: "x" | "y") =>
    Math.min(Math.max(f[axis], f.w / 2), 1 - f.w / 2);
  // Translate so the focus point lands in the middle of the frame.
  const offsetAt = (f: Focus, axis: "x" | "y") =>
    (0.5 - clamp(f, axis)) * 100 * scaleAt(f);

  const t = [0, durationInFrames] as const;
  const opts = {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  } as const;

  // The card is sized so the 16:9 capture fits whole at scale 1 — a partially
  // clipped sidebar or half a nav bar reads as a broken screenshot, not a
  // zoom. The bottom strip is left clear for the caption.
  const CARD_W = cardWidth;
  const IMG_H = (CARD_W / 16) * 9;

  return (
    <AbsoluteFill style={{ alignItems: "center" }}>
      <div
        style={{
          marginTop,
          width: CARD_W,
          borderRadius: 16,
          overflow: "hidden",
          background: c.gray0,
          boxShadow:
            "0 40px 110px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)",
          // Scaling the whole window, not its contents, so nothing is clipped.
          scale: cardDrift
            ? interpolate(frame, t, [1, 1.022], {
                ...opts,
                output: "perceptual-scale",
              })
            : 1,
        }}
      >
        {url ? <Chrome url={url} /> : null}
        <div
          style={{
            height: IMG_H,
            overflow: "hidden",
            position: "relative",
          }}
        >
          <Img
            src={staticFile(`shots/${shot}.png`)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "fill",
              scale: interpolate(
                frame,
                t,
                [scaleAt(from), scaleAt(end)],
                opts,
              ),
              translate: `${interpolate(
                frame,
                t,
                [offsetAt(from, "x"), offsetAt(end, "x")],
                opts,
              )}% ${interpolate(
                frame,
                t,
                [offsetAt(from, "y"), offsetAt(end, "y")],
                opts,
              )}%`,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** Exported so <Clip> can wear the identical browser window. */
export const Chrome: React.FC<{ url: string }> = ({ url }) => (
  <div
    style={{
      height: 52,
      flexShrink: 0,
      background: c.gray100,
      borderBottom: `1px solid ${c.gray200}`,
      display: "flex",
      alignItems: "center",
      gap: 10,
      paddingInline: 20,
    }}
  >
    {[c.gray400, c.gray400, c.gray400].map((dot, i) => (
      <div
        key={i}
        style={{
          width: 11,
          height: 11,
          borderRadius: 999,
          background: dot,
          opacity: 0.55,
        }}
      />
    ))}
    <div
      style={{
        marginLeft: 14,
        flex: 1,
        maxWidth: 620,
        height: 30,
        borderRadius: 999,
        background: c.gray0,
        border: `1px solid ${c.gray200}`,
        display: "flex",
        alignItems: "center",
        paddingInline: 14,
        fontFamily: font.mono,
        fontSize: 15,
        color: c.gray500,
      }}
    >
      {url}
    </div>
  </div>
);
