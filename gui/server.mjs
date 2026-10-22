#!/usr/bin/env node
// Nightwatch viewer, phase 1 (READ-ONLY): one assembler + one emitter.
//
//   node server.mjs            → http://127.0.0.1:7352/?skin=minimal
//   ?skin=<name>&range=8h|24h|3d|7d — the page's own runtime sends these
//
// The brains live elsewhere, shared with the Tauri app so neither can
// drift: gui/assemble.mjs (pure, io-injected) turns the house's files into
// a snapshot; gui/emitter.mjs (pure, browser-safe, byte-parity-tested
// against skins/build_fixture.py) turns the snapshot into the page. This
// file is only the node io, the skins list, and http. Writes nothing but
// gui/snapshot.json (a debugging/parity artifact). Actions in the page go
// through the app's NW_HOST seam, never through here.
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, openSync, readSync, closeSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hublessConfig, loadConfigFrom, loadConfigOrNone } from '../machinery/config.mjs';
import { stateKey, assemble } from './assemble.mjs';
import { readRegistry, configFileFor, mergeSnapshots, viewerRegistryFile } from './hubs.mjs';
import { homedir } from 'node:os';
import { renderPage, mergeSnapshot } from './emitter.mjs';
import { FIXTURE } from './fixture-data.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKINS = join(HERE, '..', 'skins');
// The viewer is the one reader that runs without a hub: with none named it
// pages the registry's hubs, and with no registry either it shows Set up
// (hublessConfig: no hub's paths, so nothing of any hub is read).
const CFG = loadConfigOrNone() ?? hublessConfig();
// Port resolution: env override → viewer.port from the hub config → 7352.
// The knowledge lives in config (opus's call, 10/7), not shell history.
let cfgPort;
try { cfgPort = CFG.viewer?.port; } catch { /* config unreadable: fall through */ }
const PORT = Number(process.env.NIGHTWATCH_PORT ?? cfgPort ?? 7352);

// Who this server is, for the app's /whoami check. The server outlives the
// app on purpose, so the one answering on the port can be running code from
// another tree, a removed one, or this tree before a pull. The app compares
// `started` against the newest code file on disk and replaces a stale server
// (WSL, 10/21: a viewer from a deleted worktree answered ENOENT). The rev is
// for the receipt only, read from .git's files: no git binary to spawn, so a
// Mac without developer tools never gets an install dialog from the viewer.
const ROOT = realpathSync(join(HERE, '..'));
const STARTED = Date.now();
function gitRev(root) {
  try {
    let git = join(root, '.git');
    if (statSync(git).isFile()) git = resolve(root, readFileSync(git, 'utf8').match(/^gitdir: (.+)$/m)[1].trim());
    const head = readFileSync(join(git, 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head;
    const ref = head.slice(5);
    const common = existsSync(join(git, 'commondir')) ? resolve(git, readFileSync(join(git, 'commondir'), 'utf8').trim()) : git;
    for (const d of [git, common]) { try { return readFileSync(join(d, ref), 'utf8').trim(); } catch { /* packed */ } }
    const line = readFileSync(join(common, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.split(' ')[0] : null;
  } catch { return null; }
}
const WHOAMI = JSON.stringify({ nightwatch: 'viewer', root: ROOT, rev: gitRev(ROOT), started: STARTED, pid: process.pid });

// ---------------------------------------------------------------- node io
// The io contract assemble.mjs documents; the Tauri shell implements the
// same seven calls over thin Rust commands.
const io = {
  readText(path) { try { return readFileSync(path, 'utf8'); } catch { return null; } },
  readDir(path) { try { return readdirSync(path); } catch { return []; } },
  stat(path) { try { const s = statSync(path); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; } },
  readTail(path, bytes) {
    try {
      const st = statSync(path);
      const len = Math.min(st.size, bytes);
      const fd = openSync(path, 'r');
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, st.size - len);
      closeSync(fd);
      return buf.toString('utf8');
    } catch { return null; }
  },
  livePids() {
    // A sock file names a pid, but the pid existing is not enough: sock
    // files outlive their sessions and macOS recycles pids, so a dead
    // sock's pid can alias an unrelated process. Only a pid whose command
    // is claude counts (the pid-recycling hole, wake.sh guard review).
    const out = [];
    try {
      for (const f of readdirSync(CFG.paths.sockDir)) {
        const m = f.match(/^(\d+)\.sock$/);
        if (!m) continue;
        try {
          process.kill(Number(m[1]), 0);
          const cmd = execFileSync('ps', ['-o', 'command=', '-p', m[1]], { encoding: 'utf8' });
          if (cmd.includes('claude')) out.push(Number(m[1]));
        } catch {}
      }
    } catch {}
    return out;
  },
  psCommand(pid) {
    try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }); } catch { return null; }
  },
  now: () => Date.now(),
};

const SKIN_ORDER = ['minimal', 'glass', 'amber', 'metal', 'wacky', 'steampunk', 'concrete'];
function skinsFromDisk() {
  const found = [];
  try {
    for (const d of readdirSync(SKINS).sort()) {
      try {
        const m = join(SKINS, d, 'manifest.json');
        statSync(join(SKINS, d, 'skin.css'));
        found.push([d, JSON.parse(readFileSync(m, 'utf8')).title ?? d]);
      } catch {}
    }
  } catch {}
  const rank = Object.fromEntries(SKIN_ORDER.map((n, i) => [n, i]));
  return found.sort((a, b) => (rank[a[0]] ?? SKIN_ORDER.length) - (rank[b[0]] ?? SKIN_ORDER.length) || (a[0] < b[0] ? -1 : 1));
}

// ---------------------------------------------------------------- hubs
// Every persona on the machine: the registry's hubs, each assembled on its own
// (assemble stays single-hub) and merged by gui/hubs.mjs. No registry yet, or
// an empty one: the one hub this process's config names, exactly as before.
// NIGHTWATCH_REGISTRY overrides the registry's path (scratch benches).
const REGISTRY = viewerRegistryFile();
// The poll key across every hub (see stateKey): any persona's change refreshes.
function keyAll() {
  const roots = readRegistry(io.readText(REGISTRY) ?? '');
  if (!roots.length) return stateKey(CFG, io);
  return roots.map((root) => {
    try { return stateKey(loadConfigFrom(configFileFor(root, existsSync)), io); } catch { return `${root}:?`; }
  }).join('#');
}

function snapshotAll(range) {
  const roots = readRegistry(io.readText(REGISTRY) ?? '');
  if (!roots.length) return assemble(CFG, io, range);
  const parts = [];
  for (const root of roots) {
    let cfg;
    try { cfg = loadConfigFrom(configFileFor(root, existsSync)); }
    catch (e) { console.error(`nightwatch: skipping hub ${root}: ${e.message}`); continue; }
    parts.push({ root, snap: assemble(cfg, io, range) });
  }
  return parts.length ? mergeSnapshots(parts) : assemble(CFG, io, range);
}

// ---------------------------------------------------------------- server
const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    if (url.pathname === '/whoami') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(WHOAMI);
      return;
    }
    if (url.pathname === '/key') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      res.end(keyAll());
      return;
    }
    if (url.pathname === '/') {
      const snap = snapshotAll(url.searchParams.get('range') ?? '8h');
      snap.version = '0.9'; // snapshot schema, pinned in CONTRACT.md
      // Installed skins, read live so a new skin appears without a restart
      // (the emitter is pure and never touches disk — the list rides the
      // snapshot, [[name, title]…] in SKIN_ORDER, same as the python reads).
      snap.SKINS = skinsFromDisk();
      writeFileSync(join(HERE, 'snapshot.json'), JSON.stringify(snap));
      const html = renderPage(mergeSnapshot(FIXTURE, snap));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    // static: skins assets (stylesheets, runtime, manifests)
    const safe = url.pathname.replace(/\.\./g, '');
    const p = join(SKINS, safe);
    if (existsSync(p) && statSync(p).isFile()) {
      const type = p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'text/javascript' : p.endsWith('.json') ? 'application/json' : p.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      res.end(readFileSync(p));
      return;
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(`viewer error: ${e.message}`);
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`nightwatch viewer: http://127.0.0.1:${PORT}/?skin=minimal`));
