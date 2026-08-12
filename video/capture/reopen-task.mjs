// Reopen one speaker task, so the split-screen take can be shot again.
//
//   node capture/reopen-task.mjs "Complete bio and profile"
//
// The organizer's task table has a Reopen action, which is what makes the
// realtime clip repeatable — unlike slot acknowledgement, which is one-way and
// which the first attempts at this shot used up.

import { open, signIn, settle, BASE } from "./lib.mjs";

const EV = process.env.STAGESTACK_EVENT ?? "devflow-conf-2027-2";
const WANT = process.argv[2] ?? "Complete bio and profile";
const SPEAKER = process.argv[3] ?? "Priya Raman";

const { browser, page } = await open();

/** The tab is React state; a click before hydration is silently swallowed. */
async function selectTab(name) {
  for (let i = 0; i < 5; i++) {
    await page.getByRole("tab", { name }).first().click();
    await settle(page, 900);
    const on = await page
      .getByRole("tab", { name })
      .first()
      .getAttribute("aria-selected");
    if (on === "true") return;
  }
  throw new Error(`could not select the ${name} tab`);
}

try {
  await signIn(page, "organizer");
  await page.goto(`${BASE}/app/e/${EV}/tasks`, { waitUntil: "domcontentloaded" });
  await settle(page, 2500);
  await selectTab(/^Tasks$/);

  const row = page
    .locator("tr")
    .filter({ hasText: WANT })
    .filter({ hasText: SPEAKER })
    .first();
  if (!(await row.count())) throw new Error(`no row for ${WANT} / ${SPEAKER}`);

  const before = await row.innerText();
  if (/Outstanding/.test(before)) {
    console.log(`  · already outstanding — nothing to do`);
  } else {
    await row.getByRole("button", { name: /^Reopen$/ }).first().click();
    await settle(page, 2500);
    console.log(`  ✓ reopened "${WANT}" for ${SPEAKER}`);
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await settle(page, 2500);
  await selectTab(/^Tasks$/);
  const after = await page
    .locator("tr")
    .filter({ hasText: WANT })
    .filter({ hasText: SPEAKER })
    .first()
    .innerText();
  console.log(`  status: ${/Outstanding/.test(after) ? "Outstanding" : "Complete"}`);
} finally {
  await browser.close();
}
