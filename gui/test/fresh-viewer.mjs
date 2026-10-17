#!/usr/bin/env node
// fresh-viewer: the viewer on a machine with nothing set up (no config named,
// no registry, nothing at the old default folder) serves the Set up page, not
// an error and not any one house's persona (issue #7). Starts the real
// server.mjs on a scratch HOME and a spare port, and stops it.
//
//   node gui/test/fresh-viewer.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 7300 + Math.floor(Math.random() * 80);
const home = mkdtempSync(join(tmpdir(), 'nw-fresh-viewer-'));
const env = { HOME: home, PATH: process.env.PATH, NIGHTWATCH_PORT: String(PORT) };
const server = spawn(process.execPath, [join(HERE, '..', 'server.mjs')], { env, stdio: 'ignore' });
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — ${detail}`}`); if (!ok) failures++; };
try {
  let res;
  for (let i = 0; i < 40 && !res; i++) {
    try { res = await fetch(`http://127.0.0.1:${PORT}/?skin=minimal`); } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  const body = res ? await res.text() : '';
  check('the page answers 200', res?.status === 200, `status ${res?.status} ${body.slice(0, 120)}`);
  check('it offers Set up', /Set up/.test(body));
  check('it names no house\'s persona (no "Weft" on a fresh machine)', !/aria-label="Weft"/.test(body));
} finally {
  server.kill();
  rmSync(home, { recursive: true, force: true });
}
console.log(failures ? `FRESH VIEWER: ${failures} failed` : 'FRESH VIEWER CLEAN');
process.exit(failures ? 1 : 0);
