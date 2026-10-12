// Nightwatch app-shell test: drives the SERVED page with a stand-in app host over CDP and reads back what
// runtime.js wrote: hit areas, and (10/6) the canvas: the window covers the screen and the app is placed and
// dragged inside it. Needs the viewer on 7352. Run:
//   node --experimental-websocket skins/test/hits.mjs [baseUrl]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
const BASE = process.argv[2] ?? 'http://127.0.0.1:7352/';
const PORT = 9337;
const prof = mkdtempSync(process.env.TMPDIR + '/nwcdp-');
const ch = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--disable-gpu', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, '--window-size=1100,1000', 'about:blank'],
  { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tab;
for (let i = 0; i < 50 && !tab; i++) {
  try { tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { await sleep(200); }
}
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return `THREW: ${r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text}`;
  return r.result?.result?.value;
};
await send('Page.enable'); await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__hits=[];window.NW_SHELL='tauri';window.NW_HOST={can:a=>a==='hide-window',act:()=>Promise.resolve(''),hitRects:r=>__hits.push(r),onTop:o=>(window.__top??=[]).push(o)};window.__errs=[];addEventListener('error',e=>__errs.push(e.message+' @'+e.lineno));addEventListener('unhandledrejection',e=>__errs.push('rej '+e.reason))` });
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1500); };

let pass = 0, fail = 0;
const check = async (name, expr, want) => {
  const got = await ev(expr); const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${JSON.stringify(got)}`);
};
await go(BASE + '?skin=minimal');
await check('no boot errors', 'window.__errs', []);
await check('shell = tauri, no browser ground', `document.documentElement.dataset.shell`, 'tauri');
await check('rects reported', `__hits.at(-1).length`, (n) => n >= 5);
await check('every rect inside the app box', `(()=>{const a=document.querySelector('.nw-app').getBoundingClientRect();return __hits.at(-1).every(([x,y,w,h])=>x>=a.x-1&&y>=a.y-1&&x+w<=a.right+1&&y+h<=a.bottom+1)})()`, true);
const n0 = await ev('__hits.length');
await ev(`document.querySelector('[data-action="view-menu"]').click()`); await sleep(300);
await check('opening the menu re-reports, menu included', `[__hits.length > ${n0}, __hits.at(-1).length > __hits[${n0}-1].length]`, [true, true]);
await ev(`document.querySelector('.nw-log h3').click()`); await sleep(300);
const n1 = await ev('__hits.length');
await ev(`document.querySelector('.nw-app > .nw-lanes .nw-lane[data-lane="opus"] > header').click()`); await sleep(300);
await check('opening a lane re-reports a taller card', `__hits.length > ${n1}`, true);
const n2 = await ev('__hits.length'); await sleep(1000);
await check('quiet when nothing changes', `__hits.length`, n2);
await check('on-top starts off', 'window.__top?.[0]', false);
// ---- the canvas (10/6): nothing is measured or fitted; the app is placed, dragged, remembered, clamped
await send('Emulation.setDeviceMetricsOverride', { width: 1470, height: 760, deviceScaleFactor: 1, mobile: false });
await go(BASE + '?skin=minimal'); await ev('localStorage.clear()'); await go(BASE + '?skin=minimal');
const appXY = `(r=>[Math.round(r.x),Math.round(r.y)])(document.querySelector('.nw-app').getBoundingClientRect())`;
await check('no window fitting at all', 'window.__fits ?? null', null);
await check('the app starts at the default spot', appXY, [112, 24]);
await check('the head no longer drags the whole window', `document.querySelector('.nw-head').hasAttribute('data-tauri-drag-region')`, false);
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
const drag = async (from, to) => {
  await mouse('mousePressed', ...from);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', from[0] + (to[0] - from[0]) * i / 6, from[1] + (to[1] - from[1]) * i / 6);
  await sleep(100); await mouse('mouseReleased', ...to); await sleep(300);
};
await ev('window.__hits.length=0');
const title = await ev(`(r=>[Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)])(document.querySelector('.nw-head [data-part="title"]').getBoundingClientRect())`);
await drag(title, [title[0] + 300, title[1] + 150]);
await check('dragging the head moves the app', appXY, [412, 174]);
await check('mid-drag the whole window was live, then real areas again', `[__hits.some(h=>h.length===1&&h[0][0]===0&&h[0][2]===innerWidth), __hits.at(-1).length > 1]`, [true, true]);
await go(BASE + '?skin=minimal');
await check('the spot survives a relaunch', appXY, [412, 174]);
const btn = await ev(`(r=>[Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)])(document.querySelector('[data-action="view-menu"]').getBoundingClientRect())`);
await drag(btn, [btn[0] - 200, btn[1] + 100]);
await check('a press on a head button never drags', appXY, [412, 174]);
await ev(`document.querySelector('.nw-head').click()`); // close a menu the press may have opened
const t2 = await ev(`(r=>[Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)])(document.querySelector('.nw-head [data-part="title"]').getBoundingClientRect())`);
await drag(t2, [t2[0] + 3000, t2[1] + 3000]);
await check('dragged off the edge, the head stays on screen', `(r=>r.x<=innerWidth-120&&r.y<=innerHeight-40)(document.querySelector('.nw-app').getBoundingClientRect())`, true);
await ev('localStorage.clear()');
for (const skin of ['minimal', 'glass', 'amber', 'metal', 'wacky', 'steampunk']) {
  await go(BASE + '?skin=' + skin); await sleep(600);
  for (const m of ['view', 'look', 'app']) {
    await ev(`document.querySelector('[data-action="${m}-menu"]').click()`); await sleep(250);
    await check(`${skin}: the ${m} menu is whole and on top`, `(m=>{const r=m.getBoundingClientRect();const top=document.elementFromPoint(r.x+r.width/2,r.bottom-8);return r.bottom<=innerHeight&&r.right<=innerWidth&&!!top&&m.contains(top)})(document.querySelector('[data-menu="${m}"]'))`, true);
    await ev(`document.querySelector('[data-action="${m}-menu"]').click()`);
  }
  // The midday switch lights and dims exactly like the bell (Ra, 10/12): same
  // colour, opacity and glow in both states, and on differs from off.
  await check(`${skin}: the midday switch looks like the bell, on and off`, `(()=>{const c=[...document.querySelectorAll('.nw-app > .nw-lanes .nw-lane')].find(c=>c.querySelector('[data-part="next"]')&&c.querySelector('[data-part="midday"]'));const b=c.querySelector('[data-part="next"]'),m=c.querySelector('[data-part="midday"]');const st=e=>{const s=getComputedStyle(e);return [s.color,s.opacity,s.textShadow].join('|')};const r=[];for(const v of ['true','false']){b.setAttribute('aria-pressed',v);m.setAttribute('aria-pressed',v);r.push(st(b)===st(m),st(m))}return r[0]&&r[2]&&r[1]!==r[3]})()`, true);
}
// ---- Vertical + persona rows (Ra, 10/7: clicks fell through after expanding a card or clicking "weft")
await send('Emulation.setDeviceMetricsOverride', { width: 1470, height: 1100, deviceScaleFactor: 1, mobile: false });
await go(BASE + '?skin=minimal'); await ev('localStorage.clear()'); await go(BASE + '?skin=minimal'); await sleep(400);
await ev(`(()=>{const i=document.querySelector('[name="layout"][value="column"]'); i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(400);
const COVERED = `(()=>{const rs=__hits.at(-1), els=[...document.querySelectorAll('.nw-app > .nw-lanes .nw-lane, .nw-app > .nw-lanes .nw-persona > [data-part="persona-card"]')].filter(e=>e.getClientRects().length);
  const bad=els.filter(e=>{const b=e.getBoundingClientRect(); return !rs.some(([x,y,w,h])=>x<=b.x+1&&y<=b.y+1&&x+w>=b.right-1&&y+h>=b.bottom-1)}); return bad.map(e=>e.dataset.lane??e.textContent)})()`;
await check('Vertical: every card and persona name has a click region', COVERED, []);
await ev(`document.querySelector('.nw-app > .nw-lanes .nw-lane[data-lane="opus"] > header').click()`); await sleep(400);
await check('...still true after expanding a card (regions follow the new heights)', COVERED, []);
await ev(`document.querySelector('.nw-app > .nw-lanes .nw-persona [data-part="persona-name"]').click()`); await sleep(400);
await check('...and after clicking the persona name', COVERED, []);
await ev('localStorage.clear()');

// ---- the terminal button is a toggle (Ra, 10/7), against a stand-in host that knows each lane's window
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__term={opus:'open',fable:'hidden'};window.__tcalls=[];
  window.NW_HOST={can:a=>['hide-window','open-terminal','hide-terminal','terminal-state'].includes(a),
    act:(a,o)=>{ if(a==='terminal-state') return Promise.resolve(__term[o.lane]??'missing');
      __tcalls.push([a,o.lane]); if(a==='hide-terminal') __term[o.lane]='hidden'; if(a==='open-terminal') __term[o.lane]='front'; return Promise.resolve(''); },
    hitRects:()=>{}, onTop:()=>{}};` });
await go(BASE + '?skin=minimal'); await sleep(1200);
const TB = (lane) => `document.querySelector('.nw-app > .nw-lanes .nw-lane[data-lane="${lane}"] :is([data-action="open-terminal"],[data-action="hide-terminal"])')`;
await check('an open terminal shows as Hide; a minimized one as Open', `[${TB('opus')}.dataset.action, ${TB('fable')}.dataset.action]`, ['hide-terminal', 'open-terminal']);
await ev(`${TB('opus')}.click()`); await sleep(400);
await check('pressing Hide minimizes that lane\'s window and flips the button', `[JSON.stringify(__tcalls.at(-1)), ${TB('opus')}.dataset.action, ${TB('opus')}.querySelector('use').getAttribute('href')]`, ['["hide-terminal","opus"]', 'open-terminal', '#i-terminal']);
// This runs against the live hub, so fable may really be asleep (10/8: it was,
// all day, and the step failed). Asleep, its button is disabled and must do
// nothing; awake, Open must bring it forward and flip to Hide.
const fableAsleep = await ev(`${TB('fable')}.getAttribute('aria-disabled') === 'true'`);
const callsBefore = await ev('__tcalls.length');
await ev(`${TB('fable')}.click()`); await sleep(400);
if (fableAsleep) await check('a sleeping lane\'s terminal button is disabled and does nothing', `[__tcalls.length, ${TB('fable')}.dataset.action]`, [callsBefore, 'open-terminal']);
else await check('pressing Open brings it forward and flips to Hide', `[JSON.stringify(__tcalls.at(-1)), ${TB('fable')}.dataset.action, ${TB('fable')}.querySelector('use').getAttribute('href')]`, ['["open-terminal","fable"]', 'hide-terminal', '#i-terminal-hide']);

// ---- the persona card and the + are clickable, not click-through (10/7)
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__hits2=[];window.NW_HOST={can:a=>a==='hide-window',act:()=>Promise.resolve(''),hitRects:r=>__hits2.push(r),onTop:()=>{}};` });
await go(BASE + '?skin=minimal'); await ev('localStorage.clear()'); await go(BASE + '?skin=minimal'); await sleep(500);
await ev(`document.querySelector('.nw-app > .nw-lanes .nw-persona [data-part="show-agents"]').click()`); await sleep(500);
const COV = (sel) => `(e=>{const b=e.getBoundingClientRect(); return __hits2.at(-1).some(([x,y,w,h])=>x<=b.x+1&&y<=b.y+1&&x+w>=b.right-1&&y+h>=b.bottom-1)})(document.querySelector('${sel}'))`;
await check('agents hidden: the persona card has a click region', COV('.nw-app > .nw-lanes .nw-persona > [data-part="persona-card"]'), true);
await check('...and so does the floating + (Add persona)', COV('.nw-app > .nw-lanes > .nw-add-persona'), true);
await ev('localStorage.clear()');

console.log(`\n${pass} passed, ${fail} failed`); ws.close(); ch.kill(); process.exit(fail ? 1 : 0);
