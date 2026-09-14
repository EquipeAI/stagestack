import { open, signIn, settle, shot, shotRegion, BASE } from "./lib.mjs";
const EV="devflow-conf-2027-2";
const {browser,page}=await open();
try{
  await signIn(page,"reviewerClean");
  await page.goto(`${BASE}/app/e/${EV}/reviews`,{waitUntil:"domcontentloaded"});
  await settle(page,2500);
  await page.getByText(/Taming 40-Minute CI/).first().click();
  await settle(page,2500);
  const t=await page.evaluate(()=>document.body.innerText);
  console.log((t.split("Reviews")[1]??t).slice(0,1000));
  await shot(page,"19-reviewer-scoring");
  await shotRegion(page,"Originality","d-review-form",18).catch(e=>console.log("region:",e.message));
} finally { await browser.close(); }
