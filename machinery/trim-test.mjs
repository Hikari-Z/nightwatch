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
import { spawnSync } from 'node:child_process';
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

// A trim that exits nonzero where a fixture expects a tail is a FAILED CHECK, not
// a crash: execFileSync threw, the script died with 12 PASS lines and no FAIL
// line, and a second reader took the red for green (#30, 10/21).
function trimOrFail(label, path, target) {
  const r = spawnSync(process.execPath, [join(HERE, 'trim.mjs'), path, '--target-tokens', String(target)], { encoding: 'utf8' });
  if (r.status !== 0) {
    check(`trim accepts the ${label} fixture`, false, `exit ${r.status}: ${r.stderr.trim().split('\n').pop()}`);
    console.log(`\n${fails} FAILED`);
    process.exit(1);
  }
  return JSON.parse(r.stdout);
}

try {
  const rep = trimOrFail('first', src, 100000);
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
  const rep = trimOrFail('peer-seam', src3, 5000);
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
  // A row written ABOVE the tail it continues (10/27, nightwatch#56): a woken
  // session's SessionStart hook attachment sat at the top of the file, parented
  // to the resumed tail's last row, and the first prompt after the wake was
  // parented to it. Main's positional cut left it out and refused every fold.
  {
    const wake = (rows) => {
      const end = rows.at(-1).uuid;
      rows.unshift({ type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart', content: 'registered' }, parentUuid: end, uuid: 'hk', sessionId: 'x', timestamp: '2026-10-21T11:00:00.000Z' });
      rows.push({ type: 'user', userType: 'external', message: { role: 'user', content: 'the first prompt after the wake' }, parentUuid: 'hk', uuid: 'w1', sessionId: 'x', timestamp: '2026-10-21T11:01:00.000Z' });
      rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answered' }] }, parentUuid: 'w1', uuid: 'w2', sessionId: 'x', timestamp: '2026-10-21T11:02:00.000Z' });
    };
    const res = run(build({ order: 'late', mutate: wake }));
    check('a row above the tail it continues: the fold is accepted', res.r.status === 0 && res.wrote === 1, `${res.r.status} ${res.r.stderr.trim()}`);
    if (res.r.status === 0) {
      const rep = JSON.parse(res.r.stdout);
      const keptRows = readFileSync(rep.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const at = keptRows.findIndex((e) => e.uuid === 'hk');
      check('and that row is kept, right after its parent', at > 0 && keptRows[at - 1].uuid === keptRows[at].parentUuid, `at ${at}`);
      const byId = new Map(keptRows.map((e) => [e.uuid, e]));
      let cur = keptRows.at(-1); let walked = 1;
      while (cur.parentUuid && byId.has(cur.parentUuid)) { cur = byId.get(cur.parentUuid); walked++; }
      const convo = keptRows.filter((e) => e.uuid).length;
      check('the chain walks from the leaf through it to the first kept entry', walked === convo, `walked ${walked} of ${convo}`);
      check('the report counts it (movedIn)', rep.movedIn === 1, JSON.stringify(rep.movedIn));
    }
  }
  // A CHAIN of start-of-file attachments, the shape real resumed sessions write (nightwatch#56 review, Sonnet; 14 such
  // rows in 2 of 1,140 archived transcripts): an `instructions` row (harness-loaded, so DROPPED) parented to the tail's
  // end, and two attachments parented to it in turn, then the first prompt after the wake parented to the last of them.
  // Pins the closure (rows parented to a moved row move too) and the relink past a moved-then-dropped row.
  {
    let endId;
    const chain = (rows) => {
      endId = rows.at(-1).uuid;
      rows.unshift(
        { type: 'attachment', attachment: { type: 'instructions', files: [{ path: 'CLAUDE.md', content: 'i'.repeat(500) }] }, parentUuid: endId, uuid: 'x1', sessionId: 'x', timestamp: '2026-10-21T11:00:00.000Z' },
        { type: 'attachment', attachment: { type: 'session_context', content: 'ctx' }, parentUuid: 'x1', uuid: 'x2', sessionId: 'x', timestamp: '2026-10-21T11:00:01.000Z' },
        { type: 'attachment', attachment: { type: 'credential_org', content: 'org' }, parentUuid: 'x2', uuid: 'x3', sessionId: 'x', timestamp: '2026-10-21T11:00:02.000Z' });
      rows.push({ type: 'user', userType: 'external', message: { role: 'user', content: 'first prompt after the wake' }, parentUuid: 'x3', uuid: 'w1', sessionId: 'x', timestamp: '2026-10-21T11:01:00.000Z' });
      rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answered' }] }, parentUuid: 'w1', uuid: 'w2', sessionId: 'x', timestamp: '2026-10-21T11:02:00.000Z' });
    };
    const res = run(build({ order: 'late', mutate: chain }));
    check('a chain of rows above the tail: the fold is accepted', res.r.status === 0 && res.wrote === 1, `${res.r.status} ${res.r.stderr.trim()}`);
    if (res.r.status === 0) {
      const rep = JSON.parse(res.r.stdout);
      const keptRows = readFileSync(rep.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const byId = new Map(keptRows.map((e) => [e.uuid, e]));
      check('…all three rows moved in (the closure), and the report counts them', rep.movedIn === 3, JSON.stringify(rep.movedIn));
      check('…the harness-loaded one is dropped and not kept', !byId.has('x1') && byId.has('x2') && byId.has('x3'), [...byId.keys()].filter((k) => k.startsWith('x')).join());
      check('…its child is re-pointed at the dropped row\'s parent, so the chain has no hole', byId.get('x2')?.parentUuid === endId, String(byId.get('x2')?.parentUuid));
      let cur = keptRows.at(-1); let walked = 1;
      while (cur.parentUuid && byId.has(cur.parentUuid)) { cur = byId.get(cur.parentUuid); walked++; }
      check('…and the chain walks from the leaf through all of it to the first kept entry', walked === keptRows.filter((e) => e.uuid).length, `walked ${walked} of ${keptRows.filter((e) => e.uuid).length}`);
    }
  }
  // The same chain written in REVERSED file order (grandchild above parent above
  // its parent); pins the repeat loop. A CHAIN of start-of-file attachments, the shape real resumed sessions write (nightwatch#56 review, Sonnet; 14 such
  // rows in 2 of 1,140 archived transcripts): an `instructions` row (harness-loaded, so DROPPED) parented to the tail's
  // end, and two attachments parented to it in turn, then the first prompt after the wake parented to the last of them.
  // Pins the closure (rows parented to a moved row move too) and the relink past a moved-then-dropped row.
  {
    let endId;
    const chain = (rows) => {
      endId = rows.at(-1).uuid;
      rows.unshift(
        { type: 'attachment', attachment: { type: 'credential_org', content: 'org' }, parentUuid: 'x2', uuid: 'x3', sessionId: 'x', timestamp: '2026-10-21T11:00:02.000Z' },
        { type: 'attachment', attachment: { type: 'session_context', content: 'ctx' }, parentUuid: 'x1', uuid: 'x2', sessionId: 'x', timestamp: '2026-10-21T11:00:01.000Z' },
        { type: 'attachment', attachment: { type: 'instructions', files: [{ path: 'CLAUDE.md', content: 'i'.repeat(500) }] }, parentUuid: endId, uuid: 'x1', sessionId: 'x', timestamp: '2026-10-21T11:00:00.000Z' });
      rows.push({ type: 'user', userType: 'external', message: { role: 'user', content: 'first prompt after the wake' }, parentUuid: 'x3', uuid: 'w1', sessionId: 'x', timestamp: '2026-10-21T11:01:00.000Z' });
      rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answered' }] }, parentUuid: 'w1', uuid: 'w2', sessionId: 'x', timestamp: '2026-10-21T11:02:00.000Z' });
    };
    const res = run(build({ order: 'late', mutate: chain }));
    check('a chain of rows above the tail: the fold is accepted (reversed)', res.r.status === 0 && res.wrote === 1, `${res.r.status} ${res.r.stderr.trim()}`);
    if (res.r.status === 0) {
      const rep = JSON.parse(res.r.stdout);
      const keptRows = readFileSync(rep.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const byId = new Map(keptRows.map((e) => [e.uuid, e]));
      check('…all three rows moved in (the closure), and the report counts them (reversed)', rep.movedIn === 3, JSON.stringify(rep.movedIn));
      check('…the harness-loaded one is dropped and not kept (reversed)', !byId.has('x1') && byId.has('x2') && byId.has('x3'), [...byId.keys()].filter((k) => k.startsWith('x')).join());
      check('…its child is re-pointed at the dropped row\'s parent, so the chain has no hole (reversed)', byId.get('x2')?.parentUuid === endId, String(byId.get('x2')?.parentUuid));
      let cur = keptRows.at(-1); let walked = 1;
      while (cur.parentUuid && byId.has(cur.parentUuid)) { cur = byId.get(cur.parentUuid); walked++; }
      check('…and the chain walks from the leaf through all of it to the first kept entry (reversed)', walked === keptRows.filter((e) => e.uuid).length, `walked ${walked} of ${keptRows.filter((e) => e.uuid).length}`);
    }
  }
  // Two siblings written above the tail, both children of its last row: they
  // move in keeping their file order (the splice once reversed them).
  {
    const sibs = (rows) => {
      const end = rows.at(-1).uuid;
      rows.unshift(
        { type: 'attachment', attachment: { type: 'hook_success', content: 'first' }, parentUuid: end, uuid: 's1', sessionId: 'x', timestamp: '2026-10-21T11:00:00.000Z' },
        { type: 'attachment', attachment: { type: 'hook_success', content: 'second' }, parentUuid: end, uuid: 's2', sessionId: 'x', timestamp: '2026-10-21T11:00:01.000Z' });
      rows.push({ type: 'user', userType: 'external', message: { role: 'user', content: 'after the wake' }, parentUuid: 's2', uuid: 'w1', sessionId: 'x', timestamp: '2026-10-21T11:01:00.000Z' });
    };
    const res = run(build({ order: 'late', mutate: sibs }));
    const keptRows = res.r.status === 0 ? readFileSync(JSON.parse(res.r.stdout).path, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    const ids = keptRows.map((e) => e.uuid);
    check('two siblings above the tail move in, in their file order', res.r.status === 0 && ids.indexOf('s1') > 0 && ids.indexOf('s1') + 1 === ids.indexOf('s2'), `${res.r.status} ${ids.filter((x) => /^s\d/.test(x)).join()}`);
  }
  // A cascade past MAX_MOVED_IN (21 rows above the tail, chained to its end):
  // refused, nothing written, rather than a silently bloated tail.
  {
    const many = (rows) => {
      let parent = rows.at(-1).uuid;
      const top = [];
      for (let i = 1; i <= 21; i++) { top.push({ type: 'attachment', attachment: { type: 'hook_success', content: `h${i}` }, parentUuid: parent, uuid: `m${i}`, sessionId: 'x', timestamp: '2026-10-21T11:00:00.000Z' }); parent = `m${i}`; }
      rows.unshift(...top);
      rows.push({ type: 'user', userType: 'external', message: { role: 'user', content: 'after the wake' }, parentUuid: parent, uuid: 'w1', sessionId: 'x', timestamp: '2026-10-21T11:01:00.000Z' });
    };
    check('more than 20 rows to move in: refused, nothing written', refused(run(build({ order: 'late', mutate: many })), /rows written above the tail would move into it/), '');
  }
  // The cap's boundary (nightwatch#57 review, Sonnet): exactly MAX_MOVED_IN (20) rows written above the tail are
  // ACCEPTED; the 21-row case above is refused. Pins `>` against `>=` and the constant against 19/21.
  {
    const nAbove = (n) => (rows) => {
      const end = rows.at(-1).uuid; const above = []; let prev = end;
      for (let k = 1; k <= n; k++) { above.push({ type: 'attachment', attachment: { type: 'credential_org', content: `org${k}` }, parentUuid: prev, uuid: `c${k}`, sessionId: 'x', timestamp: '2026-10-21T11:00:00.000Z' }); prev = `c${k}`; }
      rows.unshift(...above);
      rows.push({ type: 'user', userType: 'external', message: { role: 'user', content: 'first prompt after the wake' }, parentUuid: prev, uuid: 'w1', sessionId: 'x', timestamp: '2026-10-21T11:01:00.000Z' });
      rows.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'answered' }] }, parentUuid: 'w1', uuid: 'w2', sessionId: 'x', timestamp: '2026-10-21T11:02:00.000Z' });
    };
    const at20 = run(build({ order: 'late', mutate: nAbove(20) }));
    check('exactly 20 rows above the tail: accepted, and counted', at20.r.status === 0 && at20.wrote === 1 && JSON.parse(at20.r.stdout).movedIn === 20, `${at20.r.status} ${at20.r.stderr.trim()}`);
  }
  check('isMeta renamed, cut stays on the prompt: refused (wrapper rides in the tail unmarked)', refused(run(build({ order: 'late', metaKey: 'meta' })), /not marked isMeta/), '');
  check('isMeta renamed, cut lands ON the caveat: refused (the repro that moved the cut)', refused(run(build({ order: 'near', metaKey: 'meta' })), /not marked isMeta/), '');

  // `usage` renamed: the stale figure would travel (the 10/8 refusal). The check
  // looks for the token FIELDS as numeric keys on a kept assistant entry, never
  // for the word `usage` and never in text.
  const renameUsage = (to) => (rows) => { const m = rows.at(-1).message; m[to] = m.usage; delete m.usage; };
  check('usage renamed inside the message: refused, nothing written', refused(run(build({ order: 'late', mutate: renameUsage('token_usage') })), /token-usage record/), '');
  check('usage moved to a top-level key of the entry: refused', refused(run(build({ order: 'late', mutate: (rows) => { const e = rows.at(-1); e.tokenUsage = e.message.usage; delete e.message.usage; } })), /token-usage record/), '');
  const naming = run(build({ order: 'late', mutate: (rows) => {
    // Everything below names or even holds the token fields and is normal in this house's transcripts:
    // text, a tool call whose INPUT has a numeric input_tokens key (an assistant `content` block), a
    // wireToolInputs copy of it, a plain-text mention in an in-scope field, and a user-side tool result
    // that carries them as keys. The tool result is the LAST one, so it is inside the kept tail.
    const reply = rows.at(-1);
    reply.message.content[0].text = 'the trimmer strips input_tokens and cache_read_input_tokens from message.usage';
    reply.message.content.push({ type: 'tool_use', id: 'tz', name: 'Calc', input: { input_tokens: 5, cache_read_input_tokens: 937000 } });
    reply.wireToolInputs = [{ input: { input_tokens: 5 } }];
    reply.requestNote = 'see cache_read_input_tokens in the docs';
    const tr = rows.filter((e) => Array.isArray(e.message?.content) && e.message.content[0]?.type === 'tool_result').at(-1);
    tr.message.content[0].content = 'usage: {"cache_read_input_tokens": 937000, "input_tokens": 10}';
    tr.toolUseResult = { input_tokens: 5, cache_read_input_tokens: 937000 };
  } }));
  check('text, tool inputs, wireToolInputs and user-side results that carry the token fields pass (keys on kept replies outside content only)', naming.r.status === 0 && naming.wrote === 1, `${naming.r.status} ${naming.r.stderr.trim()}`);
  {
    const namingOut = readFileSync(JSON.parse(naming.r.stdout).path, 'utf8');
    check('and that fixture really kept them (not vacuous): the user-side result and the tool call are in the tail', namingOut.includes('"toolUseResult"') && namingOut.includes('"name":"Calc"'), '');
  }

  const torn = run(build({ order: 'late' }), ['{"type":"user","message":{"cont', 'not json at all']);
  const tornRep = torn.r.status === 0 ? JSON.parse(torn.r.stdout) : {};
  check('torn lines are counted in the report (they reach the fold row)', tornRep.tornLines === 2, JSON.stringify(tornRep.tornLines));
  check('and a clean file reports none', JSON.parse(good.r.stdout).tornLines === 0, '');
  rmSync(dir5, { recursive: true, force: true });
}

// claudeVersion: the newest version Claude Code stamped on a kept entry (the
// writer of the tail). Junk is not a version, an unstamped file reports none.
{
  const dirV = mkdtempSync(join(tmpdir(), 'trim-test-ver-'));
  const SIDV = '77777777-2222-3333-4444-555555555555';
  const mk = (versions, { target = 200000, bulk = false } = {}) => {
    const rowsV = versions.map((v, i) => ({
      parentUuid: i ? `x${i - 1}` : null, uuid: `x${i}`, sessionId: SIDV, timestamp: `2026-10-25T10:${String(i).padStart(2, '0')}:00.000Z`,
      ...(i % 2 === 0 ? { type: 'user', message: { role: 'user', content: `prompt ${i}` } } : { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: bulk && i >= 3 ? 'the long morning of ordinary prose work '.repeat(1_000) : `reply ${i}` }] } }),
      ...(v === undefined ? {} : { version: v }),
    }));
    const f = join(dirV, `${SIDV}.jsonl`);
    writeFileSync(f, rowsV.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = spawnSync(process.execPath, [join(HERE, 'trim.mjs'), f, '--target-tokens', String(target), '--dry'], { encoding: 'utf8' });
    return r.status === 0 ? JSON.parse(r.stdout) : { exit: r.status, err: r.stderr.trim().split('\n').pop() };
  };
  const stamped = mk(['2.1.308', '2.1.309', undefined, '2.1.310', 'latest']);
  check('claudeVersion is the newest valid version on a kept entry (a trailing junk value is skipped)', stamped.claudeVersion === '2.1.310', JSON.stringify(stamped.claudeVersion ?? stamped));
  const none = mk([undefined, undefined, undefined, undefined]);
  check('an unstamped file reports no claudeVersion at all', none.keptEntries > 0 && !('claudeVersion' in none), JSON.stringify(none));
  const onlyJunk = mk(['latest', 7, '', null]);
  check('only junk values report none', onlyJunk.keptEntries > 0 && !('claudeVersion' in onlyJunk), JSON.stringify(onlyJunk));
  // Only the kept tail's writer counts: a version stamped before the cut is gone with it.
  const cutOff = mk(['2.1.300', undefined, undefined, undefined], { target: 5_000, bulk: true });
  check('(the fixture really cuts the stamped entries off: 2 of 4 kept)', cutOff.keptEntries === 2 && cutOff.totalEntries === 4, JSON.stringify({ k: cutOff.keptEntries, t: cutOff.totalEntries }));
  check('a version only on entries before the cut is not the tail\'s writer', !('claudeVersion' in cutOff), JSON.stringify(cutOff.claudeVersion));
  rmSync(dirV, { recursive: true, force: true });
}

// IMAGE BUDGET (10/25): a fold keeps the NEWEST images up to --image-budget-bytes of base64 and turns
// each older one into a line of text; images in the request log (never sent on resume) are neither
// counted nor touched. Three Read results with a 600 KB image each, oldest first, plus a request-log
// copy of a 900 KB image placed last, where it would be "newest" if it were counted.
{
  const dirI = mkdtempSync(join(tmpdir(), 'trim-img-'));
  const SIDI = '33333333-4444-5555-6666-777777777777';
  const img = (ch, kb) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: ch.repeat(kb * 1000) } });
  const rowsI = [];
  let p = null; let i = 0;
  const push = (e) => { const uuid = e.type === 'api-request-blob' ? undefined : `i${++i}`; rowsI.push({ ...(uuid ? { parentUuid: p, uuid } : {}), sessionId: SIDI, timestamp: `2026-10-25T22:${String(rowsI.length).padStart(2, '0')}:00.000Z`, ...e }); if (uuid) p = uuid; };
  push({ type: 'user', message: { role: 'user', content: 'show me the plants' } });
  for (const [ch, n] of [['A', 1], ['B', 2], ['C', 3]]) {
    push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${n}`, name: 'Read', input: { file_path: `/p/${n}.jpg` } }] } });
    push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: [img(ch, 600)] }] }, toolUseResult: { type: 'image', file: { base64: ch.repeat(600 * 1000), type: 'image/jpeg' } } });
  }
  push({ type: 'api-request-blob', hash: 'h1', message: { role: 'user', content: [{ type: 'tool_result', content: [img('Z', 900)] }] } });
  push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'lovely' }] } });
  const f = join(dirI, `${SIDI}.jsonl`);
  writeFileSync(f, rowsI.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const run = (budget) => {
    const r = spawnSync(process.execPath, [join(HERE, 'trim.mjs'), f, '--target-tokens', '2000000', ...(budget === undefined ? [] : String(budget).startsWith('=') ? [`--image-budget-bytes${budget}`] : ['--image-budget-bytes', String(budget)])], { encoding: 'utf8' });
    if (r.status !== 0) return { exit: r.status, err: r.stderr.trim() };
    const rep = JSON.parse(r.stdout);
    const tail = readFileSync(rep.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    rmSync(rep.path, { force: true });
    const imgs = (e) => JSON.stringify(e.message?.content ?? '').match(/"data":"([A-Z])/g)?.map((m) => m.slice(-1)) ?? [];
    const sent = tail.filter((e) => e.type !== 'api-request-blob').flatMap(imgs);
    return { rep, tail, sent, log: tail.filter((e) => e.type === 'api-request-blob').flatMap(imgs) };
  };
  const d = run();
  check('default 1 MB budget: only the NEWEST message image is kept (the request-log copy does not take its place)', JSON.stringify(d.sent) === '["C"]', JSON.stringify(d.sent ?? d));
  check('each older image becomes a text line saying what was there', d.tail.filter((e) => /image removed at fold: image\/jpeg, 586 KB/.test(JSON.stringify(e.message?.content ?? ''))).length === 2, JSON.stringify(d.rep?.imagesStripped));
  check('the report counts what went', d.rep?.imagesStripped?.count === 2 && d.rep.imagesStripped.bytes === 1_200_000, JSON.stringify(d.rep?.imagesStripped));
  check('the request log is left as it was', JSON.stringify(d.log) === '["Z"]', JSON.stringify(d.log));
  const ids = new Set(d.tail.map((e) => e.uuid).filter(Boolean));
  check('the chain is whole (only content changed)', d.tail.filter((e) => e.uuid && e.parentUuid && !ids.has(e.parentUuid)).length === 0);
  check('a stripped image\'s harness copy (toolUseResult) goes with it; the kept one\'s stays', d.tail.filter((e) => e.toolUseResult?.file).map((e) => e.toolUseResult.file.base64.length).join(',') === '0,0,600000', d.tail.filter((e) => e.toolUseResult?.file).map((e) => e.toolUseResult.file.base64.length).join(','));
  const all = run(2_000_000);
  check('under the budget nothing is touched and nothing is reported', JSON.stringify(all.sent) === '["A","B","C"]' && !('imagesStripped' in all.rep), JSON.stringify(all.sent));
  const none = run(0);
  check('a budget of 0 keeps no image', JSON.stringify(none.sent) === '[]' && none.rep.imagesStripped.count === 3, JSON.stringify(none.sent));
  // The placeholder's SHAPE, where the API reads it: a text block with non-empty text, in the tool_result's
  // own content array. A block with the words under any other key would pass a search of the string and be
  // refused by the API on every request of the woken session (the second reader's surviving mutant, 10/25).
  const placed = d.tail.flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
    .filter((b) => b?.type === 'tool_result' && Array.isArray(b.content)).flatMap((b) => b.content);
  check('a replaced image is a text block with text, inside the tool_result\'s content', placed.filter((b) => b.type === 'text' && /^\[image removed at fold/.test(b.text ?? '')).length === 2 && placed.every((b) => b.type === 'image' || (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)), JSON.stringify(placed.map((b) => Object.keys(b))));
  check('the estimate drops with the pixels it no longer carries', d.rep.estTokens < all.rep.estTokens, `${d.rep.estTokens} vs ${all.rep.estTokens}`);
  const eq = run('=500000');
  check('the --image-budget-bytes=N spelling is honoured', Array.isArray(eq.sent) && eq.sent.length === 0 && eq.rep.imagesStripped.count === 3, JSON.stringify(eq.sent ?? eq));
  const bad = run('lots');
  check('a budget that is not a number is refused (exit 2)', bad.exit === 2 && /image-budget-bytes/.test(bad.err), JSON.stringify(bad));
  // Within one entry the later block is the newer: two images in one tool_result, the budget exactly one
  // image's size (<= keeps an exact fit). And the greedy fill: a newest image bigger than the budget goes,
  // an older smaller one that fits stays.
  const one = (blocks, budget) => {
    const SIDO = '44444444-5555-6666-7777-888888888888';
    const r0 = [
      { parentUuid: null, uuid: 'o1', sessionId: SIDO, timestamp: '2026-10-25T23:00:00.000Z', type: 'user', message: { role: 'user', content: 'look' } },
      ...blocks.map((content, n) => ({ parentUuid: `o${n + 1}`, uuid: `o${n + 2}`, sessionId: SIDO, timestamp: `2026-10-25T23:0${n + 1}:00.000Z`, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${n}`, content }] } })),
    ];
    const fo = join(dirI, `${SIDO}.jsonl`);
    writeFileSync(fo, r0.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const r = spawnSync(process.execPath, [join(HERE, 'trim.mjs'), fo, '--target-tokens', '2000000', '--image-budget-bytes', String(budget)], { encoding: 'utf8' });
    const rep = JSON.parse(r.stdout);
    const tail = readFileSync(rep.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    rmSync(rep.path, { force: true });
    return tail.flatMap((e) => JSON.stringify(e.message?.content ?? '').match(/"data":"([A-Z])/g)?.map((m) => m.slice(-1)) ?? []);
  };
  check('two images in one tool_result: the later one is kept, and an exact fit counts as fitting', JSON.stringify(one([[img('D', 300), img('E', 300)]], 300_000)) === '["E"]', JSON.stringify(one([[img('D', 300), img('E', 300)]], 300_000)));
  check('one byte short of an image, it goes', JSON.stringify(one([[img('E', 300)]], 299_999)) === '[]');
  check('greedy: an oversized newest image goes and an older one that fits stays', JSON.stringify(one([[img('F', 200)], [img('G', 900)]], 500_000)) === '["F"]', JSON.stringify(one([[img('F', 200)], [img('G', 900)]], 500_000)));
  rmSync(dirI, { recursive: true, force: true });
}

console.log(fails ? `\n${fails} FAILED` : '\nall pass');
process.exit(fails ? 1 : 0);
