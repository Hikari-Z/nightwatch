#!/usr/bin/env node
// dehouse-test — what a stranger's machine gets, with nothing of the house that
// built Nightwatch in it. Scratch-only, per the rehearsal law: every hub, HOME
// and projects folder here is under a temp dir, and no hub config is inherited.
//   1. transcriptsFor names Claude Code's project folder by Claude Code's own
//      rule (2.1.306: every character but letters and digits becomes '-'; past
//      200 it's cut there and given '-' and a hash, which is found, not guessed)
//   2. Set up writes this machine's time zone and no transcripts path, so a hub
//      under "My Hubs/jane.doe" watches the folder Claude Code actually makes
//   3. a config with no timezone runs in the machine's zone, not one house's
//   4. doctor with no hub named says so in words, not with a stack trace
//   5. the PreCompact guard's receipt lands in the hub, never ~/origin/weft
//   6. the VERSION line Set up stamps is a version
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';
import { transcriptsFor, PROJECT_DIR_MAX, machineZone } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); } };
const scratch = mkdtempSync(join(tmpdir(), 'nw-dehouse-'));
// no hub config inherited: this file tests what a machine with none sees
const bareEnv = (extra = {}) => { const env = { ...process.env, WEFT_NW_NO_ACTIVATE: '1', ...extra };
  for (const k of ['WEFT_CONFIG', 'NIGHTWATCH_CONFIG', 'WEFT_LANE', 'NIGHTWATCH_LANE']) if (!(k in extra)) delete env[k]; return env; };
const spec = (o) => { const p = join(scratch, `${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(o)); return p; };

try {
  // ---- 1. Claude Code's rule ----
  const projects = join(scratch, 'projects'); mkdirSync(projects);
  check('a path with a dot, a space and an underscore: every one becomes "-", as Claude Code names it', () => {
    assert.strictEqual(transcriptsFor('/Users/jane.doe/My Hubs/lark_1', projects), join(projects, '-Users-jane-doe-My-Hubs-lark-1'));
    assert.strictEqual(transcriptsFor('/Users/you/origin', projects), join(projects, '-Users-you-origin'));
  });
  const long = '/Users/you/' + 'deep-folder/'.repeat(24) + 'hub';
  const cut = long.replace(/[^A-Za-z0-9]/g, '-').slice(0, PROJECT_DIR_MAX);
  check(`past ${PROJECT_DIR_MAX} characters: the cut name until a session has made the folder`, () => {
    assert.ok(long.length > PROJECT_DIR_MAX);
    assert.strictEqual(transcriptsFor(long, projects), join(projects, cut));
  });
  mkdirSync(join(projects, `${cut}-1x9abc`));
  check('…then the one folder Claude Code made, its hash included', () => assert.strictEqual(transcriptsFor(long, projects), join(projects, `${cut}-1x9abc`)));
  mkdirSync(join(projects, `${cut}-2zzz`));
  check('…and with two to choose from, neither: the cut name, which doctor reports missing', () => assert.strictEqual(transcriptsFor(long, projects), join(projects, cut)));

  // ---- 2. Set up ----
  const hub = join(scratch, 'My Hubs', 'jane.doe');
  const initSpec = { op: 'init', hub, lane: { id: 'alpha', model: 'claude-fable-5', firstSession: { kind: 'fresh' } }, persona: { name: 'Lark', about: 'a scratch persona', person: 'Tester' } };
  execFileSync(process.execPath, [join(HERE, 'nightwatch.mjs'), 'apply', spec(initSpec)], { encoding: 'utf8', env: bareEnv() });
  const written = JSON.parse(readFileSync(join(hub, 'nightwatch.config.json'), 'utf8'));
  check("Set up pins this machine's time zone in the hub's config", () => assert.strictEqual(written.timezone, machineZone()));
  check('Set up writes no transcripts path, and the hub loads the one Claude Code makes for it', () => {
    assert.strictEqual(written.paths?.transcripts, undefined);
    const got = execFileSync(process.execPath, [join(HERE, 'config.mjs'), 'get', 'paths.transcripts'], { encoding: 'utf8', env: bareEnv({ NIGHTWATCH_CONFIG: join(hub, 'nightwatch.config.json') }) }).trim();
    assert.ok(got.endsWith(`/${hub.replace(/[^A-Za-z0-9]/g, '-')}`), got);
    assert.ok(!/[ .]/.test(got.split('/').pop()), got);
  });
  check('Set up stamps a version, not a note from before the repo', () => assert.match(written.machineryVersion, /^\d+\.\d+\.\d+ /));

  // ---- 3. the machine's zone ----
  const plainHub = join(scratch, 'plain'); mkdirSync(plainHub);
  const plainCfg = join(plainHub, 'nightwatch.config.json'); writeFileSync(plainCfg, JSON.stringify({ lanes: { main: { targetTokens: 250000 } } }));
  check('a config that names no timezone runs in the machine\'s (TZ=Europe/Berlin here), not Los Angeles', () => {
    const tz = execFileSync(process.execPath, [join(HERE, 'config.mjs'), 'get', 'timezone'], { encoding: 'utf8', env: bareEnv({ NIGHTWATCH_CONFIG: plainCfg, TZ: 'Europe/Berlin' }) }).trim();
    assert.strictEqual(tz, 'Europe/Berlin');
  });

  // ---- 4. doctor with no hub ----
  check('doctor with no hub named says so in words, exit 2, no stack trace', () => {
    const r = spawnSync(process.execPath, [join(HERE, 'config.mjs'), 'doctor'], { encoding: 'utf8', env: bareEnv() });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /No hub config named\. Set NIGHTWATCH_CONFIG/);
    assert.ok(!/\n\s+at /.test(r.stderr), r.stderr);
  });

  // ---- 5. the guard's receipt ----
  const home = join(scratch, 'home'); mkdirSync(home);
  const guard = (input, env) => spawnSync('sh', [join(HERE, 'precompact-guard.sh')], { input: JSON.stringify(input), encoding: 'utf8', env: bareEnv({ HOME: home, ...env }) });
  const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').length : 0);
  const sessHub = join(scratch, 'sess-hub'); mkdirSync(join(sessHub, 'wakecycle'), { recursive: true });
  const cfgHub = join(scratch, 'cfg-hub'); mkdirSync(join(cfgHub, 'wakecycle'), { recursive: true });
  const flatHub = join(scratch, 'flat-hub'); mkdirSync(flatHub);
  check("the guard's receipt: in the session's hub when it runs in one", () => {
    const r = guard({ cwd: sessHub, trigger: 'manual' }, {}); assert.strictEqual(r.status, 0); assert.match(r.stdout, /"decision": "block"/);
    assert.strictEqual(lines(join(sessHub, 'wakecycle', 'precompact-guard.log')), 1);
  });
  check('…else in the hub its config names (wakecycle/ when it has one)', () => {
    guard({ cwd: '/nowhere', trigger: 'auto' }, { NIGHTWATCH_CONFIG: join(cfgHub, 'nightwatch.config.json') });
    assert.strictEqual(lines(join(cfgHub, 'wakecycle', 'precompact-guard.log')), 1);
  });
  check('…the hub itself when it has no wakecycle/ (WEFT_CONFIG, the old name, read too)', () => {
    guard({ cwd: '/nowhere', trigger: 'auto' }, { WEFT_CONFIG: join(flatHub, 'nightwatch.config.json') });
    assert.strictEqual(lines(join(flatHub, 'precompact-guard.log')), 1);
  });
  check('…and with no hub at all, ~/.nightwatch; never ~/origin/weft', () => {
    guard({ cwd: '/nowhere', trigger: 'auto' }, {});
    assert.strictEqual(lines(join(home, '.nightwatch', 'precompact-guard.log')), 1);
    assert.ok(!existsSync(join(home, 'origin')), 'something wrote under ~/origin');
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\ndehouse-test: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
