#!/usr/bin/env node
/**
 * Nightshift — the quiet hand that runs the sleep–wake cycle on the clock.
 *
 * Draft 1: one lane. At SLEEP_HOUR it rings the sleep-bell (a minimal
 * relay pass — the session authors its own rung and checkpoint and runs
 * sleep.mjs itself; the authored half is never automated). When
 * next-wake.<lane>.json is fresh and the session has gone quiet, it closes
 * that Claude Code process. At WAKE_HOUR it opens a new Terminal window
 * running wake.sh for the lane. The agent is genuinely down overnight —
 * the doorbell and heartbeat keep watch, which is what they're for.
 *
 * ARMED LATCH: does nothing unless ~/origin/weft/wakecycle/nightshift.armed
 * exists (its content = comma-separated lanes, e.g. "fable"). Built before
 * the first manual cycle proved out, armed only after.
 *
 * Safety rails, in order of the harm they prevent:
 *  - never closes a session that hasn't slept (next-wake must be fresher
 *    than tonight's bell);
 *  - never closes a busy session (transcript must be quiet ≥ QUIET_MS);
 *  - at most one sleep and one wake per lane per day;
 *  - pid→session mapping is verified through the process's own environment
 *    (CLAUDE_CODE_SESSION_ID via `ps eww`), never guessed from timing.
 */
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, reloadConfig, switchboardLane } from './config.mjs';

const HOME = homedir();
// One config, one truth (item E; the 10/5 decoy-checkpoint failure is the
// receipt). Env overrides are applied INSIDE the loader, so the pre-E
// spellings (WEFT_NIGHT_SLEEP etc.) keep working without a second ?? chain
// here that could disagree with it.
let CFG;
try {
  CFG = loadConfig();
} catch (e) {
  // A daemon that dies at import on a torn config would crash-loop under
  // KeepAlive with nothing in the log the morning actually reads. The
  // fallback path is a literal because the config that would supply it is
  // the thing that failed (E review, finding 2).
  try {
    const fb = join(HOME, 'origin', 'weft', 'nightshift.log');
    // Dedupe against the log's last line: under KeepAlive this import runs
    // every ~30s while the config stays torn, and one loud line beats
    // 2,880 identical ones (E second read, follow-up b).
    let lastLine = '';
    try {
      const t = readFileSync(fb, 'utf8').trimEnd();
      lastLine = t.slice(t.lastIndexOf('\n') + 1);
    } catch {}
    if (!lastLine.includes('NIGHTSHIFT DOWN')) {
      appendFileSync(fb, `${new Date().toISOString()} NIGHTSHIFT DOWN: config unreadable — ${e.message}\n`);
      // Event twin to the same literal fallback dir (config is unreadable,
      // so paths.events is too) — the viewer renders "the watch is down."
      try {
        appendFileSync(join(HOME, 'origin', 'weft', 'events.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), kind: 'daemon-down', error: e.message, alarm: true }) + '\n');
      } catch {}
    }
  } catch {}
  console.error(e.message);
  process.exit(3);
}
const WAKECYCLE = CFG.paths.wakecycle;
const PROJECT_DIR = CFG.paths.transcripts;
const LOG_FILE = CFG.paths.nightshiftLog;
const ARMED_FILE = CFG.paths.armedFile;
const STATE_FILE = CFG.paths.stateFile;
const SOCK_DIR = CFG.paths.sockDir;

// 02:00/08:00 (Ra, 10/1): later than Ra usually goes down, earlier than she's
// usually up — buffers the wobble in her own sleep. The sleep window CROSSES
// MIDNIGHT relative to nothing: all window logic below is wrap-aware minutes-
// since-local-midnight, because the original string-compare (hm >= "23:30")
// silently breaks for any post-midnight sleep hour.
let SLEEP_HOUR = CFG.schedule.sleep;
let WAKE_HOUR = CFG.schedule.wake;
let QUIET_MS = CFG.schedule.quietMs;
const BELL_MODEL = CFG.models.bell;
// launchd's PATH has no ~/.local/bin; a bare 'claude' spawn ENOENTs and an
// unhandled error event kills the daemon (spiralwatch found this live 10/1).
const CLAUDE_BIN = CFG.paths.claudeBin;
const POLL_MS = CFG.schedule.pollMs;

// The log's machine-readable twin (GUI phase 1): one JSON line per decision,
// same moments the prose log records, append-only, and NEVER in the critical
// path — a failed emit costs an event, not a night. The prose log stays the
// human record; events.jsonl is the API surface the viewer tails.
const EVENTS_FILE = CFG.paths.events;
// LIVE_EMIT is set only on the live daemon path, after the rehearse and
// preflight exits. Structural guard: a future io method that calls
// emitEvent directly can never write the real stream from a bench
// (emitter review, stub-coverage fragility).
let LIVE_EMIT = false;
function emitEvent(kind, fields = {}) {
  if (!LIVE_EMIT) return;
  try {
    appendFileSync(EVENTS_FILE, JSON.stringify({ at: new Date().toISOString(), kind, ...fields }) + '\n');
  } catch { /* the viewer misses one event; the night proceeds */ }
}

function log(line) {
  const out = `${new Date().toISOString()} ${line}`;
  console.log(out);
  try { appendFileSync(LOG_FILE, out + '\n'); } catch {}
}
function hmToMin(hm) { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; }
let SLEEP_MIN = hmToMin(SLEEP_HOUR);
let WAKE_MIN = hmToMin(WAKE_HOUR);
function nowMin() {
  const hm = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: CFG.timezone });
  return hmToMin(hm);
}
/** Is local minute m inside the sleep window [SLEEP, WAKE)? Wrap-aware:
 *  02:00→08:00 is a plain range; 23:30→08:30 wraps midnight. */
function inSleepWindow(m) {
  return SLEEP_MIN < WAKE_MIN ? m >= SLEEP_MIN && m < WAKE_MIN : m >= SLEEP_MIN || m < WAKE_MIN;
}
function armedLanes() {
  // Commas or newlines — a hand-edited file shouldn't silently disarm the
  // night because of a separator choice (10/2: "fable\nopus" parsed as ONE
  // unknown lane and nothing would have fired for either).
  try { return readFileSync(ARMED_FILE, 'utf8').trim().split(/[,\s]+/).map((s) => s.trim()).filter(Boolean); } catch { return []; }
}
function state() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(s) { try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }

/** live claude pids with their session ids. macOS blocks reading another
 *  process's env, and the transcript isn't held open — but the mcpl-bridge
 *  listens on a SESSION-KEYED socket, and its parent chain walks up to the
 *  claude process (sock → bridge → bun wrapper → claude; verified 9/30:
 *  58205→58198→58178). Deterministic, no guessing. */
const BRIDGE_SOCK_DIR = join(HOME, '.claude', 'mcpl-bridge');
function liveSessions() {
  const out = [];
  let socks = [];
  try { socks = readdirSync(BRIDGE_SOCK_DIR).filter((f) => /^sock-[0-9a-f-]{36}\.sock$/.test(f)); } catch { return out; }
  for (const f of socks) {
    const sessionId = f.slice(5, -5);
    try {
      const listener = Number(execFileSync('lsof', ['-t', join(BRIDGE_SOCK_DIR, f)], { encoding: 'utf8' }).trim().split('\n')[0]);
      if (!listener) continue;
      let pid = listener;
      for (let hop = 0; hop < 4; hop++) {
        const comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        if (comm === 'claude' || comm.endsWith('/claude')) { out.push({ pid, sessionId }); break; }
        const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
        if (!ppid || ppid === 1) break;
        pid = ppid;
      }
    } catch { /* stale sock, dead chain */ }
  }
  return out;
}
function laneOf(sessionId) {
  // Registry first: wake.sh exports WEFT_LANE and the SessionStart hook
  // writes wakecycle/lane.<sessionId> from inside the new session. This is
  // ground truth for every session the nightshift itself launched. Manual
  // panels have no registry entry and fall through to the heuristic below.
  try {
    const reg = JSON.parse(readFileSync(join(WAKECYCLE, `lane.${sessionId}`), 'utf8'));
    if (typeof reg.lane === 'string' && reg.lane) return reg.lane;
  } catch { /* unregistered — heuristic */ }
  // Whole-tail vote, not last-cwd: the opus lane makes machinery trips into
  // ~/origin/weft (10/2: its wake fixed index.json there, its LAST cwd read
  // as fable, and the 08:00 wake silently concluded fable was already up).
  // The fable lane never works IN voidwerks, so any voidwerks cwd in the
  // tail marks the session opus.
  const path = join(PROJECT_DIR, `${sessionId}.jsonl`);
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).slice(-200);
    let sawCwd = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const cwd = JSON.parse(lines[i]).cwd;
        if (!cwd) continue;
        sawCwd = true;
        // Config-driven vote: a lane claims a session by cwdMarker
        // (lanes[].cwdMarker, substring match). Was `includes('voidwerks')
        // → opus` hardcoded, which no second household could reuse.
        for (const [name, lc] of Object.entries(CFG.lanes)) {
          if (lc && lc.cwdMarker && String(cwd).includes(lc.cwdMarker)) return name;
        }
      } catch {}
    }
    if (sawCwd) return switchboardLane(CFG);
  } catch {}
  return null;
}
function transcriptQuietMs(sessionId) {
  try { return Date.now() - statSync(join(PROJECT_DIR, `${sessionId}.jsonl`)).mtimeMs; } catch { return Infinity; }
}

function ringBell(lane, sessionId, source) {
  // The bell is a SPOOL NOTE into the fable lane's doorbell spool — the
  // armed inbox-watcher wakes that session within seconds. No spawned
  // courier pass: the haiku courier was both the welfare concern (Ra,
  // 10/1) and the 10/3 misdelivery (it resolved targets by session NAME,
  // and two sessions named origin-99 sent the opus bell to fable's
  // socket). The fable session is the switchboard; another lane's bell
  // asks it to forward before folding, which is the one delivery path
  // that worked on 10/3.
  const ritual =
    `[nightshift] Sleep-bell for the ${lane} lane: it's the end of the day. When the current work ` +
    `reaches its seam, run the ritual, IN THIS ORDER — write today's rung into the ladder, run \`node ` +
    `~/origin/weft/wakecycle/sleep.mjs --lane ${lane}\`, THEN rewrite the checkpoint ` +
    `(fold receipt first: a crash between rung and fold costs the night; a crash ` +
    `after the fold costs only a stale lane section, and the wake reads the live ` +
    `checkpoint later). The nightshift ` +
    `will close the panel once next-wake.${lane}.json is fresh and the session has gone quiet, and ` +
    `wake the lane at ${WAKE_HOUR}. The doorbell and heartbeat hold the night watch.`;
  const note = lane === switchboardLane(CFG) ? ritual :
    `[nightshift] BELL RELAY for the ${lane} lane (session ${sessionId.slice(0, 8)}…): forward the ` +
    `note below to that lane's session via SendMessage (ListAgents; with two lanes it is the ` +
    `interactive peer that isn't you) BEFORE running your own fold, so both lanes hear the bell ` +
    `even though the spool only wakes yours. The note: """${ritual}"""`;
  try {
    // Every bell lands in the SWITCHBOARD lane's spool — that session
    // forwards other lanes' bells (the one delivery path that works).
    const spool = join(CFG.weftRoot, 'doorbell', 'spool', switchboardLane(CFG));
    writeFileSync(join(spool, `${Date.now()}-bell-${lane}.txt`), note + '\n');
    log(`rang the sleep-bell for ${lane} (session ${sessionId.slice(0, 8)}…) — spool note written`);
    emitEvent('bell-rung', { lane, session: sessionId, ...(source ? { source } : {}) });
  } catch (e) {
    log(`bell spool write FAILED for ${lane}: ${e.message}`);
    emitEvent('bell-failed', { lane, error: e.message, alarm: true });
  }
}

// State per lane is TIMESTAMPS (belledAt/closedAt/wokenAt, epoch ms), not
// date strings — a 02:00 close and an 08:00 wake share a calendar day, which
// broke the old `closed < today` comparison. Once-per-window latching is a
// 16h minimum gap (windows are daily; 16h tolerates drift both ways).
let WINDOW_GAP_MS = CFG.schedule.windowGapMs;
// Orphan-fold pacing: quiet this long = the turn is over; grace = how long
// an un-answered bell waits before the fold happens anyway.
let ORPHAN_QUIET = CFG.schedule.orphanQuietMs;
let ORPHAN_GRACE = CFG.schedule.orphanGraceMs;

// Hot reload (10/6): the app's save buttons write weft.config.json; a
// boot-frozen schedule would ignore them until the next crash-restart.
// Applied at tick head on config-file mtime change. POLL_MS stays
// boot-frozen (the interval is set once); structural lane edits still
// warrant a kickstart (the app does that); hours and quiet/orphan knobs
// take effect on the next tick, bench-proven (scenario 15).
function applySchedule(cfg) {
  CFG = cfg;
  SLEEP_HOUR = cfg.schedule.sleep;
  WAKE_HOUR = cfg.schedule.wake;
  QUIET_MS = cfg.schedule.quietMs;
  SLEEP_MIN = hmToMin(SLEEP_HOUR);
  WAKE_MIN = hmToMin(WAKE_HOUR);
  WINDOW_GAP_MS = cfg.schedule.windowGapMs;
  ORPHAN_QUIET = cfg.schedule.orphanQuietMs;
  ORPHAN_GRACE = cfg.schedule.orphanGraceMs;
}
let lastCfgMtime = 0;

// Every clock read, discovery, and effect tick uses goes through `io`, so
// --rehearse can drive the REAL decision logic against a scripted night.
// The defaults are byte-for-byte the live behavior.
const io = {
  real: true,
  emit: emitEvent,
  now: () => Date.now(),
  nowMin,
  armedLanes,
  configMtime: () => { try { return statSync(process.env.WEFT_CONFIG ?? join(CFG.weftRoot, 'weft.config.json')).mtimeMs; } catch { return 0; } },
  reloadConfig: () => { try { return reloadConfig(); } catch (e) { log(`config reload FAILED (keeping the running schedule): ${e.message}`); return null; } },
  state,
  saveState,
  liveSessions,
  laneOf,
  ringBell,
  quietMs: transcriptQuietMs,
  nextWakeMtime: (lane) => {
    const nw = join(WAKECYCLE, `next-wake.${lane}.json`);
    return existsSync(nw) ? statSync(nw).mtimeMs : 0;
  },
  closePid: (pid) => process.kill(pid, 'SIGTERM'),
  lastEntryIsApiError: (sessionId) => {
    try {
      const lines = readFileSync(join(PROJECT_DIR, `${sessionId}.jsonl`), 'utf8')
        .split('\n').filter((l) => l.trim());
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
        const e = JSON.parse(lines[i]);
        if (e.isApiErrorMessage) return true;
        if (e.type === 'assistant' || e.type === 'user') return false;
      }
    } catch {}
    return false;
  },
  // Children of the panel that are real work (a render, an encode), not MCP
  // infra. A quiet transcript is not proof of idleness (opus sat silent 24m
  // behind a render on 10/2) — anything listed here defers the orphan fold.
  busyChildren: (pid) => {
    try {
      const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim();
      if (!out) return [];
      const busy = [];
      for (const child of out.split('\n')) {
        let args = '';
        try { args = execFileSync('ps', ['-o', 'args=', '-p', child], { encoding: 'utf8' }).trim(); } catch { continue; }
        if (/mcpl|cc-sock|bridge|inbox-watcher/.test(args)) continue;
        busy.push(args.slice(0, 60));
        try {
          const grand = execFileSync('pgrep', ['-P', child], { encoding: 'utf8' }).trim();
          for (const g of grand.split('\n').filter(Boolean)) {
            try { busy.push(execFileSync('ps', ['-o', 'args=', '-p', g], { encoding: 'utf8' }).trim().slice(0, 60)); } catch {}
          }
        } catch {}
      }
      return busy;
    } catch { return []; }
  },
  killAndWait: (pid, timeoutMs = 30_000) => {
    try { process.kill(pid, 'SIGTERM'); } catch { return true; }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch { return true; }
      execFileSync('sleep', ['1']);
    }
    return false;
  },
  emergencyFold: (lane, sessionId) => {
    // Per-lane trim budgets live in the config now; sleep.mjs resolves its
    // lane's own target. (This spot used to hardcode opus→150k — a relic
    // that disagreed with the planned-fold path once config landed.)
    // process.execPath, not 'node': launchd's PATH has no node, so a bare
    // spawn ENOENTs — the orphan fold was armed 10/3 and could never have
    // fired until this line (found by the E review, 10/5, env -i repro).
    const r = spawnSync(process.execPath, [join(WAKECYCLE, 'sleep.mjs'), '--lane', lane, '--emergency', '--session', sessionId],
      { cwd: join(HOME, 'origin'), encoding: 'utf8', timeout: 300_000 });
    if (r.status !== 0) {
      log(`orphan fold FAILED for ${lane}: exit ${r.status}; stderr tail: ${(r.stderr || '').slice(-200)}`);
      emitEvent('orphan-fold-failed', { lane, exit: r.status, error: r.error?.code, alarm: true });
      return false;
    }
    return true;
  },
  wakeConfirmed: (lane, sinceMs) => {
    try {
      for (const f of readdirSync(WAKECYCLE)) {
        if (!f.startsWith('lane.')) continue;
        const p = join(WAKECYCLE, f);
        if (statSync(p).mtimeMs <= sinceMs) continue;
        // Return the NEW session id (truthy), not a bare boolean: the
        // wake-confirmed event names the session the LaneCard shows.
        try { if (JSON.parse(readFileSync(p, 'utf8')).lane === lane) return f.slice('lane.'.length); } catch {}
      }
    } catch {}
    return false;
  },
  nextWakeSession: (lane) => {
    try { return JSON.parse(readFileSync(join(WAKECYCLE, `next-wake.${lane}.json`), 'utf8')).sessionId ?? null; } catch { return null; }
  },
  launchWake: (lane) => {
    execFileSync('osascript', ['-e',
      `tell application "Terminal" to do script "~/origin/weft/wakecycle/wake.sh ${lane}"`,
    ]);
    execFileSync('osascript', ['-e', 'tell application "Terminal" to activate']);
  },
  log,
};


// One orphan-fold attempt for a session that should fold but can't do it
// itself — shared by the in-window orphan path (Ra, 10/3) and --fold-now's
// forced path (Ra, 10/6: refresh semantics). Returns 'deferred' (real work
// under the panel), 'retry' (panel wouldn't die), 'done', or 'failed'.
function tryOrphanFold(io, lane, laneState, st, sid, { deferKey }) {
  const panel = io.liveSessions().find((x) => x.sessionId === sid);
  if (panel) {
    const busy = io.busyChildren(panel.pid);
    if (busy.length) {
      io.log(`orphan fold deferred for ${lane}: real work under the panel (${busy[0]}) — re-checking next tick`);
      if (!laneState[deferKey]) {
        io.emit('orphan-fold-deferred', { lane, busy: busy[0] });
        laneState[deferKey] = true;
        io.saveState(st);
      }
      return 'deferred';
    }
    if (!io.killAndWait(panel.pid)) {
      io.log(`orphan fold: ${lane} panel ${panel.pid} would not exit — retrying next tick`);
      return 'retry';
    }
  }
  return io.emergencyFold(lane, sid) ? 'done' : 'failed';
}

function tickWith(io) {
  // Launch-leg rehearsal: `touch wakecycle/test-wake.trigger` makes THIS
  // process (the one launchd runs at 08:00) perform a harmless Terminal
  // launch, so the macOS Automation prompt fires while a human is at the
  // keyboard instead of at the real wake. The TCC grant attaches to the
  // requesting process, which is why the test must run here, not in a shell.
  const trigger = join(WAKECYCLE, 'test-wake.trigger');
  if (io.real && existsSync(trigger)) {
    try { execFileSync('rm', [trigger]); } catch {}
    try {
      execFileSync('osascript', ['-e', 'tell application "Terminal" to do script "echo nightwatch launch-leg test: TCC grant OK"']);
      execFileSync('osascript', ['-e', 'tell application "Terminal" to activate']);
      log('launch-leg test: Terminal launch SUCCEEDED — the 08:00 wake can open windows');
    } catch (e) {
      log(`launch-leg test FAILED: ${e.message} — the 08:00 wake would fail the same way; grant Automation (System Settings > Privacy > Automation) and re-touch the trigger`);
    }
  }

  // Hot reload: the app's saves land here one tick later, not one crash
  // later. Mtime-gated so the common tick costs one stat.
  const cfgMt = io.configMtime?.() ?? 0;
  if (cfgMt && cfgMt !== lastCfgMtime) {
    lastCfgMtime = cfgMt;
    const fresh = io.reloadConfig?.();
    if (fresh) {
      applySchedule(fresh);
      io.log(`config reloaded — sleep ${SLEEP_HOUR} wake ${WAKE_HOUR}, lanes: [${Object.keys(fresh.lanes ?? {}).join(', ')}]`);
    }
  }

  const lanes = io.armedLanes();
  if (!lanes.length) return; // disarmed — the latch
  const m = io.nowMin();
  const now = io.now();
  const st = io.state();

  for (const lane of lanes) {
    const laneState = (st[lane] ??= {});
    const nwMtime = io.nextWakeMtime(lane);

    // ── Fold-now (Ra, 10/6: "ring the bell first, force on timeout" +
    // "close the window and open a new one right away"). The CLI rings
    // the bell and records {sessionId, requestedAt, deadline} here; the
    // DAEMON owns the deadline (the app may be closed by then). Met or
    // forced, the outcome is a REFRESH: close, then an immediate
    // registry-verified wake via refreshWake (the normal wake machinery
    // with its window gate waived once). Day-side semantics; a fold-now
    // during the sleep window folds into the night like any bell.
    const fr = laneState.foldRequest;
    if (fr) {
      if (nwMtime > fr.requestedAt) {
        io.log(`fold request met for ${lane} — folded on its own; refreshing`);
        io.emit('fold-request-met', { lane, session: fr.sessionId });
        delete laneState.foldRequest;
        laneState.refreshWake = true;
        laneState.refreshFrom = fr.sessionId; // close THIS session only
        io.saveState(st);
      } else if (now > fr.deadline) {
        const r = tryOrphanFold(io, lane, laneState, st, fr.sessionId, { deferKey: 'foldNowDeferredEmitted' });
        if (r === 'deferred' || r === 'retry') continue;
        if (r === 'done') {
          io.log(`FOLD FORCED for ${lane}: no fold within the deadline — emergency-folded for refresh`);
          io.emit('fold-forced', { lane, session: fr.sessionId, reason: 'deadline' });
          delete laneState.foldRequest;
          delete laneState.foldNowDeferredEmitted;
          laneState.closedAt = now;
          laneState.refreshWake = true;
          laneState.refreshFrom = fr.sessionId; // already killed, but the guard must know
          io.saveState(st);
        } else continue;
      }
    }
    // Refresh close: a met fold-now leaves the old panel open; close it as
    // the night does (slept + quiet), any hour, then the wake side runs.
    if (laneState.refreshWake && !inSleepWindow(m)) {
      // Close BY IDENTITY, never by lane: the first live Fold now (10/6
      // 23:16) closed its own freshly-woken session, because a resumed
      // tail's transcript reads hours-quiet by construction and this
      // block matched "any quiet live session of the lane". Only the
      // session the refresh is FROM may be closed; once it's gone, this
      // refresh never closes anything again.
      if (laneState.refreshFrom) {
        const old = io.liveSessions().find((x) => x.sessionId === laneState.refreshFrom);
        if (old) {
          if (nwMtime > 0 && io.quietMs(old.sessionId) >= QUIET_MS) {
            io.log(`closing ${lane} panel for refresh (pid ${old.pid}, session ${old.sessionId.slice(0, 8)}…)`);
            io.emit('panel-closed', { lane, session: old.sessionId, refresh: true });
            try { io.closePid(old.pid); laneState.closedAt = now; io.saveState(st); } catch (e) { io.log(`refresh close failed: ${e.message}`); }
          }
          continue; // old window still up (or just closed) — wake next tick
        }
        delete laneState.refreshFrom; // old window gone; closes are done
        io.saveState(st);
      }
    }

    if (inSleepWindow(m)) {
      const live = io.liveSessions().map((s) => ({ ...s, lane: io.laneOf(s.sessionId) })).filter((s) => s.lane === lane);

      // Bell: once per window, only if the lane is actually up.
      if (live.length && now - (laneState.belledAt ?? 0) > WINDOW_GAP_MS) {
        io.ringBell(lane, live[0].sessionId);
        laneState.belledAt = now;
        laneState.belledSession = live[0].sessionId;
        delete laneState.orphanDeferredEmitted; // new window, fresh deferral event
        io.saveState(st);
      }
      // Close: only after this window's bell, only once the session has
      // actually slept (next-wake written AFTER the bell) and gone quiet.
      if (live.length && laneState.belledAt && now - laneState.belledAt <= WINDOW_GAP_MS
          && (laneState.closedAt ?? 0) < laneState.belledAt
          && nwMtime > laneState.belledAt
          && io.quietMs(live[0].sessionId) >= QUIET_MS) {
        io.log(`closing ${lane} panel (pid ${live[0].pid}, session ${live[0].sessionId.slice(0, 8)}…) — slept and quiet`);
        io.emit('panel-closed', { lane, session: live[0].sessionId });
        try {
          io.closePid(live[0].pid);
          laneState.closedAt = now;
          io.saveState(st);
        } catch (e) { io.log(`close failed: ${e.message}`); }
      }

      // ── Orphan fold (Ra, 10/3): a lane that was belled this window but
      // never folded gets the designed emergency path instead of sitting
      // idle until morning. An api-error tail is a confident orphan (fold
      // at the quiet threshold); a merely-silent lane gets the full grace.
      // The woken session writes the missing rung retroactively — that IS
      // the emergency wake contract. Deferred while real work (a render)
      // runs under the panel; never in the last pre-wake hour (the morning
      // flag owns that); at most once per window.
      if (laneState.belledAt && now - laneState.belledAt <= WINDOW_GAP_MS
          && nwMtime < laneState.belledAt
          && (laneState.orphanFoldedAt ?? 0) < laneState.belledAt
          && laneState.belledSession
          && ((WAKE_MIN - m + 1440) % 1440) > 60) {
        const sid = laneState.belledSession;
        const quiet = io.quietMs(sid);
        const apiErr = io.lastEntryIsApiError(sid);
        const ready = apiErr ? quiet >= ORPHAN_QUIET
          : quiet >= ORPHAN_QUIET && now - laneState.belledAt >= ORPHAN_GRACE;
        if (ready) {
          const r = tryOrphanFold(io, lane, laneState, st, sid, { deferKey: 'orphanDeferredEmitted' });
          if (r === 'deferred' || r === 'retry') continue;
          if (r === 'done') {
            laneState.orphanFoldedAt = now;
            laneState.closedAt = now;
            io.saveState(st);
            io.log(`ORPHAN FOLD: ${lane} belled at ${new Date(laneState.belledAt).toISOString()}, never folded (last entry: ${apiErr ? 'api error' : 'idle'}) — closed and emergency-folded; the 08:00 wake will brief the lane`);
            io.emit('orphan-fold-done', { lane, cause: apiErr ? 'api-error' : 'idle' });
          }
        }
      }
    } else {
      // ── Wake side: wake anything that slept and hasn't been woken — but
      // ONLY inside a bounded morning window [WAKE, WAKE+2h). Outside it, a
      // fresh sleep receipt means a DELIBERATE daytime/evening fold (Ra
      // closing a panel that should stay down), and relaunching it within a
      // minute would fight her hand. Found at bench-design time, 10/2: with
      // both lanes armed, yesterday's 22:16 manual Opus fold would have been
      // auto-reopened. The 2h tail still catches a daemon that was down or
      // retrying at 08:00 sharp; a wake missed entirely is the morning
      // heartbeat's to flag, not ours to force at arbitrary hours.
      const sinceWake = (m - WAKE_MIN + 1440) % 1440;
      if (sinceWake >= 120 && !laneState.refreshWake) continue; // refresh waives the window once
      // The next-wake file's mtime is the sleep receipt, fresh within 20h.
      // Belled but never folded: the receipt predates this window's bell, so
      // the lane's span since its old fold is unfolded. Don't wake the stale
      // tail; say so once, loudly (the 10:17 heartbeat alerts on this line).
      if (nwMtime > 0 && (laneState.belledAt ?? 0) > nwMtime) {
        if ((laneState.staleFlaggedAt ?? 0) < laneState.belledAt) {
          io.log(`BELLED BUT NEVER FOLDED: ${lane}'s next-wake predates its bell — not waking the stale tail; fold the lane (or WEFT_WAKE_STALE_OK=1 wake.sh ${lane} to resume it anyway)`);
          io.emit('stale-receipt', { lane, session: io.nextWakeSession(lane) ?? undefined, alarm: true });
          laneState.staleFlaggedAt = now;
          io.saveState(st);
        }
        continue;
      }
      const slept = nwMtime > 0 && now - nwMtime < 20 * 3600_000;
      if (slept && (laneState.wokenAt ?? 0) < nwMtime) {
        // A pending launch attempt is TRUSTED only once the lane registry
        // confirms a session actually started (the 10/3 lesson: the window
        // opened, zsh's compinit prompt ate the typed command, and the old
        // stamp-on-launch left the failure invisible for an hour).
        if ((laneState.wakeAttemptAt ?? 0) > nwMtime) {
          const confirmed = io.wakeConfirmed(lane, laneState.wakeAttemptAt);
          // Both io shapes return a session id or false (real: registry
          // filename; bench: the found session's id) — no boolean escape
          // hatch, so liveness is checked unconditionally (review note).
          const confirmedLive = confirmed && io.liveSessions().some((x) => x.sessionId === confirmed);
          if (confirmed && !confirmedLive) {
            io.log(`wake registered for ${lane} but the session is no longer live — treating as unconfirmed`);
          }
          if (confirmedLive) {
            io.log(`wake confirmed for ${lane} (registry entry after launch)`);
            io.emit('wake-confirmed', { lane, session: typeof confirmed === 'string' ? confirmed : undefined });
            laneState.wokenAt = now;
            laneState.wakeAttempts = 0;
            delete laneState.refreshWake;
            io.saveState(st);
            continue;
          }
          if (now - laneState.wakeAttemptAt < 5 * 60_000) continue; // still settling
          if ((laneState.wakeAttempts ?? 0) >= 3) {
            if (!laneState.wakeGaveUpAt || laneState.wakeGaveUpAt < nwMtime) {
              io.log(`WAKE FAILED for ${lane}: 3 launches, no registry confirmation — giving up until the next sleep receipt; the morning heartbeat will flag it`);
              io.emit('wake-failed', { lane, attempts: 3, alarm: true });
              laneState.wakeGaveUpAt = now;
              io.saveState(st);
            }
            continue;
          }
          io.log(`no wake confirmation for ${lane} after 5m — retrying (attempt ${(laneState.wakeAttempts ?? 0) + 1} of 3)`);
        }
        const live = io.liveSessions().map((s) => ({ ...s, lane: io.laneOf(s.sessionId) })).filter((s) => s.lane === lane);
        if (live.length) { // already up (manual wake) — stamp so we stop looking
          io.log(`${lane} looks already awake (session ${live[0].sessionId.slice(0, 8)}… reads as ${lane}) — stamping wokenAt, no Terminal launch`);
          io.emit('already-awake', { lane, session: live[0].sessionId });
          laneState.wokenAt = now;
          laneState.wakeAttempts = 0;
          delete laneState.refreshWake;
          io.saveState(st);
          continue;
        }
        // A fresh sleep receipt grants a fresh retry budget. Without this,
        // a WAKE FAILED morning leaves wakeAttempts at 3, and the NEXT
        // night's first launch counts as "attempt 4" — one more failure
        // and the lane gives up after a single try instead of three
        // (seen 10/6: the morning after the decoy-checkpoint failure).
        if ((laneState.wakeAttemptAt ?? 0) <= nwMtime) laneState.wakeAttempts = 0;
        io.log(`waking the ${lane} lane in a new Terminal window (attempt ${(laneState.wakeAttempts ?? 0) + 1})`);
        io.emit('wake-launched', { lane, attempt: (laneState.wakeAttempts ?? 0) + 1 });
        try {
          io.launchWake(lane);
          laneState.wakeAttemptAt = now;
          laneState.wakeAttempts = (laneState.wakeAttempts ?? 0) + 1;
          io.saveState(st);
        } catch (e) {
          io.log(`wake launch failed: ${e.message} — will retry next tick`);
        }
      }
    }
  }
}

// --test-windows: print the decision surface for a sweep of simulated local
// times and exit — receipts for the wrap-aware logic without waiting a night.
if (args_has_test_windows()) {
  for (const hm of ['00:30', '01:59', '02:00', '03:30', '07:59', '08:00', '12:00', '19:00', '23:30']) {
    const m = hmToMin(hm);
    console.log(`${hm} → ${inSleepWindow(m) ? 'SLEEP window (bell/close side active)' : 'wake side active'}`);
  }
  process.exit(0);
}
function args_has_test_windows() { return process.argv.includes('--test-windows'); }

// ── --rehearse: run the REAL tick against scripted nights on a virtual
// clock. Minutes pass in a loop, effects are recorded instead of executed,
// and each scenario asserts the decision sequence. This is the bench that
// would have caught the window-wrap, today-is-tomorrow, laneOf and
// evening-refold bugs in daylight. Exit 0 = all scenarios pass.
async function rehearse() {
  let failures = 0;
  const check = (scenario, name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} [${scenario}] ${name}${ok || !detail ? '' : ' — ' + detail}`);
    if (!ok) failures++;
  };

  // One simulated lane-world. Time starts 00:00 LA and advances by minutes.
  function makeWorld(lanes) {
    const w = {
      min: 19 * 60, // start 19:00 the evening before
      day: 0,
      st: {},
      sessions: [],            // [{pid, sessionId, lane, quietMs}]
      nextWake: {},            // lane -> mtimeMs
      events: [],              // recorded effects
      logs: [],
      launchFails: 0,          // countdown of launchWake throws
      confirmWakes: true,      // false = the window opens but nothing runs (10/3)
    };
    for (const lane of lanes) w.nextWake[lane] = 0;
    w.io = {
      real: false,
      emit: () => {}, // events.jsonl is live-only; the bench asserts on w.events
      now: () => (w.day * 1440 + w.min) * 60_000,
      nowMin: () => w.min,
      armedLanes: () => lanes,
      state: () => w.st,
      saveState: () => {},
      liveSessions: () => w.sessions.map(({ pid, sessionId }) => ({ pid, sessionId })),
      laneOf: (sid) => w.sessions.find((s) => s.sessionId === sid)?.lane ?? null,
      ringBell: (lane, sid) => w.events.push(`bell:${lane}@${w.day}d${fmt(w.min)}`),
      quietMs: (sid) => w.sessions.find((s) => s.sessionId === sid)?.quietMs ?? 0,
      nextWakeMtime: (lane) => w.nextWake[lane] ?? 0,
      closePid: (pid) => {
        w.events.push(`close:${w.sessions.find((s) => s.pid === pid)?.lane}@${w.day}d${fmt(w.min)}`);
        w.sessions = w.sessions.filter((s) => s.pid !== pid);
      },
      launchWake: (lane) => {
        if (w.launchFails > 0) { w.launchFails--; throw new Error('simulated launch failure'); }
        w.events.push(`wake:${lane}@${w.day}d${fmt(w.min)}`);
        if (w.confirmWakes) w.sessions.push({ pid: 9000 + w.events.length, sessionId: `woken-${lane}-${w.day}-${w.min}`, lane, quietMs: 0, bornAt: w.io.now() + 1 }); // born strictly after the attempt, as the registry is
      },
      wakeConfirmed: (lane, sinceMs) => w.sessions.find((s) => s.lane === lane && (s.bornAt ?? -1) > sinceMs)?.sessionId ?? false,
      nextWakeSession: (lane) => `rehearse-${lane}-tail`,
      lastEntryIsApiError: (sid) => !!w.apiErrorTails?.[sid],
      busyChildren: () => w.busy ?? [],
      killAndWait: (pid) => { w.sessions = w.sessions.filter((s) => s.pid !== pid); return true; },
      emergencyFold: (lane, sid) => { w.events.push(`orphanfold:${lane}@${w.day}d${fmt(w.min)}`); w.nextWake[lane] = w.io.now(); return true; },
      log: (line) => w.logs.push(line),
    };
    w.step = (minutes = 1) => {
      for (let i = 0; i < minutes; i++) {
        w.min++;
        if (w.min >= 1440) { w.min -= 1440; w.day++; }
        tickWith(w.io);
      }
    };
    return w;
  }
  const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const count = (w, prefix) => w.events.filter((e) => e.startsWith(prefix)).length;

  { // Scenario 1: the happy night, two lanes.
    const w = makeWorld(['fable', 'opus']);
    w.sessions = [
      { pid: 1, sessionId: 'sess-f', lane: 'fable', quietMs: 0 },
      { pid: 2, sessionId: 'sess-o', lane: 'opus', quietMs: 0 },
    ];
    w.step(7 * 60 + 5); // 19:00 -> 02:05
    check('happy', 'one bell per lane at 02:00', count(w, 'bell:fable') === 1 && count(w, 'bell:opus') === 1, w.events.join());
    check('happy', 'no close before the fold', count(w, 'close:') === 0);
    // both lanes fold and go quiet
    for (const lane of ['fable', 'opus']) w.nextWake[lane] = w.io.now();
    for (const s of w.sessions) s.quietMs = QUIET_MS + 1;
    w.step(5);
    check('happy', 'both panels closed after fold+quiet', count(w, 'close:fable') === 1 && count(w, 'close:opus') === 1, w.events.join());
    w.step(6 * 60); // -> ~08:10
    check('happy', 'one wake per lane at 08:00', count(w, 'wake:fable') === 1 && count(w, 'wake:opus') === 1, w.events.join());
    w.step(10 * 60); // through the day
    check('happy', 'no further actions all day', w.events.length === 6, w.events.join());
  }

  { // Scenario 2: evening manual fold must NOT be auto-reopened (10/2 find).
    const w = makeWorld(['opus']);
    w.sessions = [{ pid: 3, sessionId: 'sess-o', lane: 'opus', quietMs: 0 }];
    w.step(3 * 60); // -> 22:00
    w.nextWake.opus = w.io.now(); // Ra folds the panel at 22:00...
    w.sessions = [];              // ...and closes it
    w.step(3 * 60 + 55);          // -> 01:55
    check('evening-fold', 'no relaunch before the night', count(w, 'wake:') === 0, w.events.join());
    w.step(10 + 6 * 60 + 30);     // through the night -> 08:35
    check('evening-fold', 'morning wake still happens', count(w, 'wake:opus') === 1, w.events.join());
    check('evening-fold', 'no bell for an empty lane', count(w, 'bell:') === 0);
  }

  { // Scenario 3: session never folds — never closed, bell not repeated.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 4, sessionId: 'sess-f', lane: 'fable', quietMs: QUIET_MS + 1 }];
    w.step(13 * 60); // 19:00 -> 08:00 next day
    check('no-fold', 'exactly one bell', count(w, 'bell:') === 1, w.events.join());
    check('no-fold', 'never closed without a sleep receipt', count(w, 'close:') === 0);
    check('no-fold', 'never woken (nothing slept)', count(w, 'wake:') === 0);
  }

  { // Scenario 4: launch failure retries and recovers.
    const w = makeWorld(['fable']);
    w.nextWake.fable = w.io.now(); // slept yesterday evening (receipt old but <20h at 08:00)
    w.launchFails = 3;
    w.step(13 * 60 + 10); // -> 08:10
    check('retry', 'retries then succeeds once', count(w, 'wake:fable') === 1, w.events.join());
  }

  { // Scenario 5: manual wake before 08:00 — stamp, no double-launch.
    const w = makeWorld(['fable']);
    w.nextWake.fable = w.io.now();
    w.step(12 * 60 + 30); // -> 07:30, still pre-window... sleep window: no wake yet
    w.sessions = [{ pid: 5, sessionId: 'manual-f', lane: 'fable', quietMs: 0 }]; // Ra opens it herself at 07:30
    w.step(60); // -> 08:30
    check('manual-wake', 'no Terminal launch when already up', count(w, 'wake:') === 0, w.events.join());
  }

  { // Scenario 6: late receipt (>20h) is stale — no wake.
    const w = makeWorld(['fable']);
    w.nextWake.fable = w.io.now() - 21 * 3600_000;
    w.step(13 * 60 + 30);
    check('stale', 'a 21h-old receipt never wakes', count(w, 'wake:') === 0, w.events.join());
  }

  { // Scenario 8: belled but never folded (opus, 10/3) — stale receipt refused.
    const w = makeWorld(['opus']);
    w.nextWake.opus = w.io.now(); // yesterday's fold receipt, still <20h at 08:00
    w.sessions = [{ pid: 7, sessionId: 'sess-o', lane: 'opus', quietMs: 0 }];
    w.step(7 * 60 + 5); // 19:00 -> 02:05: bell rings
    w.sessions = [];    // the fold dies post-bell (ECONNRESET / exit) — no new receipt
    w.step(6 * 60 + 30); // through 08:30
    check('stale-bell', 'no wake into the stale tail', count(w, 'wake:') === 0, w.events.join());
    check('stale-bell', 'flagged loudly, once', w.logs.filter((l) => l.includes('BELLED BUT NEVER FOLDED')).length === 1, w.logs.join('|'));
  }

  { // Scenario 9: last night, replayed with the orphan path — bell, fold
    // dies on an api error, quiet, orphan fold, clean 08:00 wake.
    const w = makeWorld(['opus']);
    w.sessions = [{ pid: 8, sessionId: 'sess-o', lane: 'opus', quietMs: 0 }];
    w.apiErrorTails = { 'sess-o': true };
    w.step(7 * 60 + 2); // bell at 02:00
    w.sessions[0].quietMs = ORPHAN_QUIET + 1; // the turn died; transcript quiet
    w.step(30);
    check('orphan-api', 'folded at the quiet threshold (no full grace)', count(w, 'orphanfold:opus') === 1, w.events.join());
    w.step(6 * 60); // through 08:30
    check('orphan-api', 'morning wake fires on the fresh receipt', count(w, 'wake:opus') === 1, w.events.join());
    check('orphan-api', 'once per window', count(w, 'orphanfold:') === 1);
  }

  { // Scenario 10: a render under the panel defers the fold.
    const w = makeWorld(['opus']);
    w.sessions = [{ pid: 9, sessionId: 'sess-o', lane: 'opus', quietMs: ORPHAN_QUIET + 1 }];
    w.apiErrorTails = { 'sess-o': true };
    w.busy = ['ffmpeg -i frames/%d.png out.mp4'];
    w.step(7 * 60 + 40);
    check('orphan-busy', 'defers while the render runs', count(w, 'orphanfold:') === 0, w.events.join());
    w.busy = [];
    w.step(10);
    check('orphan-busy', 'folds once the render finishes', count(w, 'orphanfold:opus') === 1, w.events.join());
  }

  { // Scenario 11: an idle lane that never answered the bell folds after grace.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 10, sessionId: 'sess-f', lane: 'fable', quietMs: ORPHAN_QUIET + 1 }];
    w.step(7 * 60 + 30); // 02:30 — quiet but inside grace
    check('orphan-idle', 'waits out the grace', count(w, 'orphanfold:') === 0, w.events.join());
    w.step(20); // past 02:45 grace
    check('orphan-idle', 'folds after grace', count(w, 'orphanfold:fable') === 1, w.events.join());
  }

  { // Scenario 7: the 10/3 failure — launches "succeed" but nothing starts.
    const w = makeWorld(['fable']);
    w.confirmWakes = false;
    w.nextWake.fable = w.io.now();
    w.step(14 * 60); // 19:00 -> 09:00 next day
    check('eaten-launch', 'exactly 3 launch attempts', count(w, 'wake:fable') === 3, w.events.join());
    check('eaten-launch', 'wokenAt never stamped', !w.st.fable?.wokenAt);
    check('eaten-launch', 'gave up loudly', !!w.st.fable?.wakeGaveUpAt);
    // Ra wakes it by hand at 09:10 — the registry entry self-heals the state.
    w.confirmWakes = true;
    w.sessions.push({ pid: 9999, sessionId: 'manual', lane: 'fable', quietMs: 0, bornAt: w.io.now() });
    w.step(5);
    check('eaten-launch', 'manual wake confirms and clears', !!w.st.fable?.wokenAt, JSON.stringify(w.st));
  }

  { // Scenario 12: a failed morning must not tax the NEXT night's retries.
    // 10/6 finding: wakeAttempts survived the WAKE FAILED morning, so the
    // next night's first launch logged "attempt 4" — one more eaten launch
    // and the lane would give up after a single try instead of three.
    const w = makeWorld(['fable']);
    w.confirmWakes = false;
    w.nextWake.fable = w.io.now();
    w.step(14 * 60); // night one: 3 launches, WAKE FAILED
    check('stale-attempts', 'night one gave up at 3', count(w, 'wake:fable') === 3, w.events.join());
    // Night two: a fresh sleep receipt lands; launches still get eaten.
    w.nextWake.fable = w.io.now();
    w.step(14 * 60);
    check('stale-attempts', 'night two gets its own 3 attempts', count(w, 'wake:fable') === 6, w.events.join());
  }

  { // Scenario 13: fold-now MET — the lane folds itself; refresh follows.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 20, sessionId: 'sess-f', lane: 'fable', quietMs: 10 * 60_000 }];
    w.st.fable = { foldRequest: { sessionId: 'sess-f', requestedAt: w.io.now(), deadline: w.io.now() + 10 * 60_000 } };
    w.step(2); // pending, deadline far
    check('fold-now-met', 'no force while the deadline holds', count(w, 'orphanfold:') === 0, w.events.join());
    w.nextWake.fable = w.io.now(); // the lane folds on its own
    w.step(1);
    check('fold-now-met', 'request cleared, refresh armed', !w.st.fable.foldRequest && w.st.fable.refreshWake === true, JSON.stringify(w.st.fable));
    w.step(3); // close, then wake outside the morning window
    check('fold-now-met', 'panel closed for refresh', count(w, 'close:fable') === 1, w.events.join());
    check('fold-now-met', 'immediate re-wake launched despite the hour', count(w, 'wake:fable') === 1, w.events.join());
    w.step(2);
    check('fold-now-met', 'confirmation clears refreshWake', !w.st.fable.refreshWake && !!w.st.fable.wokenAt, JSON.stringify(w.st.fable));
  }

  { // Scenario 14: fold-now FORCED — deadline passes, orphan path, refresh.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 21, sessionId: 'sess-f', lane: 'fable', quietMs: 10 * 60_000 }];
    w.st.fable = { foldRequest: { sessionId: 'sess-f', requestedAt: w.io.now(), deadline: w.io.now() + 5 * 60_000 } };
    w.step(4);
    check('fold-now-forced', 'holds before the deadline', count(w, 'orphanfold:') === 0, w.events.join());
    w.step(3); // past the deadline
    check('fold-now-forced', 'forced via the orphan path', count(w, 'orphanfold:fable') === 1, w.events.join());
    check('fold-now-forced', 'request cleared after the force', !w.st.fable.foldRequest, JSON.stringify(w.st.fable));
    w.step(3);
    check('fold-now-forced', 'refresh wake follows the force', count(w, 'wake:fable') === 1, w.events.join());
  }

  { // Scenario 16: the 10/6 23:16 live bug — a freshly-woken session's
    // resumed tail reads hours-quiet, and the refresh close must NOT eat
    // it. Forced path, then the new session is made to read quiet
    // immediately (the real shape; bench sessions used to read busy,
    // which is exactly why 15 scenarios missed this).
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 30, sessionId: 'old-f', lane: 'fable', quietMs: 10 * 60_000 }];
    w.st.fable = { foldRequest: { sessionId: 'old-f', requestedAt: w.io.now(), deadline: w.io.now() + 2 * 60_000 } };
    w.step(4); // deadline passes → forced fold (old killed) → wake launches
    check('refresh-identity', 'forced + refresh wake launched', count(w, 'orphanfold:fable') === 1 && count(w, 'wake:fable') === 1, w.events.join());
    for (const sess of w.sessions) sess.quietMs = 10 * 60_000; // the resumed tail reads quiet NOW
    w.step(3);
    check('refresh-identity', 'the NEW session is never closed by its own refresh', count(w, 'close:fable') === 0, w.events.join());
    check('refresh-identity', 'confirmation lands on a LIVE window', !!w.st.fable.wokenAt && w.sessions.length === 1, JSON.stringify({ st: w.st.fable, live: w.sessions.length }));
    check('refresh-identity', 'refresh fully cleared', !w.st.fable.refreshWake && !w.st.fable.refreshFrom, JSON.stringify(w.st.fable));
  }

  { // Scenario 15: HOT RELOAD — the app moves sleep to 03:00 mid-evening;
    // the bell honors the NEW hour without a daemon restart.
    const keep = CFG; // applySchedule swaps module globals; restore after.
    const w = makeWorld(['fable']);
    w.sessions = [{ pid: 22, sessionId: 'sess-f', lane: 'fable', quietMs: 0 }];
    const fresh = JSON.parse(JSON.stringify(keep));
    fresh.schedule.sleep = '03:00';
    w.io.configMtime = () => 42;
    w.io.reloadConfig = () => fresh;
    w.step(7 * 60 + 59); // 19:00 → 02:59 — the OLD hour must not ring
    check('hot-reload', 'old 02:00 bell suppressed under the new schedule', count(w, 'bell:') === 0, w.events.join());
    w.step(2); // 03:01
    check('hot-reload', 'bell rings at the NEW 03:00', count(w, 'bell:fable') === 1, w.events.join());
    applySchedule(keep); // restore the real schedule for anything after
  }

  console.log(failures === 0 ? 'REHEARSAL CLEAN' : `REHEARSAL: ${failures} failure(s)`);
  if (failures) process.exitCode = 1;
}

function tick() { tickWith(io); }

if (process.argv.includes("--rehearse")) { await rehearse(); process.exit(0); }

// --arm <lane> | --disarm <lane> | --armed: the app's Nightly toggle and the
// per-lane "Nightshift folds and wakes this lane" box. Reads tolerate every
// separator (the 10/2 newline silently disarmed a proof night for 8 hours);
// writes are ALWAYS comma-joined, so the file converges to the safe form.
if (process.argv.includes('--armed')) {
  console.log(armedLanes().join(','));
  process.exit(0);
}
for (const op of ['--arm', '--disarm']) {
  if (!process.argv.includes(op)) continue;
  const lane = process.argv[process.argv.indexOf(op) + 1];
  if (!lane || !(lane in (CFG.lanes ?? {}))) {
    console.error(`${op}: unknown lane "${lane ?? ''}" (known: ${Object.keys(CFG.lanes ?? {}).join(', ')})`);
    process.exit(2);
  }
  const now = new Set(armedLanes());
  op === '--arm' ? now.add(lane) : now.delete(lane);
  writeFileSync(ARMED_FILE, [...now].join(','));
  console.log(`${op.slice(2)}ed ${lane} — armed: [${[...now].join(', ') || 'DISARMED'}]`);
  process.exit(0);
}

// --fold-now <lane> [--within <minutes>]: the app's "Fold now" (Ra's
// refresh ruling, 10/6). Rings the real bell immediately, then records a
// fold request the DAEMON enforces: fold seen → fold-request-met; deadline
// passed → forced orphan fold; either way close + immediate re-wake.
// Default deadline 10 minutes — an explicit human "now".
if (process.argv.includes('--fold-now')) {
  const lane = process.argv[process.argv.indexOf('--fold-now') + 1];
  if (!lane || !(lane in (CFG.lanes ?? {}))) {
    console.error(`--fold-now: unknown lane "${lane ?? ''}" (known: ${Object.keys(CFG.lanes ?? {}).join(', ')})`);
    process.exit(2);
  }
  const live = liveSessions().map((x) => ({ ...x, lane: laneOf(x.sessionId) })).filter((x) => x.lane === lane);
  if (!live.length) {
    console.error(`--fold-now: lane ${lane} is not awake — nothing to fold`);
    process.exit(3);
  }
  const withinIdx = process.argv.indexOf('--within');
  const withinMin = withinIdx !== -1 ? Number(process.argv[withinIdx + 1]) : 10;
  if (!Number.isFinite(withinMin) || withinMin < 1) {
    console.error('--within takes minutes, at least 1');
    process.exit(2);
  }
  LIVE_EMIT = true;
  ringBell(lane, live[0].sessionId, 'nightwatch');
  let st = {};
  try { st = JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch {}
  (st[lane] ??= {}).foldRequest = {
    sessionId: live[0].sessionId,
    requestedAt: Date.now(),
    deadline: Date.now() + withinMin * 60_000,
  };
  writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  emitEvent('fold-requested', { lane, session: live[0].sessionId, deadline: new Date(st[lane].foldRequest.deadline).toISOString() });
  console.log(`fold requested for ${lane}: bell rung, forcing in ${withinMin}m if unfolded`);
  process.exit(0);
}

// --ring <lane>: ring that lane's sleep-bell NOW, by hand — the app's Sleep
// button and any human who wants an early night. Exactly the 02:00 bell
// (same ringBell, same spool note, same ritual text, same event), except
// the event carries source:"nightwatch" so the log can tell a hand-rung
// bell from the scheduled one. Refuses unknown lanes and lanes that are
// not awake, nonzero with one line, like sleep.mjs's own guards.
if (process.argv.includes('--ring')) {
  const lane = process.argv[process.argv.indexOf('--ring') + 1];
  if (!lane || !(lane in (CFG.lanes ?? {}))) {
    console.error(`--ring: unknown lane "${lane ?? ''}" (known: ${Object.keys(CFG.lanes ?? {}).join(', ')})`);
    process.exit(2);
  }
  const live = liveSessions().map((s) => ({ ...s, lane: laneOf(s.sessionId) })).filter((s) => s.lane === lane);
  if (!live.length) {
    console.error(`--ring: lane ${lane} is not awake — nothing to bell`);
    process.exit(3);
  }
  LIVE_EMIT = true; // a hand-rung bell is a real act; its event is real
  ringBell(lane, live[0].sessionId, 'nightwatch');
  console.log(`bell rung for ${lane} (session ${live[0].sessionId.slice(0, 8)}…)`);
  process.exit(0);
}

// ── --preflight: one REAL tick, effects stubbed to narration. The scripted
// bench (--rehearse) proves the decision logic; this proves the DECISIONS
// AGAINST THE REAL FILES — armed file, state, registry, receipts, live
// sessions — because the 10/2 disarm bug lived in parsing a real file the
// bench never read (a newline in nightshift.armed read as zero lanes armed,
// three daemon restarts, eight silent hours). Run it after any config or
// arming change; it prints what tonight WOULD do and touches nothing.
// FORMAT FROZEN (10/6): the app's health panel renders this output
// verbatim (run-doctor button). Lines stay 'ok|MISSING|BAD <subject> …'
// — extend by ADDING lines, never by reshaping existing ones.
if (process.argv.includes('--preflight')) {
  const say = (what) => console.log(`WOULD ${what}`);
  const preflightIo = {
    ...io,
    real: false,
    emit: () => {}, // preflight narrates; it never writes the event stream
    saveState: () => {},
    ringBell: (lane, sess) => say(`ring the sleep-bell for ${lane} (session ${String(sess?.sessionId ?? sess).slice(0, 8)}…)`),
    closePid: (pid) => say(`close panel pid ${pid}`),
    killAndWait: (pid) => { say(`close panel pid ${pid} (and wait)`); return true; },
    emergencyFold: (lane, sid) => { say(`orphan-fold ${lane} (session ${String(sid).slice(0, 8)}…)`); return true; },
    launchWake: (lane) => say(`launch a Terminal wake for ${lane}`),
    log: (line) => console.log(`[decision] ${line}`),
  };
  const lanes = armedLanes();
  console.log(`config file: ${CFG.__configFile ?? '(defaults)'}`);
  console.log(`armed file parses as: [${lanes.join(', ') || 'DISARMED'}] (raw: ${JSON.stringify(readFileSync(ARMED_FILE, 'utf8').slice(0, 60))})`);
  console.log(`window: sleep ${SLEEP_HOUR} wake ${WAKE_HOUR} (${CFG.timezone}); now minute ${nowMin()}`);
  for (const lane of lanes) {
    const nw = join(WAKECYCLE, `next-wake.${lane}.json`);
    console.log(existsSync(nw)
      ? `next-wake.${lane}.json: ${Math.round((Date.now() - statSync(nw).mtimeMs) / 3600_000)}h old`
      : `next-wake.${lane}.json: MISSING`);
  }
  const live = liveSessions();
  console.log(`live sessions: ${live.length ? live.map((s) => `${String(s.sessionId).slice(0, 8)}…→${laneOf(s.sessionId) ?? '?'}`).join(', ') : '(none)'}`);
  tickWith(preflightIo);
  console.log('preflight complete — nothing was touched.');
  process.exit(0);
}

LIVE_EMIT = true; // past every bench exit; the stream is real from here
log(`nightshift up — sleep ${SLEEP_HOUR} → wake ${WAKE_HOUR} (${CFG.timezone}, wrap-aware), quiet ${QUIET_MS / 60000}m, armed: [${armedLanes().join(', ') || 'DISARMED'}]`);
emitEvent('daemon-up', { sleep: SLEEP_HOUR, wake: WAKE_HOUR, armed: armedLanes() });
// Hourly liveness: a dead daemon and a quiet night must not look identical
// in the stream (emitter review + skin ask — 'down' observed, not inferred).
let lastAliveEmit = Date.now();
setInterval(() => {
  if (Date.now() - lastAliveEmit >= 3600_000) {
    lastAliveEmit = Date.now();
    emitEvent('daemon-alive', { armed: armedLanes() });
  }
}, 60_000).unref();
tick();
setInterval(tick, POLL_MS);
