// Nightwatch host-bridge test: drives the FIXTURE with a stand-in NW_HOST over CDP and reads back what
// runtime.js wrote. Needs the viewer on 7352. Run:
//   node --experimental-websocket skins/test/drive.mjs [baseUrl]
// Drive the served Nightwatch page through CDP: click each control, read back
// what the runtime wrote. Usage: node drive.mjs [baseUrl]
import { launchChrome, sweepOrphans } from './chrome.mjs';
import { rmSync } from 'node:fs';
const BASE = process.argv[2] ?? 'http://127.0.0.1:7352/';
const PORT = 9337;
// A Chrome already on this port would quietly host the test instead of ours
// (10/16: a two-day-old leftover did). Refuse to start beside one.
sweepOrphans(); // a Chrome left by a killed run would otherwise hold the port
try { await fetch(`http://127.0.0.1:${PORT}/json/version`); console.error(`port ${PORT} already has a Chrome on it: stop it first`); process.exit(2); } catch { /* free, as it should be */ }
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
await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__calls=[];window.__fail=false;window.NW_SHELL='tauri';window.NW_HOST={can:a=>['wake','hide-window','sleep','remove-lane','retry-wake','open-terminal','wake-all','sleep-all','restore-checkpoint','restart-daemon','save-lane','save-settings','toggle-nightly','toggle-midday','emergency-fold','fold-all','run-doctor'].includes(a),act:(a,o)=>{__calls.push([a,o.lane]);(window.__data??=[]).push(o.data??null);return __fail?Promise.reject('scout is already awake'):Promise.resolve(a==='run-doctor'?'ok config | WOULD nothing':(a==='sleep'?'Rang ':'Waking ')+o.lane)}};window.__errs=[];addEventListener('error',e=>__errs.push(e.message+' @'+e.lineno));addEventListener('unhandledrejection',e=>__errs.push('rej '+e.reason))` });
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1500); };

let pass = 0, fail = 0;
const check = async (name, expr, want) => {
  const got = await ev(expr); const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const click = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'missing'; e.click(); return 'clicked'})()`);
const W = '.nw-app > .nw-lanes .nw-lane[data-lane="scout"] [data-action="wake"]';
await go(new URL('../fixture.html?skin=minimal', import.meta.url).href);
await check('no boot errors', 'window.__errs', []);
await check('sleeping lane: wake enabled', `document.querySelector('${W}').getAttribute('aria-disabled')`, null);
await check('awake lane: wake stays disabled', `document.querySelector('.nw-app > .nw-lanes .nw-lane[data-lane="opus"] [data-action="wake"]').getAttribute('aria-disabled')`, 'true');
await click(W);
await check('wake asks first', `document.querySelector('.nw-app > .nw-confirm [data-part="title"]').textContent.trim()`, 'Wake scout now?');
await check('nothing acted before yes', 'window.__calls', []);
await click('.nw-app > .nw-confirm [data-part="no"]');
await check('cancel closes, no act', `[!!document.querySelector('.nw-app > .nw-confirm'), window.__calls.length]`, [false, 0]);
await click(W); await click('.nw-app > .nw-confirm [data-part="yes"]'); await sleep(200);
await check('yes acts with the agent', 'window.__calls', [['wake', 'scout']]);
await check('result shown', `document.querySelector('.nw-app > .nw-toast').textContent`, 'Waking scout');
await ev('window.__fail=true'); await click(W); await click('.nw-app > .nw-confirm [data-part="yes"]'); await sleep(200);
await check('refusal shown as failure', `[document.querySelector('.nw-app > .nw-toast').dataset.status, document.querySelector('.nw-app > .nw-toast').textContent]`, ['failed', 'scout is already awake']);
await click(W); await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
await check('escape cancels', `[!!document.querySelector('.nw-app > .nw-confirm'), window.__calls.length]`, [false, 2]);
const SL = '.nw-app > .nw-lanes .nw-lane[data-lane="opus"] [data-action="sleep"]';
await ev('window.__fail=false; window.__calls=[]');
await check('awake lane: sleep enabled', `document.querySelector('${SL}').getAttribute('aria-disabled')`, null);
await check('sleeping lane: sleep stays disabled', `document.querySelector('.nw-app > .nw-lanes .nw-lane[data-lane="scout"] [data-action="sleep"]').getAttribute('aria-disabled')`, 'true');
await click('.nw-app > .nw-lanes .nw-persona:first-child > .nw-add [data-action="create-lane"]'); // still unwired (needs the lane-creation flow)
await check('unwired action never acts or asks', `[window.__calls.length, !!document.querySelector('.nw-app > .nw-confirm')]`, [0, false]);
await click(SL);
await check('sleep asks first', `document.querySelector('.nw-app > .nw-confirm [data-part="title"]').textContent.trim()`, "Put opus to sleep?");
await click('.nw-app > .nw-confirm [data-part="yes"]'); await sleep(200);
await check('sleep acts with the agent', 'window.__calls', [['sleep', 'opus']]);
// The midday cycle's switch (Ra, 10/12): off in the fixture; a click asks,
// then acts with on: true for that lane.
const MD = '.nw-app > .nw-lanes .nw-lane[data-lane="opus"] [data-action="toggle-midday"]';
await ev('window.__calls=[]; window.__data=[]');
await check('midday switch reads off', `document.querySelector('${MD}').getAttribute('aria-pressed')`, 'false');
await click(MD);
await check('midday switch asks first', `document.querySelector('.nw-app > .nw-confirm [data-part="title"]').textContent.trim()`, "Turn on opus's midday cycle?");
await check('nothing acted before yes (midday)', 'window.__calls', []);
await click('.nw-app > .nw-confirm [data-part="yes"]'); await sleep(200);
await check('midday switch acts with the agent and on: true', '[window.__calls, window.__data.at(-1)]', [[['toggle-midday', 'opus']], { on: true }]);
const L = '.nw-app > .nw-lanes .nw-lane[data-lane="scout"]';
await ev('window.__calls=[]');
await click(`${L} [data-action="lane-settings"]`);
await check('remove starts disabled', `document.querySelector('${L} [data-action="remove-lane"]').getAttribute('aria-disabled')`, 'true');
await click(`${L} [data-action="remove-lane"]`);
await check('disabled remove never acts', 'window.__calls.length', 0);
await click(`${L} [data-gate="remove-lane"]`);
await check('ticking the box enables remove', `document.querySelector('${L} [data-action="remove-lane"]').getAttribute('aria-disabled')`, 'false');
await click(`${L} [data-action="lane-settings"]`); // close the panel
await check('closing settings re-arms the gate', `[document.querySelector('${L} [data-gate="remove-lane"]').checked, document.querySelector('${L} [data-action="remove-lane"]').getAttribute('aria-disabled')]`, [false, 'true']);
const F = '.nw-app > .nw-lanes .nw-lane[data-lane="fable"] [data-part="settings"]', SC = '.nw-app > .nw-lanes .nw-lane[data-lane="scout"] [data-part="settings"]';
await check("fable sits in Weft's persona row", `document.querySelector('.nw-app > .nw-lanes .nw-lane[data-lane="fable"]').closest('.nw-persona').querySelector('[data-part="persona-name"] [data-part="label"]').textContent`, 'Weft');
await check('cards no longer repeat the persona', `document.querySelectorAll('.nw-app > .nw-lanes .nw-lane [data-part="persona"]').length`, 0);
await check("scout sits in Lark's row", `document.querySelector('.nw-app > .nw-lanes .nw-lane[data-lane="scout"]').closest('.nw-persona').querySelector('[data-part="persona-name"] [data-part="label"]').textContent`, 'Lark');
await check('inheriting lane: global times, locked', `[...document.querySelectorAll('${F} [data-part="sleep"] input, ${F} [data-part="wake"] input')].map(i=>[i.value,i.disabled])`, [['02:00', true], ['08:00', true]]);
await check('own-timer lane: its times, editable', `[...document.querySelectorAll('${SC} [data-part="sleep"] input, ${SC} [data-part="wake"] input')].map(i=>[i.value,i.disabled])`, [['12:00', false], ['18:00', false]]);
await click(`${F} [data-schedule-toggle]`);
await check('untick unlocks the fields', `[...document.querySelectorAll('${F} [data-part="sleep"] input')].map(i=>i.disabled)`, [false]);
await ev(`document.querySelector('${F} [data-part="sleep"] input').value='03:30'`);
await click(`${F} [data-schedule-toggle]`);
await check('re-tick restores global and locks', `[...document.querySelectorAll('${F} [data-part="sleep"] input')].map(i=>[i.value,i.disabled])`, [['02:00', true]]);
// batch 2: each confirm-gated action asks, then acts once with the right lane
await ev('window.__fail=false');
const cases = [
  ['.nw-app > .nw-lanes .nw-lane[data-lane="scribe"] .nw-alert [data-action="retry-wake"]', 'retry-wake', 'scribe', 'Try waking scribe again?'],
  ['.nw-app > .nw-lanes .nw-lane[data-lane="scribe"] .nw-alert [data-action="restore-checkpoint"]', 'restore-checkpoint', 'scribe', 'Restore the checkpoint?'],
  ['.nw-app > .nw-controls [data-action="wake-all"]', 'wake-all', null, 'Wake every sleeping agent?'],
  ['.nw-app > .nw-controls [data-action="sleep-all"]', 'sleep-all', null, "Ring every awake agent's bell?"],
];
for (const [sel, action, lane, title] of cases) {
  await ev('window.__calls=[]');
  await click(sel);
  await check(`${action} asks first`, `document.querySelector('.nw-app > .nw-confirm [data-part="title"]')?.textContent.trim()`, title);
  await click('.nw-app > .nw-confirm [data-part="yes"]'); await sleep(150);
  await check(`${action} acts once`, 'window.__calls', [[action, lane]]);
}
await ev('window.__calls=[]');
await click('.nw-app > .nw-lanes .nw-lane[data-lane="fable"] [data-action="open-terminal"]'); await sleep(150);
await check('open-terminal acts without asking', `[window.__calls, !!document.querySelector('.nw-app > .nw-confirm')]`, [[['open-terminal', 'fable']], false]);
// batch 3: saves send exactly their panel's fields
const FS = '.nw-app > .nw-lanes .nw-lane[data-lane="fable"] [data-part="settings"]';
await ev('window.__calls=[]; window.__data=[]');
await click('.nw-app > .nw-lanes .nw-lane[data-lane="fable"] [data-action="lane-settings"]');
await ev(`(()=>{const p=document.querySelector('${FS}');p.querySelector('input[type="number"]').value='300';const t=p.querySelector('[data-schedule-toggle]');t.click();p.querySelector('[data-part="sleep"] input').value='03:00';p.querySelector('[data-part="wake"] input').value='09:00'})()`);
await click(`${FS} [data-action="save-lane"]`); await sleep(150);
await check('save-lane sends the panel', 'window.__data.at(-1)', { targetK: 300, inherit: false, sleep: '03:00', wake: '09:00', armed: true });
// Settings are per persona (Ra, 10/7): each persona card's gear opens that persona's panel, which saves only its lanes.
const OPEN = `[...document.querySelectorAll('.nw-app > .nw-settings')].filter(p=>p.dataset.open==='true').map(p=>p.dataset.persona)`;
await check('one settings panel per persona', `[...document.querySelectorAll('.nw-app > .nw-settings')].map(p=>p.dataset.persona)`, ['weft', 'lark']);
await click('.nw-app > .nw-lanes .nw-persona[data-persona="weft"] [data-action="persona-settings"]');
await check("Weft's gear opens Weft's panel, and only it", OPEN, ['weft']);
await click('.nw-app > .nw-settings[data-persona="weft"] [data-action="save-settings"]'); await sleep(150);
await check("Weft's panel saves its schedule and only Weft's agents", `(()=>{const d=window.__data.at(-1);return [d.sleep,d.wake,d.lanes.map(l=>[l.id,l.targetK,l.armed])]})()`,
  ['02:00', '08:00', [['fable', 250, true], ['opus', 250, true], ['scribe', 200, true]]]);
await click('.nw-app > .nw-lanes .nw-persona[data-persona="lark"] [data-action="persona-settings"]');
await check("Lark's gear swaps to Lark's panel", OPEN, ['lark']);
await click('.nw-app > .nw-settings[data-persona="lark"] [data-action="save-settings"]'); await sleep(150);
await check("Lark's panel saves only Lark's agent", `window.__data.at(-1).lanes.map(l=>[l.id,l.targetK,l.armed])`, [['scout', 120, false]]);
await ev(`document.querySelector('.nw-app > .nw-settings[data-persona="lark"] [data-action="close-settings"]').click()`);
await check('close shuts it', OPEN, []);
// (the doctor checks below use the first panel, Weft's)
await click('.nw-app > .nw-lanes .nw-persona[data-persona="weft"] [data-action="persona-settings"]');
await ev(`document.querySelector('.nw-app > .nw-settings[data-persona="weft"] [data-action="close-settings"]').click()`);
await check('nightly reads ON from armed agents', `document.querySelector('.nw-controls [data-action="toggle-nightly"]').getAttribute('aria-pressed')`, 'true');
await click('.nw-controls [data-action="toggle-nightly"]');
await check('turning nightly off asks first', `document.querySelector('.nw-app > .nw-confirm [data-part="title"]')?.textContent.trim()`, 'Turn the nightly cycle off?');
await click('.nw-app > .nw-confirm [data-part="yes"]'); await sleep(150);
await check('then sends on:false', 'window.__data.at(-1)', { on: false });
// fold now / fold all / check again (10/6)
await ev('window.__calls=[]');
await click('.nw-app > .nw-lanes .nw-lane[data-lane="opus"] [data-action="emergency-fold"]');
await check('fold now asks, in danger red', `[document.querySelector('.nw-app > .nw-confirm [data-part="title"]')?.textContent.trim(), document.querySelector('.nw-app > .nw-confirm [data-part="yes"]')?.dataset.danger]`, ['Force-fold opus?', 'true']);
await click('.nw-app > .nw-confirm [data-part="yes"]'); await sleep(150);
await check('then acts on that agent', 'window.__calls', [['emergency-fold', 'opus']]);
await ev('window.__calls=[]');
await click('.nw-app > .nw-controls [data-action="fold-all"]');
await check('fold all asks first', `document.querySelector('.nw-app > .nw-confirm [data-part="title"]')?.textContent.trim()`, 'Force-fold every awake agent?');
await click('.nw-app > .nw-confirm [data-part="yes"]'); await sleep(150);
await ev(`document.querySelector('.nw-head [data-part="view-menu"][data-menu="app"] [data-action="app-settings"]').click()`);
await click('.nw-app > .nw-settings [data-action="run-doctor"]'); await sleep(150);
await check('check again writes the dry run into the panel', `document.querySelector('.nw-settings [data-part="preflight"]')?.textContent`, 'ok config | WOULD nothing');
await check('fold line on the card', `document.querySelector('.nw-app > .nw-lanes .nw-lane[data-lane="opus"] [data-part="fold-request"]')?.textContent.trim()`, 'Bell rung · forcing in 7m');
// ---- the Doctor's leftover sweep (10/16): findings as data, one confirmed removal at a time.
// A host that can sweep. Its findings shrink when an item is removed, as the real CLI's do.
await ev(`(()=>{const base=window.NW_HOST; window.__sweepCalls=[]; window.__sweepReply=null;
  window.__findings=[
    {id:'house.nightwatch.gone',kind:'job',label:'house.nightwatch.gone',hub:'/Users/x/<b>gone</b>',missing:['hub'],removable:true,volumes:false},
    {id:'house.nightwatch.junk',kind:'job',label:'house.nightwatch.junk',hub:null,missing:['unparseable'],removable:false,volumes:false},
    {id:'registry:/Volumes/Ext/hub',kind:'registry',label:null,hub:'/Volumes/Ext/hub',missing:['hub'],removable:true,volumes:true}];
  window.NW_HOST={can:(a)=>a==='sweep'||a==='remove-orphan'||base.can(a), act:(a,o)=>{
    if(a==='sweep') return Promise.resolve(window.__sweepReply ?? JSON.stringify({version:1,sweptAt:'x',findings:window.__findings}));
    if(a==='remove-orphan'){window.__sweepCalls.push(o.data); window.__findings=window.__findings.filter(f=>f.id!==o.data.id); return Promise.resolve('removed '+o.data.id);}
    return base.act(a,o);}};})()`);
const ORPHANS = `[...document.querySelectorAll('.nw-settings [data-part="doctor"] li[data-part="orphan"]')].map(li=>[li.textContent.trim(), !!li.querySelector('[data-action="remove-orphan"]')])`;
await click('.nw-app > .nw-settings [data-action="run-doctor"]'); await sleep(250);
await check('check again lists each leftover; an unreadable one has no Remove', ORPHANS, [
  ['Background job house.nightwatch.gone: its hub folder is gone (/Users/x/<b>gone</b>)Remove', true],
  ["Background job house.nightwatch.junk: Nightwatch can't read it; check it by hand", false],
  ['Hub entry /Volumes/Ext/hub: its hub folder is gone, on a drive that may just be unplugged' + 'Remove', true]]);
await check('a path from disk renders as text, never markup', `document.querySelectorAll('.nw-settings [data-part="doctor"] li[data-part="orphan"] b').length`, 0);
await click('.nw-settings [data-part="orphan"] [data-orphan-id="registry:/Volumes/Ext/hub"]');
await check('a leftover on a drive asks in danger red, saying it may just be unplugged', `[document.querySelector('.nw-app > .nw-confirm [data-part="title"]')?.textContent.trim(), document.querySelector('.nw-app > .nw-confirm [data-part="yes"]')?.dataset.danger]`, ['Remove a leftover on an external drive?', 'true']);
await click('.nw-app > .nw-confirm [data-part="no"]'); await sleep(150);
await check('declining removes nothing', 'window.__sweepCalls', []);
await click('.nw-settings [data-part="orphan"] [data-orphan-id="house.nightwatch.gone"]');
await check('an ordinary leftover asks plainly', `[document.querySelector('.nw-app > .nw-confirm [data-part="title"]')?.textContent.trim(), document.querySelector('.nw-app > .nw-confirm [data-part="yes"]')?.dataset.danger ?? null]`, ['Remove this leftover?', null]);
await click('.nw-app > .nw-confirm [data-part="yes"]'); await sleep(250);
await check('removing names exactly that one item', 'window.__sweepCalls', [{ id: 'house.nightwatch.gone' }]);
await check('and the list is read again after', `${ORPHANS}.length`, 2);
await ev(`window.__sweepReply=JSON.stringify({version:2,findings:[]})`);
await click('.nw-app > .nw-settings [data-action="run-doctor"]'); await sleep(250);
await check('a format this window does not know is said, not guessed at', ORPHANS, [["The leftover check answered in a format this window doesn't know; update the app.", false]]);
await ev(`window.__sweepReply=null; window.__findings=[]`);
await click('.nw-app > .nw-settings [data-action="run-doctor"]'); await sleep(250);
await check('nothing left says so, once', ORPHANS, [['No leftovers from removed hubs', false]]);

// ---- persona rows (Ra, 10/7), on the two-persona fixture
const FX = (q) => new URL(`../fixture.html?${q}`, import.meta.url).href;
await go(FX('skin=minimal&layout=row')); await sleep(500);
await check('one group per persona, in order', `[...document.querySelectorAll('.nw-app > .nw-lanes > .nw-persona')].map(g=>[g.dataset.persona, [...g.querySelectorAll(':scope > .nw-lane[data-lane]')].map(l=>l.dataset.lane)])`, [['weft', ['fable', 'opus', 'scribe']], ['lark', ['scout']]]);
await check('each persona has its own Add agent', `[...document.querySelectorAll('.nw-app > .nw-lanes .nw-persona > .nw-add')].map(a=>a.dataset.persona)`, ['weft', 'lark']);
const LBL = `(g=>{const l=g.querySelector('[data-part="persona-name"]').getBoundingClientRect(), a=document.querySelector('.nw-app').getBoundingClientRect(), c=g.querySelector('.nw-lane[data-lane]').getBoundingClientRect(); return {inside: l.left>=a.left-1, besideCard: l.right<=c.left+1}})(document.querySelector('.nw-persona[data-persona="lark"]'))`;
await check('Minimal: the name sits in a gutter inside the app, beside the first card', LBL, { inside: true, besideCard: true });
await go(FX('skin=glass&layout=row'));
for (let i = 0; i < 40 && (await ev(`document.querySelector('.nw-app').dataset.personaLabel`)) !== 'hang'; i++) await sleep(100); // the skin's sheet loads async
await sleep(200);
await check('Glass: the name hangs off the app\'s left edge', `(g=>g.querySelector('[data-part="persona-name"]').getBoundingClientRect().right <= document.querySelector('.nw-app').getBoundingClientRect().left + 1)(document.querySelector('.nw-persona[data-persona="weft"]'))`, true);
await go(FX('skin=minimal&layout=column')); await sleep(500);
await check('Vertical: personas are side-by-side columns, each name on top', `(([w,l])=>{const W=w.getBoundingClientRect(), L=l.getBoundingClientRect(), n=w.querySelector('[data-part="persona-name"]').getBoundingClientRect(), c=w.querySelector('.nw-lane[data-lane]').getBoundingClientRect(); return L.left>=W.right-1 && Math.abs(L.top-W.top)<2 && n.bottom<=c.top+1})([...document.querySelectorAll('.nw-persona')])`, true);

// ---- persona badges (10/7): one letter each, in hues of their own
await go(FX('skin=minimal&layout=row')); await sleep(500);
await check('each persona has its initial badge and its agents\' combined state', `[...document.querySelectorAll('.nw-persona')].map(g=>[g.querySelector('[data-part="persona-avatar"]').textContent, g.dataset.state])`, [['W', 'failed'], ['L', 'sleeping']]);
const ALIGN = (axis) => `(g=>{const a=g.querySelector('[data-part="persona-avatar"]').getBoundingClientRect(), c=g.querySelector('.nw-lane [data-part="avatar"]').getBoundingClientRect();
  return [a.width===c.width && a.height===c.height, Math.abs(${axis === 'y' ? '(a.top+a.height/2)-(c.top+c.height/2)' : '(a.left+a.width/2)-(c.left+c.width/2)'}) < 0.6]})(document.querySelector('.nw-persona[data-persona="weft"]'))`;
for (const skin of ['minimal', 'glass', 'amber', 'metal']) {
  for (const [layout, axis] of [['row', 'y'], ['column', 'x']]) {
    await go(FX(`skin=${skin}&layout=${layout}`));
    for (let i = 0; i < 40 && !(await ev(`(l=>!!(l&&l.sheet&&l.getAttribute('href').startsWith('${skin}/')))(document.querySelector('#skin'))`)); i++) await sleep(100);
    await sleep(300);
    await check(`${skin} ${layout}: the persona badge is a card avatar's size, lined up with it`, ALIGN(axis), [true, true]);
    if (layout === 'row') await check(`${skin}: its own avatar rule wins (cards and persona both ${({ minimal: 24, glass: 24, amber: 4, metal: 26 })[skin]}px wide)`,
      `[...document.querySelectorAll('.nw-persona [data-part="persona-avatar"], .nw-lane [data-part="avatar"]')].filter(e=>e.getClientRects().length).every(e=>Math.round(e.getBoundingClientRect().width)===${({ minimal: 24, glass: 24, amber: 4, metal: 26 })[skin]})`, true);
  }
}

console.log(`\n${pass} passed, ${fail} failed`); await Promise.race([send('Browser.close'), sleep(1000)]); ws.close(); ch.kill(); await sleep(300); rmSync(prof, { recursive: true, force: true }); process.exit(fail ? 1 : 0);
