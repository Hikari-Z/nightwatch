// The headless Chrome a CDP skin test drives, and its cleanup on every way out.
//
// Each test used to tidy up only at the end of its happy path, so an early
// process.exit, a throw (Node 20 without --experimental-websocket dies at the
// first `new WebSocket`), or Ctrl-C left the Chrome running and its profile on
// disk. By 10/13 that was 24 nwcur-* and 18 nwcdp-* profiles and three Chromes
// orphaned on 9337. launchChrome() registers the kill and the removal at
// launch, and they run on a normal end, process.exit, an uncaught throw or
// rejection, and SIGINT/SIGTERM/SIGHUP, waiting for Chrome's helpers to let go
// of the profile before removing it.
//
// What no handler can catch is a test killed with SIGKILL: its Chrome is
// reparented to launchd and keeps the port. sweepOrphans() finds exactly those
// (parent pid 1, user-data-dir under one of our test prefixes), kills them, and
// removes test profiles whose Chrome is gone. A Chrome that a running test owns
// still has that test as its parent, so a test running beside this one is
// never touched.
//
// Written by: claude-opus-5-5, 2026-10-16
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PREFIXES = ['nwcdp-', 'nwcur-'];
const TMP = process.env.TMPDIR ?? tmpdir();
const cleanups = [];
let armed = false;

function runCleanups() {
  while (cleanups.length) { try { cleanups.pop()(); } catch { /* the next one still runs */ } }
}
function arm() {
  if (armed) return;
  armed = true;
  // 'exit' runs on a normal end, process.exit, an uncaught throw and an
  // unhandled rejection (checked on Node 20, the WebSocket ReferenceError
  // included), so it needs no help there. A signal ends the process WITHOUT
  // running it, so each signal exits through it. Cleanup is sync only.
  process.on('exit', runCleanups);
  for (const [sig, n] of [['SIGINT', 2], ['SIGTERM', 15], ['SIGHUP', 1]]) process.on(sig, () => process.exit(128 + n));
}

/** Run `fn` once on the way out, however the test ends. Last registered, first run. */
export function onExit(fn) { arm(); cleanups.push(fn); }

const rmProfile = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); // sync: cleanup runs in 'exit'

/** Pids of every process on this profile: Chrome and its helpers. */
function holders(prof) {
  let ps = '';
  try { ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }); } catch { return []; }
  return ps.split('\n').filter((l) => l.includes(`--user-data-dir=${prof}`)).map((l) => Number(l.trim().split(/\s+/)[0]));
}

/**
 * Kill the Chrome on `prof`, wait until nothing holds the profile, then remove
 * it. Chrome's helpers outlive it by a moment and write into the profile, so
 * removing it right after the kill can leave it behind (it did, 2 runs in 6,
 * after SIGTERM). Waits at most 3 s, then kills any helper still there.
 */
function killAndRemove(pid, prof) {
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  for (let t = 0; t < 3000 && holders(prof).length; t += 100) pause(100);
  for (const h of holders(prof)) { try { process.kill(h, 'SIGKILL'); } catch { /* gone */ } }
  pause(100);
  rmProfile(prof);
}

/** Chrome's own pid for a profile it holds (SingletonLock names host-pid), or null. */
function lockPid(dir) {
  try { const m = /-(\d+)$/.exec(readlinkSync(join(dir, 'SingletonLock'))); return m ? Number(m[1]) : null; }
  catch { return null; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/**
 * Kill test Chromes left by a test that died without cleanup (parent pid 1 and
 * a profile under one of our prefixes in $TMPDIR), then remove our test
 * profiles whose Chrome is gone. Returns what it did, for the self-test.
 */
export function sweepOrphans({ tmp = TMP, prefixes = PREFIXES, minAgeMs = 60_000 } = {}) {
  const killed = [], removed = [];
  // Compare paths, not spellings: $TMPDIR ends in a slash, so a profile made as
  // TMPDIR + '/nwcdp-' reads `T//nwcdp-…` on Chrome's command line, and macOS
  // spells the same folder /var/… and /private/var/… (the 10/16 scratch-guard
  // lesson). Two orphans on `T//` outlived this sweep's first version.
  const real = (p) => { try { return realpathSync(p); } catch { return normalize(p); } };
  const tmpForms = new Set([normalize(tmp), real(tmp)].map((p) => p.replace(/\/+$/, '')));
  const ours = (dir) => prefixes.some((p) => basename(dir).startsWith(p))
    && [normalize(dirname(dir)), real(dirname(dir))].some((d) => tmpForms.has(d.replace(/\/+$/, '')));
  let ps = '';
  try { ps = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }); } catch { /* no ps: skip the kill half */ }
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || m[2] !== '1' || !m[3].startsWith(CHROME)) continue;
    const ud = /--user-data-dir=(\S+)/.exec(m[3]);
    if (!ud || !ours(ud[1])) continue;
    killAndRemove(Number(m[1]), ud[1]); killed.push(Number(m[1])); removed.push(basename(ud[1]));
  }
  let names = [];
  try { names = readdirSync(tmp); } catch { /* nothing to sweep */ }
  for (const name of names) {
    if (!prefixes.some((p) => name.startsWith(p))) continue;
    const dir = join(tmp, name);
    let age = 0;
    try { age = Date.now() - statSync(dir).mtimeMs; } catch { continue; }
    const pid = lockPid(dir);
    // A live Chrome keeps its profile. Without a lock, a young folder may be
    // a test between mkdtemp and Chrome's start, so only older ones go.
    if (removed.includes(name)) continue;
    if (pid !== null ? (alive(pid) && !killed.includes(pid)) : age < minAgeMs) continue;
    rmProfile(dir); removed.push(name);
  }
  return { killed, removed };
}

/**
 * Start headless Chrome on a fresh profile with remote debugging on `port`,
 * after sweeping orphans. Its kill and the profile's removal are registered
 * for every way the test can end.
 */
export function launchChrome({ port, prefix = 'nwcdp-', size = '1100,1000' }) {
  arm();
  sweepOrphans();
  const prof = mkdtempSync(join(TMP, prefix));
  const args = ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`];
  if (size) args.push(`--window-size=${size}`);
  const ch = spawn(CHROME, [...args, 'about:blank'], { stdio: 'ignore' });
  onExit(() => killAndRemove(ch.pid, prof));
  return { ch, prof };
}
