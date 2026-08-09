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

- **Program-side scope, not CRM/marketing**: Sessionboard exposes separate Program, CRM, Marketing, and CMS products. At 00:02:06–00:02:24, swyx says AIE will "only" use the program side and is "not really using" the marketing or CRM sides. This is a strong scope signal rather than a formal prohibition: operational event email remains required, but CRM, campaigns, and marketing tooling are not challenge expectations.
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
- CRM, prospect management, and marketing campaigns — absent from the requested feature set and explicitly deprioritized in the walkthrough. Do not confuse these with required transactional speaker communications.
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
| 1 | Real DB as source of truth; defer Airtable persistence and synchronization | Airtable is a bonus, not a requirement, and its rate limits conflict with the explicit speed bonus. Reconsider it only after the judged workflow is complete. |
| 2 | Calendar invites via iCalendar email (METHOD:REQUEST .ics), not Google/Outlook OAuth APIs | Lands natively in Gmail/Outlook/Apple with zero OAuth verification risk; achievable and reliable in the timeline. |
| 3 | Form builder covers the shown field types + conditional logic, not a generic Typeform clone | Breadth-over-polish is the trap; the walkthrough tests the shown fields. |
| 4 | One active CFP form per event; organizer-defined answers and conditional sections handle routing | The brief explicitly tests custom forms, conditional logic, and category routing, but does not require multiple independently active forms or a platform-owned category taxonomy. This preserves the judged workflow without adding separate URLs, deadlines, and lifecycle management. |
| 5 | Create an event with name, start/end, and timezone; generate its editable slug and private starter CFP | Screenshot 03 marks only name, slug, start, and end as required, while the walkthrough calls Event Details “basic stuff” and prioritizes core functionality. Type, location, branding, tracks, and CFP-specific dates/settings remain available after creation. |
| 6 | Implement Import as an agent using StageStack's normal domain tools, not a mapping wizard | The screenshots expose Import but do not prescribe its interface. Upload → agent plan → organizer confirmation → validated tool calls is faster for startup users, reuses the product's core actions, and remains distinct from the struck AI-assisted review feature. |
| 7 | Model breaks, meals, registration, and ceremonies as lightweight agenda items, not fake submissions or sessions | A credible published agenda needs operational blocks, but forcing them through CFP, review, speaker, and readiness workflows would add meaningless data and slow organizers down. |
| 8 | Store audience-specific virtual/hybrid links without provisioning meeting rooms | Public attendee, private backstage, and organizer-only host links connect StageStack to real event delivery while avoiding provider integrations and protecting privileged access details. |
| 9 | Keep post-event recordings, slides, and resources on the original session, with explicit publication | This extends the program's useful life without creating a second content system. Task submissions remain private by default, and external video/CMS automation stays outside v1. |
| 10 | Limit v1 data output to public program content plus the shown Abstracts CSV/XLSX export | Broad operational export packs and full backups are product hardening, not challenge requirements. Public API/embeds support the optional content-out story, while the narrow private export preserves the walkthrough surface. |
| 11 | Unpublish public content without cancelling its internal workflow record | Organizers need a safe correction for accidental or temporarily inappropriate publication. Removing public visibility must not destroy schedule, confirmation, task, or audit state or surprise speakers with an automatic message. |
| 12 | Serve one shared published program to every public channel | Pages, embeds, API, and public export should never disagree about which version or fields are public. Different presentation is useful; channel-specific content copies and visibility rules are unnecessary v1 complexity. |
| 13 | Build one shareable public event page; treat embedding its sections as a stretch | The page makes published output usable and directly testable without creating a microsite product. The optional embed can reuse that same surface after core challenge work, with no separate layout or configuration system. |
| 14 | Build UI and agent workflows on the same authorized domain capabilities; ship the public read API without a developer platform | Reusable actions make agent execution and later APIs natural instead of parallel rewrites. V1 gains the public content API while deferring mutation endpoints, credential management, webhooks, SDKs, and integration-specific support. |
| 15 | Agents inherit the initiating user's permissions and require confirmation at consequential boundaries | Agent assistance should remove repetitive work without creating a hidden super-admin or an annoying confirmation for every reversible action. Bulk ambiguity and externally visible or destructive effects deserve an explicit final check and complete attribution. |
| 16 | Keep StageStack authoritative; public integrations are read-only and Import is the reviewed inbound bridge | Copies may feed websites and other systems, but external edits and bidirectional sync would create competing workflow truth. Organizer-confirmed import supports migration without surrendering StageStack's ownership of state. |
| 17 | Stack: Convex + Clerk + Vercel + exe.dev worker (Flue agents) — consciously forfeiting the Cloudflare, Airtable, and Forge bonuses | All stack bonuses are "mild"/"teeny" while speed and the six features are judged. Convex's reactive queries make the real-time dashboard (requirement #6) and live agenda near-free; Clerk removes auth-building days; an always-on VM worker cleanly hosts the durable Import agent. Velocity and product quality over bonus points. See ARCHITECTURE.md. |
| 18 | Transactional email via Resend (Convex component), not a hand-rolled channel | Durable queued sends with exactly-once idempotency and delivery webhooks feed the comms log the spec already requires; calendar .ics rides the same channel. Provider stays swappable per the email boundary (Cloudflare Email Service is the named post-beta alternative). |
| 19 | Frontend: TanStack Start over Next.js and SvelteKit | Only framework besides Next with the Convex+Clerk triangle officially documented; typed URL search params + TanStack Table v8 match the table-heavy judged surface (saved views = URL state); SSR public pages without Next's complexity tax and CVE-prone server surface; React+shadcn is the most AI-codegen-fluent UI stack. Versions pinned against its daily release cadence. |
| 20 | Import agent LLM: GPT-5.6-Luna via OpenRouter, high thinking for planning, low for execution | Luna is purpose-built for extraction/classification at ~pennies per import; effort-as-ceiling keeps easy steps fast. Long-context weakness designed around via Node-side parsing + bounded chunks. OpenRouter gives provider failover and Exacto tool-calling routing without vendor lock. |

## Open questions / freeze tracking

- [x] Watch initial walkthrough video ([local copy](reference/walkthrough-1.mp4), [transcript](reference/walkthrough-1.en.srt); origin: youtu.be/vUuK4Knl7oc) — reviewed Aug 8: nothing beyond the screenshots/brief.
- [ ] Absorb Saturday clarification video.
- [ ] Absorb Sunday clarification video → **requirements freeze; update this doc, then stop touching it.**
- [ ] Monitor Discord for clarifications that affect the six.
- [ ] Confirm where the submission form will be posted.
