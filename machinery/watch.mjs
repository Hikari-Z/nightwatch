#!/usr/bin/env node
/**
 * The stuck/spiral watch: notices when an agent this hub runs is stuck, and
 * says so. Notify-only by design: it never folds, kills, pokes or writes to a
 * session. Its own daemon per hub (launchd label house.nightwatch.<slug>.watch),
 * apart from nightshift, so a fault here can never touch the bell or the wake.
 *
 * What counts (every signature is a real transcript's, surveyed 10/8 across
 * 323 transcripts on Weft's machine):
 *   spiral      two or more API-error lines inside watch.spiralWindowMs with
 *               the newest still an error. Each line is a turn that already
 *               used up Claude Code's ~10 automatic retries, so two is ~20
 *               failures (Ra's calibration, 9/30). Most bursts are cold-cache
 *               recomputes after a quiet gap, which one short message usually
 *               clears.
 *   too-long    "Prompt is too long": the session can't take any prompt, so
 *               messages and the sleep bell can't reach it.
 *   login       the login expired ("OAuth session expired", "Please run /login").
 *   usage-limit the account's usage limit.
 *   offline     "Unable to connect to API" / "Can't reach the API server".
 *   slept       "Your computer went to sleep mid-response".
 *   classifier  watch.classifierThreshold auto-mode classifier denials inside
 *               watch.classifierWindowMs.
 *   context     the newest reply's input side at watch.contextWarn of the
 *               model's window (re-arms below watch.contextRearm).
 *   waiting     the session's status file says 'waiting' (a permission prompt
 *               or a question) for watch.waitingMs.
 *
 * Which sessions: Claude Code's live status files (paths.sessions), kept to
 * the ones THIS hub's registry knows (wakecycle/lane.<sessionId>), and not
 * already folded. A session stuck on a prompt or a usage limit stops writing
 * its transcript, so status files, not transcript age, say what's alive.
 *
 * Where an alert goes: always the hub's event stream (the app's alert cards:
 * kinds spiral-alarm, stuck, stuck-cleared), then the notifier (config
 * notify.*): a macOS Notification Center banner, and/or notify.command, an
 * executable run with the message on stdin and NIGHTWATCH_ALERT_* in its
 * environment. Each stuck state is an episode: one alert when it starts, one
 * stuck-cleared event when it ends while the session lives. Episodes persist
 * (paths.watchState), so a restart doesn't re-announce anything.
 *
 * Wake cost (incident fix 4, 10/9): for each recent fold, the watch finds the
 * session woken from its tail (a session this hub registered after the fold
 * whose transcript carries the tail's entries, whichever path woke it) and
 * records that session's first real request beside the fold's estimate: one
 * row in paths.wakeCosts and one `wake-cost` event, fields {at, lane, tail,
 * session, source, estTokens, firstRequestTokens}. Every night then measures
 * the trimmer's estimate against what the harness actually sent.
 *
 * Run: WEFT_CONFIG=<hub config> node watch.mjs [--once]
 *
 * Written by: claude-opus-5-5, 2026-10-09, from weft's watch-spiral.mjs
 * (claude-fable-5 and claude-opus-5-5, 9/30–10/8). Left behind on purpose: the
 * fill bell (transcript bytes as a fill gauge, which the context cause now
 * measures from real usage, and a headless relay pass the house retired) and
 * the cwd-based lane guess (the registry is the only attribution).
 */
import { readFileSync, readdirSync, statSync, appendFileSync, writeFileSync, renameSync, openSync, readSync, closeSync } from 'node:fs';
import { notifyBanner } from './platform.mjs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';

const CFG = loadConfig();
const W = CFG.watch;
const P = CFG.paths;
const ONCE = process.argv.includes('--once');
const TAIL_BYTES = 2 * 1024 * 1024;
const TAIL_LINES = 400;

function log(line) {
  const out = `${new Date().toISOString()} ${line}`;
  console.log(out);
  try { appendFileSync(P.watchLog, out + '\n'); } catch {}
}

function emit(event) {
  try { appendFileSync(P.events, JSON.stringify(event) + '\n'); } catch (e) { log(`event write failed: ${e.message}`); }
}

// ── who an alert is about ────────────────────────────────────────────────
// Words for people: "agent", never "lane", and no pronouns the agent didn't
// choose (Ra, 10/8). A named persona with several agents reads "Weft (opus)";
// a single-agent hub reads just its name.
function agentLabel(lane) {
  const name = CFG.persona?.name;
  const several = Object.keys(CFG.lanes ?? {}).length > 1;
  if (name) return several ? `${name} (${lane})` : name;
  return `the ${lane} agent`;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ── notifier ─────────────────────────────────────────────────────────────
const pending = [];

function notify(alert) {
  // notify.macos keeps its name for existing configs; it means "native
  // banner on this platform" (platform.mjs picks the mechanism per OS).
  if (CFG.notify?.macos) {
    for (const child of notifyBanner({ title: alert.title, text: alert.text })) {
      child.on('error', (e) => log(`banner failed: ${e.message}`));
    }
  }
  const cmd = CFG.notify?.command;
  if (!cmd) return;
  pending.push(new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, [], {
        stdio: ['pipe', 'ignore', 'pipe'],
        env: {
          ...process.env,
          NIGHTWATCH_ALERT_KIND: alert.kind, NIGHTWATCH_ALERT_CAUSE: alert.cause ?? '',
          NIGHTWATCH_ALERT_LANE: alert.lane, NIGHTWATCH_ALERT_SESSION: alert.session,
          NIGHTWATCH_ALERT_TITLE: alert.title, NIGHTWATCH_PERSONA: CFG.persona?.name ?? '',
        },
      });
    } catch (e) { log(`notify command failed to start: ${e.message}`); return resolve(); }
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 30_000);
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); log(`notify command failed: ${e.message}`); resolve(); });
    child.on('close', (code) => {
      clearTimeout(timer);
      log(code === 0 ? `notified (${alert.kind}${alert.cause ? `: ${alert.cause}` : ''}) for ${alert.session.slice(0, 8)}…`
        : `notify command exited ${code}${err ? `: ${err.trim().slice(0, 200)}` : ''}; the event card still stands`);
      resolve();
    });
    child.stdin.on('error', () => {});
    child.stdin.end(alert.text);
  }));
}

// ── reading sessions ─────────────────────────────────────────────────────
/** The newest TAIL_LINES entries, reading only the file's last TAIL_BYTES. */
function tailEntries(path) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return []; }
  try {
    const size = statSync(path).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let lines = buf.toString('utf8').split('\n');
    if (len < size) lines = lines.slice(1); // the first line is cut
    const out = [];
    for (const l of lines.filter((x) => x.trim()).slice(-TAIL_LINES)) { try { out.push(JSON.parse(l)); } catch {} }
    return out;
  } finally { closeSync(fd); }
}

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

function foldedSessions() {
  const out = new Set();
  let text = '';
  try { text = readFileSync(P.folds, 'utf8'); } catch { return out; }
  for (const l of text.split('\n')) {
    try {
      const f = JSON.parse(l);
      // A fold's source is the session it closed; its tail is a copy no live
      // window ever runs as (wakes fork it to a fresh id).
      if (f.source?.startsWith('jsonl:')) out.add(f.source.slice(6));
      if (f.tail) out.add(f.tail);
    } catch {}
  }
  return out;
}

function liveSessions() {
  const out = [];
  let names = [];
  try { names = readdirSync(P.sessions).filter((f) => f.endsWith('.json')); } catch { return out; }
  const folded = foldedSessions();
  for (const f of names) {
    let d; try { d = JSON.parse(readFileSync(join(P.sessions, f), 'utf8')); } catch { continue; }
    if (!d?.sessionId || !d.pid || !pidAlive(d.pid)) continue;
    if (d.kind && d.kind !== 'interactive') continue;
    if (folded.has(d.sessionId)) continue;
    let lane = null;
    try { lane = JSON.parse(readFileSync(join(P.wakecycle, `lane.${d.sessionId}`), 'utf8')).lane ?? null; } catch {}
    if (!lane) continue; // not this hub's agent
    out.push({ sid: d.sessionId, lane, status: d.status, statusAt: d.statusUpdatedAt ?? d.updatedAt });
  }
  return out;
}

const textOf = (e) => {
  const c = e?.message?.content;
  return Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : '')).join(' ') : typeof c === 'string' ? c : '';
};

/** The named stuck cause an API-error entry stands for, or null for a plain API error (a spiral's). */
function errorCause(e) {
  const t = textOf(e);
  if (/prompt is too long/i.test(t)) return 'too-long';
  if (e.error === 'authentication_failed' || /OAuth|Login expired|Please run \/login|Failed to authenticate/i.test(t)) return 'login';
  if (e.error === 'rate_limit' && /limit/i.test(t)) return 'usage-limit';
  if (/reached your .{0,40}limit|usage limit/i.test(t)) return 'usage-limit';
  if (/Unable to connect to API|Can't reach the API server|check your internet/i.test(t)) return 'offline';
  if (/went to sleep mid-response/i.test(t)) return 'slept';
  return null;
}

function windowFor(lane, model) {
  const own = CFG.lanes?.[lane]?.contextWindow;
  if (own) return own;
  if (!model) return null;
  if (/haiku/.test(model)) return 200_000;
  if (/^claude-(fable|mythos|opus|sonnet)-/.test(model)) return 1_000_000;
  return null;
}

// ── state ────────────────────────────────────────────────────────────────
// active: `${sid}\u0000${cause}` → episode key; spiral: sid → last alert ms;
// costed: tails whose wake cost is recorded; costSeen: tail → woken transcript mtime last read.
let state = { active: {}, spiral: {}, costed: [], costSeen: {} };
try { state = { ...state, ...JSON.parse(readFileSync(P.watchState, 'utf8')) }; } catch { /* first run */ }
function saveState() {
  try { writeFileSync(P.watchState + '.tmp', JSON.stringify(state)); renameSync(P.watchState + '.tmp', P.watchState); }
  catch (e) { log(`state save failed: ${e.message}`); }
}

// ── the words ────────────────────────────────────────────────────────────
const mins = (ms) => Math.round(ms / 60000);
const STUCK = {
  'too-long': (a) => ['Too full to answer', `${cap(a)} can't take any prompt ("Prompt is too long"), so messages and the sleep bell can't reach the session. Force fold on the agent's card folds from the last session that actually ran and opens a fresh window. If the fresh window says the same, run /clear there.`],
  login: (a) => ['Logged out', `${cap(a)} is logged out (the login expired). Nothing can happen until someone runs /login in the agent's window.`],
  'usage-limit': (a) => ['Usage limit reached', `${cap(a)} hit the account's usage limit and is stopped until the limit resets or the model is switched (/model).`],
  offline: (a) => ['Can\'t reach the API', `${cap(a)} can't reach the API (connection or DNS). The session retries when the network is back; worth a look if this machine is offline.`],
  slept: (a) => ['Cut off by sleep', `${cap(a)} was cut off mid-reply when this machine went to sleep. A short message in the agent's window resumes the session.`],
  classifier: (a, d) => ['Classifier denials', `${cap(a)} has had ${d.count} tool calls denied by the auto mode classifier in ${mins(W.classifierWindowMs)} minutes${d.reason ? ` (latest: ${d.reason})` : ''}. The session may be circling something; worth a look.`],
  context: (a, d) => ['Context filling up', `${cap(a)} is at ${Math.round(d.ratio * 100)}% of the context window (${Math.round(d.tokens / 1000)}k of ${Math.round(d.window / 1000)}k). Worth a fold at the next good stopping point.`],
  waiting: (a, d) => ['Waiting on you', `${cap(a)} has been waiting for ${mins(d.forMs)} minutes (a permission prompt or a question in the agent's window).`],
};

// ── checks ───────────────────────────────────────────────────────────────
function spiralCheck(now, s, entries) {
  const errors = entries.filter((e) => e.isApiErrorMessage && e.timestamp && now - Date.parse(e.timestamp) < W.spiralWindowMs);
  if (errors.length < W.spiralThreshold) return;
  // Still spiraling? A session that answered since the errors is left alone.
  const newest = [...entries].reverse().find((e) => e.type === 'assistant' || e.type === 'user');
  if (!newest?.isApiErrorMessage) return;
  // A named stuck state is the stuck check's: its advice is the one that helps
  // (a too-full session can't take the short message a spiral wants).
  if (errorCause(newest)) return;
  if (now - (state.spiral[s.sid] ?? 0) < W.spiralCooldownMs) return;
  state.spiral[s.sid] = now;
  const a = agentLabel(s.lane);
  log(`SPIRAL: ${s.lane} (${s.sid.slice(0, 8)}…) — ${errors.length} API errors in ${mins(W.spiralWindowMs)}m, newest still an error`);
  emit({ at: new Date(now).toISOString(), kind: 'spiral-alarm', lane: s.lane, session: s.sid, errors: errors.length, windowMin: mins(W.spiralWindowMs), alarm: true });
  notify({
    kind: 'spiral-alarm', lane: s.lane, session: s.sid, title: 'API errors',
    text: `${cap(a)} has hit ${errors.length} API errors in ${mins(W.spiralWindowMs)} minutes and is still erroring. Usually this is a cold cache after a quiet gap, and one short message in the agent's window gets the session going again. If that doesn't, Force fold on the agent's card closes the window, folds, and opens a fresh one, which writes the rung for the day.`,
  });
}

function stuckCauses(now, s, entries) {
  const causes = new Map();
  if (s.status === 'waiting' && s.statusAt && now - s.statusAt >= W.waitingMs) {
    causes.set('waiting', { key: String(s.statusAt), detail: { forMs: now - s.statusAt } });
  }
  const newest = [...entries].reverse().find((e) => e.type === 'assistant' || e.type === 'user');
  if (newest?.isApiErrorMessage) {
    const cause = errorCause(newest);
    if (cause) causes.set(cause, { key: newest.uuid ?? newest.timestamp ?? 'x', detail: { text: textOf(newest).slice(0, 160) } });
  }
  const denials = [];
  for (const e of entries) {
    if (e.type !== 'user' || !e.timestamp || now - Date.parse(e.timestamp) > W.classifierWindowMs) continue;
    for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (b?.type !== 'tool_result' || !b.is_error) continue;
      const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      if (/denied by the Claude Code auto mode classifier/i.test(t)) denials.push({ at: e.timestamp, reason: (t.match(/Reason:\s*([^\n.]{0,80})/) ?? [])[1] });
    }
  }
  if (denials.length >= W.classifierThreshold) {
    causes.set('classifier', { key: denials[0].at, detail: { count: denials.length, reason: denials[denials.length - 1].reason } });
  }
  const reply = [...entries].reverse().find((e) => e.type === 'assistant' && e.message?.usage && !e.isApiErrorMessage);
  const u = reply?.message?.usage;
  const window = windowFor(s.lane, reply?.message?.model);
  if (u && window) {
    const tokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const ratio = tokens / window;
    const k = `${s.sid}\u0000context`;
    const was = k in state.active;
    if (ratio >= W.contextWarn || (was && ratio >= W.contextRearm)) causes.set('context', { key: was ? state.active[k] : String(now), detail: { ratio, tokens, window } });
  }
  return causes;
}

// ── wake cost (fix 4) ────────────────────────────────────────────────────
const COST_LOOKBACK_MS = 3 * 24 * 3600_000;
/**
 * The file's first `maxLines` complete lines, read in chunks with no byte cap:
 * one transcript entry can be hundreds of KB (a screenshot in a tail's first
 * entries; 448KB measured by Fable on 10/9), and a fixed window would cut it
 * mid-line and silently never cost that wake.
 */
function headLines(path, maxLines) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return []; }
  try {
    const out = [];
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = Buffer.alloc(0);
    let pos = 0;
    while (out.length < maxLines) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n === 0) { if (carry.length) out.push(carry.toString('utf8')); break; }
      pos += n;
      let buf = Buffer.concat([carry, chunk.subarray(0, n)]);
      let nl;
      while (out.length < maxLines && (nl = buf.indexOf(10)) !== -1) { out.push(buf.subarray(0, nl).toString('utf8')); buf = buf.subarray(nl + 1); }
      carry = Buffer.from(buf);
    }
    return out;
  } finally { closeSync(fd); }
}
// The harness writes a few uuid-less metadata lines before the first entry
// (last-prompt, ai-title, mode…), and a forked wake puts the tail's first
// entry within its first handful of lines (index 4 on fae38e0a, 10/9).
const HEAD_LINES = 64;
const firstUuid = (path) => {
  for (const l of headLines(path, HEAD_LINES)) { try { const u = JSON.parse(l).uuid; if (u) return u; } catch {} }
  return null;
};
const headHas = (path, uuid) => headLines(path, HEAD_LINES).some((l) => { try { return JSON.parse(l).uuid === uuid; } catch { return false; } });
const usageTokens = (u) => (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);

function wakeCostCheck(now) {
  let rows = [];
  try { rows = readFileSync(P.folds, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return; }
  const costed = new Set(state.costed);
  // A tail some agent's wake receipt still names stays eligible however old
  // its fold (a vacation hold, a long-disarmed agent); the lookback only
  // retires tails that a later fold has replaced (Fable's read, 10/9).
  const current = new Set();
  try {
    for (const f of readdirSync(P.wakecycle)) {
      if (!/^next-wake\..+\.json$/.test(f)) continue;
      try { const id = JSON.parse(readFileSync(join(P.wakecycle, f), 'utf8')).sessionId; if (id) current.add(id); } catch {}
    }
  } catch {}
  let registry = [];
  try { registry = readdirSync(P.wakecycle).filter((f) => f.startsWith('lane.')).map((f) => ({ sid: f.slice(5), mtime: statSync(join(P.wakecycle, f)).mtimeMs, file: join(P.wakecycle, f) })); } catch { return; }
  for (const row of rows) {
    const foldAt = Date.parse(row.at);
    if (!row.tail || costed.has(row.tail) || !(current.has(row.tail) || now - foldAt < COST_LOOKBACK_MS)) continue;
    const tailPath = join(P.transcripts, `${row.tail}.jsonl`);
    const anchor = firstUuid(tailPath);
    if (!anchor) continue;
    const woken = registry.filter((r) => r.mtime > foldAt && r.sid !== row.tail).sort((a, b) => a.mtime - b.mtime)
      .find((r) => headHas(join(P.transcripts, `${r.sid}.jsonl`), anchor));
    if (!woken) continue;
    const wokenPath = join(P.transcripts, `${woken.sid}.jsonl`);
    let mtime = 0;
    try { mtime = statSync(wokenPath).mtimeMs; } catch { continue; }
    if (state.costSeen[row.tail] === mtime) continue; // nothing new since the last read
    state.costSeen[row.tail] = mtime;
    const copied = new Set();
    try { for (const l of readFileSync(tailPath, 'utf8').split('\n')) { try { const u = JSON.parse(l).uuid; if (u) copied.add(u); } catch {} } } catch { continue; }
    let first = null;
    for (const l of readFileSync(wokenPath, 'utf8').split('\n')) {
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.type !== 'assistant' || copied.has(e.uuid) || e.isApiErrorMessage) continue;
      const t = usageTokens(e.message?.usage);
      if (t > 0) { first = { at: e.timestamp, tokens: t }; break; }
    }
    if (!first) continue; // no real reply yet (or a dead wake: deadwake.mjs's business)
    let lane = null;
    try { lane = JSON.parse(readFileSync(woken.file, 'utf8')).lane ?? null; } catch {}
    const record = { at: first.at, lane, tail: row.tail, session: woken.sid, source: row.source ?? null, estTokens: row.est_tokens ?? null, firstRequestTokens: first.tokens };
    try { appendFileSync(P.wakeCosts, JSON.stringify(record) + '\n'); } catch (e) { log(`wake-cost write failed: ${e.message}`); continue; }
    emit({ ...record, kind: 'wake-cost' });
    log(`WAKE COST: ${lane ?? '?'} woke from ${row.tail.slice(0, 8)}… as ${woken.sid.slice(0, 8)}…: first request ${first.tokens} tokens, fold estimated ${row.est_tokens ?? '?'}`);
    state.costed.push(row.tail);
    delete state.costSeen[row.tail];
  }
  state.costed = state.costed.slice(-200);
}

function check() {
  const now = Date.now();
  const before = JSON.stringify(state);
  const live = liveSessions();
  const seen = new Set();
  for (const s of live) {
    const entries = tailEntries(join(P.transcripts, `${s.sid}.jsonl`));
    spiralCheck(now, s, entries);
    for (const [cause, { key, detail }] of stuckCauses(now, s, entries)) {
      const k = `${s.sid}\u0000${cause}`;
      seen.add(k);
      if (state.active[k] === key) continue; // this episode is already told
      state.active[k] = key;
      log(`STUCK: ${s.lane} (${s.sid.slice(0, 8)}…) — ${cause}`);
      emit({ at: new Date(now).toISOString(), kind: 'stuck', cause, lane: s.lane, session: s.sid, ...detail, alarm: true });
      const [title, text] = STUCK[cause](agentLabel(s.lane), detail);
      notify({ kind: 'stuck', cause, lane: s.lane, session: s.sid, title, text });
    }
  }
  // An episode that ended while its session lives gets a clear; a gone
  // session's episodes lapse (its window closing ends the card).
  const liveSids = new Set(live.map((s) => s.sid));
  for (const k of Object.keys(state.active)) {
    if (seen.has(k)) continue;
    const [sid, cause] = k.split('\u0000');
    delete state.active[k];
    if (!liveSids.has(sid)) continue;
    const lane = live.find((s) => s.sid === sid)?.lane;
    log(`STUCK cleared: ${lane} (${sid.slice(0, 8)}…) — ${cause}`);
    emit({ at: new Date(now).toISOString(), kind: 'stuck-cleared', cause, lane, session: sid });
  }
  for (const sid of Object.keys(state.spiral)) if (!liveSids.has(sid)) delete state.spiral[sid];
  try { wakeCostCheck(now); } catch (e) { log(`wake-cost check failed: ${e.message}`); }
  if (JSON.stringify(state) !== before) saveState();
}

log(`watch up — ${CFG.__configFile ?? 'defaults'}; poll ${W.pollMs / 1000}s; notify: ${[CFG.notify?.macos && 'banner', CFG.notify?.command && 'command'].filter(Boolean).join(' + ') || 'events only'}`);
check();
if (ONCE) {
  await Promise.all(pending);
} else {
  setInterval(() => { try { check(); } catch (e) { log(`check failed: ${e.stack ?? e.message}`); } }, W.pollMs);
}
