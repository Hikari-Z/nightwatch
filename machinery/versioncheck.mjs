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
 * When paths.claudeBin isn't usable, the fallback has to look `claude` up the
 * way the wake WINDOW's shell does, not Doctor's: on macOS the window is
 * Terminal's interactive login shell (`$SHELL -ilc`), which reads ~/.zshrc,
 * where ~/.local/bin usually goes on PATH; `sh -lc` and `zsh -lc` do not, and
 * on this machine find the old Homebrew cask (2.1.267) instead of the live
 * 2.1.310 (Opus measured it, 10/25). On Linux and WSL the window runs
 * `sh -lc` with the node and configured-claude directories prefixed
 * (platform.mjs withToolPath). The line says which shell looked.
 *
 * Line words follow the preflight's frozen vocabulary where one fits and add
 * two: `ok`, and `WARN` (amber) / `note` (neutral). Pure functions, I/O
 * injected, so the tests need no real claude.
 *
 * Written by: claude-sonnet-5-5, 2026-10-25.
 */
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { platformKind } from './platform.mjs';

/**
 * The command that finds `claude` the way the wake window's shell would.
 * Pure: returns { bin, args, label }. `label` is what the Doctor line says
 * about who looked, so it never implies more fidelity than it has.
 */
export function lookupCommand({ kind = platformKind(), shell = process.env.SHELL, nodePath = process.execPath, claudeBin } = {}) {
  if (kind === 'darwin') {
    const bin = shell && shell.startsWith('/') ? shell : '/bin/zsh';
    return { bin, args: ['-ilc', 'command -v claude'], label: `looked up by \`${bin.split('/').pop()} -ilc\`, the shell Terminal's wake window runs` };
  }
  if (kind === 'linux' || kind === 'wsl') {
    const dirs = [...new Set([dirname(nodePath), ...(claudeBin ? [dirname(claudeBin)] : [])])];
    return { bin: '/bin/sh', args: ['-lc', `PATH="${dirs.join(':')}:$PATH"; command -v claude`], label: 'looked up by `sh -lc` with the node and configured-claude directories first, as the wake window runs' };
  }
  return { bin: '/bin/sh', args: ['-lc', 'command -v claude'], label: "PATH as Doctor's shell sees it (not necessarily the wake window's)" };
}

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
  const where = `${bin.path} (via ${bin.via}${bin.via === 'PATH' && io.lookupLabel ? `; ${io.lookupLabel}` : ''})`;
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

/**
 * The flags wake.sh passes, and how `claude --help` lists each. Not every flag is its own line there:
 * `--append-system-prompt-file` appears only as `--append-system-prompt[-file]` in the --bare text (checked
 * 10/25 on 2.1.310 against a working install), so a naive "is every flag listed" would WARN on a healthy
 * machine. It is checked as the family name, and the line says so.
 *
 * A flag counts only where it is DEFINED, at the start of a help line (optionally after a short alias, as in
 * `-r, --resume [value]`): `--resume` is named five times in prose in that help, so a loose match would stay
 * green after the flag itself was removed.
 */
const defined = (flag) => new RegExp(`^\\s+(?:-\\w, )?${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'm');
export const WAKE_FLAGS = [
  { flag: '--system-prompt-snapshot', re: defined('--system-prompt-snapshot') },
  { flag: '--resume', re: defined('--resume') },
  { flag: '--fork-session', re: defined('--fork-session') },
  { flag: '--model', re: defined('--model') },
  { flag: '--append-system-prompt[-file]', re: defined('--append-system-prompt') },
];

/**
 * Does the claude wake.sh would run still list the flags it passes? Offline (`--help` calls no API), so it
 * warns BEFORE 08:00 about a flag that would otherwise show up as WAKE FAILED after the launch. Amber, never
 * red; and a flag listed but ignored is not seen here at all (the head witness, in the watch, is that check).
 * io: the resolveClaude inputs plus runHelp(path) → stdout | null.
 */
export function flagLines(io) {
  const bin = resolveClaude(io);
  if (!bin.path) return []; // claudeVersionLines already said claude could not be found
  const where = `${bin.path} (via ${bin.via}${bin.via === 'PATH' && io.lookupLabel ? `; ${io.lookupLabel}` : ''})`;
  const help = io.runHelp(bin.path);
  if (!help) return [`WARN    claude ${where}: could not read \`--help\`, so the flags wake.sh passes were not checked`];
  const missing = WAKE_FLAGS.filter(({ re }) => !re.test(help)).map(({ flag }) => flag);
  if (missing.length) {
    return [`WARN    claude ${where}: \`--help\` no longer lists ${missing.join(', ')}, which wake.sh passes; a removed or renamed flag fails the wake at launch (WAKE FAILED), so this is the warning before 08:00`];
  }
  return [`ok      claude ${where}: \`--help\` still lists the flags wake.sh passes (${WAKE_FLAGS.map(({ flag }) => flag).join(', ')}; the last is listed as a family)`];
}

/** Real I/O for the nightshift's preflight. */
export function realIo({ claudeBin, wakeCostsPath, kind, shell, nodePath, spawn = spawnSync }) {
  const look = lookupCommand({ kind, shell, nodePath, claudeBin });
  return {
    claudeBin,
    lookupLabel: look.label,
    isExecutable: (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } },
    lookupPath: () => {
      // An interactive shell can print rc noise: the answer is the last line that is a path.
      const r = spawn(look.bin, look.args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      const found = String(r.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/')).pop();
      return r.status === 0 && found ? found : null;
    },
    runVersion: (p) => {
      const r = spawnSync(p, ['--version'], { encoding: 'utf8', timeout: 10_000 });
      return r.status === 0 ? r.stdout : null;
    },
    runHelp: (p) => {
      const r = spawnSync(p, ['--help'], { encoding: 'utf8', timeout: 10_000 });
      return r.status === 0 && r.stdout ? r.stdout : null;
    },
    wakeCostsText: existsSync(wakeCostsPath) ? readFileSync(wakeCostsPath, 'utf8') : '',
  };
}
