# StageStack — Business Context

## What StageStack is

StageStack is an open source **event content, speaker & abstract management** platform. It covers the workflow between "we're running an event" and "attendees show up": sourcing, evaluating, selecting, and operationalizing an event's content and speakers.

It is a direct alternative to Sessionboard, and competes in the same niche as Sessionize, Lineup Ninja, Oxford Abstracts, Ex Ordo, and the abstract-management modules of suites like Cvent, Bizzabo, and Whova.

## The workflow territory

1. **Call for Speakers / CFP** — public submission forms, collecting session proposals and speaker info.
2. **Review & evaluation** — scoring, statuses, accept/decline queues, decisions.
3. **Speaker operations (post-acceptance)** — the neglected grind: chasing bios, headshots, slides, confirmations via a self-service speaker portal, tasks, and automated communications.
4. **Agenda building** — turning accepted sessions into a conflict-free schedule across rooms, tracks, and time slots.
5. **Content afterlife** — session/speaker data feeding websites, embeds, and post-event publishing.

## Market structure (two axes)

- **Academic peer-review pole** (Oxford Abstracts, Ex Ordo, Fourwaves, Cadmium): rigorous multi-round review is the product; workflow largely ends at acceptance.
- **Modern speaker-ops pole** (Sessionboard, Lineup Ninja, Sessionize): the real pain is everything *after* acceptance.
- **Standalone best-of-breed** (Sessionize, Sessionboard) vs. **all-in-one suites** (Cvent, Bizzabo): best-of-breed content engines integrate into registration platforms rather than replacing them.

**StageStack's position: speaker-ops pole, standalone best-of-breed, open source.** We do not build registration, ticketing, or attendee apps.

## Design-partner customer: AI Engineer

AIE runs the World's Fair (~7,000 attendees, 9 tracks, 5 simultaneous stages), NY/London Summits, and partner conferences — organized by a very small team. They currently pay >$40k/yr for Sessionboard and are actively trying to replace it (see CHALLENGE.md).

Documented pains from swyx's 2024 organizing retro (swyx.io/aiewf-2024):

- **No single source of truth**: up to 5 spreadsheets tracking speakers, rooms, and time assignments.
- **Speaker logistics failures**: missing contact info caused a keynote speaker to miss their own talk.
- **Late confirmations**: speakers confirmed days before the event, cascading into scheduling chaos.
- **Dual pipeline**: ~500 CFP submissions (~6% accepted) *plus* invited outreach from per-track target lists; wave-based acceptances (deferred ≠ rejected). Tools only model the inbound half.
- **Content flywheel**: 10M+ YouTube views/yr of talks; session metadata → published content is a first-class need, not an afterthought.

## Product principles

1. **Single source of truth** — speakers, submissions, sessions, rooms, and schedule live in one place; exports/embeds derive from it.
2. **Post-acceptance is half the product** — tasks, chasing, and readiness tracking get first-class treatment.
3. **Fast** — lean pages, no heavy-SPA sluggishness. Speed is a feature.
4. **Open source & self-hostable** — cheap to run forever; no per-event ransom pricing.
5. **API-first** — everything in the UI is reachable via API; integrations and embeds derive from it.
