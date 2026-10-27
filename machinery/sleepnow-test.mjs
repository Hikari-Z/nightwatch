// sleepnow-test.mjs — Sleep now on a nearly full window (nightwatch#56).
// On 10/26 a Sleep now at 98% sent the bell note into a window with no room
// for the ritual it asks for; the session hit 100% and could answer nothing.
// At or past schedule.sleepNowFoldPct of its window, --ring now rings no bell:
// it records the bell as full, and the daemon's orphan floor folds the session
// on its next tick (the rehearsal's sleep-now-full scenario). Checks:
//   - the context measure shared with the watch (windowForLane, contextOfEntries);
//   - --ring on a session at 96%: exit 0, says so, no spool note, the state
//     carries fullBell equal to belledAt;
//   - --ring on a session at 50%: the bell rings (a spool note), no fullBell.
// The live session is a copy of node named claude, its status file and the
// registry entry, as wake-cli-test.mjs builds one; HOME is scratch.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, contextOfEntries, loadConfigFrom, windowForLane } from './config.mjs';

const MACHINERY = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `\n    ${detail}`}`);
}

// ── the measure ──────────────────────────────────────────────────────────
{
  const cfg = { lanes: { own: { contextWindow: 400_000 }, plain: {} } };
  check('a lane\'s own contextWindow wins', windowForLane(cfg, 'own', 'claude-opus-5-5') === 400_000);
  check('else the model family: 1M for opus, fable, sonnet, mythos', ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-mythos-1'].every((m) => windowForLane(cfg, 'plain', m) === 1_000_000));
  check('200k for haiku; null for a model it does not know', windowForLane(cfg, 'plain', 'claude-haiku-4-5') === 200_000 && windowForLane(cfg, 'plain', 'gpt-x') === null);
  const reply = (input, read, made, extra = {}) => ({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: made } }, ...extra });
  const ctx = contextOfEntries(cfg, 'plain', [reply(1, 1, 1), reply(10_000, 900_000, 50_000), { type: 'user' }]);
  check('the newest real reply\'s three input fields, against the window', ctx?.tokens === 960_000 && ctx.ratio === 0.96, JSON.stringify(ctx));
  const skip = contextOfEntries(cfg, 'plain', [reply(10, 500_000, 0), reply(0, 999_000, 0, { isApiErrorMessage: true })]);
  check('an API error\'s reply is skipped', skip?.tokens === 500_010, JSON.stringify(skip));
  check('no reply with usage: null', contextOfEntries(cfg, 'plain', [{ type: 'user' }]) === null);
  check('the threshold defaults to 95%', DEFAULTS.schedule.sleepNowFoldPct === 0.95);
}

// ── the CLI, against a scratch hub ───────────────────────────────────────
const hub = mkdtempSync(join(tmpdir(), 'nw-sleepnow-'));
for (const d of ['wakecycle', 'ladder', 'sessions', 'projects', 'bin']) mkdirSync(join(hub, d), { recursive: true });
const cfgFile = join(hub, 'nightwatch.config.json');
writeFileSync(cfgFile, JSON.stringify({
  weftRoot: hub, lanes: { main: { targetTokens: 250000 } },
  notify: { macos: false }, paths: { transcripts: join(hub, 'projects'), sessions: join(hub, 'sessions') },
}));
const cfg = loadConfigFrom(cfgFile);
const home = join(hub, 'home');
mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
const env = { ...process.env, HOME: home, NIGHTWATCH_CONFIG: cfgFile };
for (const k of ['WEFT_CONFIG', 'WEFT_LANE', 'NIGHTWATCH_LANE']) delete env[k];
const ring = (lane) => spawnSync(process.execPath, [join(MACHINERY, 'nightshift.mjs'), '--ring', lane], { env, encoding: 'utf8', timeout: 20_000 });
const spoolNotes = () => { try { return readdirSync(join(cfg.paths.spool, 'main')).length; } catch { return 0; } };
const state = () => { try { return JSON.parse(readFileSync(cfg.paths.stateFile, 'utf8')).main ?? {}; } catch { return {}; } };

const fakeClaude = join(hub, 'bin', 'claude');
copyFileSync(process.execPath, fakeClaude);
chmodSync(fakeClaude, 0o755);
function session(sid, readTokens, run) {
  const up = spawn(fakeClaude, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    writeFileSync(join(home, '.claude', 'sessions', `${up.pid}.json`), JSON.stringify({ pid: up.pid, sessionId: sid, kind: 'interactive' }));
    writeFileSync(join(hub, 'wakecycle', `lane.${sid}`), JSON.stringify({ lane: 'main', at: new Date().toISOString() }));
    writeFileSync(join(hub, 'projects', `${sid}.jsonl`), [
      { type: 'user', uuid: 'a', parentUuid: null, message: { role: 'user', content: 'hello' } },
      { type: 'assistant', uuid: 'b', parentUuid: 'a', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 2, cache_read_input_tokens: readTokens, cache_creation_input_tokens: 0 } } },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    return run();
  } finally {
    up.kill();
    rmSync(join(home, '.claude', 'sessions', `${up.pid}.json`), { force: true });
    rmSync(join(hub, 'wakecycle', `lane.${sid}`), { force: true });
  }
}

try {
  session('sess-full', 960_000, () => {
    const before = spoolNotes();
    const r = ring('main');
    const st = state();
    check('at 96%: exit 0, and it says the window is too full for the ritual', r.status === 0 && /too full for the bedtime ritual/.test(r.stdout), `status ${r.status}: ${r.stdout}${r.stderr}`);
    check('…no bell: no spool note', spoolNotes() === before, `${before} → ${spoolNotes()}`);
    check('…the bell is recorded as full, for the daemon\'s floor', st.belledSession === 'sess-full' && typeof st.fullBell === 'number' && st.fullBell === st.belledAt, JSON.stringify(st));
  });
  session('sess-room', 500_000, () => {
    const before = spoolNotes();
    const r = ring('main');
    const st = state();
    check('at 50%: the bell rings (a spool note)', r.status === 0 && /bell rung/.test(r.stdout) && spoolNotes() === before + 1, `status ${r.status}: ${r.stdout}${r.stderr}; notes ${before} → ${spoolNotes()}`);
    check('…and no full mark, so the floor waits for its grace as before', st.belledSession === 'sess-room' && st.fullBell === undefined, JSON.stringify(st));
  });
} finally {
  if (!fail) rmSync(hub, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed${fail ? `  (scratch kept: ${hub})` : ''}`);
process.exit(fail ? 1 : 0);
