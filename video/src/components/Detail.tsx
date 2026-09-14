// A single UI element, framed on the dark ground.
//
// This is the answer to "the zoom looks weird". Cropping into a full-page
// capture always slices a heading or a card in half; a detail beat instead
// shows one element that was screenshotted at its own bounds, so it is
// correctly framed by construction and can be shown large.

import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { c } from "../theme";

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

export const Detail: React.FC<{
  shot: string;
  durationInFrames: number;
  /** how much of the safe area the element may occupy */
  scale?: number;
  /** the padding reserves a caption band below; portrait cuts place the
   *  caption outside this box and need the element to fill what it is given */
  padding?: string;
}> = ({ shot, durationInFrames, scale = 1, padding = "120px 160px 300px" }) => {
  const frame = useCurrentFrame();
  const t = [0, durationInFrames] as const;
  const opts = {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  } as const;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        // Leaves the lower band clear for the caption.
        padding,
      }}
    >
      <Img
        src={staticFile(`shots/${shot}.png`)}
        style={{
          maxWidth: `${100 * scale}%`,
          maxHeight: `${100 * scale}%`,
          objectFit: "contain",
          borderRadius: 14,
          background: c.gray0,
          boxShadow:
            "0 40px 110px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08)",
          // A slow, tiny push. Nothing is cropped, so this can never slice
          // an element the way a region zoom did.
          scale: interpolate(frame, t, [1, 1.045], opts),
          opacity: interpolate(frame, [0, 10], [0, 1], opts),
        }}
      />
    </AbsoluteFill>
  );
};
