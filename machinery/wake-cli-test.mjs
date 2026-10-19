// wake-cli-test.mjs — nightshift.mjs --wake against a scratch hub, the app's
// Wake button off macOS (nightwatch#2). Every terminal launcher the platform
// might call (osascript on macOS, wt.exe on WSL, x-terminal-emulator on a
// Linux desktop, tmux headless) is a stub first on PATH that records its
// argv, so no real window opens. (The first version left wt.exe out, and on
// WSL it opened a real Windows Terminal tab: marginalia's report, 10/19.) On
// WSL the launch names a summons file, not the command, so the checks read
// through it, as marginalia's fix does. Checks:
//   - an unknown agent is refused, and nothing is launched;
//   - so is a name every object inherits ("constructor"): the guard reads
//     the config's own lanes only (Sonnet Weft's second read);
//   - an agent the registry shows awake is refused, and nothing is launched;
//   - otherwise the launcher gets this hub's wake.sh for that lane, with the
//     hub's config named, exactly as the daemon's own 08:00 wake builds it.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MACHINERY = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : `\n    ${detail}`}`);
}

const hub = mkdtempSync(join(tmpdir(), 'nw-wakecli-'));
for (const d of ['wakecycle', 'ladder', 'sessions', 'projects', 'bin']) mkdirSync(join(hub, d), { recursive: true });
const record = join(hub, 'launched.argv');
for (const name of ['osascript', 'wt.exe', 'x-terminal-emulator', 'tmux']) {
  const stub = join(hub, 'bin', name);
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "${name}" "$@" >> "${record}"\n`);
  chmodSync(stub, 0o755);
}
const cfgFile = join(hub, 'nightwatch.config.json');
writeFileSync(cfgFile, JSON.stringify({
  weftRoot: hub, lanes: { main: { targetTokens: 250000 } },
  notify: { macos: false }, paths: { transcripts: join(hub, 'projects'), sessions: join(hub, 'sessions') },
}));
// A scratch HOME: the live-session readers look under ~/.claude (the bridge's
// sockets, Claude Code's status files), and this machine's real ones must
// not count, nor this hub's stand-in count on the machine.
const home = join(hub, 'home');
mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
const env = { ...process.env, HOME: home, NIGHTWATCH_CONFIG: cfgFile, PATH: `${join(hub, 'bin')}:${process.env.PATH}`, DISPLAY: ':0' };
for (const k of ['WEFT_CONFIG', 'WEFT_LANE', 'NIGHTWATCH_LANE', 'WAYLAND_DISPLAY']) delete env[k];
const wake = (lane) => spawnSync(process.execPath, [join(MACHINERY, 'nightshift.mjs'), '--wake', lane], { env, encoding: 'utf8', timeout: 20_000 });
const launched = () => existsSync(record) ? readFileSync(record, 'utf8') : '';

try {
  const unknown = wake('nobody');
  check('an unknown agent is refused, nothing launched', unknown.status === 2 && launched() === '', `status ${unknown.status}: ${unknown.stderr}`);
  const inherited = wake('constructor');
  check('an inherited name ("constructor") is refused, nothing launched', inherited.status === 2 && launched() === '', `status ${inherited.status}: ${inherited.stdout}${inherited.stderr}`);

  // A live session the registry attributes to main: a process whose command
  // name is claude (a copy of sleep), its status file, and the registry entry.
  const fakeClaude = join(hub, 'bin', 'claude');
  copyFileSync('/bin/sleep', fakeClaude);
  chmodSync(fakeClaude, 0o755);
  const up = spawn(fakeClaude, ['60'], { stdio: 'ignore' });
  try {
    writeFileSync(join(home, '.claude', 'sessions', `${up.pid}.json`), JSON.stringify({ pid: up.pid, sessionId: 'sess-up', kind: 'interactive' }));
    writeFileSync(join(hub, 'wakecycle', 'lane.sess-up'), JSON.stringify({ lane: 'main' }));
    const awake = wake('main');
    check('an agent the registry shows awake is refused, nothing launched', awake.status === 3 && /already awake/.test(awake.stderr) && launched() === '', `status ${awake.status}: ${awake.stderr} launched=${launched()}`);
  } finally { up.kill(); }
  rmSync(join(home, '.claude', 'sessions', `${up.pid}.json`));
  rmSync(join(hub, 'wakecycle', 'lane.sess-up'));

  const ok = wake('main');
  // On WSL wt.exe is handed a summons file that holds the command; read it too.
  const sent = launched();
  const summons = sent.match(/sh "([^"]+wake-summon-[^"]+\.sh)"/);
  const argv = summons && existsSync(summons[1]) ? `${sent}\n${readFileSync(summons[1], 'utf8')}` : sent;
  check('a sleeping agent is woken: exit 0 and a terminal launched', ok.status === 0 && /Waking main/.test(ok.stdout) && argv !== '', `status ${ok.status}: ${ok.stderr}`);
  check("the launcher runs this hub's wake.sh for that lane", argv.includes(join(MACHINERY, 'wake.sh')) && /wake\.sh\\?"? main/.test(argv), argv);
  check("and names this hub's config", argv.includes(`NIGHTWATCH_CONFIG=`) && argv.includes(cfgFile), argv);
} finally {
  if (!fail) rmSync(hub, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed${fail ? `  (scratch kept: ${hub})` : ''}`);
process.exit(fail ? 1 : 0);
