/**
 * Who is listening for a lane's bell (10/16). A watcher is the shell running
 * bell-watcher.sh or the switchboard's inbox-watcher.sh for the lane (the two
 * share the lane's spool). It's TRACKED when its parent is alive (not pid 1):
 * its exit reaches a session, and that exit is the bell. A detached one
 * (parent pid 1) catches the bell and tells no one. The harness's zsh wrapper
 * carries the same text in its command line, so only a shell running the
 * script itself counts.
 */
import { execFileSync } from 'node:child_process';

const SHELLS = new Set(['sh', '/bin/sh', 'bash', '/bin/bash']);

/** Watchers for `lane` in `ps -axo pid=,ppid=,command=` output, each with whether it is tracked. */
export function laneWatchers(psText, lane) {
  const tails = [`bell-watcher.sh ${lane}`, `inbox-watcher.sh ${lane}`];
  const out = [];
  for (const raw of String(psText).split('\n')) {
    const line = raw.trim();
    const m = line.match(/^(\d+)\s+(\d+)\s+(\S+)(.*)$/);
    if (!m || !SHELLS.has(m[3])) continue;
    if (!tails.some((t) => line.endsWith(t))) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), tracked: m[2] !== '1' });
  }
  return out;
}

/** The live process table, or null when it can't be read (then nothing is concluded). */
export function processTable() {
  try { return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 5000 }); } catch { return null; }
}

/** The LOUD line for a bell no tracked watcher will hear, or null when one will. */
export function unheardBell(psText, lane) {
  const watchers = laneWatchers(psText, lane);
  if (watchers.some((w) => w.tracked)) return null;
  return `LOUD: no tracked watcher holds ${lane}'s spool at the bell${watchers.length ? ` (only a detached one, pid ${watchers.map((w) => w.pid).join(',')}, whose exit reaches no one)` : ''}: the note waits for the next arm or the spool hook, and the orphan fold is the floor`;
}
