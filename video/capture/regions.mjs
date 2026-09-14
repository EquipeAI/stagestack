// Re-capture the two detail shots whose class selector matched the page root.
import { open, signIn, settle, shotRegion, BASE } from "./lib.mjs";
const EV="devflow-conf-2027-2";
{
  const {browser,page}=await open();
  try{
    await signIn(page,"organizer");
    await page.goto(`${BASE}/app/e/${EV}/agenda?view=room`,{waitUntil:"domcontentloaded"});
    await settle(page,2000);
    await shotRegion(page,"Speaker double-booked","d-conflicts",14);
  } finally { await browser.close(); }
}
{
  const {browser,page}=await open();
  try{
    await signIn(page,"speaker");
    await page.goto(`${BASE}/portal/${EV}`,{waitUntil:"domcontentloaded"});
    await settle(page,2000);
    await shotRegion(page,"Your slot","d-speaker-slot",14);
  } finally { await browser.close(); }
}
