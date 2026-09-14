# StageStack demo video

The product demo, built in code with [Remotion](https://remotion.dev) 4.0.508.
Three cuts render from one timeline.

| Cut | Composition | Size | Length | Use |
|---|---|---|---|---|
| Full | `Full` | 1920×1080 | 2:43 | Submission + README |
| Loop | `Loop` | 1920×1080 | 0:22 | stagestack.dev hero, silent, seamless |
| Social | `Social` | 1080×1350 | 0:34 | X / LinkedIn |

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
capture/clips.mjs      screen recordings: the agenda drag, the five views
capture/realtime.mjs   the split-screen, plus the alignment offsets
capture/restore-agenda.mjs  undoes the conflict the drag clip creates
scripts/voice.mjs      Deepgram Aura-2 narration + measured durations
scripts/voice-check.mjs  speech-to-text round trip, to catch mispronunciations
scripts/music.mjs      the Lyria score
src/theme.ts           brand tokens + fonts, lifted from apps/web/src/ds
src/beats.ts           THE CUT — every beat as data
src/components/        Screen (page in browser chrome), Detail (one element),
                       Clip (a recording in that same window), Split (two
                       recordings, time-aligned), Rail, ActCard, Caption
src/Full|Loop|Social.tsx
```

### Four kinds of beat

`kind: "screen"` shows a whole page inside browser chrome. `kind: "detail"`
shows a single element, screenshotted at its own bounds. `kind: "clip"` plays a
screen recording inside that same window. `kind: "split"` plays two recordings
side by side, aligned to the same instant.

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

### The audio

The narration script is [narration.json](./narration.json); `scripts/voice.mjs`
generates it with Deepgram Aura-2 and **measures every line**, writing
`public/voice/durations.json`. `beats.ts` reads those durations, so each segment
lasts its own line plus a breath — the cut is timed *from* the audio rather than
beside it. Lines are content-hashed, so editing one sentence regenerates one
file.

Two rules live at the top of `narration.json` and both were learned the hard
way: the voice never reads the caption aloud, and it never uses an unusual
compound word (Aura-2 read "self-hostable" with the stress of "hostage", and it
supports no SSML or phoneme tags, so the fix is different words).

`scripts/voice-check.mjs` sends the generated speech back through Deepgram's
speech-to-text and diffs it against the script. It catches a word swapped for
another word. It does **not** catch a word merely stressed wrongly — recognisers
repair those silently — so it is a net, not a proof.

The score comes from `scripts/music.mjs` (Lyria 3 Pro) and sits at 0.12 under
the voice. If it returns `content_blocked`, change the wording of the brief:
the filter false-positives on some entirely ordinary phrasings.

To retime or reword the video, edit `src/beats.ts` and `narration.json`. That's
the whole edit surface — the compositions just render it.

## Running it

```bash
npm install
```

Recapture the footage (needs `CLERK_SECRET_KEY` in the repo-root `.env.local`;
`public/shots` is gitignored because they're regenerable retina PNGs):

```bash
node capture/shots.mjs
```

Then the element shots, the recordings and the audio:

```bash
node capture/details.mjs && node capture/reviewer.mjs && node capture/comms-log.mjs
```

```bash
node capture/clips.mjs drag && node capture/restore-agenda.mjs && node capture/clips.mjs views && node capture/realtime.mjs
```

```bash
node scripts/voice.mjs && node scripts/voice-check.mjs && node scripts/music.mjs
```

`capture/clips.mjs drag` deliberately creates a scheduling conflict on the live
event so the blocker fires on camera — always run `restore-agenda.mjs` after it.

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
