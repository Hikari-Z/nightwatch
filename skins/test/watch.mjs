import { spawn } from 'node:child_process'; import { mkdtempSync } from 'node:fs';
const PORT=9338, prof=mkdtempSync(process.env.TMPDIR+'/nwcdp-');
const ch=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--disable-gpu',`--remote-debugging-port=${PORT}`,`--user-data-dir=${prof}`,'about:blank'],{stdio:'ignore'});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); let tab;
for(let i=0;i<50&&!tab;i++){try{tab=await(await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`,{method:'PUT'})).json()}catch{await sleep(200)}}
const ws=new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0;const P=new Map();ws.addEventListener('message',m=>{const d=JSON.parse(m.data);if(d.id&&P.has(d.id)){P.get(d.id)(d);P.delete(d.id)}});
const send=(method,params={})=>new Promise(r=>{const i=++id;P.set(i,r);ws.send(JSON.stringify({id:i,method,params}))});
const ev=async e=>(await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true})).result?.result?.value;
await send('Page.navigate',{url:'http://127.0.0.1:7352/?skin=minimal&desk=1'}); await sleep(1500);
await ev(`document.querySelector('.nw-app > .nw-lanes').dataset.mark='old'; window.__f=0; const of=window.fetch; window.fetch=(...a)=>{window.__f++; return of(...a)}; 1`);
console.log('desk:', await ev(`document.documentElement.dataset.desk`), '| url:', await ev('location.search'));
console.log('active:', await ev(`document.activeElement.tagName`), 'busy-menu', await ev(`!!document.querySelector('[data-part="view-menu"][data-open="true"]')`));
await sleep(34000);
console.log('fetches in 34s:', await ev('window.__f'), '| lanes swapped:', await ev(`document.querySelector('.nw-app > .nw-lanes').dataset.mark!=='old'`), '| stale:', await ev(`document.documentElement.dataset.stale`));
ws.close(); ch.kill(); process.exit(0);
