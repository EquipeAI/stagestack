# StageStack demo video — the story

Source of truth for the Remotion timeline. Every beat is a state that exists on
the deployed app, re-photographed at video resolution by `capture/`. Nothing is
mocked, and every capture asserts it loaded before the shutter fires.

- Capture target: `https://stagestack-git-develop-equipe-ai.vercel.app`
- Backend: `marvelous-snail-907` (staging)
- Live demo data: org **DevFlow**, event **DevFlow Conf 2027** (12–14 May 2027,
  Moscone West), speakers **Priya Raman**, **Marcus Okafor**, **Dana Kowalski**,
  reviewer **Sam Whitfield**.

## The change that matters

The first version of this video was a feature reel: shot, zoom, feature name,
next. It answered "what does it have?" — a question nobody watching a demo is
actually asking. This version answers "what is my week like?".

It follows **one organizer running one conference**, in the order the work
happens. Each act opens on a chapter card with the job to be done and what that
job normally costs, and every beat inside plays under a **lifecycle rail**
(Import · Call · Review · Decide · Schedule · Prep · Publish) with the current
stage lit.

The rail is the argument. A feature list makes a viewer wonder how many more
features there are; the rail tells them up front, and by the close — where the
whole rail is lit at once — they have watched one product carry a conference
from an inherited spreadsheet to a published program.

Captions follow one rule: **say the consequence, never the feature name.**
"Weighted scorecards, reviewer caps, dated rounds" is a spec sheet. "You set the
weights once, and every score lands on the same scale" is why anyone cares.

## The acts

| Stage | The job | Beats |
|---|---|---|
| **Import** | Day one: you inherit a spreadsheet | import plan; one record with the agent's reasoning |
| **Call** | Open the call for speakers | CFP builder; conditional sections; the public wizard |
| **Review** | Read all of it, fairly | blind scoring form; weighted scorecard |
| **Decide** | Decide, then tell 60 people | proposals table; comms templates; the delivery log |
| **Schedule** | Fit it into three rooms and three days | conflict refusal; list / track / week |
| **Prep** | Stop chasing people for bios | speaker portal; their slot; the missing-bio warning; auto reminders |
| **Publish** | Put the program in front of the world | public event page; embed widgets |

Cold open states the problem ($40k, "he called it slow"); the close lands on the
full rail plus `stagestack.dev`.

## Cuts

| Cut | Comp | Size | Use |
|---|---|---|---|
| Full | `Full` | 1920×1080 | submission + README |
| Loop | `Loop` | 1920×1080 | stagestack.dev hero, silent, seamless |
| Social | `Social` | 1080×1350 | X / LinkedIn |

The Loop is ordered as the same lifecycle so it still reads as one event moving
forward even without captions. Social has no room for the rail, so each beat
carries its stage as an eyebrow instead.

## Capture notes

- `capture/shots.mjs` — 28 full-page stills, each asserting real content loaded.
- `capture/details.mjs`, `reviewer.mjs`, `comms-log.mjs` — element and tab shots.
- `capture/import-rerun.mjs` — clears the previous plan, uploads the fixture CSV
  and captures the fresh plan. **Never approves the import** — that would write
  into the event the eval judges look at.
- The import fixture is deliberately ASCII: the parser currently decodes UTF-8
  as latin-1, so an em-dash arrives as `â€`. Real bug, reported separately; the
  demo should not ship a screenshot of it.

## Deliberately cut

CRM (explicitly deprioritized), exhibitors/sponsors, and any shot where a
fixture mailbox address is the content rather than incidental.

## Still missing

1. **Real inbox + `.ics` on a calendar** — needs the owner's own mailbox; two
   supplied screenshots dropped into `public/shots` would slot straight in.
2. **Motion clips**: the agenda drag itself, and the portal→dashboard realtime
   update. `capture/lib.mjs` supports `recordVideo`; the clips are unbuilt.
