#!/usr/bin/env node
// deadwake.mjs against the 2026-10-08 chain, rebuilt small:
//   LIVE (ran all day) --fold--> TAIL1 --wake--> DEAD1 ("Prompt is too long")
//   DEAD1 --refold--> TAIL2 --wake--> DEAD2 ("Prompt is too long")
// plus WORKED: woken from TAIL1, did real turns, THEN hit the limit.
// Expect: DEAD2 and DEAD1 resolve to LIVE; LIVE and WORKED resolve to
// themselves; cannotAnswer is true only for sessions whose newest reply
// says the prompt is too long. Temp dir only.
// Run: node wakecycle/deadwake-test.mjs   (exit 0 = all pass)
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFoldSource, cannotAnswer } from './deadwake.mjs';

const dir = mkdtempSync(join(tmpdir(), 'deadwake-test-'));
const write = (sid, rows) => writeFileSync(join(dir, `${sid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const user = (uuid, text) => ({ type: 'user', uuid, message: { role: 'user', content: text } });
const reply = (uuid, text) => ({ type: 'assistant', uuid, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] } });
const tooLong = (uuid) => ({ type: 'assistant', uuid, isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'Prompt is too long' }] } });
const noReply = (uuid) => ({ type: 'assistant', uuid, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } });
const head = (uuid) => ({ type: 'attachment', uuid, attachment: { type: 'instructions', files: [] } });

const early = [user('a', 'morning'), reply('b', 'on it')];
const late = [user('c', 'two notes'), reply('d', 'done')];
write('LIVE', [...early, ...late]);
write('TAIL1', late);                                                  // fold of LIVE
write('DEAD1', [...late, noReply('e'), user('f', 'welcome back'), head('g'), tooLong('h')]);
write('TAIL2', [user('f', 'welcome back'), head('g'), tooLong('h')]);  // refold of DEAD1
write('DEAD2', [user('f', 'welcome back'), head('g'), tooLong('h'), user('i', 'again'), head('j'), tooLong('k')]);
write('WORKED', [...late, user('l', 'next'), reply('m', 'real work'), user('n', 'more'), tooLong('o')]);
const foldsPath = join(dir, 'folds.jsonl');
writeFileSync(foldsPath, [
  { source: 'jsonl:LIVE', tail: 'TAIL1' },
  { source: 'jsonl:DEAD1', tail: 'TAIL2' },
].map((r) => JSON.stringify(r)).join('\n') + '\n');

let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) fails++;
}
const r = (sid) => resolveFoldSource(sid, { transcripts: dir, foldsPath });
try {
  const d2 = r('DEAD2');
  check('second dead wake walks back to the session that ran', d2.sid === 'LIVE' && d2.skipped.join() === 'DEAD2,DEAD1', d2);
  const d1 = r('DEAD1');
  check('first dead wake folds its source', d1.sid === 'LIVE' && d1.skipped.join() === 'DEAD1', d1);
  check('a live session folds as itself', r('LIVE').sid === 'LIVE' && r('LIVE').skipped.length === 0, r('LIVE'));
  const wk = r('WORKED');
  check('worked, then hit the limit: its own turns are the record', wk.sid === 'WORKED' && wk.skipped.length === 0, wk);
  check('cannotAnswer: dead and worked-then-full are true', cannotAnswer(join(dir, 'DEAD2.jsonl')) && cannotAnswer(join(dir, 'WORKED.jsonl')));
  check('cannotAnswer: a live session is false', !cannotAnswer(join(dir, 'LIVE.jsonl')));
  check('cannotAnswer: a missing file is false, never a throw', cannotAnswer(join(dir, 'NOPE.jsonl')) === false);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall pass');
process.exit(fails ? 1 : 0);
