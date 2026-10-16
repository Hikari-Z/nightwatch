/*
 * retention.mjs — the transcript-retention consent step (Ra's ruling, 10/11).
 *
 * Claude Code deletes its local session files once they're older than
 * `cleanupPeriodDays` (default 30, minimum 1; 0 fails validation, so it never
 * means "keep forever"). A persona's archive copies each folded day into the
 * hub (archive.mjs), but the originals, and any session that never folds,
 * still go at 30 days. Set up offers to raise the setting, and does it only
 * when the person ticks the box in the preview.
 *
 * What the person is agreeing to, stated in the step itself: this is a
 * machine-wide setting in their own Claude Code settings. It keeps every
 * project's session files longer (transcripts, file-history snapshots, debug
 * logs, pasted content), not only this persona's.
 *
 * Facts from the Claude Code docs, fetched 10/16 (code.claude.com/docs/en/
 * claude-directory.md "Cleaned up automatically", settings.md "Settings files
 * and precedence"): the user file is $CLAUDE_CONFIG_DIR/settings.json, else
 * ~/.claude/settings.json. Managed settings outrank it, and so do a project's
 * own .claude/settings(.local).json files. Managed settings can arrive by a
 * file, an MDM profile, the claude.ai admin console or an embedding host, so
 * no file check here could see them all; and a project file depends on where
 * a session runs. The step names both limits in its text instead of
 * pretending to detect them.
 *
 * Written by: claude-opus-5-5, 2026-10-16
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The days Set up offers: the value Weft's own house has run on since 9/2026. */
export const RETENTION_DAYS = 3650;
export const DEFAULT_DAYS = 30;

/** The user settings file Claude Code reads, resolved as Claude Code does. */
export function userSettingsPath(env = process.env, home = homedir()) {
  return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json');
}

/**
 * Read one settings file's cleanupPeriodDays.
 * → {exists, days (number|null when unset), error (string|null)}
 * A file that exists but doesn't parse is an error: the step must never
 * rewrite a file it couldn't read, since writing would drop what it held.
 */
export function readDays(file) {
  if (!existsSync(file)) return { exists: false, days: null, error: null };
  let obj;
  try { obj = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return { exists: true, days: null, error: 'not valid JSON' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { exists: true, days: null, error: 'not a JSON object' };
  const d = obj.cleanupPeriodDays;
  if (d === undefined) return { exists: true, days: null, error: null };
  if (typeof d !== 'number' || !Number.isFinite(d)) return { exists: true, days: null, error: `cleanupPeriodDays is ${JSON.stringify(d)}, not a number` };
  return { exists: true, days: d, error: null };
}

/**
 * What the step should be, from what the files say.
 * → {kind: 'offer'|'already'|'unreadable', current, target}
 *   offer      — the user value (or the default) is below the target
 *   already    — the user value is at or above it (Ra: skip when larger)
 *   unreadable — the user file exists but can't be read safely
 */
export function decide({ user, target = RETENTION_DAYS }) {
  if (user.error) return { kind: 'unreadable', current: null, target, error: user.error };
  const current = user.days ?? DEFAULT_DAYS;
  return { kind: current >= target ? 'already' : 'offer', current, target };
}

/** decide() from the real files (or the ones a caller names). */
export function survey({ file = userSettingsPath(), target = RETENTION_DAYS } = {}) {
  return { file, ...decide({ user: readDays(file), target }) };
}

/**
 * Raise cleanupPeriodDays in `file` to `target`, keeping every other key.
 * Re-reads at the moment of writing: if the value changed since the preview
 * and is now at or above the target, it writes nothing. Atomic (stage, then
 * rename beside the file) and keeps the file's mode.
 * → {changed, before (number|null: null = was unset), after}
 * Throws on a file it can't read safely.
 */
export function raise(file, target = RETENTION_DAYS) {
  const now = readDays(file);
  if (now.error) throw new Error(`${file} is ${now.error}, so it was left alone; set cleanupPeriodDays by hand`);
  if ((now.days ?? DEFAULT_DAYS) >= target) return { changed: false, before: now.days, after: now.days };
  const obj = now.exists ? JSON.parse(readFileSync(file, 'utf8')) : {};
  obj.cleanupPeriodDays = target;
  const mode = now.exists ? statSync(file).mode & 0o777 : 0o600;
  const tmp = `${file}.nightwatch-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
  return { changed: true, before: now.days, after: target };
}

/** The preview line for each kind. `consent` marks the one step that runs only when ticked. */
export function stepFor(s) {
  const where = s.file.replace(homedir(), '~');
  if (s.kind === 'offer') return {
    verb: 'Raise', what: `Claude Code's transcript retention, ${s.current} → ${s.target} days`,
    detail: `Claude Code deletes its session files after ${s.current} days. Nightwatch keeps a copy of each day they fold either way; this keeps the originals too, and any session that never folds. It's a setting in ${where} for this whole computer, so every project's session files are kept longer, not only theirs. A setting from your organization, or in a project's own Claude Code settings, would outrank it. Runs only if ticked.`,
    consent: 'keepTranscripts',
  };
  if (s.kind === 'already') return {
    verb: 'Keep', what: `Claude Code's transcript retention at ${s.current} days`,
    detail: `already ${s.target} days or longer, so there's nothing to change`,
  };
  return {
    verb: 'Leave', what: "Claude Code's transcript retention",
    detail: `${where} is ${s.error}, so Nightwatch won't rewrite it; set cleanupPeriodDays by hand if you want transcripts kept longer`,
  };
}

/**
 * The step's run: only for an offer the person ticked. `refuse(file)` is the
 * point-of-effect guard (nightwatch.mjs passes scratchRooted: a settings file
 * in scratch space means a bench, and a bench changes no settings). The
 * outcome is recorded in the install manifest beside the jobs it came with,
 * so the previous value can be put back by hand (before null = was unset).
 *
 * NEVER throws. The step runs after Start and before the first session, and
 * apply stops at the first failing step: a failure here would leave the jobs
 * installed and the first session never opened, so the persona's first
 * contact would be an unattended nightshift wake instead of the welcomed
 * first session (Fable's read, 10/16). A miss is recorded and returned, and
 * the caller tells the person.
 * → null when nothing was to be done; else the raise() result, or {error}.
 */
export function applyRetention({ s, keep, manifestFile, refuse }) {
  if (s.kind !== 'offer' || keep !== true) return null;
  let r;
  try {
    if (refuse(s.file)) throw new Error('refusing to change Claude Code settings in scratch space');
    r = raise(s.file, s.target);
  } catch (e) {
    r = { changed: false, error: e.message };
  }
  const rec = r.error
    ? { file: s.file, key: 'cleanupPeriodDays', changed: false, error: r.error, at: new Date().toISOString() }
    : { file: s.file, key: 'cleanupPeriodDays', before: r.before, after: r.after, changed: r.changed, at: new Date().toISOString() };
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    manifest.settings = [rec];
    writeFileSync(manifestFile + '.tmp', JSON.stringify(manifest, null, 2) + '\n');
    renameSync(manifestFile + '.tmp', manifestFile);
  } catch (e) {
    // The setting's outcome stands either way; a manifest we couldn't
    // update is reported with it rather than undoing a good change.
    r = { ...r, manifestError: e.message };
  }
  return r;
}
