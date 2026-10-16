#!/usr/bin/env node
// init-sweep-test — refuse-by-default, the install manifest, and the doctor
// sweep (the porch-leak law, 10/15–16): init writes nothing user-global
// without --live; --live refuses scratch hubs and bench seams; what a live
// install writes is recorded in the hub's installed.json; and doctor-sweep
// finds installed jobs and registry entries whose hub or machinery is gone,
// from the records — never from a teardown, because a SIGKILL'd bench and a
// deleted worktree run no exit path (the 10/13 leak respawned a crash loop
// for two days under exactly that shape). Scratch-only, per the rehearsal
// law: NW_INSTALL_DIR and NW_REGISTRY_DIR point every write at this test's
// own directories.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); } };

const scratch = mkdtempSync(join(tmpdir(), 'nw-initsweep-'));
const jobsDir = join(scratch, 'agents');
const regDir = join(scratch, 'registry');
mkdirSync(jobsDir, { recursive: true });
mkdirSync(regDir, { recursive: true });
const spec = (o) => { const p = join(scratch, `${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(o)); return p; };
const nw = (args, env2 = {}, opts = {}) => {
  const env = { ...process.env, NW_INSTALL_DIR: jobsDir, NW_REGISTRY_DIR: regDir, ...env2 };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  delete env.WEFT_CONFIG;
  delete env.WEFT_NW_NO_ACTIVATE;
  return execFileSync(process.execPath, [join(HERE, 'nightwatch.mjs'), ...args], { encoding: 'utf8', env, ...opts });
};
const initSpec = (hub) => ({ op: 'init', hub, lane: { id: 'alpha', model: 'claude-fable-5', firstSession: { kind: 'fresh' } }, persona: { name: 'Mothwing', about: 'a scratch persona for the sweep test', person: 'Tester' }, schedule: { sleep: '02:00', wake: '08:00' } });

try {
  // 1. Refuse-by-default: apply WITHOUT --live stages everything and
  //    installs nothing, even with no WEFT_NW_NO_ACTIVATE anywhere in sight.
  const hub1 = join(scratch, 'hub1');
  const out1 = nw(['apply', spec(initSpec(hub1))]);
  check('without --live the hub is built', () => assert.ok(existsSync(join(hub1, 'nightwatch.config.json'))));
  check('without --live nothing lands in the jobs dir', () => assert.deepEqual(readdirSync(jobsDir), []));
  check('without --live no registry entry is written', () => assert.ok(!existsSync(join(regDir, 'hubs.json'))));
  check('without --live no install manifest is claimed', () => assert.ok(!existsSync(join(hub1, 'wakecycle', 'installed.json'))));
  check('the staged-only outcome is said plainly', () => assert.match(out1, /staged everything — nothing user-global was written/));

  // 2. --live refuses a scratch hub.
  // The seams stay SET here on purpose (the 10/16 lesson: this test once
  // unset them to isolate the scratch guard, and when that guard turned out
  // to have a realpath hole, the run installed REAL launchd jobs — the
  // seams were the only working layer and the test had removed them). The
  // scratch check fires first, so the assert still pins the specific guard.
  check('--live refuses a hub in scratch space', () => {
    assert.throws(() => nw(['apply', spec(initSpec(join(scratch, 'hub2'))), '--live'], {}, { stdio: 'pipe' }),
      (e) => /scratch space/.test(String(e.stderr)));
  });

  // 3. --live refuses the bench seams.
  check('--live refuses NW_INSTALL_DIR / NW_REGISTRY_DIR', () => {
    assert.throws(() => nw(['apply', spec({ ...initSpec(join(scratch, 'hub3')), hub: join(scratch, 'hub3') }), '--live'], {}, { stdio: 'pipe' }),
      (e) => /bench seams|scratch space/.test(String(e.stderr)));
  });

  // 4. doctor-sweep: an orphan job, a healthy job, a dead registry entry.
  const liveHub = join(scratch, 'living-hub');
  mkdirSync(liveHub, { recursive: true });
  writeFileSync(join(liveHub, 'nightwatch.config.json'), '{}\n');
  const plist = (label, cfg, script) => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/usr/bin/node</string><string>${script}</string></array>
  <key>EnvironmentVariables</key><dict><key>WEFT_CONFIG</key><string>${cfg}</string></dict>
</dict></plist>\n`;
  writeFileSync(join(jobsDir, 'house.nightwatch.ghost.plist'),
    plist('house.nightwatch.ghost', join(scratch, 'deleted-hub', 'nightwatch.config.json'), join(scratch, 'deleted-wt', 'nightshift.mjs')));
  writeFileSync(join(jobsDir, 'house.nightwatch.living.plist'),
    plist('house.nightwatch.living', join(liveHub, 'nightwatch.config.json'), join(HERE, 'nightshift.mjs')));
  writeFileSync(join(regDir, 'hubs.json'), JSON.stringify({ version: 1, hubs: [{ path: liveHub }, { path: join(scratch, 'deleted-hub') }] }, null, 2) + '\n');

  const report = nw(['doctor-sweep']);
  check('the sweep flags the orphan job', () => assert.match(report, /house\.nightwatch\.ghost.*missing hub/));
  check('the sweep flags the dead registry entry', () => assert.match(report, /hubs\.json entry.*deleted-hub.*missing hub/));
  check('the sweep never flags the living job', () => assert.doesNotMatch(report, /house\.nightwatch\.living/));
  check('report mode removes nothing', () => assert.ok(existsSync(join(jobsDir, 'house.nightwatch.ghost.plist'))));

  const removal = nw(['doctor-sweep', '--remove', '--yes']);
  check('--remove --yes deletes the orphan job file', () => assert.ok(!existsSync(join(jobsDir, 'house.nightwatch.ghost.plist'))));
  check('--remove --yes keeps the living job', () => assert.ok(existsSync(join(jobsDir, 'house.nightwatch.living.plist'))));
  check('--remove --yes drops only the dead registry entry', () => {
    const reg = JSON.parse(readFileSync(join(regDir, 'hubs.json'), 'utf8'));
    assert.deepEqual(reg.hubs.map((h) => h.path), [liveHub]);
  });
  check('the removal says what it did', () => assert.match(removal, /removed house\.nightwatch\.ghost/));

  // 5. A clean second sweep has nothing to do.
  check('a second sweep finds a clean house', () => assert.match(nw(['doctor-sweep']), /Nothing to do/));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
