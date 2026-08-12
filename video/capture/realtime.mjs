// The split-screen: a speaker acts, and the organizer's screen changes.
//
//   node capture/realtime.mjs
//
// This is the one claim in the whole video that a screenshot physically
// cannot make. "Real-time" means the organizer did not refresh — and the only
// way to show that is to keep both screens in frame while nobody touches the
// second one.
//
// Playwright records one video per page, so the two sides are captured as two
// files and composed side by side in Remotion. Alignment is not eyeballed:
// each recording starts when its context is created, so the script measures
// the delay from each context's creation to the moment of the click and
// writes both offsets to clips/realtime.json. Remotion trims each side by its
// own offset, which lands the two on the same instant.

import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { signIn, settle, CLIPS, BASE } from "./lib.mjs";

const EV = process.env.STAGESTACK_EVENT ?? "devflow-conf-2027-2";
const LEAD = 2500; // dwell before the click, so the viewer reads both screens
const HOLD = 5000; // dwell after, so the change is unmissable

const browser = await chromium.launch({ headless: true });

/** A context that records, plus the wall-clock instant recording began. */
async function screen(role, path) {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    recordVideo: { dir: CLIPS, size: { width: 1920, height: 1080 } },
  });
  const startedAt = Date.now();
  const page = await context.newPage();
  await signIn(page, role);
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  return { context, page, startedAt };
}

try {
  // Organizer first, so their screen is already sitting there doing nothing
  // by the time the speaker acts.
  const organizer = await screen("organizer", `/app/e/${EV}/tasks`);
  const speaker = await screen("speaker", `/portal/${EV}`);

  await settle(organizer.page, 2500);
  await settle(speaker.page, 2500);

  // The task the speaker will complete. Named explicitly rather than taking
  // whatever sorts first, because the organizer has to be watching the same
  // row — three earlier takes of this shot filmed a counter that had nothing
  // to do with the click. Run capture/reopen-task.mjs first to reset it.
  const TASK = process.env.REALTIME_TASK ?? "Complete bio and profile";
  const SPEAKER = process.env.REALTIME_SPEAKER ?? "Priya Raman";

  const button = speaker.page
    .locator(".ss-card")
    .filter({ hasText: TASK })
    .getByRole("button", { name: /^Mark as done$/i })
    .first();
  if (!(await button.count())) {
    throw new Error(`"${TASK}" is not open in the speaker portal — reopen it first`);
  }

  // The organizer's own task table: one row per speaker per requirement, with
  // a status. That row flipping is the beat — a sidebar badge counting down
  // is chrome, not the organizer's screen.
  for (let i = 0; i < 5; i++) {
    await organizer.page.getByRole("tab", { name: /^Tasks$/ }).first().click();
    await settle(organizer.page, 900);
    const on = await organizer.page
      .getByRole("tab", { name: /^Tasks$/ })
      .first()
      .getAttribute("aria-selected");
    if (on === "true") break;
  }

  const row = organizer.page
    .locator("tr")
    .filter({ hasText: TASK })
    .filter({ hasText: SPEAKER })
    .first();
  if (!(await row.count())) {
    throw new Error(`organizer cannot see the row for "${TASK}" / ${SPEAKER}`);
  }
  await row.scrollIntoViewIfNeeded();
  await settle(organizer.page, 800);

  const status = async () => {
    const text = await row.innerText();
    return /Outstanding/.test(text) ? "Outstanding" : "Complete";
  };
  const before = await status();
  if (before !== "Outstanding") {
    throw new Error("that row is already Complete — run capture/reopen-task.mjs");
  }
  console.log(`  organizer is watching: ${SPEAKER} / ${TASK} — ${before}`);

  await speaker.page.waitForTimeout(LEAD);
  const clickedAt = Date.now();
  await button.click();

  await organizer.page.waitForTimeout(HOLD);
  const after = await status();

  const offsets = {
    // ms into each recording at which the click happened
    organizer: clickedAt - organizer.startedAt,
    speaker: clickedAt - speaker.startedAt,
    before,
    after,
    changed: before !== after,
  };

  const videos = {
    organizer: organizer.page.video(),
    speaker: speaker.page.video(),
  };
  await organizer.context.close();
  await speaker.context.close();
  await rename(await videos.organizer.path(), resolve(CLIPS, "realtime-organizer.webm"));
  await rename(await videos.speaker.path(), resolve(CLIPS, "realtime-speaker.webm"));
  await writeFile(
    resolve(CLIPS, "realtime.json"),
    JSON.stringify(offsets, null, 2) + "\n",
  );

  console.log(`  row status: ${before} → ${after}`);
  console.log(
    offsets.changed
      ? "  ✓ the organizer's screen changed with nobody touching it"
      : "  ✗ nothing changed — do not use this clip",
  );
  console.log(`  click at organizer+${offsets.organizer}ms / speaker+${offsets.speaker}ms`);
} finally {
  await browser.close();
}
