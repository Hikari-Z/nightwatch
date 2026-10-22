#!/usr/bin/env node
/**
 * Transcript trimmer — the tail half of the wake (resident_ladder_on_claude_code.md rev 4).
 *
 * Takes a Claude Code session transcript, keeps the newest ~TARGET tokens of
 * entries extended back to the nearest genuine human prompt, and writes the
 * kept tail as a NEW session file (fresh uuid) in the same project directory.
 * Delete-only: whole JSONL entries are kept or dropped, nothing inside an
 * entry is rewritten except the session id itself, each reply's recorded
 * token `usage` (see STALE USAGE), and, where a dropped harness entry sat
 * mid-chain, its children's parentUuid (see HARNESS_LOADED). The original is never
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
 *               targetTokens, cutAt, cutPrompt, overshoot? }
 * overshoot (fix 5, 10/9) appears when reaching back to a human prompt carried
 * the kept estimate past OVERSHOOT × target: { ratio, extendedEntries,
 * walkCutAt }. It's also said on stderr, so a person running a fold sees it.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

import { loadConfig } from './config.mjs';

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith('--'));
const target = Number((args.find((a) => a.startsWith('--target-tokens')) ?? '').split('=')[1] || args[args.indexOf('--target-tokens') + 1] || 250_000);
const dry = args.includes('--dry');
if (!src) {
  console.error('usage: trim.mjs <session-id-or-path> [--target-tokens N] [--dry]');
  process.exit(2);
}

// A path names its own transcript. Only a bare session id needs the hub's
// transcripts folder, so only then is a hub config required: since #7 (A2)
// a missing config is an error, and loading it up front refused path runs
// that touch no hub (trim-test's, and any by hand).
const srcPath = existsSync(src) ? src : join(loadConfig().paths.transcripts, `${src}.jsonl`);
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

// Entries Claude Code writes as its own request log (since 2.1.300):
// `api-request` (full request params), `api-request-blob` (the log's
// content-by-hash dedup store) and `api-request-shape` (the system-prompt
// shape). A day's transcript holds megabytes of them, but none carries a
// uuid and no entry's parentUuid points at one, so a resume never loads
// any into context (measured on two live transcripts, 10/19). They stay
// in the kept file (they are the session's own record), and they weigh
// nothing in the estimate — counting them produced the 10/16–10/18
// phantom overshoots (a 6.22x warning over a ~88k conversation). The
// list stays explicit rather than a "no uuid" rule: an unknown future
// type then defaults to counted, which can only overcount, never hide.
const REQUEST_LOG = new Set(['api-request', 'api-request-blob', 'api-request-shape']);
function isResumeInert(e) {
  return REQUEST_LOG.has(e?.type);
}

// STALE USAGE: every reply records the token usage of the request that made
// it. Claude Code reads the newest one as the session's current size, and on
// resume it trusted the kept tail's last figure: 937k, recorded at 93% before
// the fold. It decided the window was full and refused locally ("Prompt is
// too long", terminal_reason blocking_limit, no API call) on 2026-10-08. The
// same tail with these fields removed resumed and answered at 181,590 real
// tokens. A copied usage figure describes the session that was folded, not
// the one that resumes, so it never travels.
function withoutUsage(e) {
  if (e?.type !== 'assistant' || !e.message || !('usage' in e.message)) return null;
  const { usage, ...message } = e.message;
  return { ...e, message };
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

/** A peer's cross-session message opens an exchange the same way a human
 *  prompt does (Ra's ruling, 10/9): a tail may start on one. Without this,
 *  a cover day where the lanes talk to each other all afternoon reaches
 *  back to the human's LAST prompt and keeps everything since — the live
 *  958k-est overshoot at opus's 10/9 fold. Peer messages arrive as
 *  isMeta user turns, so isHumanPrompt alone excludes them. */
function isPeerMessage(e) {
  if (!e || e.type !== 'user' || !e.isMeta) return false;
  const c = e.message?.content;
  return typeof c === 'string' && c.includes('<cross-session-message ');
}

/** Where a cut may land: a turn that OPENS an exchange. */
function isSeamTurn(e) {
  return isHumanPrompt(e) || isPeerMessage(e);
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
// results and metadata — the honest weight of what resumes), remembering the
// suffix estimate AT each index so seams can be compared afterwards.
let est = 0;
let cut = lines.length; // index of first KEPT line
const suffixEst = new Array(lines.length + 1).fill(0);
for (let i = lines.length - 1; i >= 0; i--) {
  if (!isHarnessLoaded(entries[i]) && !isResumeInert(entries[i])) est += estLine(lines[i]);
  suffixEst[i] = est;
  if (est >= target && cut === lines.length) cut = i;
}
if (cut === lines.length) cut = 0; // whole session fits
// The tail must OPEN at a seam (a human prompt, or a peer's cross-session
// message — Ra's ruling, 10/9). Among all seams, take the one whose kept
// estimate lands CLOSEST to the target: the old nearest-backward rule kept
// everything since the human's last morning prompt on a lane-to-lane
// afternoon (the live 958k-est overshoot at opus's 10/9 fold), when a peer
// seam within sight of the target existed. Ties prefer the larger tail
// (fold-TO keeps at least the tide line where it can).
const walkCut = cut;
let promptIdx = -1;
let bestDist = Infinity;
for (let i = 0; i < lines.length; i++) {
  if (!isSeamTurn(entries[i])) continue;
  const dist = Math.abs(suffixEst[i] - target);
  if (dist < bestDist || (dist === bestDist && i < promptIdx)) {
    bestDist = dist;
    promptIdx = i;
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
let usageStripped = 0;
for (let i = cut; i < lines.length; i++) {
  if (entries[i] === null) continue;
  if (isHarnessLoaded(entries[i])) { dropped++; continue; }
  let e = entries[i];
  let changed = false;
  const p = e.parentUuid;
  if (p && droppedParent.has(p)) {
    e = { ...e, parentUuid: liveParent(p) };
    relinked++;
    changed = true;
  }
  const stripped = withoutUsage(e);
  if (stripped) { e = stripped; usageStripped++; changed = true; }
  const line = changed ? JSON.stringify(e) : lines[i];
  kept.push(line);
  if (!isResumeInert(e)) keptEst += estLine(line);
}

// OUTPUT CHECK (10/21): the cut above is made by fields this script does not
// own, so it checks the tail it just built against the shape a resume needs,
// and refuses to write one that fails. Three silent failures, each reproduced
// on a scratch fixture (compat repro, 10/21), all exit 0 before this check:
//  1. uuid or parentUuid renamed: relinking no-ops (relinked 0), the chain has
//     a hole, and the harness would resume only the turns after it.
//  2. a parent that is not in the tail: the same hole by any other cause.
//  3. isMeta renamed: harness wrappers read as human prompts, and the cut can
//     land ON one. The wrappers named here carry isMeta in every transcript
//     measured on this hub (1,344 peer messages, 111 local-command-caveats,
//     9 "response cut" nudges; 0 exceptions), so one without it is drift.
//     `<local-command-stdout>` is deliberately NOT listed: it is a real
//     user-role entry with isMeta false (74 of them).
//  4. `usage` renamed: withoutUsage (above) then strips nothing, and the stale
//     figure travels, the 10/8 "Prompt is too long" refusal. The check looks
//     for the token FIELDS, not the key's name: a numeric input_tokens /
//     cache_read_input_tokens / cache_creation_input_tokens held as an object
//     key on a kept assistant entry, outside its content, means a usage record
//     survived under some other key. Keys, not text: transcripts here are full
//     of message text and tool results that NAME those fields, and user entries
//     and `content` are never scanned. Measured on this hub's archive (76,327
//     assistant entries): 0 such carriers outside `usage`. It does not catch a
//     rename of the inner field names as well.
// A check that fails exits 1 and writes nothing: a fold skipped loudly beats a
// tail that resumes wrong silently. The first kept entry may point outside the
// tail (its parent is the cut); no other entry may.
const USAGE_FIELDS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
function carriesUsage(v, depth = 0) {
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return depth < 2 && v.slice(0, 5).some((x) => carriesUsage(x, depth + 1));
  return USAGE_FIELDS.some((k) => typeof v[k] === 'number') || (depth < 2 && Object.values(v).some((x) => carriesUsage(x, depth + 1)));
}
const META_WRAPPERS = [/^<local-command-caveat>/, /^Your response above was cut/, /^Another Claude session sent a message/];
function tailProblems(keptLines) {
  const rows = keptLines.map((l) => JSON.parse(l));
  const problems = [];
  const conv = rows.filter((e) => e.type === 'user' || e.type === 'assistant');
  const noFields = conv.filter((e) => typeof e.uuid !== 'string' || !('parentUuid' in e)).length;
  if (noFields) problems.push(`${noFields} of ${conv.length} conversation entries lack a uuid or a parentUuid field: the transcript format may have changed`);
  const ids = new Set(rows.map((e) => e.uuid).filter((u) => typeof u === 'string'));
  const holes = rows.slice(1).filter((e) => e.parentUuid && !ids.has(e.parentUuid)).length;
  if (holes) problems.push(`${holes} kept entries point at a parent that is not in the tail: a resume would load only the turns after the gap`);
  const drift = rows.filter((e) => e.type === 'user' && typeof e.message?.content === 'string' && e.isMeta !== true && META_WRAPPERS.some((re) => re.test(e.message.content))).length;
  if (drift) problems.push(`${drift} harness-wrapper entries are not marked isMeta: seam detection can no longer tell them from a human prompt`);
  const staleUsage = rows.filter((e) => e.type === 'assistant' && [
    ...Object.entries(e.message ?? {}).filter(([k]) => k !== 'content'),
    ...Object.entries(e).filter(([k]) => k !== 'message' && k !== 'wireToolInputs'),
  ].some(([, v]) => carriesUsage(v))).length;
  if (staleUsage) problems.push(`${staleUsage} kept replies still carry a token-usage record under a key the trimmer did not strip: a copied figure makes the resume refuse locally ("Prompt is too long")`);
  return problems;
}
const problems = tailProblems(kept);
if (problems.length) {
  console.error(`trim: OUTPUT CHECK FAILED, nothing written. ${problems.join('; ')}.`);
  process.exit(1);
}

const newId = randomUUID();
// The session id appears as `sessionId` and `session_id`; the value is the
// old uuid, globally unique, so a plain string replace is exact.
const out = kept.map((l) => l.split(oldId).join(newId)).join('\n') + '\n';
const outPath = join(dirname(srcPath), `${newId}.jsonl`);

// Overshoot (incident fix 5, 10/8): the walk stops at the target, but the
// tail has to start at a human prompt, and the nearest one can sit far back
// (288k kept against a 150k target at 22:28 on 10/8, unreported). Say so.
// Whether a cut may land on an assistant-turn boundary instead is a separate
// design question: the tail still has to open with a valid user turn.
const OVERSHOOT = 1.25;
const overshoot = keptEst > target * OVERSHOOT
  ? { ratio: Math.round((keptEst / target) * 100) / 100, extendedEntries: Math.max(0, walkCut - cut), walkCutAt: entries[walkCut]?.timestamp ?? null }
  : null;
if (overshoot) {
  console.error(`trim: OVERSHOOT, kept ~${keptEst} tokens against a ${target} target (${overshoot.ratio}x): the nearest human prompt before the cut was ${overshoot.extendedEntries} entries further back.`);
}

const cutEntry = entries[cut];
const report = {
  newSessionId: newId,
  path: outPath,
  keptEntries: kept.length,
  totalEntries: lines.length,
  estTokens: keptEst,
  targetTokens: target,
  ...(overshoot ? { overshoot } : {}),
  harnessDropped: dropped,
  tornLines: torn,
  relinked,
  usageStripped,
  cutAt: cutEntry?.timestamp ?? null,
  cutPrompt: String(cutEntry?.message?.content ?? '').slice(0, 120),
};
if (dry) {
  report.dry = true;
} else {
  writeFileSync(outPath, out);
}
console.log(JSON.stringify(report, null, 2));
