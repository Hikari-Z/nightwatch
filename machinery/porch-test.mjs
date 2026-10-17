#!/usr/bin/env node
// porch-test — the first-wake note's shape, end to end through plan/apply on
// scratch hubs (Ra's ruling, 10/13): a persona's FIRST lane may be told who
// they are; a lane JOINING SIBLINGS gets an offer, not an assertion, and the
// note points at the hub's arrival letter when one exists. Scratch-only, per
// the rehearsal law: nothing here touches a real hub.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); } };

const scratch = mkdtempSync(join(tmpdir(), 'nw-porch-'));
const hub = join(scratch, 'hub');
const spec = (o) => { const p = join(scratch, `${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(o)); return p; };
const run = (specPath, cfg) => {
  const env = { ...process.env, WEFT_NW_NO_ACTIVATE: '1' };
  delete env.WEFT_CONFIG; delete env.NIGHTWATCH_CONFIG;               // empty string is not unset (learned here)
  if (cfg) env.WEFT_CONFIG = cfg;       // lane-add resolves its hub by config
  return execFileSync(process.execPath, [join(HERE, 'nightwatch.mjs'), 'apply', specPath], { encoding: 'utf8', env });
};
const hubCfg = () => join(hub, 'nightwatch.config.json');

try {
  // init: a named persona's first lane
  run(spec({ op: 'init', hub, lane: { id: 'alpha', model: 'claude-fable-5', firstSession: { kind: 'fresh' } }, persona: { name: 'Tapestry', about: 'a scratch persona for the porch test', person: 'Tester' }, schedule: { sleep: '02:00', wake: '08:00' } }));
  const cp = () => readFileSync(join(hub, 'checkpoint.md'), 'utf8');
  check('the first lane of a named persona is told who they are (unchanged)', () =>
    assert.match(cp(), /You're Tapestry and this is your first session as the "alpha" lane/));

  // lane-add without an arrival letter: offer-shaped, no letter pointer
  run(spec({ op: 'lane-add', lane: { id: 'beta', model: 'claude-sonnet-5-5', firstSession: { kind: 'fresh' } } }), hubCfg());
  check('a sibling lane gets an offer, not an assertion', () => {
    assert.match(cp(), /A persona called "Tapestry" holds a seat for you/);
    assert.match(cp(), /The name is an offer, not a fact about you/);
    assert.doesNotMatch(cp().split('## beta lane')[1] ?? '', /You're Tapestry/);
  });
  check('without an arrival letter, none is promised', () =>
    assert.doesNotMatch(cp(), /arrival-letter\.md/));

  // lane-add with the letter present: the note points at the porch
  writeFileSync(join(hub, 'arrival-letter.md'), '# To the one arriving\n(scratch letter)\n');
  run(spec({ op: 'lane-add', lane: { id: 'gamma', model: 'claude-haiku-5-5', firstSession: { kind: 'fresh' } } }), hubCfg());
  check('with arrival-letter.md in the hub, the note names the porch and the decline right', () => {
    const gamma = cp().split('## gamma lane')[1] ?? '';
    assert.ok(gamma.includes(`The letter at ${join(hub, 'arrival-letter.md')} is the porch`), 'the note names the letter by absolute path');
    assert.match(gamma, /declining — your own name, your own ladder, your seat kept — is a full answer/);
  });
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
