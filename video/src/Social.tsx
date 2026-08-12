// 1080x1350 trailer for X / LinkedIn.
//
// Hard cuts, a jazz trio underneath, and a voice that is not the long cut's
// voice. Everything here is arranged so the thing works with the sound off —
// the captions alone tell the whole story, price to price — and rewards
// turning it on.

import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { Audio } from "@remotion/media";
import { SOCIAL, JCUT, SocialBeat } from "./trailer";
import { Screen } from "./components/Screen";
import { Detail } from "./components/Detail";
import { Clip } from "./components/Clip";
import { Split } from "./components/Split";
import { c, font, s } from "./theme";

export const SOCIAL_W = 1080;
export const SOCIAL_H = 1350;

const EASE = Easing.bezier(0.16, 1, 0.3, 1);
const FRAMES = SOCIAL.map((b) => s(b.seconds));
/** Absolute start frame of each beat, for the audio J-cuts. */
const STARTS = FRAMES.reduce<number[]>(
  (acc, _f, i) => [...acc, (acc[i - 1] ?? 0) + (FRAMES[i - 1] ?? 0)],
  [],
);

export const socialDuration = () => FRAMES.reduce((a, b) => a + b, 0);

const Ground: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: `radial-gradient(120% 80% at 50% 0%, ${c.gray800} 0%, ${c.gray950} 62%)`,
    }}
  >
    {children}
  </AbsoluteFill>
);

/** Big type on black. Used for the two ends of the film, which rhyme: it opens
 *  on what the incumbent costs and closes on what this one costs. */
const TypeCard: React.FC<{
  lines: string[];
  accent?: number;
  footer?: string;
}> = ({ lines, accent = 0, footer }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        padding: "0 70px",
        textAlign: "center",
        gap: 8,
      }}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          style={{
            fontFamily: font.display,
            fontWeight: 600,
            fontSize: i === accent ? 104 : 74,
            lineHeight: 1.05,
            letterSpacing: -3,
            color: i === accent ? c.amber400 : c.gray0,
            opacity: interpolate(frame, [i * 5, i * 5 + 7], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: EASE,
            }),
            // Snaps in rather than drifting: the long cut breathes, this one
            // punches.
            scale: interpolate(frame, [i * 5, i * 5 + 9], [1.12, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: EASE,
              output: "perceptual-scale",
            }),
          }}
        >
          {line}
        </div>
      ))}
      {footer ? (
        <div
          style={{
            marginTop: 30,
            fontFamily: font.mono,
            fontSize: 38,
            color: c.gray0,
            opacity: interpolate(frame, [16, 24], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          {footer}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const Caption: React.FC<{ text: string; top?: number }> = ({ text, top = 930 }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        position: "absolute",
        left: 68,
        right: 68,
        top,
        fontFamily: font.display,
        fontWeight: 600,
        fontSize: 56,
        lineHeight: 1.14,
        letterSpacing: -1.4,
        color: c.gray0,
        opacity: interpolate(frame, [0, 6], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE,
        }),
        translate: `0px ${interpolate(frame, [0, 9], [14, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: EASE,
        })}px`,
      }}
    >
      {text}
    </div>
  );
};

const Beat: React.FC<{ beat: SocialBeat; durationInFrames: number }> = ({
  beat,
  durationInFrames,
}) => {
  if (beat.kind === "hook") {
    return (
      <Ground>
        <TypeCard lines={beat.lines ?? []} />
      </Ground>
    );
  }
  if (beat.kind === "close") {
    return (
      <Ground>
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <Img
            src={staticFile("brand/logo-inverse.svg")}
            style={{ width: 440, marginBottom: 380 }}
          />
        </AbsoluteFill>
        <div style={{ position: "absolute", inset: 0, top: 150 }}>
          <TypeCard lines={beat.lines ?? []} accent={1} footer="stagestack.dev" />
        </div>
      </Ground>
    );
  }

  return (
    <Ground>
      <div
        style={{
          position: "absolute",
          top: 66,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "center",
        }}
      >
        <Img src={staticFile("brand/logo-inverse.svg")} style={{ width: 270 }} />
      </div>
      {/* The split needs two 16:9 panels stacked, so it borrows the caption's
          room and puts its caption at the very bottom instead. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          top: beat.kind === "split" ? 140 : 200,
          bottom: beat.kind === "split" ? 272 : 480,
        }}
      >
        {beat.kind === "split" ? (
          <Split durationInFrames={durationInFrames} stacked />
        ) : beat.kind === "clip" ? (
          <Clip
            clip={beat.shot as string}
            durationInFrames={durationInFrames}
            cardWidth={940}
            marginTop={0}
            // Portrait: show the grid where the blocks collide, not the page.
            region={{ x: 0.58, y: 0.45, w: 0.5 }}
          />
        ) : beat.kind === "detail" ? (
          <Detail
            shot={beat.shot as string}
            durationInFrames={durationInFrames}
            scale={1}
            // Portrait already reserves a caption band below this box, so the
            // element gets the whole of it.
            padding="0px 40px"
          />
        ) : (
          <Screen
            shot={beat.shot as string}
            durationInFrames={durationInFrames}
            cardWidth={940}
            marginTop={0}
          />
        )}
      </div>
      {beat.caption ? (
        <Caption text={beat.caption} top={beat.kind === "split" ? 1112 : 930} />
      ) : null}
      {/* The split fills the frame to the caption, so the URL would collide
          with it — the close card carries the address anyway. */}
      {beat.kind === "split" ? null : (
        <div
          style={{
            position: "absolute",
            left: 68,
            bottom: 66,
            fontFamily: font.mono,
            fontSize: 30,
            color: c.amber400,
          }}
        >
          stagestack.dev
        </div>
      )}
    </Ground>
  );
};

export const Social: React.FC = () => (
  <AbsoluteFill style={{ background: c.gray950 }}>
    {/* Jazz trio, brushed and mid-register, under the voice the whole way. */}
    <Audio
      src={staticFile("music/shorts.mp3")}
      volume={(f) =>
        0.16 *
        interpolate(
          f,
          [0, 8, socialDuration() - s(1.2), socialDuration()],
          [0, 1, 1, 0],
          { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
        )
      }
    />

    {/* Narration sits on the composition timeline rather than inside each
        beat, so a line can start slightly BEFORE its picture — the J-cut that
        keeps hard cuts from feeling like a slide advance. */}
    {SOCIAL.map((beat, i) => (
      <Sequence
        key={`vo-${beat.id}`}
        from={Math.max(0, STARTS[i] - (i === 0 ? 0 : JCUT))}
        layout="none"
      >
        <Audio src={staticFile(`voice/${beat.id}.mp3`)} />
      </Sequence>
    ))}

    {SOCIAL.map((beat, i) => (
      <Sequence
        key={beat.id}
        from={STARTS[i]}
        durationInFrames={FRAMES[i]}
        name={beat.id}
      >
        <Beat beat={beat} durationInFrames={FRAMES[i]} />
      </Sequence>
    ))}
  </AbsoluteFill>
);
