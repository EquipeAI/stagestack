// Generate the score with Lyria 3 Pro (Gemini Interactions API).
//
//   node scripts/music.mjs           # only if missing
//   node scripts/music.mjs --force   # regenerate
//
// The brief matters more than the model here. This is an underscore playing
// beneath a voiceover for two and a half minutes, so what it must NOT do is
// most of what music generators like doing: no vocals, no drops, no big
// dynamic swings that fight a sentence. Steady, warm, and slightly forward
// over time, so the cut feels like it is going somewhere without the track
// ever asking for attention.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = resolve(ROOT, "public/music");
const MODEL = process.env.LYRIA_MODEL ?? "lyria-3-pro-preview";
const force = process.argv.includes("--force");

// Phrasing note: the safety filter false-positives on some perfectly ordinary
// briefs — "A calm instrumental ambient piece with warm synth pads and soft
// piano" was blocked outright, while the wording below went straight through.
// Leading with the instrumentation rather than the mood seems to be what does
// it. If a future edit starts returning content_blocked, change the words
// before assuming the key or the model is wrong.
const BRIEF = `Instrumental only, no vocals. Warm analog synth pads, a soft
felt piano playing a simple repeating four-note motif, a quiet pulsing bass
note, and light arpeggios low in the mix. Steady 100 BPM throughout. About two
minutes forty seconds long.

[0:00 - 0:30] sparse: pad and the piano motif alone, unhurried
[0:30 - 1:40] pulse and bass enter, gradually warmer
[1:40 - 2:20] fullest point: motif doubled, brighter harmony
[2:20 - 2:45] settle back to the pad and one closing piano phrase

This plays underneath a spoken voiceover the whole way, so keep the mid-range
open, the dynamics narrow and the texture even. Smooth transitions between
sections. It should be understated enough to be almost boring on its own.`;

function apiKey() {
  const raw = readFileSync(resolve(ROOT, "../.env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("GEMINI_API_KEY missing from the repo-root .env.local");
}

mkdirSync(OUT, { recursive: true });
const file = resolve(OUT, "score.mp3");
if (existsSync(file) && !force) {
  console.log("  · score.mp3 already exists (--force to regenerate)");
  process.exit(0);
}

const res = await fetch(
  "https://generativelanguage.googleapis.com/v1beta/interactions",
  {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, input: BRIEF }),
  },
);

const body = await res.json();
if (!res.ok) {
  throw new Error(`Lyria ${res.status}: ${JSON.stringify(body).slice(0, 600)}`);
}

/** Walk the response for the first base64 audio blob, whatever it's nested in. */
function findAudio(node) {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findAudio(item);
      if (hit) return hit;
    }
    return null;
  }
  const mime = node.mimeType ?? node.mime_type ?? "";
  const data = node.data ?? node.audioData ?? node.audio_data;
  if (typeof data === "string" && data.length > 1000) {
    if (!mime || mime.startsWith("audio")) return data;
  }
  for (const value of Object.values(node)) {
    const hit = findAudio(value);
    if (hit) return hit;
  }
  return null;
}

const b64 = findAudio(body);
if (!b64) {
  writeFileSync(resolve(OUT, "response.json"), JSON.stringify(body, null, 2));
  throw new Error("no audio in the response — dumped to public/music/response.json");
}

writeFileSync(file, Buffer.from(b64, "base64"));
const seconds = Number(
  execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    file,
  ]).toString().trim(),
);
console.log(`  ✓ public/music/score.mp3 — ${seconds.toFixed(1)}s`);
