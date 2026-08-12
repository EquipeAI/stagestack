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

/** Region of the 1920x1080 recording to show, in 0..1 source coords. Full-page
 *  at half width is useless here: the whole beat rests on a two-digit number
 *  in a sidebar, and at panel scale that is about ten pixels tall. */
type Region = { x: number; y: number; w: number };

const Panel: React.FC<{
  clip: string;
  label: string;
  trimBefore: number;
  durationInFrames: number;
  delay: number;
  region: Region;
}> = ({ clip, label, trimBefore, durationInFrames, delay, region }) => {
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
          style={{
            width: "100%",
            height: "100%",
            objectFit: "fill",
            scale: 1 / region.w,
            // Clamped so the zoom can never pull empty space into frame.
            translate: `${(0.5 - Math.min(Math.max(region.x, region.w / 2), 1 - region.w / 2)) * 100 * (1 / region.w)}% ${(0.5 - Math.min(Math.max(region.y, region.w / 2), 1 - region.w / 2)) * 100 * (1 / region.w)}%`,
          }}
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
        // The one task card being ticked.
        region={{ x: 0.5, y: 0.46, w: 0.46 }}
      />
      <Panel
        clip="realtime-organizer"
        label="The organizer — nobody here"
        trimBefore={ms(offsets.organizer - LEAD * 1000)}
        durationInFrames={durationInFrames}
        delay={6}
        // The organizer's task table: the column header row down through
        // Priya's row, so the STATUS badge that flips is readable.
        region={{ x: 0.52, y: 0.62, w: 0.6 }}
      />
    </div>
  </AbsoluteFill>
);
