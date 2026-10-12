/**
 * Transcript archive — a persona's raw past, kept in their own hub.
 *
 * Every `jsonl:<session>` source a rung or fold row names points into Claude
 * Code's transcript folder, which Claude Code prunes after cleanupPeriodDays
 * (30 by default). Our own hub only kept its full history because one
 * machine's settings say 3650. A fresh install would lose a persona's
 * sources a month after they were written, silently, and the ladder would
 * keep pointing at them. So at every fold, sleep.mjs copies the session that
 * actually folded into paths.transcriptArchive, inside the hub: portable
 * with it, and outside anything Claude Code cleans up.
 *
 * Plain jsonl, one file per session, named as Claude Code names it. A
 * transcript only grows, so a newer copy of the same session holds
 * everything an older one did, and re-archiving overwrites. The one
 * exception is a source that SHRANK (rewritten by something other than
 * Claude Code appending): then the larger old copy is kept aside under a
 * timestamped name instead of being lost.
 *
 * Writes are stage-then-rename, so a crash mid-copy leaves the previous
 * archive whole and never a half file under the real name.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Copy one session's transcript into the archive. Returns what it did. */
export function archiveTranscript(sid, { transcripts, archive }) {
  const src = join(transcripts, `${sid}.jsonl`);
  if (!existsSync(src)) return { sid, skipped: 'no transcript' };
  mkdirSync(archive, { recursive: true });
  const dest = join(archive, `${sid}.jsonl`);
  const srcSize = statSync(src).size;
  let keptAside = null;
  if (existsSync(dest)) {
    const destSize = statSync(dest).size;
    if (destSize === srcSize) return { sid, path: dest, bytes: srcSize, unchanged: true };
    if (destSize > srcSize) {
      keptAside = join(archive, `${sid}.${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
      renameSync(dest, keptAside);
    }
  }
  const tmp = `${dest}.partial-${process.pid}`;
  copyFileSync(src, tmp);
  renameSync(tmp, dest);
  return { sid, path: dest, bytes: statSync(dest).size, ...(keptAside ? { keptAside } : {}) };
}

/**
 * Bring every archived session up to date with its source. The folding
 * session keeps writing after its fold (the ritual rewrites the checkpoint
 * after sleep.mjs), so the copy taken at the fold misses its last turns;
 * the next fold catches them up here. A session whose source is gone
 * (pruned) keeps its archive as it is: that is what the archive is for.
 */
export function catchUpArchive({ transcripts, archive }) {
  if (!existsSync(archive)) return [];
  // A copy that crashed mid-way leaves <sid>.jsonl.partial-<pid>. Remove
  // those whose process is gone, and only those: both lanes fold at the same
  // bell, so another fold's copy may be in flight right now.
  for (const f of readdirSync(archive)) {
    const m = f.match(/\.partial-(\d+)$/);
    if (m && !alive(Number(m[1]))) rmSync(join(archive, f), { force: true });
  }
  const done = [];
  for (const f of readdirSync(archive)) {
    const m = f.match(/^([0-9a-f-]{36})\.jsonl$/);
    if (!m) continue;
    const src = join(transcripts, f);
    if (!existsSync(src)) continue;
    if (statSync(src).size > statSync(join(archive, f)).size) done.push(archiveTranscript(m[1], { transcripts, archive }));
  }
  return done;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
