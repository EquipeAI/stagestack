// A StageStack screen building itself, piece by piece, then resolving into the
// real thing.
//
// The honesty problem with an animated "product UI" is that it is a drawing:
// it can show anything, including things the product cannot do. So this one is
// deliberately a WIREFRAME — flat blocks in the brand's own colours, obviously
// a diagram rather than a screenshot — and it ends by cross-dissolving into an
// actual capture of the deployed app. The abstraction resolves into the real
// screen, which is the opposite of passing a drawing off as a product.
//
// Everything animates off `useCurrentFrame()` with staggered delays; there is
// no CSS transition anywhere, because those do not render.

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

const EASE = Easing.bezier(0.16, 1, 0.3, 1);

/** Fade + rise + settle, delayed by `delay` frames. */
const enter = (frame: number, delay: number, rise = 26) => ({
  opacity: interpolate(frame, [delay, delay + 9], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  }),
  translate: `0px ${interpolate(frame, [delay, delay + 13], [rise, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  })}px`,
});

const Bar: React.FC<{
  w: number | string;
  h: number;
  delay: number;
  colour?: string;
  radius?: number;
}> = ({ w, h, delay, colour = c.gray200, radius = 5 }) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: radius,
        background: colour,
        ...enter(frame, delay, 10),
      }}
    />
  );
};

/** A stat tile whose number counts up as it lands. */
const Stat: React.FC<{ label: string; to: number; delay: number }> = ({
  label,
  to,
  delay,
}) => {
  const frame = useCurrentFrame();
  const value = Math.round(
    interpolate(frame, [delay + 6, delay + 30], [0, to], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: EASE,
    }),
  );
  return (
    <div
      style={{
        flex: 1,
        background: c.gray50,
        border: `1px solid ${c.gray200}`,
        borderRadius: 10,
        padding: "16px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        ...enter(frame, delay, 22),
      }}
    >
      <div
        style={{
          fontFamily: font.mono,
          fontSize: 13,
          letterSpacing: 1.6,
          textTransform: "uppercase",
          color: c.gray500,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: font.display,
          fontWeight: 600,
          fontSize: 34,
          lineHeight: 1,
          color: c.gray900,
        }}
      >
        {value}
      </div>
    </div>
  );
};

export const Assemble: React.FC<{
  /** the real capture this resolves into */
  shot?: string;
  /** frame at which the real screenshot has fully taken over */
  resolveAt?: number;
  width?: number;
}> = ({ shot = "02-dashboard", resolveAt = 78, width = 1180 }) => {
  const frame = useCurrentFrame();
  const H = (width / 16) * 9;

  // The wireframe hands over to the real capture. Both are inside the same
  // window, so the swap reads as the drawing becoming the product.
  const real = interpolate(frame, [resolveAt - 14, resolveAt], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: EASE,
  });

  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          width,
          borderRadius: 14,
          overflow: "hidden",
          background: c.gray0,
          boxShadow:
            "0 40px 110px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.07)",
          // The window itself draws first, from nothing.
          scale: interpolate(frame, [0, 12], [0.94, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: EASE,
            output: "perceptual-scale",
          }),
          opacity: interpolate(frame, [0, 7], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      >
        <div
          style={{
            height: 40,
            background: c.gray100,
            borderBottom: `1px solid ${c.gray200}`,
            display: "flex",
            alignItems: "center",
            gap: 8,
            paddingInline: 16,
          }}
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              style={{
                width: 9,
                height: 9,
                borderRadius: 999,
                background: c.gray400,
                opacity: 0.5,
              }}
            />
          ))}
        </div>

        <div style={{ height: H, position: "relative", display: "flex" }}>
          {/* ---- the wireframe ---- */}
          <div
            style={{
              width: 168,
              background: c.gray50,
              borderRight: `1px solid ${c.gray200}`,
              padding: "18px 14px",
              display: "flex",
              flexDirection: "column",
              gap: 11,
            }}
          >
            <Bar w={94} h={11} delay={8} colour={c.amber400} />
            <div style={{ height: 8 }} />
            {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
              <Bar key={i} w={i % 3 === 0 ? 118 : 96} h={9} delay={12 + i * 2} />
            ))}
          </div>

          <div
            style={{
              flex: 1,
              padding: "22px 26px 24px",
              display: "flex",
              flexDirection: "column",
              gap: 16,
              minHeight: 0,
            }}
          >
            <Bar w={330} h={20} delay={16} colour={c.gray400} radius={6} />
            <Bar w={190} h={10} delay={19} />
            <div style={{ display: "flex", gap: 12, marginTop: 6 }}>
              <Stat label="Proposals" to={512} delay={24} />
              <Stat label="Reviews" to={128} delay={28} />
              <Stat label="Sessions" to={68} delay={32} />
              <Stat label="Tasks" to={17} delay={36} />
            </div>
            <div
              style={{
                marginTop: 4,
                border: `1px solid ${c.gray200}`,
                borderRadius: 10,
                overflow: "hidden",
                flex: 1,
                display: "flex",
                flexDirection: "column",
              }}
            >
              {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                <div
                  key={i}
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "0 16px",
                    borderTop: i === 0 ? "none" : `1px solid ${c.gray100}`,
                  }}
                >
                  <Bar w={250 - i * 14} h={10} delay={42 + i * 2.5} />
                  <div style={{ flex: 1 }} />
                  <Bar
                    w={62}
                    h={16}
                    delay={44 + i * 2.5}
                    colour={i === 1 ? c.amber400 : c.gray200}
                    radius={999}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* ---- and the real screen, taking over ---- */}
          <Img
            src={staticFile(`shots/${shot}.png`)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "fill",
              opacity: real,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
