#!/usr/bin/env node
/**
 * Transcript trimmer — the tail half of the wake (resident_ladder_on_claude_code.md rev 4).
 *
 * Takes a Claude Code session transcript, keeps the newest ~TARGET tokens of
 * entries extended back to the nearest genuine human prompt, and writes the
 * kept tail as a NEW session file (fresh uuid) in the same project directory.
 * Delete-only: whole JSONL entries are kept or dropped, nothing inside an
 * entry is rewritten except the session id itself and, where a dropped
 * harness entry sat mid-chain, its children's parentUuid (see HARNESS_LOADED). The original is never
 * touched. `claude --resume <new-id> --fork-session` loads the copy as
 * native turns (tested 2026-09-27: 1,058/1,987 entries, 29 s load, texture
 * intact).
 *
 * The transcript format is the harness's own and undocumented; this script
 * knows as little of it as possible on purpose. If the format shifts, the
 * next wake breaks loudly here rather than corrupting anything.
 *
 * Usage: node trim.mjs <session-id-or-path> [--target-tokens 250000] [--dry]
 * Prints JSON: { newSessionId, path, keptEntries, totalEntries, estTokens,
 *               cutAt, cutPrompt }
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

import { loadConfig } from './config.mjs';

const CFG = loadConfig();
const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const target = Number((args.find((a) => a.startsWith('--target-tokens')) ?? '').split('=')[1] || args[args.indexOf('--target-tokens') + 1] || 250_000);
const dry = args.includes('--dry');
if (!src) {
  console.error('usage: trim.mjs <session-id-or-path> [--target-tokens N] [--dry]');
  process.exit(2);
}

const PROJECT_DIR = CFG.paths.transcripts;
const srcPath = existsSync(src) ? src : join(PROJECT_DIR, `${src}.jsonl`);
if (!existsSync(srcPath)) {
  console.error(`no transcript at ${srcPath}`);
  process.exit(2);
}
const oldId = basename(srcPath, '.jsonl');

const lines = readFileSync(srcPath, 'utf8').split('\n').filter((l) => l.trim());
const entries = lines.map((l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null; // a torn line is dropped like any other entry, loudly below
  }
});
const torn = entries.filter((e) => e === null).length;
if (torn) console.error(`warning: ${torn} unparseable line(s) will be dropped`);

// Entries the harness writes at EVERY session start, whether or not a copy
// is already in the transcript: resuming a tail that carries one loads the
// head twice. Measured 2026-10-08 (anima_dev/nightwatch_incident_2026-10-08_
// prompt_too_long.md): a refold of a dead wake kept its 429KB `instructions`
// entry (CLAUDE.md + ladder + memory, ~55k tokens), the next resume added a
// fresh one, and the wake died on "Prompt is too long". `environment` and
// `total_tokens_reminder` are re-sent too, but they are small AND written
// every turn mid-session (the cwd changes, the token count): dropping them
// would edit what the model was told along the way, so they stay. The
// *_delta / skill_listing entries are not re-sent (the harness rebuilds that
// state from the transcript) and stay.
const HARNESS_LOADED = new Set(['instructions']);
function isHarnessLoaded(e) {
  return e?.type === 'attachment' && HARNESS_LOADED.has(e.attachment?.type);
}

/** A genuine human prompt: typed by the person, not a tool result, not a
 *  meta/caveat wrapper. The cut must land ON one so the resumed session's
 *  first conversational turn is a human turn. */
function isHumanPrompt(e) {
  if (!e || e.type !== 'user' || e.isMeta) return false;
  if (e.userType && e.userType !== 'external') return false;
  const c = e.message?.content;
  if (typeof c === 'string') return true;
  if (Array.isArray(c)) return c.some((b) => b?.type === 'text') && !c.some((b) => b?.type === 'tool_result');
  return false;
}

// Per-line token estimate: chars/4 for text, with long base64 runs (image
// blobs in tool results, screenshots, data URIs) billed at the vision rate
// instead of the byte rate. A 200KB screenshot is ~273k base64 chars —
// chars/4 says 68k tokens, the provider's vision cost caps near 1,600. The
// raw-byte rule inflated image-heavy folds 4–6x three nights running
// (1.15M/333 and 1.29M/404 entries on the MV lane vs ~287k text folds),
// which starves the kept tail: the walk hits target in a handful of
// screenshot entries and drops conversation that would actually fit.
// min(1600, chars/4) never bills a small blob above the old estimate.
const BLOB_RUN = /[A-Za-z0-9+/]{4000,}={0,2}/g;
function estLine(l) {
  let blobChars = 0;
  let blobTokens = 0;
  for (const m of l.matchAll(BLOB_RUN)) {
    blobChars += m[0].length;
    blobTokens += Math.min(1600, Math.ceil(m[0].length / 4));
  }
  return Math.ceil((l.length - blobChars) / 4) + blobTokens;
}

// Walk from the end, accumulating the estimate per raw line (includes tool
// results and metadata — the honest weight of what resumes).
let est = 0;
let cut = lines.length; // index of first KEPT line
for (let i = lines.length - 1; i >= 0; i--) {
  if (!isHarnessLoaded(entries[i])) est += estLine(lines[i]);
  cut = i;
  if (est >= target) break;
}
// Extend back to the nearest human prompt at or before the cut.
let promptIdx = -1;
for (let i = cut; i >= 0; i--) {
  if (isHumanPrompt(entries[i])) {
    promptIdx = i;
    break;
  }
}
if (promptIdx === -1) {
  // No human prompt before the cut — take the first one after it instead
  // (a short session, or a cut into a machine-only stretch).
  for (let i = cut; i < lines.length; i++) {
    if (isHumanPrompt(entries[i])) {
      promptIdx = i;
      break;
    }
  }
}
if (promptIdx === -1) {
  console.error('no human prompt found anywhere — refusing to cut');
  process.exit(1);
}
cut = promptIdx;

// A dropped entry's children are re-pointed at its parent, or the harness's
// chain walk (leaf → parentUuid → …) would stop at the gap and silently
// resume only the turns after it.
const droppedParent = new Map();
for (let i = cut; i < lines.length; i++) {
  if (isHarnessLoaded(entries[i]) && entries[i].uuid) droppedParent.set(entries[i].uuid, entries[i].parentUuid ?? null);
}
function liveParent(u) {
  const seen = new Set();
  while (u && droppedParent.has(u) && !seen.has(u)) { seen.add(u); u = droppedParent.get(u); }
  return u ?? null;
}
const kept = [];
let keptEst = 0;
let dropped = 0;
let relinked = 0;
for (let i = cut; i < lines.length; i++) {
  if (entries[i] === null) continue;
  if (isHarnessLoaded(entries[i])) { dropped++; continue; }
  let line = lines[i];
  const p = entries[i].parentUuid;
  if (p && droppedParent.has(p)) {
    line = JSON.stringify({ ...entries[i], parentUuid: liveParent(p) });
    relinked++;
  }
  kept.push(line);
  keptEst += estLine(line);
}

const newId = randomUUID();
// The session id appears as `sessionId` and `session_id`; the value is the
// old uuid, globally unique, so a plain string replace is exact.
const out = kept.map((l) => l.split(oldId).join(newId)).join('\n') + '\n';
const outPath = join(dirname(srcPath), `${newId}.jsonl`);

const cutEntry = entries[cut];
const report = {
  newSessionId: newId,
  path: outPath,
  keptEntries: kept.length,
  totalEntries: lines.length,
  estTokens: keptEst,
  harnessDropped: dropped,
  relinked,
  cutAt: cutEntry?.timestamp ?? null,
  cutPrompt: String(cutEntry?.message?.content ?? '').slice(0, 120),
};
if (dry) {
  report.dry = true;
} else {
  writeFileSync(outPath, out);
}
console.log(JSON.stringify(report, null, 2));
