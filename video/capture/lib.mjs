// Shared capture helpers: Clerk bot sign-in + retina screenshots.
//
// Everything the demo video shows is re-photographed from the real deployed
// app. This module is the only place that knows how to get in the door.
//
// Secrets come from the repo-root .env.local and never reach argv or stdout.

import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../..");
export const SHOTS = resolve(HERE, "../public/shots");
export const CLIPS = resolve(HERE, "../public/clips");

export const BASE =
  process.env.STAGESTACK_BASE ??
  "https://stagestack-git-develop-equipe-ai.vercel.app";

/** Parse the root .env.local without pulling the whole app's config in. */
export function env(key) {
  const raw = readFileSync(resolve(ROOT, ".env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && m[1] === key) return m[2].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(`${key} missing from .env.local`);
}

const FIXTURES = {
  organizer: "alvaro+sbek-organizer@equipeai.com.br",
  speaker: "alvaro+sbek-speaker@equipeai.com.br",
  speaker2: "alvaro+sbek-speaker2@equipeai.com.br",
  reviewer: "alvaro+sbek-reviewer@equipeai.com.br",
  // The reviewer that has a display name set. The plain `reviewer` fixture
  // never completed the profile gate, so it lands on "Put a name to your
  // work" instead of a queue.
  reviewerClean: "alvaro+sbek-reviewer-clean@equipeai.com.br",
};

/** Mint a single-use Clerk sign-in ticket for a fixture user. */
async function ticketFor(role) {
  const secret = env("CLERK_SECRET_KEY");
  const email = FIXTURES[role];
  if (!email) throw new Error(`unknown fixture role: ${role}`);

  const lookup = await fetch(
    `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${secret}` } },
  );
  const users = await lookup.json();
  const userId = users?.[0]?.id;
  if (!userId) throw new Error(`no Clerk user for ${role}`);

  const res = await fetch("https://api.clerk.com/v1/sign_in_tokens", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_id: userId, expires_in_seconds: 600 }),
  });
  const body = await res.json();
  if (!body?.token) throw new Error(`ticket mint failed: ${res.status}`);
  return body.token;
}

/**
 * Launch a browser at video resolution. `scale: 2` gives retina pixels so a
 * 1920x1080 frame can be zoomed into without turning to mush — the whole
 * reason the eval run's 739px captures were unusable.
 */
export async function open({ scale = 2, video = false } = {}) {
  mkdirSync(SHOTS, { recursive: true });
  mkdirSync(CLIPS, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: video ? 1 : scale, // video capture ignores DSF anyway
    colorScheme: "light",
    reducedMotion: "no-preference",
    ...(video
      ? { recordVideo: { dir: CLIPS, size: { width: 1920, height: 1080 } } }
      : {}),
  });

  // Hide the Clerk "Development mode" watermark — it's a dev-instance artifact,
  // not part of the product, and it would read as unfinished on camera.
  await context.addStyleTag?.({ content: "" }).catch(() => {});
  await context.addInitScript(() => {
    const css = `.cl-internal-development-mode-badge,
      [class*="developmentMode"], .cl-badge { display: none !important; }`;
    document.addEventListener("DOMContentLoaded", () => {
      const s = document.createElement("style");
      s.textContent = css;
      document.head.appendChild(s);
    });
  });

  const page = await context.newPage();
  return { browser, context, page };
}

/** Sign in as a fixture user via Clerk's `ticket` strategy. */
export async function signIn(page, role) {
  const ticket = await ticketFor(role);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.Clerk?.loaded), {
    timeout: 45_000,
  });
  await page.evaluate(async (t) => {
    const res = await window.Clerk.client.signIn.create({
      strategy: "ticket",
      ticket: t,
    });
    await window.Clerk.setActive({ session: res.createdSessionId });
  }, ticket);
  await page.waitForFunction(() => Boolean(window.Clerk?.user), {
    timeout: 45_000,
  });
}

/** Settle: fonts loaded, network idle, no in-flight animation. */
export async function settle(page, ms = 700) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(ms);
}

/**
 * Hide fixture email addresses before the shutter fires.
 *
 * The eval fixtures are real mailboxes (alvaro+sbek-…@equipeai.com.br) and
 * they surface as secondary lines in submitter/reviewer columns. This blanks
 * those nodes — it never substitutes invented text, so the shot still shows
 * only things the app actually rendered, minus a personal address.
 * `visibility` rather than `display` so no row reflows.
 */
export async function redactFixtureEmails(page) {
  return page.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll("*")) {
      if (el.children.length) continue; // leaves only
      if (/alvaro\+[\w.+-]*@/.test(el.textContent ?? "")) {
        el.style.visibility = "hidden";
        n++;
      }
    }
    return n;
  });
}

/**
 * Screenshot a single element.
 *
 * Cropping into a full-page capture always slices some heading or card in
 * half — that's what made the zooms look broken. An element shot is framed
 * correctly by construction, so detail beats use these instead of a zoom.
 */
export async function shotEl(page, locator, name, pad = 24) {
  await settle(page);
  await redactFixtureEmails(page);
  const el = typeof locator === "string" ? page.locator(locator) : locator;
  await el.first().waitFor({ state: "visible", timeout: 20_000 });
  await el.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  const box = await el.first().boundingBox();
  if (!box) throw new Error(`no bounding box for ${name}`);
  const path = resolve(SHOTS, `${name}.png`);
  await page.screenshot({
    path,
    clip: {
      x: Math.max(0, box.x - pad),
      y: Math.max(0, box.y - pad),
      width: Math.min(box.width + pad * 2, 1920 - Math.max(0, box.x - pad)),
      height: Math.min(box.height + pad * 2, 1080 - Math.max(0, box.y - pad)),
    },
  });
  console.log(`  ✓ ${name}.png (element)`);
  return path;
}

/**
 * Screenshot the *smallest* visible element containing `text`.
 *
 * More reliable than guessing a class: `.ss-card` doesn't wrap everything,
 * and a bare `div` selector matches the page root, which is how two "element"
 * shots came back as full pages.
 */
export async function shotRegion(page, text, name, pad = 20) {
  await settle(page);
  await redactFixtureEmails(page);
  const rect = await page.evaluate((needle) => {
    let best = null;
    for (const el of document.querySelectorAll("div,section,aside,article")) {
      if (!el.textContent?.includes(needle)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 120 || r.height < 40) continue;
      if (r.top < 0 || r.bottom > window.innerHeight) continue;
      const area = r.width * r.height;
      if (!best || area < best.area)
        best = { x: r.x, y: r.y, width: r.width, height: r.height, area };
    }
    return best;
  }, text);
  if (!rect) throw new Error(`no region containing "${text}"`);
  const path = resolve(SHOTS, `${name}.png`);
  await page.screenshot({
    path,
    clip: {
      x: Math.max(0, rect.x - pad),
      y: Math.max(0, rect.y - pad),
      width: Math.min(rect.width + pad * 2, 1920 - Math.max(0, rect.x - pad)),
      height: Math.min(rect.height + pad * 2, 1080 - Math.max(0, rect.y - pad)),
    },
  });
  console.log(`  ✓ ${name}.png (region ${Math.round(rect.width)}x${Math.round(rect.height)})`);
  return path;
}

export async function shot(page, name, opts = {}) {
  await settle(page);
  await redactFixtureEmails(page);
  const path = resolve(SHOTS, `${name}.png`);
  await page.screenshot({ path, ...opts });
  console.log(`  ✓ ${name}.png`);
  return path;
}
