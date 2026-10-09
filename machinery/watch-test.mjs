#!/usr/bin/env node
// The stuck/spiral watch, end to end: watch.mjs --once against a scratch hub
// (its own config, transcripts, session status files, registry, events,
// state), banners off, notify.command pointed at a recorder script. Nothing
// real is read or written. Run: node machinery/watch-test.mjs
//
// Written by: claude-opus-5-5, 2026-10-09 (cases from weft's stuck-test.mjs, 10/8)
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'watch-test-'));
const dirs = { projects: join(root, 'projects'), sessions: join(root, 'sessions'), wakecycle: join(root, 'wakecycle'), ladder: join(root, 'ladder') };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
const EVENTS = join(root, 'events.jsonl');
const SENT = join(root, 'sent.jsonl');
const recorder = join(root, 'recorder.sh');
writeFileSync(recorder, `#!/bin/sh
body=$(cat)
printf '%s\\n' "$(node -e 'const e=process.env;console.log(JSON.stringify({kind:e.NIGHTWATCH_ALERT_KIND,cause:e.NIGHTWATCH_ALERT_CAUSE,lane:e.NIGHTWATCH_ALERT_LANE,session:e.NIGHTWATCH_ALERT_SESSION,title:e.NIGHTWATCH_ALERT_TITLE,persona:e.NIGHTWATCH_PERSONA,body:process.argv[1]}))' "$body")" >> "${SENT}"
`);
chmodSync(recorder, 0o755);
const config = (extra = {}) => {
  const file = join(root, 'nightwatch.config.json');
  writeFileSync(file, JSON.stringify({
    weftRoot: root, persona: { name: 'Lark' },
    lanes: { fable: { targetTokens: 250000 }, opus: { targetTokens: 250000 } },
    notify: { macos: false, command: recorder },
    paths: { transcripts: dirs.projects, sessions: dirs.sessions },
    ...extra,
  }));
  return file;
};
const CONFIG = config();

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
const reply = (text, extra = {}) => ({ type: 'assistant', uuid: `u${++seq}`, timestamp: iso(now - 60_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: 20_000, output_tokens: 5 } }, ...extra });
const apiError = (text, error, minsAgo = 0.5) => ({ type: 'assistant', uuid: `u${++seq}`, timestamp: iso(now - minsAgo * 60_000), isApiErrorMessage: true, error, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] } });
const denial = (minsAgo, reason) => ({ type: 'user', uuid: `u${++seq}`, timestamp: iso(now - minsAgo * 60_000), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', is_error: true, content: `Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${reason}. More text.` }] } });
const write = (sid, entries) => writeFileSync(join(dirs.projects, `${sid}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
const append = (sid, e) => appendFileSync(join(dirs.projects, `${sid}.jsonl`), JSON.stringify(e) + '\n');
let pid = 0;
const session = (sid, lane, { status = 'idle', statusAt = now } = {}) => {
  writeFileSync(join(dirs.sessions, `${++pid}.json`), JSON.stringify({ pid: process.pid, sessionId: sid, kind: 'interactive', status, statusUpdatedAt: statusAt, updatedAt: statusAt }));
  if (lane) writeFileSync(join(dirs.wakecycle, `lane.${sid}`), JSON.stringify({ lane }));
};

session('s-login', 'fable'); write('s-login', [reply('hi'), apiError('Failed to authenticate: OAuth session expired and could not be refreshed', 'authentication_failed')]);
session('s-usage', 'fable'); write('s-usage', [reply('hi'), apiError("You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.", 'rate_limit')]);
session('s-offline', 'opus'); write('s-offline', [reply('hi'), apiError("API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)", 'server_error')]);
session('s-slept', 'opus'); write('s-slept', [reply('hi'), apiError('API Error: Your computer went to sleep mid-response. The response above may be incomplete.', 'server_error')]);
session('s-classifier', 'fable'); write('s-classifier', [reply('hi'), denial(20, '[Irreversible Local Destruction]'), denial(5, 'Blocked by classifier'), reply('ok')]);
session('s-context', 'opus'); write('s-context', [{ ...reply('big'), message: { ...reply('big').message, usage: { input_tokens: 100, cache_read_input_tokens: 880_000, cache_creation_input_tokens: 2_000, output_tokens: 5 } } }]);
session('s-waiting', 'fable', { status: 'waiting', statusAt: now - 20 * 60_000 }); write('s-waiting', [reply('may I?')]);
session('s-toolong', 'opus'); write('s-toolong', [reply('hi'), apiError('Prompt is too long', 'invalid_request'), apiError('Prompt is too long', 'invalid_request')]);
session('s-spiral', 'opus'); write('s-spiral', [reply('hi'), apiError('API Error: Connection dropped (ECONNRESET)', 'server_error', 9), apiError('API Error: Connection dropped (ECONNRESET)', 'server_error', 2)]);
session('s-plainapi', 'opus'); write('s-plainapi', [reply('hi'), apiError('API Error: Connection dropped (ECONNRESET)', 'server_error')]);
session('s-recovered', 'opus'); write('s-recovered', [apiError('API Error: Overloaded', 'server_error', 9), apiError('API Error: Overloaded', 'server_error', 5), reply('back')]);
session('s-fine', 'opus'); write('s-fine', [reply('all good')]);
// Another hub's agent: live on this machine, absent from THIS hub's registry.
session('s-otherhub', null); write('s-otherhub', [reply('hi'), apiError('Login expired · Please run /login', 'authentication_failed')]);
// Folded already: the window can outlive its fold for a moment.
session('s-folded', 'fable'); write('s-folded', [reply('hi'), apiError('Login expired · Please run /login', 'authentication_failed')]);
writeFileSync(join(dirs.ladder, 'folds.jsonl'), JSON.stringify({ source: 'jsonl:s-folded', tail: 'x-tail' }) + '\n');

const tick = (file = CONFIG) => execFileSync(process.execPath, [join(HERE, 'watch.mjs'), '--once'], { env: { ...process.env, WEFT_CONFIG: file }, stdio: 'ignore', timeout: 60_000 });
const lines = (f) => existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const stuckBy = (evs) => Object.fromEntries(evs.filter((e) => e.kind === 'stuck').map((e) => [e.session, `${e.lane}:${e.cause}`]));

tick();
const first = lines(EVENTS);
check('each stuck state is told once, under its own agent', stuckBy(first), {
  's-login': 'fable:login', 's-usage': 'fable:usage-limit', 's-offline': 'opus:offline', 's-slept': 'opus:slept',
  's-classifier': 'fable:classifier', 's-context': 'opus:context', 's-waiting': 'fable:waiting', 's-toolong': 'opus:too-long',
});
check('a spiral (two errors, newest still one) is a spiral-alarm', first.filter((e) => e.kind === 'spiral-alarm').map((e) => `${e.session}:${e.errors}`), ['s-spiral:2']);
check('one plain error, a recovered session and a fine one say nothing', ['s-plainapi', 's-recovered', 's-fine'].filter((s) => first.some((e) => e.session === s)), []);
check("another hub's agent and a folded session say nothing", ['s-otherhub', 's-folded'].filter((s) => first.some((e) => e.session === s)), []);
check('a too-full session is a stuck state, not a spiral', first.filter((e) => e.kind === 'spiral-alarm' && e.session === 's-toolong').length, 0);
check('every alert event is an alarm', first.every((e) => e.alarm === true), true);
check('the classifier event counts the denials', first.find((e) => e.cause === 'classifier')?.count, 2);
check('the context event carries the ratio', Math.round((first.find((e) => e.cause === 'context')?.ratio ?? 0) * 100), 88);

const sent = lines(SENT);
check('the notify command gets one message per alert', sent.length, first.length);
check('it gets the kind, cause, agent, session, title and persona in its environment',
  sent.find((m) => m.session === 's-login') && (({ kind, cause, lane, title, persona }) => ({ kind, cause, lane, title, persona }))(sent.find((m) => m.session === 's-login')),
  { kind: 'stuck', cause: 'login', lane: 'fable', title: 'Logged out', persona: 'Lark' });
check('the message body arrives on stdin', /^Lark \(fable\) is logged out/.test(sent.find((m) => m.session === 's-login')?.body ?? ''), true);
check('the words say "agent", never "lane", and no "it"/"its"',
  sent.filter((m) => /\blanes?\b|\b[Ii]ts?\b/.test(m.body)).map((m) => m.body.slice(0, 60)), []);

tick();
check('a second tick (a restart, even) re-announces nothing', [lines(EVENTS).length, lines(SENT).length], [first.length, sent.length]);

append('s-offline', reply('back online'));
const ctx = (input) => ({ ...reply('x'), message: { ...reply('x').message, usage: { input_tokens: 0, cache_read_input_tokens: input, output_tokens: 1 } } });
append('s-context', ctx(820_000)); // between the re-arm line and the warning: the same episode
tick();
check('recovery clears offline, once, and sends nothing', [lines(EVENTS).slice(first.length).map((e) => `${e.kind}:${e.cause}`), lines(SENT).length - sent.length], [['stuck-cleared:offline'], 0]);
append('s-context', ctx(500_000));
tick();
check('context clears only below the re-arm line', lines(EVENTS).slice(first.length + 1).map((e) => `${e.kind}:${e.cause}`), ['stuck-cleared:context']);

// Wake cost (fix 4): the session woken from a fold's tail, found by the
// tail's entries in its transcript, records its first real request beside
// the fold's estimate. A decoy registered after the fold and a dead wake
// record nothing.
const fold = (tail, est) => appendFileSync(join(dirs.ladder, 'folds.jsonl'), JSON.stringify({ at: iso(now - 2 * 3600_000), reason: 'sleep', source: `jsonl:src-${tail}`, est_tokens: est, tail }) + '\n');
const copiedReply = (uuid) => ({ type: 'assistant', uuid, timestamp: iso(now - 3 * 3600_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'from yesterday' }], usage: { input_tokens: 0, cache_read_input_tokens: 937_000, output_tokens: 1 } } }); // a pre-10/8 tail's stale copied usage
const tailEntries = [{ type: 'user', uuid: 'tail-u1', timestamp: iso(now - 3 * 3600_000), message: { role: 'user', content: 'yesterday' } }, copiedReply('tail-a1')];
write('t-good', tailEntries);
write('w-good', [{ type: 'last-prompt' }, ...tailEntries, { type: 'user', uuid: 'w-u1', timestamp: iso(now - 50 * 60_000), message: { role: 'user', content: 'morning' } },
  // Claude Code's own synthetic replies carry all-zero usage and aren't errors: not a request.
  { type: 'assistant', uuid: 'w-syn', timestamp: iso(now - 50 * 60_000), message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }], usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } } },
  { type: 'assistant', uuid: 'w-a1', timestamp: iso(now - 49 * 60_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'awake' }], usage: { input_tokens: 3, cache_read_input_tokens: 190_000, cache_creation_input_tokens: 15_796, output_tokens: 40 } } }]);
write('w-decoy', [{ type: 'assistant', uuid: 'd-a1', timestamp: iso(now - 30 * 60_000), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'unrelated' }], usage: { input_tokens: 999, output_tokens: 1 } } }]);
const deadTail = [{ type: 'user', uuid: 'dt-u1', timestamp: iso(now - 3 * 3600_000), message: { role: 'user', content: 'x' } }];
write('t-dead', deadTail);
write('w-dead', [...deadTail, apiError('Prompt is too long', 'invalid_request')]);
for (const [sid, lane] of [['w-decoy', 'opus'], ['w-good', 'opus'], ['w-dead', 'fable']]) writeFileSync(join(dirs.wakecycle, `lane.${sid}`), JSON.stringify({ lane }));
fold('t-good', 252_417);
fold('t-dead', 250_000);
const eventsBefore = lines(EVENTS).length;
tick();
const costs = lines(join(root, 'ladder', 'wake-costs.jsonl'));
check('the woken session records its first real request beside the estimate',
  costs.map(({ lane, tail, session, source, estTokens, firstRequestTokens }) => ({ lane, tail, session, source, estTokens, firstRequestTokens })),
  [{ lane: 'opus', tail: 't-good', session: 'w-good', source: 'jsonl:src-t-good', estTokens: 252_417, firstRequestTokens: 205_799 }]);
check('the record is stamped with the reply\'s own time', costs[0]?.at, iso(now - 49 * 60_000));
check('and lands as a wake-cost event', lines(EVENTS).slice(eventsBefore).filter((e) => e.kind === 'wake-cost').map((e) => `${e.tail}:${e.firstRequestTokens}`), ['t-good:205799']);
tick();
check('a second tick records nothing twice', lines(join(root, 'ladder', 'wake-costs.jsonl')).length, 1);

// An unnamed single-agent hub reads "the main agent"; a failing command never
// costs the event card.
const solo = join(root, 'solo');
for (const d of ['wakecycle', 'ladder']) mkdirSync(join(solo, d), { recursive: true });
const soloCfg = join(solo, 'nightwatch.config.json');
writeFileSync(soloCfg, JSON.stringify({ weftRoot: solo, lanes: { main: { targetTokens: 250000 } }, notify: { macos: false, command: join(root, 'missing.sh') }, paths: { transcripts: dirs.projects, sessions: dirs.sessions } }));
writeFileSync(join(solo, 'wakecycle', 'lane.s-login'), JSON.stringify({ lane: 'main' }));
tick(soloCfg);
const soloEvents = lines(join(solo, 'events.jsonl'));
check('a missing notify command still leaves the event', soloEvents.map((e) => `${e.session}:${e.cause}`), ['s-login:login']);
check('the failure is logged, not thrown', /notify command failed/.test(readFileSync(join(solo, 'watch.log'), 'utf8')), true);

console.log(`${pass} passed, ${fail} failed  (scratch: ${root})`);
process.exit(fail ? 1 : 0);
