// A screen recording of the real UI, in the same browser window the stills
// use — so a beat that moves doesn't look like it came from a different video.
//
// Recordings are 1920x1080 (see capture/clips.mjs) and play at their natural
// speed. The card holding them is deliberately identical to <Screen>'s: the
// cut should feel like the same camera, whether the frame happens to move.

import React from "react";
import { AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Video } from "@remotion/media";
import { Chrome } from "./Screen";
import inPoints from "../../public/clips/clips.json";
import { c, FPS } from "../theme";

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

export const Clip: React.FC<{
  clip: string;
  durationInFrames: number;
  url?: string;
  cardWidth?: number;
  marginTop?: number;
  /** region of the 1920x1080 recording to show, 0..1 source coords. A whole
   *  page shrunk into a portrait card is unreadable — the drag beat needs the
   *  grid, not the chrome around it. */
  region?: { x: number; y: number; w: number };
  /** seconds into the recording to start from; defaults to the in-point the
   *  capture measured for this clip (recording begins during sign-in, so the
   *  first several seconds are a login page, not the product) */
  startFrom?: number;
}> = ({
  clip,
  durationInFrames,
  url,
  cardWidth = 1520,
  marginTop = 122,
  startFrom,
  region,
}) => {
  const frame = useCurrentFrame();
  const measured =
    (inPoints as Record<string, { startAt: number }>)[clip]?.startAt ?? 0;
  const trimBefore = Math.round(
    (startFrom !== undefined ? startFrom : measured / 1000) * FPS,
  );
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
          opacity: interpolate(frame, [0, 8], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: EASE,
          }),
        }}
      >
        {url ? <Chrome url={url} /> : null}
        <div style={{ height: IMG_H, overflow: "hidden", position: "relative" }}>
          <Video
            src={staticFile(`clips/${clip}.mp4`)}
            trimBefore={trimBefore}
            durationInFrames={durationInFrames}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "fill",
              ...(region
                ? {
                    scale: 1 / region.w,
                    translate: `${(0.5 - Math.min(Math.max(region.x, region.w / 2), 1 - region.w / 2)) * 100 * (1 / region.w)}% ${(0.5 - Math.min(Math.max(region.y, region.w / 2), 1 - region.w / 2)) * 100 * (1 / region.w)}%`,
                  }
                : {}),
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
