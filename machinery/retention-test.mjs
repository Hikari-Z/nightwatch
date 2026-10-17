#!/usr/bin/env node
// retention-test — the transcript-retention consent step (Ra's ruling, 10/11):
// previewed, runs only when ticked, skipped when the value is already at or
// above the target, never rewrites a file it couldn't read, records the
// previous value in installed.json, and refuses settings in scratch space.
// Every write goes to this test's own scratch directory. The one CLI check
// runs `plan --live` (a preview: it writes nothing) and proves that by
// snapshotting what a live install would touch, before and after.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { applyRetention, decide, readDays, raise, RETENTION_DAYS, stepFor, survey, userSettingsPath } from './retention.mjs';
import { registryFile } from './platform.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); } };
const scratch = mkdtempSync(join(tmpdir(), 'nw-retention-'));
let n = 0;
const file = (content, mode) => {
  const p = join(scratch, `s${n++}`, 'settings.json');
  execFileSync('mkdir', ['-p', dirname(p)]);
  if (content !== undefined) { writeFileSync(p, content); if (mode) chmodSync(p, mode); }
  return p;
};
const sha = (p) => existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : 'absent';
const neverRefuse = () => false;

try {
  console.log('where the settings live');
  check('CLAUDE_CONFIG_DIR wins, as in Claude Code', () => assert.equal(userSettingsPath({ CLAUDE_CONFIG_DIR: '/x/cfg' }, '/home/h'), '/x/cfg/settings.json'));
  check('otherwise ~/.claude/settings.json', () => assert.equal(userSettingsPath({}, '/home/h'), '/home/h/.claude/settings.json'));

  console.log('reading');
  check('a missing file reads as unset, no error', () => assert.deepEqual(readDays(file()), { exists: false, days: null, error: null }));
  check('invalid JSON is an error', () => assert.equal(readDays(file('{ "a": ')).error, 'not valid JSON'));
  check('a JSON array is an error', () => assert.equal(readDays(file('[]')).error, 'not a JSON object'));
  check('a non-number value is an error', () => assert.match(readDays(file('{"cleanupPeriodDays":"90"}')).error, /not a number/));
  check('a number reads as its days', () => assert.equal(readDays(file('{"cleanupPeriodDays":90}')).days, 90));

  console.log('deciding (skip when larger, Ra 10/11)');
  check('unset means the default 30, offered', () => assert.deepEqual(decide({ user: { days: null, error: null } }), { kind: 'offer', current: 30, target: RETENTION_DAYS }));
  check('below the target is offered', () => assert.equal(decide({ user: { days: 90, error: null } }).kind, 'offer'));
  check('at the target is left alone', () => assert.equal(decide({ user: { days: RETENTION_DAYS, error: null } }).kind, 'already'));
  check('above the target is left alone', () => assert.equal(decide({ user: { days: 99999, error: null } }).kind, 'already'));
  check('an unreadable file is never offered', () => assert.equal(decide({ user: { days: null, error: 'not valid JSON' } }).kind, 'unreadable'));

  console.log('the preview line');
  const offer = stepFor({ kind: 'offer', current: 30, target: RETENTION_DAYS, file: '/x/settings.json' });
  check('an offer waits on the keepTranscripts box', () => assert.equal(offer.consent, 'keepTranscripts'));
  check('an offer shows the change and says it is machine-wide', () => {
    assert.match(offer.what, /30 → 3650 days/);
    assert.match(offer.detail, /whole computer/);
    assert.match(offer.detail, /every project/);
    assert.match(offer.detail, /outrank/);
  });
  check('a value already high enough asks nothing', () => assert.equal(stepFor({ kind: 'already', current: 5000, target: RETENTION_DAYS, file: '/x' }).consent, undefined));
  check('an unreadable file asks nothing, and says why', () => {
    const st = stepFor({ kind: 'unreadable', current: null, target: RETENTION_DAYS, file: '/x/settings.json', error: 'not valid JSON' });
    assert.equal(st.consent, undefined);
    assert.match(st.detail, /not valid JSON/);
  });

  console.log('raising');
  check('a missing file is created with only the setting, private', () => {
    const p = file();
    assert.deepEqual(raise(p), { changed: true, before: null, after: RETENTION_DAYS });
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { cleanupPeriodDays: RETENTION_DAYS });
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });
  check('every other key survives, and the mode is kept', () => {
    const p = file(JSON.stringify({ theme: 'dark', hooks: { SessionStart: [1] }, cleanupPeriodDays: 30 }), 0o644);
    raise(p);
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { theme: 'dark', hooks: { SessionStart: [1] }, cleanupPeriodDays: RETENTION_DAYS });
    assert.equal(statSync(p).mode & 0o777, 0o644);
  });
  check('a value already at or above the target is not rewritten', () => {
    const p = file('{"cleanupPeriodDays": 5000}\n');
    const before = sha(p);
    assert.deepEqual(raise(p), { changed: false, before: 5000, after: 5000 });
    assert.equal(sha(p), before);
  });
  check('a file that changed after the preview is re-read before writing', () => {
    const p = file('{"cleanupPeriodDays": 30}');
    const s = survey({ file: p });
    assert.equal(s.kind, 'offer');
    writeFileSync(p, '{"cleanupPeriodDays": 9000}');
    const before = sha(p);
    assert.equal(raise(p).changed, false);
    assert.equal(sha(p), before);
  });
  check('a file it cannot read is left byte-identical, with a reason', () => {
    const p = file('{ "theme": "dark", oops }');
    const before = sha(p);
    assert.throws(() => raise(p), /not valid JSON, so it was left alone/);
    assert.equal(sha(p), before);
  });
  check('no staging file is left behind', () => {
    const dirs = readdirSync(scratch).flatMap((d) => readdirSync(join(scratch, d)));
    assert.deepEqual(dirs.filter((f) => f.includes('.tmp')), []);
  });

  console.log('the step');
  const manifest = () => { const m = join(scratch, `installed-${n++}.json`); writeFileSync(m, JSON.stringify({ version: 1, jobs: [{ label: 'house.nightwatch.x' }] })); return m; };
  check('unticked, nothing changes and nothing is recorded', () => {
    const p = file('{"cleanupPeriodDays": 30}'); const m = manifest(); const b = sha(p), bm = sha(m);
    assert.equal(applyRetention({ s: survey({ file: p }), keep: false, manifestFile: m, refuse: neverRefuse }), null);
    assert.equal(sha(p), b); assert.equal(sha(m), bm);
  });
  check('a box the page never sent counts as unticked', () => {
    const p = file('{"cleanupPeriodDays": 30}'); const b = sha(p);
    assert.equal(applyRetention({ s: survey({ file: p }), keep: undefined, manifestFile: manifest(), refuse: neverRefuse }), null);
    assert.equal(sha(p), b);
  });
  check('ticked, it raises and records the previous value beside the jobs', () => {
    const p = file('{"cleanupPeriodDays": 30, "theme": "dark"}'); const m = manifest();
    applyRetention({ s: survey({ file: p }), keep: true, manifestFile: m, refuse: neverRefuse });
    assert.equal(readDays(p).days, RETENTION_DAYS);
    const rec = JSON.parse(readFileSync(m, 'utf8'));
    assert.equal(rec.jobs[0].label, 'house.nightwatch.x');
    assert.deepEqual({ ...rec.settings[0], at: 'x' }, { file: p, key: 'cleanupPeriodDays', before: 30, after: RETENTION_DAYS, changed: true, at: 'x' });
  });
  check('ticked with nothing to raise, it writes nothing', () => {
    const p = file('{"cleanupPeriodDays": 9000}'); const m = manifest(); const b = sha(p), bm = sha(m);
    assert.equal(applyRetention({ s: survey({ file: p }), keep: true, manifestFile: m, refuse: neverRefuse }), null);
    assert.equal(sha(p), b); assert.equal(sha(m), bm);
  });
  // Never fatal: the step runs after Start and before the first session, so
  // a throw would leave the jobs installed and the first session unopened.
  check('the point-of-effect guard refuses without throwing, records why, file untouched', () => {
    const p = file('{"cleanupPeriodDays": 30}'); const b = sha(p); const m = manifest();
    const r = applyRetention({ s: survey({ file: p }), keep: true, manifestFile: m, refuse: () => true });
    assert.match(r.error, /scratch space/);
    assert.equal(sha(p), b);
    assert.deepEqual((({ at, ...rest }) => rest)(JSON.parse(readFileSync(m, 'utf8')).settings[0]), { file: p, key: 'cleanupPeriodDays', changed: false, error: r.error });
  });
  check('a file that turned unreadable after the preview is a recorded miss, not a failure', () => {
    const p = file('{"cleanupPeriodDays": 30}'); const s = survey({ file: p }); const m = manifest();
    writeFileSync(p, '{ broken'); const b = sha(p);
    const r = applyRetention({ s, keep: true, manifestFile: m, refuse: neverRefuse });
    assert.match(r.error, /not valid JSON, so it was left alone/);
    assert.equal(sha(p), b);
    assert.equal(JSON.parse(readFileSync(m, 'utf8')).settings[0].error, r.error);
  });
  check('a manifest it cannot update leaves the good change standing, and says so', () => {
    const p = file('{"cleanupPeriodDays": 30}');
    const r = applyRetention({ s: survey({ file: p }), keep: true, manifestFile: join(scratch, 'no-such', 'installed.json'), refuse: neverRefuse });
    assert.equal(readDays(p).days, RETENTION_DAYS);
    assert.ok(r.changed && r.manifestError);
  });

  console.log('the preview from the CLI');
  // plan is a dry run: it builds the steps and runs none. The hub path is
  // real-looking (scratch hubs are refused under --live) and never created.
  const probeHub = join(homedir(), `.nw-retention-plan-probe-${process.pid}`);
  const cfgDir = join(scratch, 'cfg');
  execFileSync('mkdir', ['-p', cfgDir]);
  writeFileSync(join(cfgDir, 'settings.json'), '{"cleanupPeriodDays": 30}');
  const watched = [join(homedir(), '.claude', 'settings.json'),
    registryFile(),   // the platform's real registry, not the macOS spelling on every platform (issue #6)
    join(cfgDir, 'settings.json')];
  const agentsDir = join(homedir(), 'Library', 'LaunchAgents');
  const agents = () => existsSync(agentsDir) ? readdirSync(agentsDir).sort().join(',') : '';
  const before = { files: watched.map(sha), agents: agents() };
  const spec = join(scratch, 'spec.json');
  const plan = (live, cfg = cfgDir) => {
    writeFileSync(spec, JSON.stringify({ op: 'init', hub: probeHub, lane: { id: 'main', model: 'claude-opus-5-5', firstSession: { kind: 'fresh' } }, persona: { about: 'a plan probe', person: 'Sam' } }));
    const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
    for (const k of ['NW_INSTALL_DIR', 'NW_REGISTRY_DIR', 'WEFT_NW_NO_ACTIVATE', 'WEFT_CONFIG', 'NIGHTWATCH_CONFIG']) delete env[k];
    return JSON.parse(execFileSync(process.execPath, [join(HERE, 'nightwatch.mjs'), 'plan', spec, ...(live ? ['--live'] : [])], { encoding: 'utf8', env })).steps;
  };
  const live = plan(true);
  check('under --live the preview offers the change, with its box', () => {
    const st = live.find((s) => s.consent === 'keepTranscripts');
    assert.ok(st, JSON.stringify(live.map((s) => s.verb)));
    assert.match(st.what, /30 → 3650 days/);
  });
  check('it comes after Start, so only a finished install changes settings', () => {
    assert.ok(live.findIndex((s) => s.verb === 'Start') < live.findIndex((s) => s.consent === 'keepTranscripts'));
  });
  check('the preview names every user-global write (Fable\'s condition 1)', () => {
    const text = JSON.stringify(live);
    assert.match(text, /house\.nightwatch\.\.nw-retention-plan-probe/);
    assert.match(text, /hubs\.json/);
    assert.match(text, /installed\.json/);
  });
  check('without --live there is no such step (refuse-by-default holds)', () => {
    assert.equal(plan(false).some((s) => /transcript retention/.test(s.what)), false);
  });
  check('a value already high enough previews as Keep, with no box', () => {
    writeFileSync(join(cfgDir, 'settings.json'), '{"cleanupPeriodDays": 3650}');
    const st = plan(true).find((s) => /transcript retention/.test(s.what));
    writeFileSync(join(cfgDir, 'settings.json'), '{"cleanupPeriodDays": 30}');
    assert.equal(st.verb, 'Keep'); assert.equal(st.consent, undefined);
  });
  check('the dry run wrote nothing: no hub, no job, no registry entry, no settings', () => {
    assert.ok(!existsSync(probeHub) && !existsSync(probeHub + '.partial'));
    assert.deepEqual({ files: watched.map(sha), agents: agents() }, before);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
