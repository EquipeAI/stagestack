# StageStack demo video

The product demo, built in code with [Remotion](https://remotion.dev) 4.0.508.
Three cuts render from one timeline.

| Cut | Composition | Size | Length | Use |
|---|---|---|---|---|
| Full | `Full` | 1920×1080 | 1:24 | Submission + README |
| Loop | `Loop` | 1920×1080 | 0:19 | stagestack.dev hero, silent, seamless |
| Social | `Social` | 1080×1350 | 0:31 | X / LinkedIn |

## It's a story, not a feature reel

The cut follows one organizer running one conference, in the order the work
happens: **Import · Call · Review · Decide · Schedule · Prep · Publish**. Each
act opens on a chapter card naming the job and what that job normally costs;
every beat plays under a lifecycle rail with the current stage lit, and the
close lands on the whole rail at once.

Captions state the *consequence*, never the feature name — see the comment at
the top of `src/beats.ts`. To restructure the story, edit `ACTS` there; the
compositions just render it.

## Why it's built this way

Nothing here is mocked. Every frame is a **re-photograph of the live deployed
app**, driven by Playwright against the develop preview and the real fixture
data the 2026-08-11 eval run left behind. That means:

- If the product changes, re-run the capture — no re-recording, no re-editing.
- Nothing on screen is a promise the app can't keep.

[SHOTLIST.md](./SHOTLIST.md) maps every beat to the eval evidence that proves
the state is real.

## Layout

```
capture/lib.mjs        Clerk bot sign-in, retina shots, element/region shots,
                       fixture-email redaction
capture/shots.mjs      full-page stills; every shot asserts it loaded
capture/details.mjs    element shots + runs the import agent
capture/reviewer.mjs   the blind scoring form
capture/regions.mjs    re-captures for regions a class selector can't hit
capture/probe*.mjs     throwaway route/selector discovery
src/theme.ts           brand tokens + fonts, lifted from apps/web/src/ds
src/beats.ts           THE CUT — every beat as data
src/components/        Screen (page in browser chrome), Detail (one element),
                       Caption
src/Full|Loop|Social.tsx
```

### Two kinds of beat

`kind: "screen"` shows a whole page inside browser chrome. `kind: "detail"`
shows a single element, screenshotted at its own bounds.

Detail beats exist because **region zooms don't work here**. Cropping into a
full-page capture always slices a heading or card in half, which reads as a
broken screenshot rather than a zoom. Anything that needs to be seen close up
gets its own element capture instead.

### Two honesty rules the capture enforces

1. **Every shot asserts it loaded.** A 404 and a pre-hydration empty state both
   render happily; three of them reached a shipped render before this existed.
   Shots check for error markers and for text proving the real content is there.
2. **Fixture emails are redacted, never faked.** The eval fixtures are real
   mailboxes. `redactFixtureEmails` hides those nodes before the shutter fires.
   It never substitutes invented text — the frame shows only what the app
   rendered, minus a personal address. Shots where the address *is* the content
   were cut from the video instead.

To retime or reword the video, edit `src/beats.ts`. That's the whole edit
surface — the compositions just render it.

## Running it

```bash
npm install
```

Recapture the footage (needs `CLERK_SECRET_KEY` in the repo-root `.env.local`;
`public/shots` is gitignored because they're regenerable retina PNGs):

```bash
node capture/shots.mjs
```

Preview in Remotion Studio:

```bash
npx remotion studio
```

Render all three cuts:

```bash
npx remotion render Full out/stagestack-full.mp4 && npx remotion render Loop out/stagestack-loop.mp4 && npx remotion render Social out/stagestack-social.mp4
```

## Notes

- This project deliberately sits at the repo root, **not** under `apps/`, so
  Vercel's `apps/*` workspace install never pulls Remotion's headless Chrome
  into the web build.
- Remotion is free for individuals and companies up to three people; above
  that it needs a company licence.
- Fonts and logos are copied from `apps/web` into `public/` so the video and
  the product can't drift apart visually.
