// Bench for chrome.mjs: a CDP test's Chrome and profile go away however the
// test ends, and the orphan sweep removes what a SIGKILL'd test leaves without
// touching a Chrome a live test still owns. Real processes, real Chrome, ports
// 9371–9378. Run: node skins/test/chrome-test.mjs
// Written by: claude-opus-5-5, 2026-10-16
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { sweepOrphans } from './chrome.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, ok, why = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  (${why})`}`); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const until = async (fn, ms = 4000) => { for (let t = 0; t < ms; t += 100) { if (fn()) return true; await sleep(100); } return fn(); };

const work = mkdtempSync(join(tmpdir(), 'nw-chrome-test-'));
// One child script, told what to do by argv: launch, wait for Chrome to hold
// its profile, report, then end the way the scenario says.
const child = join(work, 'child.mjs');
writeFileSync(child, `
import { launchChrome } from ${JSON.stringify(join(HERE, 'chrome.mjs'))};
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
const [how, port] = process.argv.slice(2);
let ch, prof;
if (how === 'raw-double-slash') {
  // The pre-chrome.mjs spelling: TMPDIR (with its trailing slash) + '/nwcdp-'.
  prof = process.env.TMPDIR + '/nwcdp-rawprobe' + process.pid; mkdirSync(prof);
  ch = spawn(${JSON.stringify(CHROME)}, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + port, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
} else ({ ch, prof } = launchChrome({ port: Number(port), size: null }));
for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:' + port + '/json/version'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
console.log(JSON.stringify({ chrome: ch.pid, prof }));
if (how === 'throw') throw new Error('a test that throws');
if (how === 'exit') process.exit(3);
if (how === 'reject') Promise.reject(new Error('a test that rejects'));
await new Promise(() => setInterval(() => {}, 1000)); // wait to be signalled
`);

async function run(how, port, { signal } = {}) {
  const env = { ...process.env, TMPDIR: process.env.TMPDIR ?? tmpdir() + '/' };
  const p = spawn(process.execPath, [child, how, String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  // Listen for the exit at spawn: a child that throws right after reporting can
  // be gone before the report is read, and a listener added then never fires.
  const exited = new Promise((r) => p.on('exit', (code, sig) => r({ code, sig })));
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', () => {});
  const info = await new Promise((resolve) => {
    const t = setInterval(() => { const line = out.split('\n').find((l) => l.startsWith('{')); if (line) { clearInterval(t); resolve(JSON.parse(line)); } }, 50);
    setTimeout(() => { clearInterval(t); resolve(null); }, 15000);
  });
  if (signal) { await sleep(300); p.kill(signal); }
  return { info, child: p, exited };
}

try {
  // 1–4: every way out that a handler can see.
  for (const [how, port, signal, wantCode] of [['throw', 9371, null, 1], ['exit', 9372, null, 3], ['reject', 9373, null, 1], ['wait', 9374, 'SIGTERM', 143]]) {
    const { info, exited } = await run(how, port, { signal });
    const e = await exited;
    if (!info) { check(`${how}: the child launched Chrome`, false, 'no report'); continue; }
    const dead = await until(() => !alive(info.chrome));
    const gone = await until(() => !existsSync(info.prof));
    check(`${how}: Chrome is killed and its profile removed (exit ${e.code ?? e.sig})`, dead && gone && e.code === wantCode,
      `chrome alive ${!dead}, profile present ${!gone}, exit ${e.code}/${e.sig}, want ${wantCode}`);
  }

  // 5: SIGKILL runs no handler, so the Chrome is orphaned; the sweep finds it.
  {
    const { info, child: p, exited } = await run('wait', 9375);
    p.kill('SIGKILL'); await exited;
    const orphaned = info && alive(info.chrome) && existsSync(info.prof);
    check('SIGKILL leaves an orphan (as no handler can help it)', orphaned, `info ${JSON.stringify(info)}`);
    const swept = sweepOrphans();
    const dead = info && await until(() => !alive(info.chrome)), gone = info && await until(() => !existsSync(info.prof));
    check('the sweep kills the orphan and removes its profile', swept.killed.includes(info?.chrome) && dead && gone,
      `killed ${JSON.stringify(swept.killed)}, chrome alive ${!dead}, profile present ${!gone}`);
  }

  // 6: the spelling that outlived the sweep's first version: TMPDIR + '/nwcdp-'
  // with TMPDIR's trailing slash, so Chrome's command line reads T//nwcdp-….
  {
    const { info, child: p, exited } = await run('raw-double-slash', 9376);
    p.kill('SIGKILL'); await exited;
    check('a double-slash profile path is the shape under test', !!info && info.prof.includes('//nwcdp-'), `prof ${info?.prof}`);
    const swept = sweepOrphans();
    const dead = info && await until(() => !alive(info.chrome)), gone = info && await until(() => !existsSync(info.prof));
    check('the sweep matches it by path, not by spelling', swept.killed.includes(info?.chrome) && dead && gone,
      `killed ${JSON.stringify(swept.killed)}, chrome alive ${!dead}, profile present ${!gone}`);
  }

  // 7: a Chrome a live test owns is left alone, profile and all.
  {
    const { info, child: p, exited } = await run('wait', 9377);
    const swept = sweepOrphans();
    await sleep(300);
    check("a live test's Chrome survives a sweep, profile and all",
      !!info && !swept.killed.includes(info.chrome) && alive(info.chrome) && existsSync(info.prof) && !swept.removed.includes(info.prof.split('/').pop()),
      `killed ${JSON.stringify(swept.killed)}, removed ${JSON.stringify(swept.removed)}`);
    p.kill('SIGTERM'); await exited;
    check('...and is cleaned up when that test ends', !!info && await until(() => !alive(info.chrome)) && await until(() => !existsSync(info.prof)));
  }
  // 8: Chrome dies mid-test (its pid may be reused by exit time, so it isn't
  // killed again); the test still removes the profile on its way out.
  {
    const { info, child: p, exited } = await run('wait', 9378);
    if (info) { process.kill(info.chrome, 'SIGKILL'); await until(() => !alive(info.chrome)); }
    p.kill('SIGTERM'); const e = await exited;
    check('a Chrome that died mid-test still leaves no profile', !!info && await until(() => !existsSync(info.prof)) && e.code === 143,
      `exit ${e.code}/${e.sig}, profile present ${info && existsSync(info.prof)}`);
  }
} finally {
  sweepOrphans();
  rmSync(work, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
