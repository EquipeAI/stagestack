// Lower-third captions and section eyebrows.
//
// The video has to work muted — most people watch a demo with the sound off
// the first time — so captions carry the whole narration.

import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { c, font } from "../theme";

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

/** Fade + rise in, hold, fade out. */
const useReveal = (durationInFrames: number, delay = 0) => {
  const frame = useCurrentFrame();
  const inA = delay;
  const inB = delay + 12;
  const outA = Math.max(inB + 6, durationInFrames - 12);
  const outB = durationInFrames;
  const opacity = interpolate(
    frame,
    [inA, inB, outA, outB],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE },
  );
  const rise = interpolate(frame, [inA, inB], [18, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });
  return { opacity, rise };
};

/** The main narration line, bottom-left, on a graphite scrim. */
export const Caption: React.FC<{
  text: string;
  /** small amber label above the line, e.g. "Requirement 4" */
  eyebrow?: string;
  durationInFrames: number;
  delay?: number;
}> = ({ text, eyebrow, durationInFrames, delay = 0 }) => {
  const { opacity, rise } = useReveal(durationInFrames, delay);

  return (
    <div
      style={{
        position: "absolute",
        left: 152,
        right: 152,
        // Sits inside the browser card (which ends at y=996) rather than
        // hanging off its bottom edge into the ground.
        bottom: 88,
        opacity,
        translate: `0px ${rise}px`,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        alignItems: "flex-start",
      }}
    >
      {eyebrow ? (
        <div
          style={{
            fontFamily: font.mono,
            fontSize: 22,
            letterSpacing: 2.4,
            textTransform: "uppercase",
            color: c.gray950,
            background: c.amber400,
            padding: "7px 16px",
            borderRadius: 6,
            fontWeight: 600,
          }}
        >
          {eyebrow}
        </div>
      ) : null}
      <div
        style={{
          fontFamily: font.display,
          fontWeight: 600,
          fontSize: 48,
          lineHeight: 1.16,
          letterSpacing: -0.8,
          color: c.gray0,
          background: "rgba(10,14,20,0.88)",
          padding: "18px 28px",
          borderRadius: 12,
          maxWidth: 1150,
          boxShadow: "0 20px 60px rgba(10,14,20,0.4)",
        }}
      >
        {text}
      </div>
    </div>
  );
};

/** Big centred statement on the dark ground, used between sections. */
export const Statement: React.FC<{
  lines: string[];
  durationInFrames: number;
  /** index of the line to paint amber */
  accent?: number;
}> = ({ lines, durationInFrames, accent }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      display: "flex",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      gap: 8,
      padding: 120,
      textAlign: "center",
    }}
  >
    {lines.map((line, i) => (
      <StatementLine
        key={i}
        line={line}
        index={i}
        accent={accent === i}
        durationInFrames={durationInFrames}
      />
    ))}
  </div>
);

const StatementLine: React.FC<{
  line: string;
  index: number;
  accent: boolean;
  durationInFrames: number;
}> = ({ line, index, accent, durationInFrames }) => {
  const { opacity, rise } = useReveal(durationInFrames, index * 9);
  return (
    <div
      style={{
        opacity,
        translate: `0px ${rise}px`,
        fontFamily: font.display,
        fontWeight: 600,
        fontSize: 82,
        lineHeight: 1.1,
        letterSpacing: -2,
        color: accent ? c.amber400 : c.gray0,
      }}
    >
      {line}
    </div>
  );
};
