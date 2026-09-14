// Capture every still frame the demo video needs, at 3840x2160 retina.
//
// Re-runnable: if the app changes, re-run this instead of re-recording. Each
// shot is isolated — one broken selector can't take down the run — and the
// summary at the end reports exactly what's missing.
//
//   node capture/shots.mjs            # everything
//   node capture/shots.mjs cfp review # only shots whose id matches a filter

import { open, signIn, settle, shot, BASE } from "./lib.mjs";

const EV = "devflow-conf-2027-2";
const app = (p = "") => `${BASE}/app/e/${EV}${p}`;

const filters = process.argv.slice(2);
const wanted = (id) => !filters.length || filters.some((f) => id.includes(f));

/** Click the first element matching any of `names`, tolerating absence. */
async function tap(page, names, { role = "button", timeout = 4000 } = {}) {
  for (const n of [].concat(names)) {
    const el = page.getByRole(role, { name: n, exact: false }).first();
    try {
      await el.waitFor({ state: "visible", timeout });
      await el.click();
      await settle(page, 900);
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
}

/**
 * Tabs are React state, not URL state, so a click that lands before hydration
 * is silently swallowed — that's how the first run captured an empty "My
 * queue" instead of the evaluation plan. Click, then verify aria-selected
 * actually flipped, and retry if it didn't.
 */
async function selectTab(page, name, tries = 4) {
  const tab = page.getByRole("tab", { name, exact: false }).first();
  await tab.waitFor({ state: "visible", timeout: 20_000 });
  for (let i = 0; i < tries; i++) {
    await tab.click().catch(() => {});
    try {
      await page
        .locator(`[role="tab"][aria-selected="true"]`)
        .filter({ hasText: name })
        .waitFor({ state: "visible", timeout: 3000 });
      await settle(page, 1200);
      return true;
    } catch {
      await page.waitForTimeout(1200);
    }
  }
  throw new Error(`tab "${name}" never became selected`);
}

/**
 * Text that means the capture is worthless no matter which page we asked for.
 * A 404 or a signed-out shell renders perfectly happily and would otherwise
 * sail into the cut — that is exactly how a "This page does not exist" frame
 * shipped in the first render.
 */
const POISON = [
  "This page does not exist",
  "The link may be out of date",
  "Sign in to StageStack",
  "Something went wrong",
];

/**
 * Every shot must prove it loaded real content. `expect` is text that has to
 * be on the page; without it the shot fails loudly instead of silently
 * capturing an empty state.
 */
async function verify(page, expect) {
  const body = await page.evaluate(() => document.body.innerText);
  for (const bad of POISON) {
    if (body.includes(bad)) throw new Error(`page shows "${bad}"`);
  }
  for (const need of [].concat(expect ?? [])) {
    if (!body.includes(need)) throw new Error(`missing expected "${need}"`);
  }
  // An organizer page with almost no text is an unresolved loading state.
  if (body.trim().length < 120) throw new Error("page looks empty");
  // Fixture accounts are real addresses. They must not end up on camera, so
  // flag any shot that would need cropping or dropping.
  if (/alvaro\+/.test(body)) return "shows a fixture email address";
  return null;
}

/**
 * Shots are grouped by the role that has to be signed in, because switching
 * identity means a fresh browser context.
 */
const PLANS = {
  public: [
    ["01-marketing-hero", async (p) => {
      await p.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    }, "StageStack"],
    ["06-public-cfp", async (p) => {
      await p.goto(`${BASE}/cfp/${EV}`, { waitUntil: "domcontentloaded" });
    }, "DevFlow"],
    ["28-public-event-page", async (p) => {
      await p.goto(`${BASE}/e/${EV}`, { waitUntil: "domcontentloaded" });
    }, "DevFlow Conf 2027"],
    ["28b-public-agenda", async (p) => {
      await p.goto(`${BASE}/e/${EV}?view=agenda`, {
        waitUntil: "domcontentloaded",
      });
    }, ["DevFlow", "Taming"]],
    ["28c-public-speakers", async (p) => {
      await p.goto(`${BASE}/e/${EV}?view=speakers`, {
        waitUntil: "domcontentloaded",
      });
    }, "Raman"],
    ["29-embed-widget", async (p) => {
      await p.goto(
        `${BASE}/embed/w/nx7ewd0k340y3vhq46zg8j5pjh8c9q32`,
        { waitUntil: "domcontentloaded" },
      );
    }, "Taming"],
  ],

  organizer: [
    ["02-dashboard", async (p) => {
      await p.goto(app("/dashboard"), { waitUntil: "domcontentloaded" });
    }, "Speakers"],
    ["03-cfp-builder", async (p) => {
      await p.goto(app("/cfp"), { waitUntil: "domcontentloaded" });
    }, "Required"],
    ["04-cfp-builder-scrolled", async (p) => {
      await p.goto(app("/cfp"), { waitUntil: "domcontentloaded" });
      await settle(p, 1200);
      await p.mouse.wheel(0, 900);
    }, "Required"],
    ["16-proposals-table", async (p) => {
      await p.goto(app("/proposals"), { waitUntil: "domcontentloaded" });
    }, "Taming"],
    ["17-eval-plan", async (p) => {
      await p.goto(app("/reviews"), { waitUntil: "domcontentloaded" });
      await settle(p, 1800);
      await selectTab(p, "Evaluation plan");
    }, "Scorecard"],
    ["18-review-progress", async (p) => {
      await p.goto(app("/reviews"), { waitUntil: "domcontentloaded" });
      await settle(p, 1800);
      await selectTab(p, "Progress");
    }, "Sam Whitfield"],
    ["20-sessions", async (p) => {
      await p.goto(app("/sessions"), { waitUntil: "domcontentloaded" });
    }, "Taming"],
    ["21-agenda-room", async (p) => {
      await p.goto(app("/agenda?view=room"), { waitUntil: "domcontentloaded" });
    }, "Main Stage"],
    ["25a-agenda-list", async (p) => {
      await p.goto(app("/agenda?view=list"), { waitUntil: "domcontentloaded" });
    }, "Taming"],
    ["25b-agenda-track", async (p) => {
      await p.goto(app("/agenda?view=track"), { waitUntil: "domcontentloaded" });
    }, "Taming"],
    ["25c-agenda-week", async (p) => {
      await p.goto(app("/agenda?view=week"), { waitUntil: "domcontentloaded" });
    }, "Taming"],
    ["26-speaker-tasks", async (p) => {
      await p.goto(app("/tasks"), { waitUntil: "domcontentloaded" });
    }, "New requirement"],
    ["26b-task-files", async (p) => {
      await p.goto(app("/tasks"), { waitUntil: "domcontentloaded" });
      await settle(p, 1800);
      await selectTab(p, "Files");
    }, "Priya"],
    ["26c-task-list", async (p) => {
      await p.goto(app("/tasks"), { waitUntil: "domcontentloaded" });
      await settle(p, 1800);
      await selectTab(p, "Tasks");
    }, "Priya"],
    ["12-comms", async (p) => {
      await p.goto(app("/comms"), { waitUntil: "domcontentloaded" });
    }, "template"],
    ["11-speaker-roster", async (p) => {
      await p.goto(app("/speakers"), { waitUntil: "domcontentloaded" });
    }, "Priya"],
    ["30-publish-embeds", async (p) => {
      await p.goto(app("/publish"), { waitUntil: "domcontentloaded" });
    }, "Lineup"],
    ["30b-publish-scrolled", async (p) => {
      await p.goto(app("/publish"), { waitUntil: "domcontentloaded" });
      await settle(p, 1200);
      await p.mouse.wheel(0, 1400);
    }, "Lineup"],
    ["31-import-agent", async (p) => {
      await p.goto(app("/import"), { waitUntil: "domcontentloaded" });
    }, "import"],
    ["33-settings", async (p) => {
      await p.goto(app("/settings"), { waitUntil: "domcontentloaded" });
    }, "Slug"],
  ],

  speaker: [
    // The portal is per-event: /portal/$eventSlug, not /portal.
    ["08-speaker-portal", async (p) => {
      await p.goto(`${BASE}/portal/${EV}`, { waitUntil: "domcontentloaded" });
    }, "DevFlow"],
  ],

  reviewer: [
    ["19-reviewer-queue", async (p) => {
      await p.goto(app("/reviews"), { waitUntil: "domcontentloaded" });
    }, "DevFlow"],
  ],
};

const done = [];
const failed = [];
const warned = [];

for (const [role, plan] of Object.entries(PLANS)) {
  const todo = plan.filter(([id]) => wanted(id));
  if (!todo.length) continue;

  console.log(`\n=== ${role} (${todo.length} shots) ===`);
  const { browser, page } = await open();
  try {
    if (role !== "public") await signIn(page, role);
    for (const [id, go, expect] of todo) {
      try {
        await go(page);
        await settle(page, 400);
        const warn = await verify(page, expect);
        await shot(page, id);
        if (warn) {
          console.log(`  ⚠ ${id}: ${warn}`);
          warned.push(id);
        }
        done.push(id);
      } catch (e) {
        console.log(`  ✗ ${id}: ${e.message.split("\n")[0]}`);
        failed.push(id);
      }
    }
  } catch (e) {
    console.log(`  !! ${role} session failed: ${e.message.split("\n")[0]}`);
    todo.forEach(([id]) => failed.includes(id) || failed.push(id));
  } finally {
    await browser.close();
  }
}

console.log(`\n${done.length} captured, ${failed.length} failed`);
if (failed.length) console.log("failed:", failed.join(", "));
if (warned.length)
  console.log("privacy review needed:", warned.join(", "));
