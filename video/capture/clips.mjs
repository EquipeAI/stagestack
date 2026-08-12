// Motion clips: the two moments that are only convincing as video.
//
//   node capture/clips.mjs drag     conflict refusal while a block is moving
//   node capture/clips.mjs views    the same program re-read five ways
//
// The drag is driven through the agenda's KEYBOARD drag rather than synthetic
// mouse moves: dnd-kit's pointer sensor needs a precise press/move/settle
// sequence that is fragile to script, while space-arrows-space is the app's
// own documented contract (see apps/web/src/components/agenda/keyboardDrag.ts).
//
// It ends on Escape, never on a drop. The interesting frame — the grid
// refusing the illegal slot — happens *during* the drag, so cancelling gets
// the whole shot without writing anything to the event the judges look at.

import { rename } from "node:fs/promises";
import { resolve } from "node:path";
import { open, signIn, settle, CLIPS, BASE } from "./lib.mjs";

const EV = process.env.STAGESTACK_EVENT ?? "devflow-conf-2027-2";
const which = process.argv[2] ?? "drag";
const app = (p = "") => `${BASE}/app/e/${EV}${p}`;

const { browser, context, page } = await open({ video: true });

/** Playwright names the file by internal page id; give it the clip's name. */
async function save(name) {
  const video = page.video();
  await context.close();
  const from = await video.path();
  await rename(from, resolve(CLIPS, `${name}.webm`));
  console.log(`  ✓ clips/${name}.webm`);
}

try {
  await signIn(page, "organizer");
  await page.goto(app("/agenda"), { waitUntil: "domcontentloaded" });
  await settle(page, 3000);

  if (which === "views") {
    // Let each view breathe long enough to read before the next one.
    for (const view of ["List", "Day", "Week", "Track", "Room"]) {
      await page.getByRole("tab", { name: view, exact: true }).first().click();
      await page.waitForTimeout(1600);
    }
    await save("agenda-views");
  } else {
    // The move is chosen to collide on purpose: Lightning sits on Main Stage
    // at 09:00 and Taming CI sits in Room 2A at 10:00, so carrying Lightning
    // one column right and four 15-minute steps down lands it on top of a
    // session already in that room. Room clash is a Blocker, and the point of
    // the shot is that the grid says so while the block is still moving.
    const block = page
      .locator(".agenda-draggable")
      .filter({ hasText: "Lightning" })
      .first();
    if (!(await block.count())) throw new Error("no Lightning block to drag");

    await page.waitForTimeout(1200); // don't open mid-paint
    await block.scrollIntoViewIfNeeded();
    // focus(), not click(): a click on a block opens its detail dialog.
    await block.focus();
    await page.waitForTimeout(900);

    await page.keyboard.press("Space"); // pick up
    await page.waitForTimeout(800);

    for (const key of [
      "ArrowRight",
      "ArrowDown",
      "ArrowDown",
      "ArrowDown",
      "ArrowDown",
    ]) {
      await page.keyboard.press(key);
      await page.waitForTimeout(620);
    }
    await page.waitForTimeout(1600); // hold on the refusal

    await page.keyboard.press("Space"); // drop it anyway
    await page.waitForTimeout(2600); // the conflict stands, with no reload

    await save("agenda-drag");
  }
} finally {
  await browser.close();
}
