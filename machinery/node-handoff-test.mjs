#!/usr/bin/env node
// node-handoff-test: the scripts a woken session runs (its SessionStart hook, register-lane.sh, and its
// bell watcher, bell-watcher.sh) use the node wake.sh exported as NIGHTWATCH_NODE, the daemon's own,
// never a different `node` on their shell's PATH (10/25: Terminal's PATH found Homebrew's Node 20 while
// the daemons ran 22). A decoy `node` sits first on PATH and leaves a mark if it ever runs; NIGHTWATCH_NODE
// is a wrapper that logs each use, then runs the real node. Scratch hub only.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const check = (name, fn) => { try { fn(); pass++; console.log(`  ✓ ${name}`); } catch (e) { fail++; console.log(`  ✗ ${name}\n    ${e.message}`); } };

const hub = mkdtempSync(join(tmpdir(), 'nw-node-handoff-'));
try {
  mkdirSync(join(hub, 'wakecycle'), { recursive: true });
  const cfg = join(hub, 'nightwatch.config.json');
  writeFileSync(cfg, JSON.stringify({ weftRoot: hub, defaultLane: 'alpha', lanes: { alpha: {} }, paths: { wakecycle: 'wakecycle', spool: join(hub, 'spool'), due: join(hub, 'due') } }));
  const decoy = join(hub, 'decoy'); mkdirSync(decoy);
  writeFileSync(join(decoy, 'node'), `#!/bin/sh\ntouch "${join(hub, 'decoy-ran')}"\nexit 97\n`); chmodSync(join(decoy, 'node'), 0o755);
  const wrap = join(hub, 'node-wrapper');
  writeFileSync(wrap, `#!/bin/sh\necho "$*" >> "${join(hub, 'wrapper.log')}"\nexec "${process.execPath}" "$@"\n`); chmodSync(wrap, 0o755);
  const env = (extra) => {
    const e = { ...process.env, PATH: `${decoy}:/usr/bin:/bin`, NIGHTWATCH_CONFIG: cfg, NIGHTWATCH_NODE: wrap, ...extra };
    for (const k of ['WEFT_CONFIG', 'WEFT_LANE', 'NIGHTWATCH_LANE']) if (!(k in (extra ?? {}))) delete e[k];
    return e;
  };

  check('the SessionStart hook registers through the handed node, not the PATH one', () => {
    // Inside the check, so a script that fails (the decoy exits 97) reads as this check's FAIL, not a crash.
    execFileSync('sh', [join(HERE, 'register-lane.sh')], { env: env({ NIGHTWATCH_LANE: 'alpha' }), input: JSON.stringify({ session_id: 'sid-h' }), encoding: 'utf8' });
    assert.equal(JSON.parse(readFileSync(join(hub, 'wakecycle', 'lane.sid-h'), 'utf8')).lane, 'alpha');
    assert.equal(existsSync(join(hub, 'decoy-ran')), false, 'the PATH node ran');
    assert.match(readFileSync(join(hub, 'wrapper.log'), 'utf8'), /config\.mjs get paths\.wakecycle/);
  });

  mkdirSync(join(hub, 'spool', 'nhtest'), { recursive: true });
  writeFileSync(join(hub, 'spool', 'nhtest', '1-bell-nhtest.txt'), 'BELL for the handoff test\n');
  check('the bell watcher reads its config through the handed node and delivers the note', () => {
    const out = execFileSync('sh', [join(HERE, 'bell-watcher.sh'), 'nhtest'], { env: env(), encoding: 'utf8', timeout: 20000 });
    assert.match(out, /BELL for the handoff test/);
    assert.equal(existsSync(join(hub, 'decoy-ran')), false, 'the PATH node ran');
    assert.match(readFileSync(join(hub, 'wrapper.log'), 'utf8'), /config\.mjs get paths\.spool/);
  });
} finally {
  rmSync(hub, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
