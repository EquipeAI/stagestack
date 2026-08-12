// Re-run the import agent from scratch and capture the fresh plan.
//
// /import keeps the last plan, so there is no file input until "Start over" is
// clicked. Nothing is ever approved — the plan is an un-written proposal, which
// is exactly the state the video shows.
//
// The fixture CSV deliberately contains em-dashes. The parser used to decode
// UTF-8 as CP1252, so they arrived as "â€" and the corruption was what got
// stored; this file is now the demo's own regression test for that fix.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { open, signIn, settle, shot, shotEl, BASE } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EV = "devflow-conf-2027-2";
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
    await settle(page, 2000);
    console.log("  · cleared the previous plan");
  }

  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(resolve(HERE, "fixtures/devflow-talks.csv"));
  await page.waitForTimeout(1000);

  const hint = page.locator("textarea").first();
  if (await hint.isVisible().catch(() => false)) {
    await hint.fill(
      "Talk submissions exported from our old CFP tool — one row per talk.",
    );
  }
  await settle(page, 800);
  await shot(page, "d-import-1-ready");

  await page
    .getByRole("button", { name: /Upload & plan import/i })
    .first()
    .click();
  console.log("  · agent planning…");

  // Wait on the *absence* of the planning state — matching /plan/ would hit
  // "Planning your import…" immediately and capture a spinner.
  await page
    .getByRole("button", { name: /Approve & import/i })
    .first()
    .waitFor({ state: "visible", timeout: 300_000 });
  await settle(page, 2500);

  await shot(page, "d-import-2-plan");
  await shotEl(
    page,
    page.locator(".ss-card").filter({ hasText: "Proposal" }).first(),
    "d-import-record",
  );
  console.log("  ✓ fresh import plan captured (nothing approved)");
} finally {
  await browser.close();
}
