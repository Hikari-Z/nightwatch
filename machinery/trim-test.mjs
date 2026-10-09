#!/usr/bin/env node
// trim.mjs against a fixture shaped like the 2026-10-08 dead wake: a human
// prompt, then the harness's session-start entries (one of them the big
// `instructions` head), then the reply. The kept tail must carry no
// harness-loaded entry and its parentUuid chain must still walk from the
// leaf to the first kept entry with no gap. Writes only to a temp dir.
// Run: node wakecycle/trim-test.mjs   (exit 0 = all pass)
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'trim-test-'));
const SID = '11111111-2222-3333-4444-555555555555';
let n = 0;
let prev = null;
const rows = [];
function add(e) {
  const uuid = `u${++n}`;
  rows.push({ parentUuid: prev, uuid, sessionId: SID, timestamp: `2026-10-08T22:${String(n).padStart(2, '0')}:00.000Z`, ...e });
  prev = uuid;
}
const big = 'x'.repeat(40_000);
add({ type: 'user', message: { role: 'user', content: 'earlier human prompt' } });
add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] } });
add({ type: 'user', message: { role: 'user', content: 'welcome back' } });
add({ type: 'attachment', attachment: { type: 'environment', text: 'env' } });
add({ type: 'attachment', attachment: { type: 'skill_listing', content: 'skills' } });
add({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: 'CLAUDE.md', content: big }] } });
add({ type: 'attachment', attachment: { type: 'total_tokens_reminder' } });
add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } });
const src = join(dir, `${SID}.jsonl`);
writeFileSync(src, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

let fails = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) fails++;
}

try {
  const rep = JSON.parse(execFileSync(process.execPath, [join(HERE, 'trim.mjs'), src, '--target-tokens', '100000'], { encoding: 'utf8' }));
  const kept = readFileSync(rep.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const types = kept.map((e) => e.attachment?.type ?? e.type);
  check('no instructions entry kept', !types.includes('instructions'), types.join(','));
  check('per-turn and delta entries kept (environment, total_tokens_reminder, skill_listing)', ['environment', 'total_tokens_reminder', 'skill_listing'].every((k) => types.includes(k)), types.join(','));
  check('conversation kept', kept.some((e) => e.message?.content === 'welcome back') && kept.at(-1).message?.content?.[0]?.text === 'reply');
  // Walk the chain from the leaf the way the harness does.
  const byId = new Map(kept.map((e) => [e.uuid, e]));
  let cur = kept.at(-1);
  let walked = 1;
  while (cur.parentUuid && byId.has(cur.parentUuid)) { cur = byId.get(cur.parentUuid); walked++; }
  check('chain walks leaf → first kept entry with no gap', walked === kept.length, `walked ${walked} of ${kept.length}`);
  check('estimate leaves the head out', rep.estTokens < 2_000, `est ${rep.estTokens}`);
  check('report counts drops and relinks', rep.harnessDropped === 1 && rep.relinked >= 1, JSON.stringify({ d: rep.harnessDropped, r: rep.relinked }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nall pass');
process.exit(fails ? 1 : 0);
