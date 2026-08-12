// Detail shots: tightly framed single elements, plus the import agent
// actually running.
//
// These replace the crop-zooms in the cut. Zooming into a full-page capture
// always slices a heading or card in half; an element screenshot is framed
// correctly by construction.
//
//   node capture/details.mjs           # everything
//   node capture/details.mjs import    # just the import flow

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { open, signIn, settle, shot, shotEl, BASE } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EV = "devflow-conf-2027-2";
const app = (p = "") => `${BASE}/app/e/${EV}${p}`;

const filters = process.argv.slice(2);
const want = (id) => !filters.length || filters.some((f) => id.includes(f));

/** The .ss-card / .ss-callout that contains a given piece of text. */
const cardWith = (page, text, sel = ".ss-card") =>
  page.locator(sel).filter({ hasText: text }).first();

const done = [];
const failed = [];
const run = async (id, fn) => {
  if (!want(id)) return;
  try {
    await fn();
    done.push(id);
  } catch (e) {
    console.log(`  ✗ ${id}: ${e.message.split("\n")[0]}`);
    failed.push(id);
  }
};

// ---------------------------------------------------------------- organizer
{
  const { browser, page } = await open();
  try {
    await signIn(page, "organizer");

    await run("d-ops-warning", async () => {
      await page.goto(app("/dashboard"), { waitUntil: "domcontentloaded" });
      await settle(page, 1500);
      await shotEl(
        page,
        cardWith(page, "missing a bio or headshot", ".ss-callout"),
        "d-ops-warning",
      );
    });

    await run("d-readiness", async () => {
      await page.goto(app("/dashboard"), { waitUntil: "domcontentloaded" });
      await settle(page, 1500);
      await shotEl(page, cardWith(page, "Session readiness"), "d-readiness");
    });

    await run("d-scorecard", async () => {
      await page.goto(app("/reviews"), { waitUntil: "domcontentloaded" });
      await settle(page, 1800);
      const tab = page.getByRole("tab", { name: "Evaluation plan" }).first();
      for (let i = 0; i < 4; i++) {
        await tab.click().catch(() => {});
        await page.waitForTimeout(900);
        if (await cardWith(page, "Scorecard").isVisible().catch(() => false)) break;
      }
      await shotEl(page, cardWith(page, "Scorecard"), "d-scorecard");
    });

    await run("d-conflicts", async () => {
      await page.goto(app("/agenda?view=room"), {
        waitUntil: "domcontentloaded",
      });
      await settle(page, 1800);
      await shotEl(page, cardWith(page, "Blocker", "div"), "d-conflicts", 12);
    });

    await run("d-cfp-conditional", async () => {
      await page.goto(app("/cfp"), { waitUntil: "domcontentloaded" });
      await settle(page, 1800);
      await shotEl(page, cardWith(page, "Show this section conditionally"), "d-cfp-conditional");
    });

    // ---- the import agent, actually running -----------------------------
    await run("d-import", async () => {
      await page.goto(app("/import"), { waitUntil: "domcontentloaded" });
      await settle(page, 1500);
      await page
        .locator('input[type="file"]')
        .first()
        .setInputFiles(resolve(HERE, "fixtures/devflow-talks.csv"));
      await page.waitForTimeout(800);
      const hint = page.locator("textarea").first();
      if (await hint.isVisible().catch(() => false)) {
        await hint.fill(
          "Talk submissions exported from our old CFP tool — one row per talk.",
        );
      }
      await settle(page, 600);
      await shot(page, "d-import-1-ready");

      await page
        .getByRole("button", { name: /Upload & plan import/i })
        .first()
        .click();

      // The agent parses, classifies and proposes. Nothing is written until
      // an organizer approves, so we capture the plan and stop there.
      await page
        .getByText(/Approve|Apply|Confirm|proposed|plan/i)
        .first()
        .waitFor({ state: "visible", timeout: 240_000 });
      await settle(page, 2500);
      await shot(page, "d-import-2-plan");
      await page.mouse.wheel(0, 500);
      await settle(page, 800);
      await shot(page, "d-import-3-plan-detail");
    });
  } finally {
    await browser.close();
  }
}

// ------------------------------------------------------------------ speaker
{
  const { browser, page } = await open();
  try {
    await signIn(page, "speaker");
    await run("d-speaker-slot", async () => {
      await page.goto(`${BASE}/portal/${EV}`, { waitUntil: "domcontentloaded" });
      await settle(page, 1800);
      await shotEl(page, cardWith(page, "Your slot", "div"), "d-speaker-slot", 16);
    });
  } finally {
    await browser.close();
  }
}

// ----------------------------------------------------------------- reviewer
{
  const { browser, page } = await open();
  try {
    await signIn(page, "reviewerClean");
    await run("d-reviewer-queue", async () => {
      await page.goto(app("/reviews"), { waitUntil: "domcontentloaded" });
      await settle(page, 2500);
      await shot(page, "19-reviewer-queue");
    });
  } finally {
    await browser.close();
  }
}

console.log(`\n${done.length} captured, ${failed.length} failed`);
if (failed.length) console.log("failed:", failed.join(", "));
