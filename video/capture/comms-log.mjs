// The communications Log tab — the beat that proves mail actually went out.
//
// The templates list shows intent; the log shows delivery. The caption in the
// cut claims "real mail", so the cut should show the receipts.

import { open, signIn, settle, shot, redactFixtureEmails, BASE } from "./lib.mjs";

const EV = "devflow-conf-2027-2";
const { browser, page } = await open();

try {
  await signIn(page, "organizer");
  await page.goto(`${BASE}/app/e/${EV}/comms`, {
    waitUntil: "domcontentloaded",
  });
  await settle(page, 2000);

  // Tabs are React state — a click before hydration is silently swallowed, so
  // assert the tab actually flipped before shooting.
  for (let i = 0; i < 4; i++) {
    await page.getByRole("tab", { name: /Log/i }).first().click();
    await settle(page, 900);
    const on = await page
      .getByRole("tab", { name: /Log/i })
      .first()
      .getAttribute("aria-selected");
    if (on === "true") break;
  }

  // The log is per-speaker and opens on "Choose a speaker to see their log…".
  // Shooting it unselected would put an empty state in the cut.
  const picker = page.locator("select").first();
  if (await picker.isVisible().catch(() => false)) {
    const label = (await picker.locator("option").allInnerTexts()).find((t) =>
      /Priya Raman/.test(t),
    );
    await picker.selectOption({ label });
  } else {
    await page.getByText(/Priya Raman/).first().click();
  }
  await settle(page, 2000);

  const body = await page.locator("main").innerText();
  console.log(body.slice(0, 1500));
  // "Choose a speaker…" survives as the select's placeholder option, so assert
  // on the log actually having rows instead.
  if (!/\d+ recorded/.test(body)) throw new Error("log still unselected");

  await redactFixtureEmails(page);
  await shot(page, "12b-comms-log");
} finally {
  await browser.close();
}
