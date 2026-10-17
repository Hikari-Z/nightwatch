#!/usr/bin/env node
// register-lane-test: the SessionStart hook records a session's lane in its
// hub's registry under either lane name, NIGHTWATCH_LANE or the older
// WEFT_LANE a pre-#7 wake exported (issue #7), and names the config the new
// way in the arming line it prints. Scratch hub only, per the rehearsal law.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); } };

const hub = mkdtempSync(join(tmpdir(), 'nw-register-lane-'));
try {
  mkdirSync(join(hub, 'wakecycle'), { recursive: true });
  const cfg = join(hub, 'nightwatch.config.json');
  writeFileSync(cfg, JSON.stringify({ defaultLane: 'alpha', lanes: { alpha: {}, beta: {} } }));
  const run = (env, sid) => {
    const e = { ...process.env, ...env };
    for (const k of ['NIGHTWATCH_CONFIG', 'WEFT_CONFIG', 'NIGHTWATCH_LANE', 'WEFT_LANE']) if (!(k in env)) delete e[k];
    return execFileSync('sh', [join(HERE, 'register-lane.sh')], { env: e, input: JSON.stringify({ session_id: sid }), encoding: 'utf8' });
  };
  const entry = (sid) => JSON.parse(readFileSync(join(hub, 'wakecycle', `lane.${sid}`), 'utf8'));

  const out = run({ NIGHTWATCH_CONFIG: cfg, NIGHTWATCH_LANE: 'alpha' }, 'sid-new');
  check('NIGHTWATCH_LANE is recorded in the hub registry', () => assert.equal(entry('sid-new').lane, 'alpha'));
  check('the arming line names the config as NIGHTWATCH_CONFIG', () => assert.match(out, new RegExp(`NIGHTWATCH_CONFIG=${cfg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `)));

  run({ WEFT_CONFIG: cfg, WEFT_LANE: 'beta' }, 'sid-old');
  check('an older wake\'s WEFT_LANE (and WEFT_CONFIG) still registers', () => assert.equal(entry('sid-old').lane, 'beta'));

  run({ NIGHTWATCH_CONFIG: cfg }, 'sid-none');
  check('no lane named registers nothing', () => assert.ok(!existsSync(join(hub, 'wakecycle', 'lane.sid-none'))));
} finally {
  rmSync(hub, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
