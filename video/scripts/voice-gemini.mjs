// Re-voice a script with Gemini TTS, which takes direction.
//
//   node scripts/voice-gemini.mjs narration-social.json
//   node scripts/voice-gemini.mjs narration-social.json --force
//
// Deepgram's Aura-2 picks a voice and reads; there is no way to ask it for
// more energy. Gemini's TTS takes a natural-language brief before the
// transcript, which is the whole reason to use it here: the trailer was
// correctly written and flatly delivered, and delivery is the only thing
// changing.
//
// Writes the same public/voice/<id>.mp3 files and the same durations.json the
// Deepgram generator does, so the cut re-times itself and nothing else in the
// project needs to know which engine spoke.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = resolve(ROOT, "public/voice");
const MODEL = process.env.GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview";
const VOICE = process.env.GEMINI_TTS_VOICE ?? "Puck";
const force = process.argv.includes("--force");
const SCRIPT = process.argv.slice(2).find((a) => a.endsWith(".json")) ?? "narration-social.json";

/** The direction. Spoken performance only — it must never reach the audio,
 *  which is what the voice-check round trip is there to confirm. */
const DIRECTION = [
  "You are the voiceover on a fast, confident product trailer.",
  "Delivery: high energy, upbeat, and quick, like you cannot wait to show",
  "someone this. Punch the first word of every sentence. Keep the pace brisk",
  "and never trail off at the end of a line. Sound like you are smiling.",
  "Read only the transcript, exactly as written, and say nothing else.",
  "",
  "Transcript:",
].join(" ");

function apiKey() {
  const raw = readFileSync(resolve(ROOT, "../.env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("GEMINI_API_KEY missing from the repo-root .env.local");
}

/** Gemini returns raw 24kHz mono 16-bit PCM; give it a WAV header so ffmpeg
 *  can read it, then encode to mp3 like every other line in the project. */
function pcmToMp3(pcm, mp3Path) {
  const wav = mp3Path.replace(/\.mp3$/, ".wav");
  const header = Buffer.alloc(44);
  const rate = 24000, channels = 1, bits = 16;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE((rate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  writeFileSync(wav, Buffer.concat([header, pcm]));
  execFileSync("ffmpeg", ["-v", "error", "-i", wav, "-b:a", "192k", mp3Path, "-y"]);
  unlinkSync(wav);
}

/** Walk the response for the first base64 audio blob, whatever it is nested in. */
function findAudio(node) {
  if (node === null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findAudio(item);
      if (hit) return hit;
    }
    return null;
  }
  const data = node.data ?? node.audioData ?? node.audio_data;
  const mime = node.mimeType ?? node.mime_type ?? "";
  if (typeof data === "string" && data.length > 1000 && (!mime || /audio|pcm|L16/i.test(mime))) {
    return data;
  }
  for (const value of Object.values(node)) {
    const hit = findAudio(value);
    if (hit) return hit;
  }
  return null;
}

const script = JSON.parse(readFileSync(resolve(ROOT, SCRIPT), "utf8"));
const lines = Object.entries(script).filter(([id]) => !id.startsWith("_"));

mkdirSync(OUT, { recursive: true });
const manifestPath = resolve(OUT, "durations.json");
const previous = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : {};
const manifest = { ...previous };
const key = apiKey();
let generated = 0;

for (const [id, text] of lines) {
  const file = resolve(OUT, `${id}.mp3`);
  const hash = createHash("sha1")
    .update(`${MODEL}::${VOICE}::${DIRECTION}::${text}`)
    .digest("hex")
    .slice(0, 12);

  if (!force && previous[id]?.hash === hash && existsSync(file)) {
    continue;
  }

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/interactions",
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        input: `${DIRECTION} ${text}`,
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice: VOICE }] },
      }),
    },
  );
  const body = await res.json();
  if (!res.ok) {
    throw new Error(`${id}: Gemini ${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  }
  const b64 = findAudio(body);
  if (!b64) throw new Error(`${id}: no audio in response`);

  pcmToMp3(Buffer.from(b64, "base64"), file);
  generated++;

  const seconds = Number(
    execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file,
    ]).toString().trim(),
  );
  manifest[id] = { hash, seconds: Math.round(seconds * 1000) / 1000 };
  console.log(`  ✓ ${id.padEnd(22)} ${manifest[id].seconds.toFixed(2)}s`);
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\n${generated} generated with ${VOICE} — now run: node scripts/voice-check.mjs ${SCRIPT}`);
