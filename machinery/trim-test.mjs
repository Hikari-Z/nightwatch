#!/usr/bin/env node
// trim.mjs against a fixture shaped like the 2026-10-08 dead wake: a human
// prompt, then the harness's session-start entries (one of them the big
// `instructions` head), then the reply. The kept tail must carry no
// harness-loaded entry and its parentUuid chain must still walk from the
// leaf to the first kept entry with no gap. Writes only to a temp dir.
// Run: node wakecycle/trim-test.mjs   (exit 0 = all pass)
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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
add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }], usage: { input_tokens: 10, cache_read_input_tokens: 937_000 } } });
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
  check('no reply carries a copied usage figure (the 937k that blocked the wake)', kept.every((e) => e.type !== 'assistant' || !('usage' in (e.message ?? {}))), types.join(','));
  check('estimate leaves the head out', rep.estTokens < 2_000, `est ${rep.estTokens}`);
  check('report counts drops and relinks', rep.harnessDropped === 1 && rep.relinked >= 1, JSON.stringify({ d: rep.harnessDropped, r: rep.relinked }));

  // Overshoot (fix 5): one human prompt, then a long machine-only stretch
  // (tool calls and results, ~6k tokens each). A 5k target stops the walk
  // inside the stretch; the tail must reach back to the prompt, and the
  // report and stderr say how far past the target that went.
  const SID2 = '66666666-7777-8888-9999-000000000000';
  const rows2 = [];
  let p2 = null;
  const add2 = (e, i) => { const uuid = `v${i}`; rows2.push({ parentUuid: p2, uuid, sessionId: SID2, timestamp: `2026-10-08T23:${String(i).padStart(2, '0')}:00.000Z`, ...e }); p2 = uuid; };
  add2({ type: 'user', message: { role: 'user', content: 'the only human prompt' } }, 0);
  for (let i = 1; i <= 8; i++) {
    add2({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'ls' } }] } }, 2 * i - 1);
    add2({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'y '.repeat(12_000) }] } }, 2 * i);
  }
  const src2 = join(dir, `${SID2}.jsonl`);
  writeFileSync(src2, rows2.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const run2 = (target) => spawnSync(process.execPath, [join(HERE, 'trim.mjs'), src2, '--target-tokens', String(target), '--dry'], { encoding: 'utf8' });
  const over = run2(5_000);
  const rep2 = JSON.parse(over.stdout);
  check('the report names its target', rep2.targetTokens === 5_000, JSON.stringify(rep2.targetTokens));
  check('an extension far past the target is reported as overshoot', rep2.overshoot?.ratio > 5 && rep2.overshoot.extendedEntries > 0 && rep2.overshoot.walkCutAt, JSON.stringify(rep2.overshoot));
  check('and said on stderr', /OVERSHOOT, kept ~\d+ tokens against a 5000 target/.test(over.stderr), over.stderr.trim());
  check('the tail still opens at the human prompt', rep2.cutPrompt === 'the only human prompt', rep2.cutPrompt);
  const roomy = run2(200_000);
  const rep3 = JSON.parse(roomy.stdout);
  check('a fold within the target reports no overshoot', !('overshoot' in rep3) && !/OVERSHOOT/.test(roomy.stderr), JSON.stringify(rep3.overshoot));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
// Peer seam (Ra's ruling, 10/9): a cross-session message opens an exchange,
// so a tail may start on one — a cover afternoon must not reach back to the
// human's last morning prompt.
{
  const SID3 = '33333333-2222-3333-4444-555555555555';
  const rows3 = [];
  let n3 = 0; let prev3 = null;
  const add3 = (e) => { const uuid = `w${++n3}`; rows3.push({ parentUuid: prev3, uuid, sessionId: SID3, timestamp: `2026-10-09T0${Math.min(9, n3)}:00:00.000Z`, ...e }); prev3 = uuid; };
  const bulk = 'the long morning of ordinary prose work '.repeat(5_000); // ~195k chars of WORDS — not a blob run, so it bills at chars/4
  add3({ type: 'user', message: { role: 'user', content: 'the human morning prompt' } });
  add3({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: bulk }] } });
  add3({ type: 'user', isMeta: true, message: { role: 'user', content: '<cross-session-message from="x" from-name="peer">afternoon review request</cross-session-message>' } });
  add3({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the afternoon work' }] } });
  const dir3 = mkdtempSync(join(tmpdir(), 'trim-test-peer-'));
  const src3 = join(dir3, `${SID3}.jsonl`);
  writeFileSync(src3, rows3.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const rep = JSON.parse(execFileSync(process.execPath, [join(HERE, 'trim.mjs'), src3, '--target-tokens', '5000'], { encoding: 'utf8' }));
  const kept = readFileSync(rep.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const first = kept.find((e) => e.type === 'user');
  check('the tail opens at the PEER message, not the morning human prompt',
    typeof first?.message?.content === 'string' && first.message.content.includes('cross-session-message'),
    JSON.stringify(first?.message?.content)?.slice(0, 80));
  check('the bulky morning stays folded away', !kept.some((e) => e.message?.content?.[0]?.text?.length > 100_000), `kept ${kept.length}`);
  rmSync(dir3, { recursive: true, force: true });
}

// api-request entries (fix 6, 10/19): Claude Code 2.1.300+ writes its own
// request log into the transcript. A resume never loads one, so they weigh
// nothing in the estimate or the overshoot math — but they stay in the kept
// file: they are the session's record. Counting them produced the 10/16–18
// phantom overshoots (a 6.22x warning over a ~88k conversation).
{
  const SID4 = '44444444-2222-3333-4444-555555555555';
  const rows4 = []; let n4 = 0; let prev4 = null;
  const add4 = (e) => { const uuid = `r${++n4}`; rows4.push({ parentUuid: prev4, uuid, sessionId: SID4, timestamp: `2026-10-19T00:${String(n4).padStart(2, '0')}:00.000Z`, ...e }); prev4 = uuid; };
  add4({ type: 'user', message: { role: 'user', content: 'the prompt' } });
  add4({ type: 'api-request', request: { model: 'm', messages: [{ role: 'user', content: 'q '.repeat(150_000) }] } });
  add4({ type: 'api-request-blob', hash: 'h1', content: 'b '.repeat(60_000) });
  add4({ type: 'api-request-shape', shape: 's '.repeat(40_000) });
  add4({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the reply' }] } });
  const dir4 = mkdtempSync(join(tmpdir(), 'trim-test-apireq-'));
  const src4 = join(dir4, `${SID4}.jsonl`);
  writeFileSync(src4, rows4.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const run4 = spawnSync(process.execPath, [join(HERE, 'trim.mjs'), src4, '--target-tokens', '5000'], { encoding: 'utf8' });
  const rep = JSON.parse(run4.stdout);
  const kept = readFileSync(rep.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  check('all three request-log types stay in the kept file', ['api-request', 'api-request-blob', 'api-request-shape'].every((t) => kept.some((e) => e.type === t)), kept.map((e) => e.type).join(','));
  check('and weigh nothing in the estimate', rep.estTokens < 2_000, `est ${rep.estTokens}`);
  check('and never manufacture an overshoot', !('overshoot' in rep) && !/OVERSHOOT/.test(run4.stderr), `${JSON.stringify(rep.overshoot)} ${run4.stderr.trim()}`);
  rmSync(dir4, { recursive: true, force: true });
}

// OUTPUT CHECK (10/21): trim refuses to write a tail that would resume wrong.
// Each fixture below reproduces a failure that exited 0 before the check (a
// renamed chain field, a hole, a renamed isMeta). Scratch files are named with
// a uuid on purpose: trim swaps the OLD session id for the new one by plain
// substring (trim.mjs, `out`), so a one-character id such as "d" rewrites every
// "d" in the file (found while reproducing this, 10/21).
{
  const dir5 = mkdtempSync(join(tmpdir(), 'trim-test-outcheck-'));
  const pad = 'z '.repeat(6000); // ~3k tokens a tool result
  // order 'near': the meta caveat has three tool turns after it and the true
  // prompt four, so a caveat mistaken for a prompt becomes the nearest seam to
  // the 9000 target. order 'late': the caveat sits near the end, so the cut
  // stays on the true prompt and the caveat only rides in the kept tail.
  function build({ parentKey = 'parentUuid', uuidKey = 'uuid', metaKey = 'isMeta', order = 'near', mutate } = {}) {
    const rows = []; let prev = null; let n = 0;
    const add = (e) => { n++; const id = `o${n}`; rows.push({ [parentKey]: prev, [uuidKey]: id, sessionId: 'x', timestamp: `2026-10-21T10:${String(n).padStart(2, '0')}:00.000Z`, ...e }); prev = id; };
    const human = (c) => add({ type: 'user', userType: 'external', message: { role: 'user', content: c } });
    const tool = (i) => { add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'ls' } }] } }); add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: pad }] } }); };
    const caveat = () => add({ type: 'user', userType: 'external', [metaKey]: true, message: { role: 'user', content: '<local-command-caveat>Caveat: the messages below were generated by the user while running local commands.</local-command-caveat>' } });
    const stdout = () => add({ type: 'user', userType: 'external', message: { role: 'user', content: '<local-command-stdout>Context Usage</local-command-stdout>' } }); // a real user-role entry, isMeta false
    const peer = () => add({ type: 'user', userType: 'external', [metaKey]: true, message: { role: 'user', content: 'Another Claude session sent a message while you were working:\n<cross-session-message from="x">hi</cross-session-message>' } });
    human('first human prompt'); tool(1);
    human('second human prompt (the true seam)');
    add({ type: 'attachment', attachment: { type: 'instructions', files: [{ path: 'CLAUDE.md', content: 'i'.repeat(8000) }] } });
    if (order === 'near') { tool(2); caveat(); tool(3); tool(4); tool(5); }
    else { tool(2); tool(3); tool(4); caveat(); stdout(); peer(); tool(5); }
    add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'final reply' }], usage: { input_tokens: 5, cache_read_input_tokens: 10 } } });
    if (mutate) mutate(rows);
    return rows;
  }
  let k = 0;
  function run(rows, extra = []) {
    const sid = `${String(++k).padStart(8, '0')}-aaaa-4000-8000-000000000000`;
    const before = readdirSync(dir5).length;
    writeFileSync(join(dir5, `${sid}.jsonl`), [...rows.map((r) => JSON.stringify(r)), ...extra].join('\n') + '\n');
    const r = spawnSync(process.execPath, [join(HERE, 'trim.mjs'), join(dir5, `${sid}.jsonl`), '--target-tokens', '9000'], { encoding: 'utf8' });
    return { r, wrote: readdirSync(dir5).length - before - 1 }; // files besides the source
  }
  const refused = (res, re) => res.r.status === 1 && re.test(res.r.stderr) && res.wrote === 0;

  const good = run(build({ order: 'late' }));
  check('a well-formed session passes the output check (the real wrapper shapes included)', good.r.status === 0 && good.wrote === 1, `${good.r.status} ${good.r.stderr.trim()}`);
  const goodNear = run(build({ order: 'near' }));
  check('and so does the near-wrapper fixture when the format is intact', goodNear.r.status === 0, `${goodNear.r.status} ${goodNear.r.stderr.trim()}`);

  // The first kept entry keeps its REAL parentUuid (the entry just before the
  // cut), which is by definition not in the tail. The hole check exempts it;
  // without the exemption every ordinary fold would be refused (Opus's second
  // read of #30). The precondition proves the fixture has that shape.
  {
    const keptRows = readFileSync(JSON.parse(good.r.stdout).path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const inTail = new Set(keptRows.map((e) => e.uuid));
    check('an ordinary cut: the first kept entry points at the entry before the cut, outside the tail', Boolean(keptRows[0].parentUuid) && !inTail.has(keptRows[0].parentUuid), JSON.stringify(keptRows[0].parentUuid));
    check('and the tail is accepted anyway (the exemption is pinned)', good.r.status === 0 && good.wrote === 1, `${good.r.status} ${good.r.stderr.trim()}`);
  }
  check('parentUuid renamed: refused, nothing written (relinking would no-op and leave a hole)', refused(run(build({ parentKey: 'parent_uuid' })), /lack a uuid or a parentUuid/), '');
  check('uuid renamed: refused, nothing written', refused(run(build({ uuidKey: 'id' })), /lack a uuid or a parentUuid/), '');
  check('a kept entry whose parent is not in the tail: refused, nothing written', refused(run(build({ order: 'late', mutate: (rows) => { rows.at(-1).parentUuid = 'nowhere'; } })), /not in the tail/), '');
  check('isMeta renamed, cut stays on the prompt: refused (wrapper rides in the tail unmarked)', refused(run(build({ order: 'late', metaKey: 'meta' })), /not marked isMeta/), '');
  check('isMeta renamed, cut lands ON the caveat: refused (the repro that moved the cut)', refused(run(build({ order: 'near', metaKey: 'meta' })), /not marked isMeta/), '');

  const torn = run(build({ order: 'late' }), ['{"type":"user","message":{"cont', 'not json at all']);
  const tornRep = torn.r.status === 0 ? JSON.parse(torn.r.stdout) : {};
  check('torn lines are counted in the report (they reach the fold row)', tornRep.tornLines === 2, JSON.stringify(tornRep.tornLines));
  check('and a clean file reports none', JSON.parse(good.r.stdout).tornLines === 0, '');
  rmSync(dir5, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : '\nall pass');
process.exit(fails ? 1 : 0);
