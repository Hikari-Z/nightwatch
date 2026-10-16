// The timeline graph's hover cursor (Ra, 10/9): hover at bucket centres and check
// the label reads that bucket's rate (series[i] / bucket minutes), the static tip
// steps aside, and leaving restores it. Runs on the fixture, no server. Usage:
//   node --experimental-websocket skins/test/cursor.mjs [skin] [layout] [out.png]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = dirname(dirname(fileURLToPath(import.meta.url)));
const [skin = 'glass', layout = 'row', outPng, theme = 'dark'] = process.argv.slice(2);
const PORT = 9341, prof = mkdtempSync(process.env.TMPDIR + '/nwcur-');
const ch = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1300,1100', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tab; for (let i = 0; i < 50 && !tab; i++) { try { tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await sleep(200); } }
const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true }); return r.result?.exceptionDetails ? 'THREW ' + JSON.stringify(r.result.exceptionDetails.exception?.description) : r.result?.result?.value; };
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
const tmp = `${dir}/_cur_fixture.html`; copyFileSync(`${dir}/fixture.html`, tmp);
await send('Page.navigate', { url: `file://${tmp}?skin=${skin}&layout=${layout}` }); await sleep(1500);
await ev(`(()=>{const a=document.querySelector('.nw-app'); a.dataset.showTimeline='true'; a.dataset.showLog='false'; window.dispatchEvent(new Event('resize'));})()`); await sleep(400);
const info = await ev(`(()=>{const a=document.querySelector('.nw-timeline [data-part="activity"]'); if(!a) return null; const s=a.querySelector('svg').getBoundingClientRect(); return {s:[s.left,s.top,s.right,s.bottom], series:a.dataset.series.split(',').map(Number), bm:+a.dataset.bucketMin, vis: a.getClientRects().length>0, col: document.querySelector('.nw-app').dataset.layout}})()`);
if (!info || !info.vis) { console.log('no visible activity graph', JSON.stringify(info)); process.exit(1); }
const n = info.series.length, peakI = info.series.indexOf(Math.max(...info.series));
const pick = [...new Set([peakI, Math.floor(n * .3), n - 3].filter((i) => info.series[i] > 0))];
const [L, T, R, B] = info.s, turned = info.col === 'column';
const at = (i) => { const t = (i + .5) / n; return turned ? [L + (R - L) / 2, B - t * (B - T)] : [L + t * (R - L), T + (B - T) / 2]; };
const fmt = (v) => v < 1000 ? `${Math.round(v)}` : v < 10000 ? `${(v / 1e3).toFixed(1)}k` : `${Math.round(v / 1e3)}k`;
let ok = 0, bad = 0;
for (const i of pick) {
  const [x, y] = at(i);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(120);
  const got = await ev(`(()=>{const a=document.querySelector('.nw-timeline [data-part="activity"]'); const l=a.querySelector('[data-part="cursor-label"]'), d=a.querySelector('[data-part="cursor"]'); const r=d&&d.getBoundingClientRect(), lr=l&&l.getBoundingClientRect(); return {label:l?.textContent, tip:a.hasAttribute('data-tip'), dot: r&&[Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)], lab: lr&&[Math.round(lr.left),Math.round(lr.top),Math.round(lr.right),Math.round(lr.bottom)]}})()`);
  const want = `${fmt(info.series[i] / info.bm)}/min`;
  const pass = got?.label === want && got.tip === false; pass ? ok++ : bad++;
  console.log(pass ? 'PASS' : 'FAIL', `bucket ${i}`, 'label', got?.label, 'want', want, 'dot', JSON.stringify(got?.dot), 'labelbox', JSON.stringify(got?.lab));
}
const [x, y] = at(pick[0]);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await sleep(150);
const pad = 70, clip = turned ? { x: L - 160, y: Math.max(0, y - 120), width: (R - L) + 200, height: 240, scale: 2 } : { x: Math.max(0, x - 260), y: T - pad, width: 520, height: (B - T) + pad + 20, scale: 2 };
if (outPng) { const shot = await send('Page.captureScreenshot', { format: 'png', clip }); writeFileSync(outPng, Buffer.from(shot.result.data, 'base64')); }
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5 }); await sleep(120);
const gone = await ev(`(()=>{const a=document.querySelector('.nw-timeline [data-part="activity"]'); return !a.querySelector('[data-part="cursor"]') && !a.querySelector('[data-part="cursor-label"]') && a.hasAttribute('data-tip')})()`);
gone ? ok++ : bad++; console.log(gone ? 'PASS' : 'FAIL', 'leaving restores the tip and removes the cursor');
console.log('errors', await ev('JSON.stringify(window.__errs ?? [])'), `${ok} pass ${bad} fail`);
await Promise.race([send('Browser.close'), sleep(1000)]); rmSync(tmp); ch.kill(); await sleep(300); rmSync(prof, { recursive: true, force: true }); process.exit(bad ? 1 : 0);
