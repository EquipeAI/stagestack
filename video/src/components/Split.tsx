// The split-screen: two people, two screens, one click.
//
// This is the only beat in the film that needs two recordings playing at once,
// because the claim is about simultaneity — the organizer's number moves while
// nobody is touching the organizer's screen. Cutting between the two would
// destroy exactly the thing being shown.
//
// The two recordings started at different moments, so they are aligned from
// measurements rather than by eye: capture/realtime.mjs writes how many
// milliseconds into each recording the click landed, and each side is trimmed
// so those instants coincide at LEAD seconds into the beat.

import React from "react";
import { AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Video } from "@remotion/media";
import offsets from "../../public/clips/realtime.json";
import { c, font, FPS } from "../theme";

const EASE = Easing.bezier(0.16, 1, 0.3, 1);
/** Seconds of "nothing is happening yet" before the click. */
export const LEAD = 2.6;

const ms = (n: number) => Math.max(0, Math.round((n / 1000) * FPS));

const Panel: React.FC<{
  clip: string;
  label: string;
  trimBefore: number;
  durationInFrames: number;
  delay: number;
}> = ({ clip, label, trimBefore, durationInFrames, delay }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        opacity: interpolate(frame, [delay, delay + 10], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE,
        }),
      }}
    >
      <div
        style={{
          fontFamily: font.mono,
          fontSize: 21,
          letterSpacing: 2.4,
          textTransform: "uppercase",
          color: c.amber400,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          borderRadius: 12,
          overflow: "hidden",
          background: c.gray0,
          aspectRatio: "16 / 9",
          boxShadow:
            "0 30px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.07)",
        }}
      >
        <Video
          src={staticFile(`clips/${clip}.mp4`)}
          trimBefore={trimBefore}
          durationInFrames={durationInFrames}
          style={{ width: "100%", height: "100%", objectFit: "fill" }}
        />
      </div>
    </div>
  );
};

export const Split: React.FC<{ durationInFrames: number }> = ({
  durationInFrames,
}) => (
  <AbsoluteFill
    style={{
      justifyContent: "center",
      alignItems: "center",
      padding: "150px 90px 330px",
    }}
  >
    <div style={{ display: "flex", gap: 40, width: "100%" }}>
      <Panel
        clip="realtime-speaker"
        label="The speaker"
        trimBefore={ms(offsets.speaker - LEAD * 1000)}
        durationInFrames={durationInFrames}
        delay={0}
      />
      <Panel
        clip="realtime-organizer"
        label="The organizer — untouched"
        trimBefore={ms(offsets.organizer - LEAD * 1000)}
        durationInFrames={durationInFrames}
        delay={6}
      />
    </div>
  </AbsoluteFill>
);
