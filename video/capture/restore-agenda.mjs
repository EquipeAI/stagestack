// Put the agenda back exactly where the conflict clip found it.
//
// The clip deliberately drops a block into an occupied room so the blocker
// fires on camera. Undoing that needs care for two reasons:
//
//  1. Keyboard nudges move whatever happens to be focused, so the block's own
//     "Edit placement" form is used instead — it sets room and times exactly.
//  2. A placement that clashes is REFUSED, silently from a script's point of
//     view: the dialog closes and the value is unchanged. So the moves are
//     ordered to never pass through a clashing state — the occupying block is
//     parked somewhere empty first — and every step is read back.

import { open, signIn, settle, BASE } from "./lib.mjs";

const EV = process.env.STAGESTACK_EVENT ?? "devflow-conf-2027-2";
const { browser, page } = await open();

const agenda = async () => {
  await page.goto(`${BASE}/app/e/${EV}/agenda`, {
    waitUntil: "domcontentloaded",
  });
  await settle(page, 2500);
};

/** Set one block's placement and assert it took. */
async function place(match, room, start, end) {
  await agenda();
  await page
    .locator(".agenda-draggable")
    .filter({ hasText: match })
    .first()
    .click();
  await settle(page, 1200);
  await page.getByRole("button", { name: /Edit placement/i }).first().click();
  await settle(page, 1200);

  const dialog = page.locator("[role=dialog]").last();
  await dialog.locator("select").first().selectOption({ label: room });
  const times = dialog.locator('input[type="datetime-local"]');
  await times.nth(0).fill(start);
  await times.nth(1).fill(end);
  await dialog
    .getByRole("button", { name: /Save placement/i })
    .first()
    .click();
  await settle(page, 2500);

  // Read it back through the same form — the board can lag a beat, the form
  // cannot.
  await agenda();
  await page
    .locator(".agenda-draggable")
    .filter({ hasText: match })
    .first()
    .click();
  await settle(page, 1200);
  await page.getByRole("button", { name: /Edit placement/i }).first().click();
  await settle(page, 1000);
  const got = await page
    .locator("[role=dialog]")
    .last()
    .locator('input[type="datetime-local"]')
    .evaluateAll((es) => es.map((e) => e.value));

  const ok = got[0] === start && got[1] === end;
  console.log(`  ${ok ? "✓" : "✗"} ${match} → ${room} ${start}–${end.slice(11)}${ok ? "" : ` (got ${got.join("–")})`}`);
  return ok;
}

try {
  await signIn(page, "organizer");

  // Park the intruder somewhere empty so neither target slot is contested.
  await place("Taming 40-Minute CI", "Workshop Lab", "2027-05-12T15:00", "2027-05-12T15:30");
  // Then restore, in an order that never clashes.
  const a = await place("Lightning", "Main Stage", "2027-05-12T09:00", "2027-05-12T10:00");
  const b = await place("Taming 40-Minute CI", "Room 2A", "2027-05-12T10:00", "2027-05-12T10:30");

  await agenda();
  const blocks = page.locator(".agenda-draggable");
  console.log("  --- board ---");
  for (let i = 0; i < (await blocks.count()); i++) {
    console.log("  ", (await blocks.nth(i).innerText()).replace(/\n/g, " | "));
  }
  const main = await page.locator("main").innerText();
  const flagged = /\d+\s*conflict|double-booked or room clash/i.test(main);
  console.log(`  restored: ${a && b ? "yes" : "NO"}; conflict legend present: ${flagged}`);
} finally {
  await browser.close();
}
