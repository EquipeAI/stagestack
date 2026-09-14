// The lifecycle rail: Import · Call · Review · Decide · Schedule · Prep · Publish.
//
// This is the storytelling spine. A feature reel makes a viewer ask "how many
// more of these are there?"; the rail answers that before they ask, and it is
// the single strongest argument the video makes — the whole job of running an
// event fits on one line, inside one product.

import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { c, font } from "../theme";

export const STAGES = [
  "Import",
  "Call",
  "Review",
  "Decide",
  "Schedule",
  "Prep",
  "Publish",
] as const;

export type Stage = (typeof STAGES)[number];

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

export const Rail: React.FC<{ active: Stage }> = ({ active }) => {
  const frame = useCurrentFrame();
  const activeIndex = STAGES.indexOf(active);

  return (
    <div
      style={{
        position: "absolute",
        top: 46,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 12,
        opacity: interpolate(frame, [0, 10], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE,
        }),
      }}
    >
      {STAGES.map((stage, i) => {
        const isActive = i === activeIndex;
        const isDone = i < activeIndex;
        return (
          <React.Fragment key={stage}>
            {i > 0 ? (
              <div
                style={{
                  width: 26,
                  height: 2,
                  borderRadius: 2,
                  background: isDone || isActive ? c.amber700 : c.gray800,
                }}
              />
            ) : null}
            <div
              style={{
                fontFamily: font.mono,
                fontSize: 19,
                letterSpacing: 2,
                textTransform: "uppercase",
                fontWeight: 600,
                padding: "8px 16px",
                borderRadius: 999,
                // Past stages stay lit but recede, so the rail reads as
                // progress through a job rather than a nav bar.
                color: isActive ? c.gray950 : isDone ? c.amber400 : c.gray700,
                background: isActive ? c.amber400 : "transparent",
                border: `1px solid ${
                  isActive
                    ? c.amber400
                    : isDone
                      ? "rgba(255,175,26,0.35)"
                      : c.gray800
                }`,
                // Only the active pill animates, and only on the frame the act
                // changes — a rail that breathes constantly steals attention
                // from the product behind it.
                scale: isActive
                  ? interpolate(frame, [0, 14], [0.86, 1], {
                      extrapolateLeft: "clamp",
                      extrapolateRight: "clamp",
                      easing: EASE,
                      output: "perceptual-scale",
                    })
                  : 1,
              }}
            >
              {stage}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
};
