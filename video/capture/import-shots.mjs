// Capture the finished import plan. Never clicks "Approve & import".
import { open, signIn, settle, shot, shotEl, BASE } from "./lib.mjs";
const EV="devflow-conf-2027-2";
const {browser,page}=await open();
try{
  await signIn(page,"organizer");
  await page.goto(`${BASE}/app/e/${EV}/import`,{waitUntil:"domcontentloaded"});
  await settle(page,3000);
  await shot(page,"d-import-2-plan");
  await shotEl(page, page.locator(".ss-card").filter({hasText:"Proposal"}).first(), "d-import-record");
  await page.mouse.wheel(0,900); await settle(page,900);
  await shot(page,"d-import-3-plan-detail");
} finally { await browser.close(); }
