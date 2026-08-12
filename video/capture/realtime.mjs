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
  const organizer = await screen("organizer", `/app/e/${EV}`);
  const speaker = await screen("speaker", `/portal/${EV}`);

  await settle(organizer.page, 2500);
  await settle(speaker.page, 2500);

  // The speaker marks one of their onboarding tasks done. That is the right
  // action for this shot for two reasons: it is the everyday thing a speaker
  // actually does, and it moves a counter the organizer can see from anywhere.
  const button = speaker.page
    .getByRole("button", { name: /^Mark as done$/i })
    .first();
  if (!(await button.count())) {
    throw new Error("no open task in the speaker portal to complete");
  }

  // Watch the organizer's Tasks badge — a single number in the sidebar, on
  // screen the whole time, that nobody is going to touch.
  const taskCount = async () => {
    const nav = await organizer.page.getByRole("button", { name: /^Tasks/ }).first().innerText();
    const m = nav.match(/(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const before = await taskCount();
  if (before === null) throw new Error("no Tasks badge on the organizer's sidebar");
  console.log(`  organizer is watching the Tasks badge: ${before}`);

  await speaker.page.waitForTimeout(LEAD);
  const clickedAt = Date.now();
  await button.click();

  await organizer.page.waitForTimeout(HOLD);
  const after = await taskCount();

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

  console.log(`  Tasks badge: ${before} → ${after}`);
  console.log(
    offsets.changed
      ? "  ✓ the organizer's screen changed with nobody touching it"
      : "  ✗ nothing changed — do not use this clip",
  );
  console.log(`  click at organizer+${offsets.organizer}ms / speaker+${offsets.speaker}ms`);
} finally {
  await browser.close();
}
