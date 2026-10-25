/**
 * Doctor's Claude Code version check (item 1 of the compatibility guard).
 *
 * The question: has the version wake.sh would run ever woken on a folded
 * tail? Wake-cost rows carry the `version` of the session that woke (watch.mjs,
 * #41), so the answer is set membership against those rows. Never red: a
 * version no wake has run is not broken, the output check in trim.mjs (#30)
 * is the gate, and red stays the word for "something is wrong now". Before
 * any row carries a version (a fresh hub, or the days before the first wake
 * after #41) there is nothing to compare, and that is said neutrally.
 *
 * The binary is resolved the way wake.sh does (paths.claudeBin when it is
 * there and executable, else the PATH's `claude`) and the path is named in the
 * line, because a Doctor that checks a different binary than the wakes run is a
 * green about something else (the 10/16 trap: a shell's claude is not
 * necessarily the one the wakes use).
 *
 * Line words follow the preflight's frozen vocabulary where one fits and add
 * two: `ok`, and `WARN` (amber) / `note` (neutral). Pure functions, I/O
 * injected, so the tests need no real claude.
 *
 * Written by: claude-sonnet-5-5, 2026-10-25.
 */
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** wake.sh: the configured claude when it is there and executable, PATH's otherwise. */
export function resolveClaude({ claudeBin, isExecutable, lookupPath }) {
  if (claudeBin && isExecutable(claudeBin)) return { path: claudeBin, via: 'paths.claudeBin' };
  const found = lookupPath();
  return found ? { path: found, via: 'PATH' } : { path: null, via: null };
}

/** "2.1.310 (Claude Code)" → "2.1.310"; anything else → null. */
export function parseVersion(text) {
  const m = /^\s*(\d+\.\d+\.\d+)\b/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** The distinct `version`s on wake-cost rows, in file order. A torn line is skipped. */
export function seenVersions(jsonlText) {
  const out = [];
  for (const l of String(jsonlText ?? '').split('\n')) {
    if (!l.trim()) continue;
    let v;
    try { v = JSON.parse(l).version; } catch { continue; }
    if (typeof v === 'string' && v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * The preflight lines. io: { claudeBin, isExecutable(path), lookupPath(),
 * runVersion(path) → stdout text | null, wakeCostsText }.
 */
export function claudeVersionLines(io) {
  const bin = resolveClaude(io);
  if (!bin.path) {
    return [`WARN    claude: no paths.claudeBin (${io.claudeBin ?? 'unset'}) that is executable, and none on this process's PATH; wake.sh looks in the same two places from its own shell, so this may be only where Doctor runs from`];
  }
  const where = `${bin.path} (via ${bin.via})`;
  const out = io.runVersion(bin.path);
  const installed = parseVersion(out);
  if (!installed) {
    return [`WARN    claude ${where}: could not read a version from \`--version\` (${JSON.stringify(String(out ?? '').trim().slice(0, 60))})`];
  }
  const seen = seenVersions(io.wakeCostsText);
  if (!seen.length) {
    return [`note    claude ${installed} ${where}: no wake record carries a version yet, so there is no baseline to compare against (the first wake after the version record lands seeds it)`];
  }
  if (seen.includes(installed)) {
    return [`ok      claude ${installed} ${where} has woken on a folded tail before`];
  }
  return [`WARN    claude ${installed} ${where} has not woken on a folded tail yet (woken: ${seen.join(', ')}); not a fault, the output check is the gate`];
}

/** Real I/O for the nightshift's preflight. */
export function realIo({ claudeBin, wakeCostsPath }) {
  return {
    claudeBin,
    isExecutable: (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } },
    lookupPath: () => {
      const r = spawnSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 });
      const last = String(r.stdout ?? '').trim().split('\n').pop();
      return r.status === 0 && last && last.startsWith('/') ? last : null;
    },
    runVersion: (p) => {
      const r = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 10_000 });
      return r.status === 0 ? r.stdout : null;
    },
    wakeCostsText: existsSync(wakeCostsPath) ? readFileSync(wakeCostsPath, 'utf8') : '',
  };
}
