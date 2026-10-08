// Nightwatch lane-creation test (10/6): drives Set up, Import and Add agent on the FIXTURE with a stand-in
// NW_HOST over CDP and checks the specs the runtime hands the machinery (anima_dev/nightwatch_lane_creation.md,
// "the contract"), its plain-words checks, and the preview it renders from the dry run. Run:
//   node --experimental-websocket skins/test/create.mjs
// Written by: claude-opus-5-5, 2026-10-06
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
await send('Page.addScriptToEvaluateOnNewDocument', { source: "window.__calls=[];window.__errs=[];window.NW_SHELL='tauri';\nwindow.NW_HOST={can:a=>['plan','apply','inspect-import','list-unclaimed'].includes(a),act:(a,o)=>{__calls.push([a,o.data??null]);\n if(a==='plan')return Promise.resolve(JSON.stringify({steps:[{verb:'Create',what:o.data.hub??('lane '+o.data.lane.id),detail:'the hub'},{verb:'Open',what:'a Terminal window',detail:'fresh session'}]}));\n if(a==='apply')return Promise.resolve('Created.');\n if(a==='inspect-import')return Promise.resolve(JSON.stringify(o.data.from==='/good'?{identity:true,about:'I am Lark.',name:'Lark',memory:3,rungs:0}:{identity:false}));\n if(a==='list-unclaimed')return Promise.resolve(JSON.stringify([{sessionId:'abcdef1234567890',cwd:'~/origin',model:'Opus 5.5'}]));\n return Promise.reject('unexpected '+a)}};\naddEventListener('error',e=>__errs.push(e.message+' @'+e.lineno));addEventListener('unhandledrejection',e=>__errs.push('rej '+e.reason))" });
const go = async (url) => { await send('Page.navigate', { url }); await sleep(1500); };
let pass = 0, fail = 0;
const check = async (name, expr, want) => {
  const got = await ev(expr); const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const click = (sel) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'missing'; e.click(); return 'clicked'})()`);
const set = (sel, v) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'missing'; if(e.type==='checkbox'){e.checked=${JSON.stringify(v)}}else{e.value=${JSON.stringify(v)}} e.dispatchEvent(new Event('change',{bubbles:true})); return 'set'})()`);
const D = '.nw-app > .nw-setup', F = (n) => `${D} [data-field="${n}"]`;
const step = `document.querySelector('${D}').dataset.step`, err = `document.querySelector('${D} [data-part="error"]').hidden ? null : document.querySelector('${D} [data-part="error"]').textContent`;
const lastCall = (a) => `(__calls.filter(c=>c[0]==='${a}').at(-1)||[])[1]`;
const tick = () => sleep(150);

// ---- Set up: who → nights → preview → create
await go(new URL('../fixture.html?skin=minimal&fresh=1', import.meta.url).href);
await check('no boot errors', 'window.__errs', []);
await click('.nw-app > .nw-controls [data-action="setup"]'); await tick();
await check('Set up opens on "who"', `[document.querySelector('${D}').dataset.open, ${step}]`, ['true', 'who']);
await click(`${D} [data-action="setup-next"]`); await tick();
await check('empty "about" is refused in plain words, nothing sent', `[${step}, ${err}, __calls.length]`, ['who', 'Write a paragraph about who they are. It seeds their identity file.', 0]);
await set(F('about'), 'A careful reader who likes trains.'); await set(F('person'), 'Terra');
await click(`${D} [data-action="setup-next"]`); await tick();
await check('a folder with no name is refused', err, 'Give their folder a name, for example ~/Nightwatch/terra-claude.');
await set(F('hub'), '~/Nightwatch/terra-claude');
await click(`${D} [data-action="setup-next"]`); await tick();
await check('then "their nights"', `[${step}, ${err}]`, ['nights', null]);
await click(`${D} [data-action="setup-next"]`); await tick();
await check('Next asks the dry run, then shows its steps', `[${step}, document.querySelectorAll('${D} [data-part="steps"] li').length, document.querySelector('${D} [data-part="steps"] li code').textContent]`,
  ['preview', 2, '~/Nightwatch/terra-claude']);
await check('the spec: unnamed persona, pinned model, global schedule, fresh main lane', lastCall('plan'),
  { op: 'init', hub: '~/Nightwatch/terra-claude', persona: { name: null, about: 'A careful reader who likes trains.', person: 'Terra' },
    schedule: { sleep: '02:00', wake: '08:00' },
    lane: { id: 'main', model: 'claude-fable-5-1', targetTokens: 250000, armed: true, schedule: null, firstSession: { kind: 'fresh' } }, import: null });
await check('only the preview step shows Create', `[...document.querySelectorAll('${D} [data-part="buttons"] button')].filter(b=>getComputedStyle(b).display!=='none').map(b=>b.dataset.action)`, ['setup-back', 'create-persona']);
await click(`${D} [data-action="setup-back"]`); await tick();
await check('Back from preview → nights', step, 'nights');
await click(`${D} [data-action="setup-next"]`); await tick();
await click(`${D} [data-action="create-persona"]`); await tick();
await check('Create sends the same spec to apply, closes, says so', `[JSON.stringify(${lastCall('apply')})===JSON.stringify(${lastCall('plan')}), document.querySelector('${D}').dataset.open, document.querySelector('.nw-app > .nw-toast')?.textContent]`, [true, 'false', 'Created.']);

// ---- Import: a folder checked first; anything missing stays missing
await ev('window.__calls=[]');
await click('.nw-app > .nw-controls [data-action="setup"]'); await tick();
await click(`${D} [data-action="setup-import"]`); await tick();
await check('import step', step, 'import');
await set(F('from'), '/bad'); await click(`${D} [data-action="check-import"]`); await tick();
await check('no identity.md: said plainly', `document.querySelector('${D} [data-part="found"] li[data-status="failed"]')?.textContent.trim()`, 'No identity.md in this folder, so there is nothing to import yet.');
await click(`${D} [data-action="setup-next"]`); await tick();
await check('cannot continue unchecked', err, 'Check the folder first.');
await set(F('from'), '/good'); await click(`${D} [data-action="check-import"]`); await tick();
await check('found list, missing items honest', `[...document.querySelectorAll('${D} [data-part="found"] li')].map(l=>[l.dataset.status,l.textContent.trim()])`,
  [['ok', 'identity.md'], ['ok', 'name.txt: Lark'], ['ok', 'memory/: 3 files'], ['missing', 'No ladder rungs']]);
await click(`${D} [data-action="setup-next"]`); await tick();
await check('then "who", pre-filled', `[${step}, document.querySelector('${F('name')}').value, document.querySelector('${F('about')}').value]`, ['who', 'Lark', 'I am Lark.']);
await set(F('person'), 'Terra'); await set(F('hub'), '~/Nightwatch/lark');
await click(`${D} [data-action="setup-next"]`); await tick(); await click(`${D} [data-action="setup-next"]`); await tick();
await check('the spec carries the import and their own name', `(s=>[s.import, s.persona.name])(${lastCall('plan')})`, [{ from: '/good' }, 'Lark']);
await ev(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await tick();
await check('Escape closes Set up', `document.querySelector('${D}').dataset.open`, 'false');
await ev(`NW_HOST.can=()=>false`);
await click('.nw-app > .nw-controls [data-action="setup"]'); await tick();
await check('a host that can\'t plan never opens it', `document.querySelector('${D}').dataset.open`, 'false');
await ev(`NW_HOST.can=a=>['plan','apply','inspect-import','list-unclaimed'].includes(a)`);

// ---- Add agent: form → preview → create
const A = '.nw-app > .nw-lanes .nw-persona:first-child > .nw-add', AF = (n) => `${A} [data-field="${n}"]`;
const aerr = `(p=>p.hidden?null:p.textContent)(document.querySelector('${A} [data-part="error"]'))`;
await go(new URL('../fixture.html?skin=minimal', import.meta.url).href);
await ev('window.__calls=[]');
await click(`${A} [data-action="add-lane"]`); await tick();
await click(`${A} [data-action="plan-lane"]`); await tick();
await check('a bad lane name is refused', aerr, 'Lane names are lowercase letters, numbers and dashes, starting with a letter (for example "scout").');
await set(AF('id'), 'opus'); await click(`${A} [data-action="plan-lane"]`); await tick();
await check('a taken lane name is refused', aerr, 'There\'s already a lane called "opus".');
await set(AF('id'), 'lark'); await set(AF('model'), 'claude-sonnet-5-5');
await click(`${A} [data-action="plan-lane"]`); await tick();
await check('preview step, from the dry run', `[document.querySelector('${A}').dataset.step, document.querySelector('${A} [data-part="steps"] li code').textContent, ${aerr}]`, ['preview', 'lane lark', null]);
await check('lane spec: pinned model, global schedule, fresh', lastCall('plan'),
  { op: 'lane-add', lane: { id: 'lark', model: 'claude-sonnet-5-5', targetTokens: 250000, armed: true, schedule: null, firstSession: { kind: 'fresh' } } });
await click(`${A} [data-action="plan-back"]`); await tick();
await set(AF('inherit'), false); await tick();
await check('own schedule unlocks', `[document.querySelector('${AF('sleep')}').disabled, document.querySelector('${AF('wake')}').disabled]`, [false, false]);
await set(AF('sleep'), '03:00'); await set(AF('wake'), '09:30');
await set(AF('first'), 'adopt'); await sleep(300);
await check('adopt lists unclaimed sessions', `[document.querySelector('${A} [data-part="adopt"]').hidden, [...document.querySelector('${AF('session')}').options].map(o=>o.textContent)]`,
  [false, ['Choose a session…', 'abcdef12… · ~/origin · Opus 5.5']]);
await click(`${A} [data-action="plan-lane"]`); await tick();
await check('adopt needs a choice', aerr, 'Pick the running session to adopt, or start from a fresh session.');
await set(AF('session'), 'abcdef1234567890');
await click(`${A} [data-action="plan-lane"]`); await tick();
await check('spec: own times, adopted session', `(l=>[l.schedule, l.firstSession])(${lastCall('plan')}.lane)`, [{ sleep: '03:00', wake: '09:30' }, { kind: 'adopt', sessionId: 'abcdef1234567890' }]);
await click(`${A} [data-action="create-lane"]`); await tick();
await check('Add and wake applies, closes the slot', `[${lastCall('apply')}.lane.id, document.querySelector('${A}').dataset.open, document.querySelector('${A}').dataset.step]`, ['lark', 'false', 'form']);
await check('no errors along the way', 'window.__errs', []);

console.log(`\n${pass} passed, ${fail} failed`);
ws.close(); ch.kill(); process.exit(fail ? 1 : 0);
