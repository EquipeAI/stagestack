// The chapter card that opens each act.
//
// Two lines only: the job the organizer is doing, and what it usually costs
// them. The product then answers the second line for the next ~15 seconds.

import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { Rail, Stage } from "./Rail";
import { c, font } from "../theme";

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

export const ActCard: React.FC<{
  stage: Stage;
  /** the organizer's job, e.g. "Read everything, fairly" */
  title: string;
  /** what it normally costs, e.g. "Usually: a shared spreadsheet and trust." */
  usually: string;
  durationInFrames: number;
}> = ({ stage, title, usually, durationInFrames }) => {
  const frame = useCurrentFrame();
  const reveal = (delay: number) => ({
    opacity: interpolate(
      frame,
      [delay, delay + 12, durationInFrames - 8, durationInFrames],
      [0, 1, 1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: EASE },
    ),
    translate: `0px ${interpolate(frame, [delay, delay + 14], [22, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE,
    })}px`,
  });

  return (
    <>
      <Rail active={stage} />
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          gap: 26,
          padding: "0 200px",
          textAlign: "center",
        }}
      >
        <div
          style={{
            ...reveal(0),
            fontFamily: font.display,
            fontWeight: 600,
            fontSize: 92,
            lineHeight: 1.06,
            letterSpacing: -2.4,
            color: c.gray0,
          }}
        >
          {title}
        </div>
        <div
          style={{
            ...reveal(9),
            fontFamily: font.body,
            fontSize: 40,
            lineHeight: 1.3,
            color: c.gray400,
            maxWidth: 1150,
          }}
        >
          {usually}
        </div>
      </div>
    </>
  );
};
