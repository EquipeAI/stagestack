# The "$10,000 Kill My SaaS" Challenge

Source: [competition brief](reference/competition-brief.pdf) + [walkthrough video 1](reference/walkthrough-1.mp4) ([transcript](reference/walkthrough-1.en.srt)) + 40 screenshots

> Note: walkthrough videos (`walkthrough-*.mp4`) are gitignored due to size (~35MB each) — keep local copies in `docs/reference/`; transcripts and PDF are committed. (extracted to [docs/screenshots/](screenshots/), numbered to match the brief's sections — they are the UI spec). Organized by swyx / AI Engineer to replace Sessionboard (>$40k/yr) with an open source clone.

**Posture: we build a good product that happens to win.** The brief is a real customer's annotated requirements — we honor it as the acceptance test, not as the product vision. Vision lives in BUSINESS_CONTEXT.md and MILESTONES.md.

## Rules & logistics

- **Deadline: Wednesday, Aug 12, 2026, 10:00 PM PT.**
- Submission = form + **open source repo** + **deployed site** they can test against the walkthrough.
- Judged by the AIE team (not swyx) walking the deployed site through the requirements.
- **Tiebreaker: product judgment calls they would actually use/buy.** This is the real bar.
- Prize: $10,000 + latent.space writeup. Token reimbursement up to $500 for valid attempts.
- Discord for questions/updates. Clarification videos Sat + Sun, then **requirements FREEZE**.

## In-scope requirements (the six)

1. **Custom CFP submission forms** — conditional logic, category-based routing. Multi-step public wizard: Welcome → Account → Submission → Participant → Review. Form builder with sections, field library (text, wysiwyg, dropdown, email, phone, file), required toggles, locked system fields (Title, First/Last Name, Email). Close dates ("kinda impt"), submission limits per user, drafts, custom success page ("make sure this works"), submitter confirmation email ("must have"), admin new/updated-submission notifications ("nice to have").
2. **Self-service speaker portal** — my submissions + statuses, editable profile (bio, headshot, social links), tasks, forms, file uploads. Admin "view as speaker" impersonation exists in Sessionboard and is worth matching.
3. **Automated, templated speaker communications** — email templates, reminders, and **calendar invites that land on the speaker's own calendar** (Gmail, Outlook, iCal).
4. **Submission evaluation & scoring** — statuses: Draft, Pending, Accept Queue, Accepted, Decline Queue, Declined, Withdrawn. Evaluation plans with reviewer scoring. (AI-assisted multi-round review was STRUCK from the brief.)
5. **Drag-and-drop agenda builder** — automatic conflict detection across rooms and tracks; views: list, day, week, track, room.
6. **Real-time speaker-ops dashboard** — outstanding onboarding tasks per speaker, e.g. "2 accepted speakers are missing a bio or headshot".

Supporting surface shown in screenshots (expected in the walkthrough):

- **Abstracts admin table**: search, filters, sort, saved views, column preferences, status chips, CSV/XLSX export, file-bundle download, manual add, import.
- **Event settings**: name, slug, type, location, timezone, start/end, logo/background images, tags, tracks, custom fields, email templates/themes.
- **Portal tasks & forms**: tasks assignable to contacts/groups/submissions; portal forms; file requests (files stored, not attached — their note).

## From the walkthrough video (transcript reviewed Aug 8)

- **Abstracts vs. Sessions**: abstracts = applications to speak; sessions = guaranteed speakers (e.g. sponsors, invited). Manual/pre-accepted entry is a first-class path, not just a CFP outcome.
- **Evaluation by committees**: reviewer teams assigned to batches of submissions, plus per-reviewer scoring views.
- **Portal**: acceptance status visibility is "a key part"; bio self-editing "very important"; post-acceptance tasks "optional, but very very handy".
- **English only** — no multi-language support needed.
- **Speed**: he complains twice, unprompted, about Sessionboard being slow. Perceived speed is a judged feature.
- **Judging philosophy, verbatim**: "It's not about fidelity to Sessionboard, it's about filling the job to be done… you are allowed to use your own judgment. The higher fidelity, the more usefulness."
- Multiple speakers per submission shown (min/max role counts exist, but their real events use min 1; he called a forced min-2 "stupid" — default min 1, flexible).
- **Account before submission**: public flow forces create-account/login (email+password) before the form; submitters must be able to log back in to their submission. (Our magic-link decision covers this, but the login step is part of the tested flow.)
- **Save-as-draft is prominent** in the public form — start/leave/resume support.
- **Field validation praised on camera** (international phone numbers) — validation polish is noticed.
- **Embeds demoed as part of the core loop** (snippet + live agenda preview). Still optional per brief, but high-value stretch goal.

## Explicitly OUT (struck or optional)

- ~~AI-assisted review rounds~~ · ~~Accelevents integration~~ · ~~Wiki/resource pages in portal~~
- Payments/fees on submission forms ("NOT NEEDED" annotation).
- CMS embeds (speaker gallery, schedule) — OPTIONAL.
- Dashboard — "optional but nice to have, best efforts" (but it's requirement #6's home; treat the speaker-tracking view as in-scope, fancy analytics as optional).
- Exhibitors/sponsors groups — visible in screenshots, not in the six. Skip.

## Nice-to-have backlog (only after the six are complete)

- **Video submissions** — walkthrough mentions "abstracts or videos" as application types; screenshots don't show it. If ever built: file field accepts video uploads / video URL field in the form builder. Parked until everything else is done.

## Bonus points (stack signals)

- Cloudflare infra deploy (mild bonus).
- Airtable for persistence (bonus — but conflicts with the speed bonus; see decision log).
- Hosting on Forge instead of GitHub (very teeny bonus).
- **Speed/performance** ("we do not want slow SaaS pls").
- **API** — reference shape: sessionboard.mintlify.app.

## Decision log (judgment calls we'll defend)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Real DB as source of truth; Airtable via one-way sync/export, not primary store | Airtable API is rate-limited (~5 req/s) and slow — conflicts with the explicit speed bonus. Sync gives them the bonus without the latency. |
| 2 | Calendar invites via iCalendar email (METHOD:REQUEST .ics), not Google/Outlook OAuth APIs | Lands natively in Gmail/Outlook/Apple with zero OAuth verification risk; achievable and reliable in the timeline. |
| 3 | Form builder covers the shown field types + conditional logic, not a generic Typeform clone | Breadth-over-polish is the trap; the walkthrough tests the shown fields. |

## Open questions / freeze tracking

- [x] Watch initial walkthrough video ([local copy](reference/walkthrough-1.mp4), [transcript](reference/walkthrough-1.en.srt); origin: youtu.be/vUuK4Knl7oc) — reviewed Aug 8: nothing beyond the screenshots/brief.
- [ ] Absorb Saturday clarification video.
- [ ] Absorb Sunday clarification video → **requirements freeze; update this doc, then stop touching it.**
- [ ] Monitor Discord for clarifications that affect the six.
- [ ] Confirm where the submission form will be posted.
