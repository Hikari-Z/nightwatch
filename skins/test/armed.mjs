// The settings dialog tracks armed state changed outside the app (Ra, 10/8: a
// lane disarmed from the terminal still showed armed in Nightwatch, and saving
// that stale dialog would have re-armed it). Runs its own viewer on a scratch
// copy of the hub config whose armedFile is a scratch file, so the live
// nightshift.armed is never touched. Run:
//   node --experimental-websocket skins/test/armed.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = join(HERE, '..', '..');
const GUI = join(HUB, 'gui');
const VIEWER_PORT = 7361;
const CDP_PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A scratch config: the hub's own, with only the armed file redirected.
const scratch = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'nw-armed-'));
const armedFile = join(scratch, 'nightshift.armed');
// The product repo holds no hub; read a real hub's config (Weft's by default).
const HUB_CONFIG = process.env.NW_TEST_HUB_CONFIG ?? join(process.env.HOME, 'origin', 'weft', 'weft.config.json');
const base = JSON.parse(readFileSync(HUB_CONFIG, 'utf8'));
const lanes = Object.keys(base.lanes ?? {});
if (lanes.length < 2) { console.log('needs a hub with two lanes'); process.exit(1); }
const [A, B] = lanes;
writeFileSync(join(scratch, 'config.json'), JSON.stringify({ ...base, paths: { ...(base.paths ?? {}), armedFile } }));
writeFileSync(armedFile, B); // A disarmed, B armed

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: GUI, stdio: 'ignore',
  env: { ...process.env, WEFT_CONFIG: join(scratch, 'config.json'), NIGHTWATCH_PORT: String(VIEWER_PORT), NIGHTWATCH_REGISTRY: '/nonexistent' },
});
const prof = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'nwcdp-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--disable-gpu', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--window-size=1100,1000', 'about:blank'],
  { stdio: 'ignore' });
const done = (code) => { server.kill(); chrome.kill(); process.exit(code); };

let tab;
for (let i = 0; i < 50 && !tab; i++) {
  try { tab = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await sleep(200); }
}
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  return r.result?.exceptionDetails ? `THREW: ${r.result.exceptionDetails.exception?.description}` : r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${VIEWER_PORT}/`); break; } catch { await sleep(200); } }
await send('Page.navigate', { url: `http://127.0.0.1:${VIEWER_PORT}/?skin=minimal` }); await sleep(1500);

let pass = 0, fail = 0;
const check = async (name, expr, want) => {
  const got = await ev(expr);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const box = (lane) => `document.querySelector('.nw-app > .nw-settings table[data-part="lanes"] tr[data-lane="${lane}"] input[type="checkbox"]')?.checked`;
const refresh = () => ev('NW_RUNTIME.refresh({ force: true })').then(() => sleep(300));

await check('the dialog matches the armed file at load (disarmed lane unchecked)', box(A), false);
await check('…and the armed lane checked', box(B), true);
writeFileSync(armedFile, `${A},${B}`); // armed from the terminal
await refresh();
await check('a closed dialog follows a lane armed outside the app', box(A), true);
await ev(`document.querySelector('.nw-app > .nw-settings').dataset.open = 'true'`);
writeFileSync(armedFile, B); // disarmed again while the dialog is open
await refresh();
await check('an open dialog is left alone (no edit swapped out under the viewer)', box(A), true);
await ev(`document.querySelector('.nw-app > .nw-settings').dataset.open = 'false'`);
await refresh();
await check('closing it lets the next refresh catch up', box(A), false);
console.log(`${pass} passed, ${fail} failed`);
done(fail ? 1 : 0);
