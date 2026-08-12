// Catch mispronunciations without having to listen to 28 files.
//
//   node scripts/voice-check.mjs
//
// Aura-2 supports no SSML, no phoneme tags and no IPA — the only lever is
// spelling a word the way it should sound. That makes "did it say the word
// right?" a question you normally answer by ear, one file at a time.
//
// So instead: send the generated speech back through Deepgram's own speech-to-
// text and diff the transcript against the line we asked for. A word the voice
// mangles is a word the recogniser hears as something else, which shows up as
// a concrete mismatch. It is not a perfect ear — a wrong-but-plausible reading
// can still transcribe correctly — but it reliably catches the class of
// failure that matters here: a word swapped for a different word.
//
// Known limitation, learned the hard way: it does NOT catch a word that is
// merely stressed wrongly. "self-hostable" came out sounding like "hostage",
// and the recogniser still transcribed it as "self hostable" — speech-to-text
// is biased toward the plausible word, so it quietly repairs exactly the
// mistake you are hunting for. For unusual compounds, the reliable fix is to
// not use them: say "you can host it yourself" instead.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const OUT = resolve(ROOT, "public/voice");
const STT_MODEL = process.env.DEEPGRAM_STT_MODEL ?? "nova-3";

function apiKey() {
  const raw = readFileSync(resolve(ROOT, "../.env.local"), "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?DEEPGRAM_API_KEY\s*=\s*(.*)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("DEEPGRAM_API_KEY missing from the repo-root .env.local");
}

/** Compare on sound-ish terms: case, punctuation and hyphens are not errors. */
const words = (s) =>
  s
    .toLowerCase()
    .replace(/[—–-]/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);

/** Recogniser habits that are not pronunciation problems: it splits compounds
 *  ("timezone" -> "time zone", "StageStack" -> "stage stack") and it spells
 *  homophones its own way ("queue" -> "cue"). Both mean the audio was RIGHT.
 *  Collapsing them here is what keeps a real mangling visible in the noise. */
const HOMOPHONES = new Map([["cue", "queue"], ["que", "queue"]]);
function normalise(want, got) {
  const out = [];
  for (let j = 0; j < got.length; j++) {
    const w = HOMOPHONES.get(got[j]) ?? got[j];
    // Re-join a split compound when the two halves spell a word we asked for.
    const joined = w + (got[j + 1] ?? "");
    if (j + 1 < got.length && want.includes(joined)) {
      out.push(joined);
      j++;
      continue;
    }
    out.push(w);
  }
  return out;
}

/** Longest-common-subsequence diff, so one dropped word doesn't cascade. */
function diff(want, got) {
  const n = want.length, m = got.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = want[i] === got[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);

  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (want[i] === got[j]) { i++; j++; continue; }
    if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ want: want[i++], got: null });
    else out.push({ want: null, got: got[j++] });
  }
  while (i < n) out.push({ want: want[i++], got: null });
  while (j < m) out.push({ want: null, got: got[j++] });
  return out;
}

const script = JSON.parse(readFileSync(resolve(ROOT, "narration.json"), "utf8"));
const key = apiKey();
let flagged = 0;

for (const [id, text] of Object.entries(script)) {
  if (id.startsWith("_")) continue;
  const file = resolve(OUT, `${id}.mp3`);
  if (!existsSync(file)) {
    console.log(`  ? ${id} — not generated yet`);
    continue;
  }

  const res = await fetch(
    `https://api.deepgram.com/v1/listen?model=${STT_MODEL}&smart_format=false&punctuate=false`,
    {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "audio/mpeg" },
      body: readFileSync(file),
    },
  );
  if (!res.ok) throw new Error(`${id}: STT ${res.status} ${await res.text()}`);
  const body = await res.json();
  const heard = body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";

  const want = words(text);
  const d = diff(want, normalise(want, words(heard))).filter((x) => x.want || x.got);
  if (d.length === 0) {
    console.log(`  ✓ ${id}`);
    continue;
  }
  flagged++;
  console.log(`  ⚠ ${id}`);
  for (const x of d) {
    console.log(
      x.want && x.got === null
        ? `      said "${x.want}" → heard nothing`
        : x.got && x.want === null
          ? `      heard an extra "${x.got}"`
          : `      "${x.want}" → "${x.got}"`,
    );
  }
  console.log(`      heard: ${heard}`);
}

console.log(
  `\n${flagged} line${flagged === 1 ? "" : "s"} to look at. A mismatch is a hint, not a verdict — read the transcript and decide.`,
);
