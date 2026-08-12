// Generate the narration with Deepgram Aura-2, and measure it.
//
//   node scripts/voice.mjs          # only what's missing or changed
//   node scripts/voice.mjs --force  # everything
//
// The measurement is the important half. Remotion needs to know how long each
// line is BEFORE it renders, so this writes public/voice/durations.json and
// beats.ts pads every beat to fit its own line. Guessing timings and hoping
// they line up is how narrated demos end up talking over their own cuts.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = resolve(ROOT, "public/voice");
const MODEL = process.env.DEEPGRAM_MODEL ?? "aura-2-thalia-en";
const force = process.argv.includes("--force");

function apiKey() {
  const raw = readFileSync(resolve(ROOT, "../.env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?DEEPGRAM_API_KEY\s*=\s*(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DEEPGRAM_API_KEY missing from the repo-root .env.local");
}

const script = JSON.parse(readFileSync(resolve(ROOT, "narration.json"), "utf8"));
const lines = Object.entries(script).filter(([id]) => !id.startsWith("_"));

mkdirSync(OUT, { recursive: true });
const manifestPath = resolve(OUT, "durations.json");
const previous = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : {};

const key = apiKey();
const manifest = {};
let generated = 0;

for (const [id, text] of lines) {
  const file = resolve(OUT, `${id}.mp3`);
  // Hash the text so an edited line regenerates and an untouched one doesn't
  // burn credits (or drift out of sync with its measured duration).
  const hash = createHash("sha1").update(`${MODEL}::${text}`).digest("hex").slice(0, 12);

  if (!force && previous[id]?.hash === hash && existsSync(file)) {
    manifest[id] = previous[id];
    continue;
  }

  const res = await fetch(
    `https://api.deepgram.com/v1/speak?model=${MODEL}&encoding=mp3`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    },
  );
  if (!res.ok) {
    throw new Error(`${id}: Deepgram ${res.status} ${await res.text()}`);
  }
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  generated++;

  const seconds = Number(
    execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "csv=p=0",
      file,
    ]).toString().trim(),
  );
  manifest[id] = { hash, seconds: Math.round(seconds * 1000) / 1000 };
  console.log(`  ✓ ${id.padEnd(28)} ${manifest[id].seconds.toFixed(2)}s`);
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

const total = Object.values(manifest).reduce((a, b) => a + b.seconds, 0);
console.log(
  `\n${generated} generated, ${lines.length - generated} unchanged — ${total.toFixed(1)}s of narration`,
);
