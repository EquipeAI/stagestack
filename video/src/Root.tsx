import "./index.css";
import React from "react";
import { Composition } from "remotion";
import { Full, fullDuration } from "./Full";
import { Loop, loopDuration } from "./Loop";
import { Social, socialDuration, SOCIAL_W, SOCIAL_H } from "./Social";
import { FPS, W, H } from "./theme";
import "./theme"; // side effect: kick off font loading

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Submission cut — the one the judges watch. */}
      <Composition
        id="Full"
        component={Full}
        durationInFrames={fullDuration()}
        fps={FPS}
        width={W}
        height={H}
      />
      {/* Silent hero loop for stagestack.dev. */}
      <Composition
        id="Loop"
        component={Loop}
        durationInFrames={loopDuration()}
        fps={FPS}
        width={W}
        height={H}
      />
      {/* Portrait cut for X / LinkedIn. */}
      <Composition
        id="Social"
        component={Social}
        durationInFrames={socialDuration()}
        fps={FPS}
        width={SOCIAL_W}
        height={SOCIAL_H}
      />
    </>
  );
};
