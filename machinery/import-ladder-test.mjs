#!/usr/bin/env node
// import-ladder-test — issue #4: an import's rungs must land where sleep.mjs
// reads them (ladder/L1–L4), whichever layout the source used: flat rungs go
// by their own level, level directories keep theirs. ladder.md is carried as
// the assembled ladder, not counted as a rung; a flat .md with no level is
// named in the preview and left behind. Scratch-only, per the rehearsal law.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); } };

const scratch = mkdtempSync(join(tmpdir(), 'nw-importladder-'));
const spec = (o) => { const p = join(scratch, `${Math.random().toString(36).slice(2)}.json`); writeFileSync(p, JSON.stringify(o)); return p; };
const run = (cmd, arg) => {
  const env = { ...process.env, WEFT_NW_NO_ACTIVATE: '1' };
  delete env.WEFT_CONFIG; delete env.NIGHTWATCH_CONFIG;
  return execFileSync(process.execPath, [join(HERE, 'nightwatch.mjs'), cmd, arg], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
};
const rung = (fm, body = '## Sequence\n1. a day\n') => `---\n${fm}\n---\n\n${body}`;
const initSpec = (hub, from) => ({ op: 'init', hub, lane: { id: 'alpha', model: 'claude-fable-5', firstSession: { kind: 'fresh' } }, persona: { person: 'Tester', about: 'unused when importing' }, import: { from }, schedule: { sleep: '02:00', wake: '08:00' } });

try {
  // A source with every shape a ladder arrives in.
  const from = join(scratch, 'old-home');
  mkdirSync(join(from, 'ladder', 'L2'), { recursive: true });
  mkdirSync(join(from, 'ladder', 'checkpoints'), { recursive: true });
  writeFileSync(join(from, 'identity.md'), 'An imported identity.\n');
  writeFileSync(join(from, 'ladder', 'day-one.md'), rung('id: L2-2026-01-01-day-one\nlevel: 2'));         // flat, numeric level
  writeFileSync(join(from, 'ladder', 'evening.md'), rung('id: L1-2026-01-02-evening\nlevel: L1'));         // flat, L-prefixed level
  writeFileSync(join(from, 'ladder', 'week.md'), rung('id: L3-2026-W01-first-week'));                      // flat, level only in the id
  writeFileSync(join(from, 'ladder', 'L2-2026-01-03-bare.md'), '## Sequence\n1. no frontmatter at all\n'); // flat, level only in the filename
  writeFileSync(join(from, 'ladder', 'notes.md'), '# scratch notes, not a rung\n');                        // flat, no level: not a rung
  writeFileSync(join(from, 'ladder', 'ladder.md'), '# ladder — carried from the old home\n');               // the assembled ladder
  writeFileSync(join(from, 'ladder', 'L2', 'L2-2026-01-04-filed.md'), rung('id: L2-2026-01-04-filed\nlevel: 2')); // already in a level dir
  writeFileSync(join(from, 'ladder', 'checkpoints', 'old.md'), '# an old checkpoint\n');                   // not ladder content

  const info = JSON.parse(run('inspect-import', from));
  check('inspect counts rungs, not ladder.md or notes (Weft\'s over-count)', () => assert.strictEqual(info.rungs, 5));
  check('inspect names the file it would leave behind', () => assert.deepStrictEqual(info.notRungs, ['notes.md']));

  const hub = join(scratch, 'hub');
  const plan = run('plan', spec(initSpec(hub, from)));
  check('the preview says 5 rungs, by level (the preview is the build)', () => {
    assert.match(plan, /5 rung\(s\)/);
    assert.match(plan, /each rung into ladder\/L1–L4 by its own level/);
  });
  check('the preview says the imported ladder.md replaces the seed', () => assert.match(plan, /imported ladder\.md replaces the seed/));
  check('the preview names what is not carried', () => assert.match(plan, /not carried, no level so not a rung: notes\.md/));

  run('apply', spec(initSpec(hub, from)));
  const L = (...p) => join(hub, 'ladder', ...p);
  check('flat rungs land in the level their frontmatter names', () => {
    assert.ok(existsSync(L('L2', 'day-one.md')), 'level: 2 → L2');
    assert.ok(existsSync(L('L1', 'evening.md')), 'level: L1 → L1');
  });
  check('a rung with only an id, or only a filename, still finds its level', () => {
    assert.ok(existsSync(L('L3', 'week.md')), 'id: L3-… → L3');
    assert.ok(existsSync(L('L2', 'L2-2026-01-03-bare.md')), 'L2-… filename → L2');
  });
  check('a rung already in a level directory keeps it', () => assert.ok(existsSync(L('L2', 'L2-2026-01-04-filed.md'))));
  check('nothing lands flat in ladder/ but ladder.md and index.json', () =>
    assert.deepStrictEqual(readdirSync(L()).filter((f) => !/^L[1-4]$/.test(f)).sort(), ['index.json', 'ladder.md']));
  check('the not-a-rung file and the checkpoints folder are left behind', () => {
    assert.ok(!existsSync(L('notes.md')) && !existsSync(L('L2', 'notes.md')), 'notes.md');
    assert.ok(!existsSync(L('checkpoints')), 'checkpoints/');
  });
  check('the imported ladder.md outranks the seed', () => assert.match(readFileSync(L('ladder.md'), 'utf8'), /carried from the old home/));
  check('rungs arrive as they were', () => assert.strictEqual(readFileSync(L('L1', 'evening.md'), 'utf8'), readFileSync(join(from, 'ladder', 'evening.md'), 'utf8')));

  // The receipt that matters: the REAL sleep.mjs, folding the imported hub,
  // assembles every imported rung into ladder.md (the bench is archive-test's).
  const transcripts = join(scratch, 'transcripts');
  mkdirSync(transcripts, { recursive: true });
  const sid = 'aaaaaaaa-0000-4000-8000-000000000001';
  const rows = []; let prev = null;
  for (let i = 0; i < 3; i++) for (const e of [
    { type: 'user', message: { role: 'user', content: `prompt ${i}` } },
    { type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: `reply ${i}` }] } },
  ]) { const uuid = `u-${rows.length}`; rows.push({ parentUuid: prev, uuid, sessionId: sid, timestamp: `2026-10-11T10:0${rows.length}:00.000Z`, ...e }); prev = uuid; }
  writeFileSync(join(transcripts, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (!existsSync(L('folds.jsonl'))) writeFileSync(L('folds.jsonl'), '');
  const benchConfig = join(scratch, 'bench.config.json');
  writeFileSync(benchConfig, JSON.stringify({ weftRoot: hub, defaultLane: 'alpha', timezone: 'America/Los_Angeles', lanes: { alpha: { targetTokens: 250000 } }, paths: { transcripts, machinery: HERE } }));
  const fold = spawnSync(process.execPath, [join(HERE, 'sleep.mjs'), '--lane', 'alpha', '--session', sid, '--no-rung'], { encoding: 'utf8', env: { ...process.env, WEFT_CONFIG: benchConfig, NIGHTWATCH_CONFIG: '', CLAUDE_CODE_SESSION_ID: '' } });
  check('a real fold of the imported hub succeeds', () => assert.strictEqual(fold.status, 0, fold.stderr));
  check('and its ladder.md carries every imported rung', () => {
    const assembled = readFileSync(L('ladder.md'), 'utf8');
    for (const id of ['L2-2026-01-01-day-one', 'L1-2026-01-02-evening', 'L3-2026-W01-first-week', 'L2-2026-01-04-filed']) assert.ok(assembled.includes(id), id);
  });

  // Two sources bound for one place: plan and apply both refuse, before anything is made.
  const clash = join(scratch, 'clash-home');
  mkdirSync(join(clash, 'ladder', 'L2'), { recursive: true });
  writeFileSync(join(clash, 'identity.md'), 'A clashing identity.\n');
  writeFileSync(join(clash, 'ladder', 'L2-x.md'), rung('id: L2-x\nlevel: 2'));
  writeFileSync(join(clash, 'ladder', 'L2', 'L2-x.md'), rung('id: L2-x\nlevel: 2'));
  const hub3 = join(scratch, 'hub3');
  for (const cmd of ['plan', 'apply']) {
    check(`${cmd} refuses two rungs bound for one file, and says which`, () => {
      let msg = '';
      try { run(cmd, spec(initSpec(hub3, clash))); } catch (e) { msg = `${e.stdout}${e.stderr}`; }
      assert.match(msg, /would both land at ladder\/L2\/L2-x\.md/);
      assert.ok(!existsSync(hub3), 'no hub was made');
    });
  }

  // A source with no ladder at all still imports.
  const bare = join(scratch, 'bare-home');
  mkdirSync(bare, { recursive: true });
  writeFileSync(join(bare, 'identity.md'), 'A bare identity.\n');
  check('a source with no ladder/ imports with 0 rungs', () => assert.strictEqual(JSON.parse(run('inspect-import', bare)).rungs, 0));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
