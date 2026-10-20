// Nightwatch runtime test: drives the SERVED page over CDP and reads back what
// runtime.js wrote. Needs the viewer on 7352. Run:
//   node --experimental-websocket skins/test/drive.mjs [baseUrl]
// Drive the served Nightwatch page through CDP: click each control, read back
// what the runtime wrote. Usage: node drive.mjs [baseUrl]
import { launchChrome } from './chrome.mjs';
import { rmSync } from 'node:fs';
const BASE = process.argv[2] ?? 'http://127.0.0.1:7352/';
const PORT = 9337;
const { ch, prof } = launchChrome({ port: PORT }); // killed and removed on every way out (chrome.mjs)
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
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__errs=[];addEventListener('error',e=>__errs.push(e.message+' @'+e.lineno));addEventListener('unhandledrejection',e=>__errs.push('rej '+e.reason))` });
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1500); };
// The live page carries whatever alerts the house has right now (a spiral on a working evening), and an un-acked
// alert keeps its lane and persona open by design. Sections that fold things press "Got it" on them first.
const ackLive = async () => { await ev(`document.querySelectorAll('.nw-app .nw-alert[data-acked="false"] [data-action="ack"]').forEach((b) => b.click())`); await sleep(200); };

let pass = 0, fail = 0;
const check = async (name, expr, want) => {
  const got = await ev(expr);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const click = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'missing'; e.click(); return 'clicked'})()`);

await go(`${BASE}?skin=glass`);
await check('no boot errors', 'window.__errs', []);
await check('skin link = glass', `document.getElementById('skin').getAttribute('href')`, 'glass/skin.css');
await check('skin stylesheet loaded', `[...document.styleSheets].some(s=>s.href&&s.href.endsWith('glass/skin.css')&&s.cssRules.length>50)`, true);
await check('shell backdrop on', `document.documentElement.dataset.shell`, 'browser');
await check('desk off', `document.documentElement.dataset.desk`, '0');
await check('read-only marks the deck\'s big button (Wake all or Sleep all)', `document.querySelector('.nw-app > .nw-controls [data-part="primary"]').getAttribute('aria-disabled')`, 'true');
await check('show-log stays live', `document.querySelector('.nw-lane [data-action="show-log"]').getAttribute('aria-disabled')`, null);
// A tip that ends in its own period gets one period before the read-only note, not two (marginalia, #25:
// "The nightshift keeps watching.. Read-only for now"). Hide's tip is the one that ends in a period.
await check('read-only tips: one period before the note', `(()=>{const ro=[...document.querySelectorAll('[data-ro-tip]')];return {marked:ro.length>0,doubled:ro.filter(b=>b.dataset.tip.includes('..')).length}})()`, { marked: true, doubled: 0 });
await check('hide\'s tip reads cleanly', `document.querySelector('[data-action="hide-window"]').dataset.tip`, "Hide to the menu bar. The nightshift keeps watching. Read-only for now: Nightwatch shows the house, it doesn't drive it yet.");

// unforced refresh: runs when idle, holds off while a live form is open
await ev(`document.querySelector('.nw-app > .nw-lanes').dataset.mark='old'`);
await ev(`NW_RUNTIME.refresh()`);
await check('idle page refreshes unforced', `document.querySelector('.nw-app > .nw-lanes').dataset.mark`, undefined);
await click('.nw-app > .nw-lanes .nw-lane[data-lane="opus"] [data-action="lane-settings"]');
await ev(`document.querySelector('.nw-app > .nw-lanes').dataset.mark='old'`);
await ev(`NW_RUNTIME.refresh()`);
await check('refresh waits while lane settings are open', `document.querySelector('.nw-app > .nw-lanes').dataset.mark`, 'old');
await click('.nw-app > .nw-lanes .nw-lane[data-lane="opus"] [data-action="lane-settings"]');
await check('desk forced off when served', `document.documentElement.dataset.desk`, '0');

// app-level alarm ack (v0.9.1 shape, injected until the emitter produces one)
await ev(`(()=>{const d=document.createElement('div');d.className='nw-alarm';d.setAttribute('role','alert');d.dataset.kind='daemon-down';d.dataset.acked='false';d.dataset.ackId='daemon-down:2026-10-06T10:00:00Z';d.innerHTML='<p data-part="title">The nightshift isn\\'t running</p><button type="button" data-action="ack" data-part="ack">Got it</button>';document.querySelector('.nw-app > .nw-alarms').append(d)})()`);
await ev(`document.querySelector('.nw-app > .nw-alarms > .nw-alarm [data-action="ack"]').click()`);
await check('app alarm acks', `document.querySelector('.nw-app > .nw-alarms > .nw-alarm').dataset.acked`, 'true');
await check('...and is gone from view, not left dimmed (Ra, 10/7)', `!document.querySelector('.nw-app > .nw-alarms > .nw-alarm').getClientRects().length`, true);
await check('alarm ack remembered by episode', `JSON.parse(localStorage.getItem('nightwatch.view.v1')).acked.includes('daemon-down:2026-10-06T10:00:00Z')`, true);
await ev(`document.querySelector('.nw-app > .nw-alarms > .nw-alarm').remove()`);

// app settings panel (10/6)
await check('settings starts closed', `document.querySelector('.nw-app > .nw-settings').dataset.open`, 'false');
// Settings left the deck for a third head menu, with Keep on top (Ra, 10/7 round 6).
await check('the transport is play, pause, stop, nightly, then the timeline and log toggles', `[...document.querySelectorAll('.nw-app > .nw-controls [data-part="transport"] button')].map(b=>b.dataset.action).slice(-4)`, ['fold-all', 'toggle-nightly', 'toggle-timeline', 'toggle-log']);
await check('each toggle\'s tip says its state', `[...document.querySelectorAll('.nw-app > .nw-controls :is([data-action="toggle-nightly"], [data-part="panel-toggle"])')].every(b=>b.dataset.tip === (b.getAttribute('aria-pressed')==='true' ? b.dataset.tipOn : b.dataset.tipOff))`, true);
await click('.nw-app > .nw-controls [data-action="toggle-log"]');
await check('...and follows a press', `(b=>[b.getAttribute('aria-pressed'), b.dataset.tip])(document.querySelector('.nw-app > .nw-controls [data-action="toggle-log"]'))`, ['false', 'Show the log']);
await click('.nw-app > .nw-controls [data-action="toggle-log"]');
await check('the View menu keeps only layout things', `!document.querySelector('.nw-head [data-part="view-menu"][data-menu="view"] :is([data-action="app-settings"], [data-view-toggle="on-top"])')`, true);
await ev(`document.querySelector('[data-action="app-menu"]').click()`);
await check('the Settings menu opens from the head', `document.querySelector('.nw-head [data-part="view-menu"][data-menu="app"]').dataset.open`, 'true');
await ev(`document.querySelector('.nw-head [data-part="view-menu"][data-menu="app"] [data-action="app-settings"]').click()`);
await check('its first item opens Settings (and closes the menu)', `[document.querySelector('.nw-app > .nw-settings').dataset.open, document.querySelector('.nw-head [data-part="view-menu"][data-menu="app"]').dataset.open]`, ['true', 'false']);
await ev(`document.querySelector('.nw-app > .nw-settings [data-action="close-settings"]').click()`);
await check('close button shuts it', `document.querySelector('.nw-app > .nw-settings').dataset.open`, 'false');
await ev(`document.querySelector('.nw-head [data-part="view-menu"][data-menu="app"] [data-action="app-settings"]').click()`);
await check('it opens again from the menu', `document.querySelector('.nw-app > .nw-settings').dataset.open`, 'true');
await check('health check names the real heartbeat', `document.querySelector('.nw-settings [data-part="doctor"] li').textContent.includes('last heartbeat')`, true);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
await check('escape shuts it', `document.querySelector('.nw-app > .nw-settings').dataset.open`, 'false');

// accordion
const lane = `.nw-app > .nw-lanes .nw-lane[data-lane="opus"]`;
const before = await ev(`document.querySelector('${lane}').dataset.open`);
await click(`${lane} > header`);
await check('header toggles lane', `document.querySelector('${lane}').dataset.open`, before === 'true' ? 'false' : 'true');
await click(`${lane} [data-part="toggle"]`);
await check('chevron toggles back', `document.querySelector('${lane}').dataset.open`, before);
await check('aria-expanded in sync', `document.querySelector('${lane} [data-part="toggle"]').getAttribute('aria-expanded')`, before);

// view menu + skin picker
await click('[data-action="view-menu"]');
await check('menu opens', `document.querySelector('[data-part="view-menu"]').dataset.open`, 'true');
await check('glass radio checked', `document.querySelector('[name="skin"][value="glass"]').checked`, true);
await check('seven skins listed', `document.querySelectorAll('[name="skin"]').length`, 7);
await click('[name="skin"][value="metal"]');
await sleep(300);
await check('skin swaps to metal', `document.getElementById('skin').getAttribute('href')`, 'metal/skin.css');
await check('url remembers skin', `new URL(location.href).searchParams.get('skin')`, 'metal');
await click('[name="layout"][value="stack"]');
await check('layout radio writes app', `document.querySelector('.nw-app').dataset.layout`, 'stack');
await click('[name="layout"][value="row"]');
// Timeline and Log are deck buttons now, not menu checkboxes (Ra, 10/7). On a fresh load with nothing stored, they
// must already show the panels as open (they came up dark until clicked twice).
await ev('localStorage.clear()'); await go(BASE + '?skin=metal'); await sleep(500);
await check('fresh load: the Timeline and Log buttons are lit when their panels are open', `[...document.querySelectorAll('.nw-app > .nw-controls [data-part="panel-toggle"]')].map(b=>[b.dataset.action, b.getAttribute('aria-pressed'), b.dataset.tip])`, [['toggle-timeline', 'true', 'Hide the timeline'], ['toggle-log', 'true', 'Hide the log']]);
await ev(`window.NW_RUNTIME.refresh()`); await sleep(1500);
await check('...and still after a refresh re-renders the deck', `[...document.querySelectorAll('.nw-app > .nw-controls [data-part="panel-toggle"]')].map(b=>b.getAttribute('aria-pressed'))`, ['true', 'true']);
// (the URL's skin isn't stored; choose Metal from the menu again, for the reload check further on)
await ev(`(()=>{const i=document.querySelector('[name="skin"][value="metal"]'); i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(400);
await ev(`document.querySelector('[data-action="view-menu"]').click()`); await sleep(200);
// Timeline and Log are deck buttons now, not menu checkboxes (Ra, 10/7).
await check('the View menu has no Timeline or Log checkbox', `!document.querySelector('[data-view-toggle="timeline"], [data-view-toggle="log"]')`, true);
await click('.nw-controls [data-action="toggle-timeline"]');
await check('the Timeline button hides the timeline, and says so', `[document.querySelector('.nw-app').dataset.showTimeline, document.querySelector('.nw-controls [data-action="toggle-timeline"]').getAttribute('aria-pressed')]`, ['false', 'false']);
await click('.nw-controls [data-action="toggle-timeline"]');
await click('.nw-log h3');
await check('outside click closes menu', `document.querySelector('[data-part="view-menu"]').dataset.open`, 'false');

// deck log toggle
const logBefore = await ev(`document.querySelector('.nw-app').dataset.showLog`);
await click('.nw-controls [data-action="toggle-log"]');
await check('deck toggles log', `document.querySelector('.nw-app').dataset.showLog`, logBefore === 'true' ? 'false' : 'true');
await check('deck aria-pressed in sync', `document.querySelector('.nw-controls [data-action="toggle-log"]').getAttribute('aria-pressed')`, logBefore === 'true' ? 'false' : 'true');
await click('.nw-controls [data-action="toggle-log"]');

// log filters
await click('.nw-log [data-part="filters"] label[data-kind="fold"] input');
await check('fold filter hides folds', `[...document.querySelectorAll('.nw-log li.nw-event[data-kind="fold"]')].every(r=>r.hidden)`, true);
await check('other rows stay', `[...document.querySelectorAll('.nw-log li.nw-event[data-kind="launch"]')].some(r=>!r.hidden)`, true);
await click('.nw-log [data-part="filters"] label[data-kind="fold"] input');
await check('fold filter restores', `[...document.querySelectorAll('.nw-log li.nw-event[data-kind="fold"]')].some(r=>!r.hidden)`, true);

// range
await click('.nw-timeline [data-range="24h"]');
await sleep(800);
await check('range radio checks 24h', `document.querySelector('.nw-timeline [data-range="24h"]').getAttribute('aria-checked')`, 'true');
await check('range survives the timeline swap', `document.querySelector('.nw-timeline').dataset.range`, '24h');
await click('.nw-timeline [data-range="8h"]'); await sleep(800);

// refresh keeps view state
await ackLive();
await click(`${lane} > header`);
const openNow = await ev(`document.querySelector('${lane}').dataset.open`);
await click('.nw-log [data-part="filters"] label[data-kind="launch"] input');
await ev(`NW_RUNTIME.refresh({force:true})`);
await check('refresh keeps lane open state', `document.querySelector('${lane}').dataset.open`, openNow);
await check('refresh keeps filters', `[...document.querySelectorAll('.nw-log li.nw-event[data-kind="launch"]')].every(r=>r.hidden)`, true);
await check('handlers survive the swap', `(document.querySelector('${lane} > header').click(), document.querySelector('${lane}').dataset.open)`, openNow === 'true' ? 'false' : 'true');
await click('.nw-log [data-part="filters"] label[data-kind="launch"] input');

// lane log button narrows the log
await click(`${lane} [data-action="show-log"]`);
await check('lane Logs narrows to lane', `[...document.querySelectorAll('.nw-log li.nw-event')].filter(r=>!r.hidden).every(r=>r.dataset.lane==='opus')`, true);

// persistence across a reload without ?skin
await go(BASE);
await check('stored skin survives reload', `document.getElementById('skin').getAttribute('href')`, 'metal/skin.css');
await check('no errors after reload', 'window.__errs', []);
await check('clock is live', `document.querySelector('time[data-part="clock"]').textContent === new Date().toTimeString().slice(0,5)`, true);

// ---- Appearance (10/6): system by default; Light/Dark stick; one-look skins say so
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
await go(BASE + '?skin=minimal'); await ev('localStorage.clear()'); await go(BASE + '?skin=minimal');
const surf = `getComputedStyle(document.documentElement).getPropertyValue('--nw-surface').trim()`;
await check('default follows the system (dark here)', `[document.documentElement.dataset.theme ?? null, ${surf}, document.querySelector('[name="theme"][value="system"]').checked]`, [null, '#1c1c1f', true]);
const pick = (v) => ev(`(()=>{const i=document.querySelector('[name="theme"][value="${v}"]'); i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
await pick('light');
await check('Light wins over a dark system', `[document.documentElement.dataset.theme, ${surf}]`, ['light', '#ffffff']);
await go(BASE + '?skin=minimal');
await check('the choice survives a reload', `[document.documentElement.dataset.theme, document.querySelector('[name="theme"][value="light"]').checked]`, ['light', true]);
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
await pick('dark');
await check('Dark wins over a light system', `[document.documentElement.dataset.theme, ${surf}]`, ['dark', '#1c1c1f']);
await pick('system');
await check('System hands it back', `[document.documentElement.dataset.theme ?? null, ${surf}]`, [null, '#ffffff']);
await ev(`(()=>{const i=document.querySelector('[name="skin"][value="amber"]'); i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(800);
await check('a one-look skin hides Appearance, heading and divider too', `[document.querySelector('[data-view="theme"][data-value="dark"]').closest('li').hidden, document.querySelector('[data-part="theme-heading"]').hidden, document.querySelector('[data-part="theme-separator"]').hidden]`, [true, true, true]);
await ev(`(()=>{const i=document.querySelector('[name="skin"][value="minimal"]'); i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(800);
await check('and a two-look skin shows it again', `document.querySelector('[data-view="theme"][data-value="dark"]').closest('li').hidden`, false);
await send('Emulation.setEmulatedMedia', { features: [] }); await ev('localStorage.clear()');

// ---- layouts (10/6): vertical panels, and the log down the side
await go(BASE + '?skin=minimal'); await ev('localStorage.clear()'); await go(BASE + '?skin=minimal');
const pickLayout = (v) => ev(`(()=>{const i=document.querySelector('[name="layout"][value="${v}"]'); i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
const toggle = (v, on) => ev(`(()=>{const i=document.querySelector('[data-view-toggle="${v}"]'); i.checked=${on}; i.dispatchEvent(new Event('change',{bubbles:true}))})()`);
await toggle('timeline', true); await toggle('log', true); await pickLayout('column'); await sleep(300);
await check('vertical panels: each persona\'s lanes form one column', `[...document.querySelectorAll('.nw-app > .nw-lanes .nw-persona')].every(g=>(xs=>xs.length>0&&xs.every(x=>x===xs[0]))([...g.querySelectorAll(':scope > .nw-lane[data-lane]')].map(l=>Math.round(l.getBoundingClientRect().x))))`, true);
await check('vertical panels: the timeline runs down, newest at the top (axis always; nodes when the range has spread)', `(()=>{const t=n=>parseFloat(n.style.getPropertyValue('--t'));
  const down=(ns,minSpread)=>{if(ns.length<2)return null;const hi=ns.reduce((a,b)=>t(b)>t(a)?b:a), lo=ns.reduce((a,b)=>t(b)<t(a)?b:a), d=t(hi)-t(lo); if(d<minSpread)return null; return hi.getBoundingClientRect().y < lo.getBoundingClientRect().y - d*100};
  const axis=down([...document.querySelectorAll('.nw-timeline [data-part="axis"] span')], .1), nodes=down([...document.querySelectorAll('.nw-strip[data-mode="expanded"] .nw-node')], .05);
  return axis===true && nodes!==false})()`, true);
await check('Minimal: no "log down the side" option (it always does it)', `document.querySelector('[data-view="log-tall"]').closest('li').hidden`, true);
// Vertical: the timeline and the log share one region; whichever is open fills it, and with both closed the column
// ends at the deck (Ra, 10/7).
const H = (sel) => `document.querySelector('.nw-app > ${sel}').offsetHeight`;
await ev(`document.querySelector('.nw-app').dataset.showLog !== 'true' && document.querySelector('.nw-controls [data-action="toggle-log"]').click()`); await sleep(400);
const region = await ev(`(()=>{const a=document.querySelector('.nw-app'), tl=a.querySelector(':scope > .nw-timeline'), lg=a.querySelector(':scope > .nw-log'); return lg.getBoundingClientRect().bottom - tl.getBoundingClientRect().top})()`);
const deckH = await ev(H('.nw-controls'));
await ev(`document.querySelector('.nw-controls [data-action="toggle-timeline"]').click()`); await sleep(400);
await check('Vertical: the Timeline button hides it', `getComputedStyle(document.querySelector('.nw-app > .nw-timeline')).display`, 'none');
await check('...and the log takes the whole region', `Math.abs(${H('.nw-log')} - ${region}) <= 2`, true);
await ev(`document.querySelector('.nw-controls [data-action="toggle-timeline"]').click()`); await ev(`document.querySelector('.nw-controls [data-action="toggle-log"]').click()`); await sleep(400);
await check('Vertical: with the log closed, the timeline takes the whole region', `Math.abs(${H('.nw-timeline')} - ${region}) <= 2`, true);
await ev(`document.querySelector('.nw-controls [data-action="toggle-timeline"]').click()`); await sleep(400);
await check('Vertical: both closed, the column ends at the deck (the deck keeps its height)', `${H('.nw-controls')} === ${deckH}`, true);
await ev(`document.querySelector('.nw-controls [data-action="toggle-timeline"]').click()`); await ev(`document.querySelector('.nw-controls [data-action="toggle-log"]').click()`); await sleep(400);
await check('Vertical: the sleep band runs across the timeline', `getComputedStyle(document.querySelector('.nw-timeline > [data-part="sleep-bands"]')).display`, 'block');
await ev(`(()=>{const i=document.querySelector('[name="skin"][value="wacky"]'); i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(900);
await check('Moonlamp: Vertical is not on the menu, shown Horizontal', `[document.querySelector('[data-view="layout"][data-value="column"]').closest('li').hidden, document.querySelector('.nw-app').dataset.layout]`, [true, 'row']);
await ev(`(()=>{const i=document.querySelector('[name="skin"][value="amber"]'); i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(900);
await check('back on a skin that has it, the choice returns', `document.querySelector('.nw-app').dataset.layout`, 'column');
await check('Amber in Vertical: no "log down the side" (Horizontal only)', `document.querySelector('[data-view="log-tall"]').closest('li').hidden`, true);
await pickLayout('row'); await toggle('log-tall', true); await sleep(300);
await check('Amber: "log down the side" stretches the log beside the lanes', `(l=>[String(document.querySelector('[data-view="log-tall"]').closest('li').hidden), Math.round(l.getBoundingClientRect().bottom) >= Math.round(document.querySelector('.nw-app > .nw-lanes').getBoundingClientRect().bottom) - 2])(document.querySelector('.nw-app > .nw-log'))`, ['false', true]);
await toggle('log-tall', false); await sleep(300);
await check('and unticked, it sits back in the panel row', `Math.round(document.querySelector('.nw-app > .nw-log').getBoundingClientRect().bottom) < Math.round(document.querySelector('.nw-app > .nw-lanes').getBoundingClientRect().top) + 2`, true);
await ev('localStorage.clear()');

// ---- Glass, inactive window (10/6): panes firm up when macOS stops the frost
await go(BASE + '?skin=glass');
const gsurf = `getComputedStyle(document.documentElement).getPropertyValue('--nw-surface').trim()`;
for (const scheme of ['light', 'dark']) {
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await ev(`document.documentElement.dataset.windowActive = 'true'`);
  const active = await ev(gsurf);
  await ev(`document.documentElement.dataset.windowActive = 'false'`);
  await check(`Glass ${scheme}: inactive window, near-opaque panes (was ${active})`, `${gsurf}.endsWith('/ .95)')`, true);
}
await send('Emulation.setEmulatedMedia', { features: [] });

// ---- 10/7: the working light, the deck's big button, the remembered range
await go(BASE + '?skin=minimal'); await ev('localStorage.clear()'); await go(BASE + '?skin=minimal'); await sleep(300);
// This test runs inside the opus session, so opus is mid-inference right now.
await check('the working light: opus (running this test) reads working', `document.querySelector('.nw-lane[data-lane="opus"]')?.dataset.activity`, 'working');
await check('a working light breathes', `getComputedStyle(document.querySelector('.nw-lane[data-lane="opus"] [data-part="state"]')).animationName`, 'nw-working');
await check("the big button fits the house: Wake all only if a lane can wake, else Sleep all; Sleep all appears once",
  `(()=>{const wakeable=[...document.querySelectorAll('.nw-app > .nw-lanes .nw-lane[data-lane]')].some(l=>['sleeping','failed','orphaned'].includes(l.dataset.state));
    const p=document.querySelector('.nw-app > .nw-controls [data-part="transport"] [data-part="primary"]').dataset.action;
    return p===(wakeable?'wake-all':'sleep-all') && document.querySelectorAll('.nw-app > .nw-controls [data-part="transport"] [data-action="sleep-all"]').length===1})()`, true);
const tlHours = `(t=>Math.round((Date.parse(t.dataset.to)-Date.parse(t.dataset.from))/3600e3))(document.querySelector('.nw-timeline'))`;
await ev(`document.querySelector('.nw-timeline [data-part="range"] [data-range="24h"]').click()`); await sleep(1500);
await check('picking 24h serves a 24h timeline', tlHours, 24);
await go(BASE + '?skin=minimal'); await sleep(2000); // a restart: the server renders its default range
await check('after a restart the remembered 24h is what the timeline shows, not just the button',
  `[document.querySelector('.nw-timeline [data-range="24h"]').getAttribute('aria-checked'), ${tlHours}]`, ['true', 24]);
await ev('localStorage.clear()');

// ---- 10/7: tips on the top card flip below instead of running into the head bar
await go(BASE + '?skin=minimal'); await ev('localStorage.clear()'); await go(BASE + '?skin=minimal');
await ev(`(()=>{const i=document.querySelector('[name="layout"][value="column"]'); i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(300);
const hover = (sel) => `(()=>{const el=document.querySelector('${sel}'); el.dispatchEvent(new PointerEvent('pointerover',{bubbles:true})); return el.dataset.tipPos ?? 'above'})()`;
// The topmost tipped things in Vertical's lane column are the first persona's lights (10/7 round 5: the name lost its
// tip, and the lights sit under the persona header, so they have room). Nudged up against the head bar, a tip flips.
const LIGHT = '.nw-app > .nw-lanes .nw-persona:first-child [data-part="persona-agents"] li';
await check('Vertical: the persona lights\' tips have room above them', hover(LIGHT), 'above');
await ev(`document.querySelector('.nw-app > .nw-lanes').style.translate = '0 -40px'`);
await check('...and a tip pressed up against the head bar flips below it', hover(LIGHT), 'below');
await ev(`document.querySelector('.nw-app > .nw-lanes').style.translate = ''`);
await check('...while a tip with room above stays above', hover('.nw-app > .nw-controls [data-part="primary"]'), 'above');
await ev('localStorage.clear()');

// ---- 10/7: the deck clocks, and the session id only behind Copy session ID
await go(BASE + '?skin=minimal'); await ev('localStorage.clear()'); await go(BASE + '?skin=minimal'); await sleep(400);
await check('awake cards count their time up', `[...document.querySelectorAll('.nw-app > .nw-lanes .nw-lane[data-state="awake"] [data-part="uptime"] time[data-part="elapsed"]')].every(t=>/^(\\d+h \\d\\dm|\\d+m)$/.test(t.textContent))`, true);
await check('the session id is shown nowhere on a card (text or tips)', `[...document.querySelectorAll('.nw-app > .nw-lanes .nw-lane[data-lane]')].every(l=>{const sid=l.querySelector('[data-action="copy-session"]')?.dataset.session; if(!sid) return true; const short=sid.slice(0,8); return !l.textContent.includes(short) && ![...l.querySelectorAll('[data-tip]')].some(e=>e.dataset.tip.includes(short))})`, true);
await check('settings carries the FULL session id', `(document.querySelector('.nw-app > .nw-lanes .nw-lane[data-lane="opus"] [data-action="copy-session"]')?.dataset.session ?? '').length`, 36);
await ev(`window.__copied=null; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:(t)=>{window.__copied=t;return Promise.resolve()}}})`);
await ev(`document.querySelector('.nw-app > .nw-lanes .nw-lane[data-lane="opus"] [data-action="copy-session"]').click()`); await sleep(300);
await check('Copy session ID copies exactly that id, and says so', `[window.__copied === document.querySelector('.nw-app > .nw-lanes .nw-lane[data-lane="opus"] [data-action="copy-session"]').dataset.session, /^Copied session ID /.test(document.querySelector('.nw-app > .nw-toast')?.textContent ?? '')]`, [true, true]);
await ev('localStorage.clear()');

// ---- 10/7: a lane's Logs narrowing can be undone; the persona tip reads upright
await go(BASE + '?skin=minimal'); await ev('localStorage.clear()'); await go(BASE + '?skin=minimal'); await sleep(400);
await ev(`document.querySelector('.nw-app > .nw-lanes .nw-lane[data-lane="opus"] [data-action="show-log"]').click()`); await sleep(300);
await ev(`(()=>{const i=document.querySelector('.nw-log [data-part="filters"] label[data-kind="bell"] input'); i.checked=false; i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(200);
await check('narrowed: only opus rows, and the heading names the lane', `(l=>[[...l.querySelectorAll('li.nw-event:not([hidden])')].every(r=>r.dataset.lane==='opus'), l.dataset.laneOnly, getComputedStyle(l.querySelector('[data-part="heading"]'),'::after').content !== 'none'])(document.querySelector('.nw-app > .nw-log'))`, [true, 'opus', true]);
await ev(`document.querySelector('.nw-log [data-action="reset-log"]').click()`); await sleep(300);
await check('reset: every lane again, filters back to their defaults', `(l=>[l.dataset.laneOnly, new Set([...l.querySelectorAll('li.nw-event:not([hidden])')].map(r=>r.dataset.lane)).size>1, [...l.querySelectorAll('[data-part="filters"] input')].every(i=>i.checked===i.defaultChecked)])(document.querySelector('.nw-app > .nw-log'))`, ['', true, true]);
await ev(`(()=>{const i=document.querySelector('[name="layout"][value="row"]'); i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(300);
await check('Horizontal: the persona name turns sideways but its label (and tip) stay upright', `(n=>[getComputedStyle(n).writingMode, getComputedStyle(n).rotate, getComputedStyle(n.querySelector('[data-part="label"]')).writingMode])(document.querySelector('.nw-app > .nw-lanes .nw-persona [data-part="persona-name"]'))`, ['horizontal-tb', 'none', 'vertical-rl']);
await ev('localStorage.clear()');

// ---- 10/7: the persona card's caret folds its own body; the eye hides the persona's agents; both stick
await go(BASE + '?skin=minimal'); await ev('localStorage.clear()'); await go(BASE + '?skin=minimal'); await sleep(400);
await ackLive();
const P = `document.querySelector('.nw-app > .nw-lanes .nw-persona')`;
// Horizontal's spine has no caret (round 6), and its tray shows even when the card was folded in another layout.
await check('Horizontal: the spine has no caret', `!${P}.querySelector('[data-part="persona-toggle"]').getClientRects().length`, true);
const LAYOUT = (v) => `(()=>{const i=document.querySelector('[name="layout"][value="${v}"]'); i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true}))})()`;
await ev(LAYOUT('column')); await sleep(300);
await ev(`${P}.querySelector('[data-part="persona-name"]').click()`); await sleep(300);
await check('the caret folds the card body only: lights and buttons away, agents still shown', `(g=>[g.querySelector('[data-part="persona-card"]').dataset.cardOpen, !g.querySelector('[data-part="persona-body"]').getClientRects().length, [...g.querySelectorAll(':scope > .nw-lane')].some(l=>l.getClientRects().length)])(${P})`, ['false', true, true]);
await ev(LAYOUT('row')); await sleep(300);
await check('...and back in Horizontal the folded card still shows its tray', `!!${P}.querySelector('[data-part="persona-body"]').getClientRects().length`, true);
await ev(LAYOUT('column')); await sleep(300);
await ev(`${P}.querySelector('[data-part="persona-name"]').click()`); await sleep(300);
await ev(LAYOUT('row')); await sleep(300);
await ev(`${P}.querySelector('[data-part="show-agents"]').click()`); await sleep(300);
const HIDDEN = `(g=>[g.dataset.open, g.querySelector('[data-part="show-agents"]').getAttribute('aria-pressed'), [...g.querySelectorAll(':scope > .nw-lane')].every(l=>!l.getClientRects().length), !!g.querySelector('[data-part="persona-card"]').getClientRects().length, g.querySelectorAll('[data-part="persona-agents"] li').length === g.querySelectorAll(':scope > .nw-lane[data-lane]').length])(${P})`;
await check('the eye hides the agents; the persona card stays, a light per agent', HIDDEN, ['false', 'false', true, true, true]);
await go(BASE + '?skin=minimal'); await sleep(500);
await check('...and stays hidden after a reload', HIDDEN, ['false', 'false', true, true, true]);
await ev(`${P}.querySelector('[data-part="show-agents"]').click()`); await sleep(300);
await check('the eye again shows them', `${P}.dataset.open`, 'true');
// ---- 10/7 round 5: the spine fits its row even when every card is folded; an alarm paints over routine nodes
for (const skin of ['minimal', 'metal']) {
  await go(BASE + `?skin=${skin}&layout=row`); await sleep(600);
  await ev(`document.querySelectorAll('.nw-app > .nw-lanes .nw-lane[data-lane]').forEach(l => l.dataset.open === 'true' && l.querySelector('header[data-action="toggle-lane"]').click())`); await sleep(500);
  await check(`${skin} Horizontal, all folded: each persona's spine fits inside its row`, `[...document.querySelectorAll('.nw-app > .nw-lanes > .nw-persona')].every(g=>{const c=g.querySelector(':scope > [data-part="persona-card"]'); const b=[...c.querySelectorAll('[data-part="persona-buttons"] button')].pop(); return b.getBoundingClientRect().bottom <= g.getBoundingClientRect().bottom + 0.5})`, true);
}
await check('an alarm node paints over the routine nodes beside it', `(()=>{const a=document.querySelector('.nw-node[data-alarm="true"]'), r=document.querySelector('.nw-node:not([data-alarm])'); return !a || +getComputedStyle(a).zIndex > +getComputedStyle(r).zIndex})()`, true);
// ---- 10/7 round 6: Metal's head meets the panels under it with no slit (when there are no app alarms)
await go(BASE + '?skin=metal'); await sleep(700);
for (const L of ['row', 'column']) {
  await ev(`(()=>{const i=document.querySelector('[name="layout"][value="${L}"]'); i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(400);
  await check(`Metal ${L}: no gap between the head and the panels under it`, `(a=>a.querySelector(':scope > .nw-alarms').children.length > 0 || a.querySelector(':scope > .nw-head').getBoundingClientRect().bottom === a.querySelector(':scope > .nw-controls').getBoundingClientRect().top)(document.querySelector('.nw-app'))`, true);
}
// ---- 10/7: choosing an option closes its menu (layout, skin, theme, a checkbox)
await go(BASE + '?skin=minimal'); await sleep(500);
for (const [menu, sel] of [['view', '[name="layout"][value="column"]'], ['view', '[data-view-toggle="controls"]'], ['look', '[name="theme"][value="dark"]'], ['look', '[name="skin"][value="glass"]'], ['app', '[data-view-toggle="on-top"]']]) {
  await ev(`document.querySelector('[data-action="${menu}-menu"]').click()`); await sleep(200);
  await ev(`document.querySelector('.nw-head [data-part="view-menu"][data-menu="${menu}"] ${sel}').click()`); await sleep(400);
  await check(`choosing ${sel} closes the ${menu} menu`, `document.querySelector('.nw-head [data-part="view-menu"][data-menu="${menu}"]').dataset.open`, 'false');
}
// ---- 10/7: Glass Horizontal: the + sits centred under the last persona's hanging tab
await go(BASE + '?skin=glass'); await sleep(700);
await ev(`(()=>{const i=document.querySelector('[name="layout"][value="row"]'); i.checked=true; i.dispatchEvent(new Event('change',{bubbles:true}))})()`); await sleep(500);
await check('Glass Horizontal: the + is centred under the last persona tab', `(a=>{const c=[...a.querySelectorAll('.nw-persona > [data-part="persona-card"]')].pop().getBoundingClientRect(), p=a.querySelector('.nw-add-persona').getBoundingClientRect(); return Math.abs((c.left+c.width/2)-(p.left+p.width/2)) <= 1 && p.top >= c.bottom})(document.querySelector('.nw-app'))`, true);
await ev('localStorage.clear()');

console.log(`\n${pass} passed, ${fail} failed`);
await Promise.race([send('Browser.close'), sleep(1000)]); ws.close(); ch.kill(); await sleep(300); rmSync(prof, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
