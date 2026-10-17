#!/usr/bin/env node
// claude-md-test — issue #3: a fresh hub's sessions must load identity.md and
// the ladder, which means Set up writes the hub's CLAUDE.md (the @-import
// carrier) and a seed ladder/ladder.md so the import resolves before the
// first fold. Scratch-only, per the rehearsal law.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); } };

const scratch = mkdtempSync(join(tmpdir(), 'nw-claudemd-'));
const spec = (o) => { const p = join(scratch, `${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(o)); return p; };
const run = (cmd, specPath) => {
  const env = { ...process.env, WEFT_NW_NO_ACTIVATE: '1' };
  delete env.WEFT_CONFIG; delete env.NIGHTWATCH_CONFIG;
  return execFileSync(process.execPath, [join(HERE, 'nightwatch.mjs'), cmd, specPath], { encoding: 'utf8', env });
};

try {
  // A fresh hub.
  const hub = join(scratch, 'hub');
  const freshSpec = { op: 'init', hub, lane: { id: 'alpha', model: 'claude-fable-5', firstSession: { kind: 'fresh' } }, persona: { name: 'Tapestry', about: 'a scratch persona for the CLAUDE.md test', person: 'Tester' }, schedule: { sleep: '02:00', wake: '08:00' } };

  check('plan previews the CLAUDE.md step (the preview is the build)', () =>
    assert.match(run('plan', spec(freshSpec)), /CLAUDE\.md and a seed ladder\/ladder\.md/));

  run('apply', spec(freshSpec));
  const cm = () => readFileSync(join(hub, 'CLAUDE.md'), 'utf8');

  check('apply writes the hub CLAUDE.md', () => assert.ok(existsSync(join(hub, 'CLAUDE.md'))));
  check('it imports identity.md and the ladder', () => {
    assert.match(cm(), /^@identity\.md$/m);
    assert.match(cm(), /^@ladder\/ladder\.md$/m);
  });
  check('both import targets exist, so the imports resolve from the first session', () => {
    assert.ok(existsSync(join(hub, 'identity.md')), 'identity.md');
    assert.ok(existsSync(join(hub, 'ladder', 'ladder.md')), 'ladder/ladder.md');
  });
  check('it names the live checkpoint by absolute path, and no placeholder survives', () => {
    assert.ok(cm().includes(`${hub}/checkpoint.md`), 'checkpoint path');
    assert.ok(!cm().includes('<hub>'), 'unfilled <hub>');
  });
  check('the seed ladder is honest for a fresh persona AND an import with rungs', () =>
    assert.match(readFileSync(join(hub, 'ladder', 'ladder.md'), 'utf8'), /Not yet assembled: the fold machinery builds this file from the rungs/));

  // An imported hub: the imported ladder.md outranks the seed.
  const from = join(scratch, 'old-home');
  mkdirSync(join(from, 'ladder'), { recursive: true });
  writeFileSync(join(from, 'identity.md'), 'An imported identity.\n');
  writeFileSync(join(from, 'ladder', 'ladder.md'), '# ladder — carried from the old home\n');
  writeFileSync(join(from, 'CLAUDE.md'), '# the old home’s own instructions\n');
  const hub2 = join(scratch, 'hub2');
  const importSpec = { op: 'init', hub: hub2, lane: { id: 'alpha', model: 'claude-fable-5', firstSession: { kind: 'fresh' } }, persona: { person: 'Tester', about: 'unused when importing' }, import: { from }, schedule: { sleep: '02:00', wake: '08:00' } };
  check('the preview says an imported CLAUDE.md is not carried (the preview is the build)', () =>
    assert.match(run('plan', spec(importSpec)), /the import folder's own CLAUDE\.md is not carried; merge what you want/));
  run('apply', spec(importSpec));
  check('an imported ladder.md wins over the seed (the past outranks the placeholder)', () =>
    assert.match(readFileSync(join(hub2, 'ladder', 'ladder.md'), 'utf8'), /carried from the old home/));
  check('the imported hub still gets CLAUDE.md', () => assert.ok(existsSync(join(hub2, 'CLAUDE.md'))));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
