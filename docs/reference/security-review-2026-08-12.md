# StageStack — Security & quality review (2026-08-12, verified 2026-08-13)

Historical record. The original review ran 2026-08-12 against `develop`; every
finding below was independently re-verified against the tree on 2026-08-13
(`develop` @ `9f2a836`) by reading the cited locations. The remediation plan
for these findings lives in [PLAN.md](../../PLAN.md) Part C; when that cycle
closes, this file stays as the record of what was found and where.

Relationship to the earlier review: commit `7634031` (2026-08-09, "Review
remediation: close every finding in REVIEW.md's fix order") closed the
**2026-08-09** review ([code-review-2026-08.md](code-review-2026-08.md)), not
this one. This review is the next pass, run after the W1–W4 M10 slice landed.

**Scope:** `convex/` backend, `apps/web`, `apps/worker`, hygiene.
**Verified-good:** the new W1–W4 work (search, savedViews, templates,
analytics) follows the ownership conventions and surfaced **no new
vulnerabilities**; all three projects typecheck.

---

## Security — Convex

| # | Sev | Finding | Verified status (2026-08-13) |
|---|---|---|---|
| F1 | Medium | Invitation accept not bound to the invited email | **Open.** `convex/model/team.ts:216-293` `acceptInvitation` validates token + status + expiry only; it never compares the redeemer's verified email against `invite.email`, so any signed-in account holding a leaked/forwarded token can redeem it. The one realistic privilege-escalation path in the app. |
| F2 | — | Content-Disposition header injection via embed name | **Fixed.** `convex/http.ts:290-293` `attachmentFilename` strips quotes/backslashes/controls; write-time validation (`assertEmbedName`) is the first layer. |
| F3 | Low | `worker.importContext` skips the rate limiter | **Open.** `convex/worker.ts:284-351` gates only on `assertWorker(secret)`; the sibling worker endpoints all consume `workerLimiter` (`worker.ts:57`). |
| F4 | Low | `tasks.generateUploadUrl` uncapped | **Open.** `convex/tasks.ts:217-223` is a bare `eventMutation`; no limiter import in the file. `imports.ts:28` has the pattern (`importLimiter`) for storage-URL minting. |
| F5–F7 | Info | Residuals from the Aug 9 review | Unchanged. |

## Security — web / worker

| # | Finding | Verified status (2026-08-13) |
|---|---|---|
| S1 | No security headers (CSP, HSTS, X-Frame-Options, …) | **Open.** No `vercel.json`; `apps/web/src/start.ts` registers only `clerkMiddleware()`. Zero header config anywhere. |
| S2 | Clerk JWT serialized into the SSR payload | **Open.** `apps/web/src/routes/__root.tsx:189-196` returns `{ userId, token }` from `beforeLoad`, so the JWT rides the dehydrated router context. Verified: **nothing outside `__root.tsx` consumes route-context `token`** — `setAuth(token)` runs before the return, so dropping `token` from the return object is a one-line fix. |
| S3 | Host-header reflection | **Hardened** (strict `HOST_PATTERN`, config fallback, metadata-only callers) — **with a new wrinkle:** `apps/web/src/lib/origin.ts:71-78` accepts a client-supplied `x-forwarded-proto: http` for any non-loopback host, so generated links downgrade to `http://` wherever the edge doesn't overwrite that header. Vercel does overwrite it, so low severity in practice; the fix is an `https` floor for non-loopback hosts. |
| S4 | Untyped `location.search` cast | **Open.** `apps/web/src/routes/app.e.$eventSlug.tsx:60` — `l.search as { status?: string }`. |
| S5 | Worker file download has no byte cap | **Open.** `apps/worker/src/import-agent.ts:403-404` does `fetch` → `arrayBuffer()` with no Content-Length check or streaming cap. |
| S6 | `previewAs` client cast | **Fixed in substance** — backend fully validates; the remaining cast is cosmetic. |

## Code quality (verified snapshot)

Essentially zero movement since the Aug 9 review, with one confirmed fix:

- No `convex/model/reminders.ts` split; monster files unchanged within a few
  lines (`agenda.ts` 2404, `reviews.ts` 2289, `tasks.ts` 2231, `cfp.ts` 1966,
  `speakers.ts` 1908).
- `program: v.any()` still at `convex/schema.ts:960`.
- cfp↔sessions nested `runMutation` still at `convex/model/cfp.ts:1485`.
- Scan caps still redeclared in ~10 files (portal's drifted `200` included);
  `vParticipantState` still duplicated in 5 files.
- The 17-string plain-message whitelist still at `convex/http.ts:69-87`.
- `.jsx`+`.d.ts` pairs in the DS vendor dir: **37** (was 34 — grew).
- `convex/README.md` still Convex boilerplate; workspace deps still duplicated.
- ✅ `.DS_Store` files no longer tracked (`git ls-files` clean).
- Test suites grew slightly (embeds 3→4 files, imports 5→8).
