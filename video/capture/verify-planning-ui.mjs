// Verification only, not a video shot: does the in-flight import state now
// offer a way out? Runs against the LOCAL dev server so it exercises the
// working tree, not the deployed preview.
//
//   STAGESTACK_BASE=http://localhost:3000 node capture/verify-planning-ui.mjs

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { open, signIn, settle, shot, BASE } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EV = process.env.STAGESTACK_EVENT ?? "devflow-conf-2027-2";
const { browser, page } = await open();

try {
  await signIn(page, "organizer");
  await page.goto(`${BASE}/app/e/${EV}/import`, {
    waitUntil: "domcontentloaded",
  });
  await settle(page, 2500);

  const startOver = page.getByRole("button", { name: /Start over/i }).first();
  if (await startOver.isVisible().catch(() => false)) {
    await startOver.click();
    await settle(page, 1500);
  }

  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(resolve(HERE, "fixtures/devflow-talks.csv"));
  await settle(page, 800);
  await page
    .getByRole("button", { name: /Upload & plan import/i })
    .first()
    .click();

  // The whole point of the fix: this button must exist WHILE planning.
  await page.getByText(/Planning your import/i).first().waitFor({
    state: "visible",
    timeout: 60_000,
  });
  const escape = page.getByRole("button", { name: /Start over/i }).first();
  await escape.waitFor({ state: "visible", timeout: 5_000 });
  console.log("  ✓ 'Start over' is offered while the agent is still planning");
  await shot(page, "verify-planning");

  // And it must actually return to the upload form.
  await escape.click();
  await settle(page, 1500);
  const inputs = await page.locator('input[type="file"]').count();
  if (inputs === 0) throw new Error("Start over did not reach the upload form");
  console.log("  ✓ it returns to the upload form");
} finally {
  await browser.close();
}
