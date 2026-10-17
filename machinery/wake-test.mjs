// wake-test.mjs — wake.sh run for real against a scratch hub, with a stub
// claude that records its argv. Each check pins one Linux-port fix and goes
// red when that fix is reverted:
//   - the head file is made with a template GNU mktemp accepts (mktemp -t
//     without XXXs dies on Linux, and set -e took the whole wake with it);
//   - a first wake is exempt from the stale-receipt guard (FIRSTWAKE used to
//     be read after the guard that tests it);
//   - paths.claudeBin is the claude that runs, when it exists;
//   - an emergency wake's receipts name THIS hub's files, not ~/origin/weft.
// The PreCompact guard rides here too: its JSON must parse and name the
// sleep.mjs beside it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MACHINERY = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

/** A scratch hub with one lane and a stub claude. `receipt` is next-wake's JSON. */
function scratchHub(receipt, { belledAt } = {}) {
  const hub = mkdtempSync(join(tmpdir(), 'nw-wake-'));
  mkdirSync(join(hub, 'wakecycle'), { recursive: true });
  mkdirSync(join(hub, 'ladder'), { recursive: true });
  mkdirSync(join(hub, 'bin'), { recursive: true });
  const stub = join(hub, 'bin', 'claude-stub');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(hub, 'claude.argv')}"\ncp "$3" "${join(hub, 'head.copy')}" 2>/dev/null || true\nfor a in "$@"; do case "$a" in */nightwatch-wake-head.*) cp "$a" "${join(hub, 'head.copy')}";; esac; done\nexit 0\n`);
  chmodSync(stub, 0o755);
  writeFileSync(join(hub, 'checkpoint.md'), '# checkpoint\n');
  const cfg = {
    weftRoot: hub, defaultLane: 'main', lanes: { main: { targetTokens: 250000 } },
    paths: { workdir: hub, machinery: MACHINERY, claudeBin: stub },
  };
  writeFileSync(join(hub, 'nightwatch.config.json'), JSON.stringify(cfg));
  writeFileSync(join(hub, 'wakecycle', 'next-wake.main.json'), JSON.stringify({ lane: 'main', checkpoint: join(hub, 'checkpoint.md'), ...receipt }));
  if (belledAt) writeFileSync(join(hub, 'wakecycle', 'nightshift.state.json'), JSON.stringify({ main: { belledAt } }));
  return hub;
}
function runWake(hub) {
  return spawnSync('sh', [join(MACHINERY, 'wake.sh'), 'main'], {
    env: { ...process.env, WEFT_CONFIG: join(hub, 'nightwatch.config.json'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    encoding: 'utf8', timeout: 30000,
  });
}

check('a first wake reaches the configured claude (GNU mktemp, paths.claudeBin)', () => {
  const hub = scratchHub({ firstWake: true });
  try {
    const r = runWake(hub);
    assert.equal(r.status, 0, `wake.sh exited ${r.status}: ${r.stdout}${r.stderr}`);
    const argv = readFileSync(join(hub, 'claude.argv'), 'utf8');
    assert.match(argv, /--append-system-prompt-file/);
    assert.doesNotMatch(argv, /--resume/, 'a first wake must not resume');
    assert.match(readFileSync(join(hub, 'nightshift.log'), 'utf8'), /wake receipt: main lane reached exec/);
  } finally { rmSync(hub, { recursive: true, force: true }); }
});

check('a first wake is not refused as stale, even with a later bell on record', () => {
  const hub = scratchHub({ firstWake: true }, { belledAt: Date.now() + 3_600_000 });
  try {
    const r = runWake(hub);
    assert.doesNotMatch(r.stdout, /STALE RECEIPT/);
    assert.equal(r.status, 0, `wake.sh exited ${r.status}: ${r.stdout}${r.stderr}`);
  } finally { rmSync(hub, { recursive: true, force: true }); }
});

check('a resumed wake IS refused when the bell postdates its receipt (the guard still works)', () => {
  const hub = scratchHub({ sessionId: '00000000-0000-0000-0000-000000000000' }, { belledAt: Date.now() + 3_600_000 });
  try {
    const r = runWake(hub);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /STALE RECEIPT/);
  } finally { rmSync(hub, { recursive: true, force: true }); }
});

check("an emergency wake's receipts name this hub's files, not ~/origin/weft", () => {
  const hub = scratchHub({ sessionId: '00000000-0000-0000-0000-000000000001', emergency: true, sleptAt: 'x', from: 'y', unauthoredSpan: { note: 'note' } });
  try {
    const r = runWake(hub);
    assert.equal(r.status, 0, `wake.sh exited ${r.status}: ${r.stdout}${r.stderr}`);
    const head = readFileSync(join(hub, 'head.copy'), 'utf8');
    assert.match(head, /Emergency wake/);
    assert.doesNotMatch(head, /origin\/weft/);
    assert.ok(head.includes(join(hub, 'wakecycle', 'next-wake.main.json')), head.slice(-300));
  } finally { rmSync(hub, { recursive: true, force: true }); }
});

check('the PreCompact guard blocks with valid JSON naming the sleep.mjs beside it', () => {
  const out = execFileSync('sh', [join(MACHINERY, 'precompact-guard.sh')], { encoding: 'utf8' });
  const j = JSON.parse(out);
  assert.equal(j.decision, 'block');
  assert.ok(j.reason.includes(`node ${MACHINERY}/sleep.mjs`), j.reason);
  assert.doesNotMatch(j.reason, /origin\/weft/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
