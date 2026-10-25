// versioncheck-test.mjs: Doctor's Claude Code version check. The pure lines
// are checked with injected I/O (no real claude); the wiring is checked by
// running the nightshift's own --preflight on a scratch hub with a stub claude
// and wake-cost rows, because a check nobody calls is a green about nothing.
// Each check goes red when the behaviour it names is reverted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveClaude, parseVersion, seenVersions, claudeVersionLines, realIo, lookupCommand } from './versioncheck.mjs';

const MACHINERY = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

const scratch0 = tmpdir();
const rows = (...vs) => vs.map((v) => JSON.stringify(v === null ? { lane: 'x' } : { lane: 'x', version: v })).join('\n') + '\n';
const io = (over = {}) => ({
  claudeBin: '/cfg/claude', isExecutable: (p) => p === '/cfg/claude', lookupPath: () => '/usr/bin/claude',
  runVersion: () => '2.1.310 (Claude Code)\n', wakeCostsText: rows('2.1.309'), ...over,
});

// ── resolving the binary the way wake.sh does ──
check('paths.claudeBin wins when it is there and executable', () => {
  assert.deepEqual(resolveClaude(io()), { path: '/cfg/claude', via: 'paths.claudeBin' });
});
check('a configured claude that is not executable falls through to PATH', () => {
  assert.deepEqual(resolveClaude(io({ isExecutable: () => false })), { path: '/usr/bin/claude', via: 'PATH' });
});
check('an unset paths.claudeBin falls through to PATH', () => {
  assert.deepEqual(resolveClaude(io({ claudeBin: undefined })), { path: '/usr/bin/claude', via: 'PATH' });
});
check('neither: no path, no via', () => {
  assert.deepEqual(resolveClaude(io({ isExecutable: () => false, lookupPath: () => null })), { path: null, via: null });
});

// ── reading versions ──
check('parseVersion reads claude --version and nothing else', () => {
  assert.equal(parseVersion('2.1.310 (Claude Code)\n'), '2.1.310');
  assert.equal(parseVersion('  12.0.1'), '12.0.1');
  for (const bad of ['latest', '', null, undefined, 'v2.1.310', 'Claude Code 2.1.310', '2.1']) assert.equal(parseVersion(bad), null, String(bad));
});
check('seenVersions: distinct, in file order, skipping torn lines and rows without a version', () => {
  const text = rows('2.1.309', '2.1.310', null, '2.1.309') + '{"version":"2.1.3' + '\n' + JSON.stringify({ version: 7 }) + '\n' + JSON.stringify({ version: '' }) + '\n';
  assert.deepEqual(seenVersions(text), ['2.1.309', '2.1.310']);
  assert.deepEqual(seenVersions(''), []);
  assert.deepEqual(seenVersions(undefined), []);
});

// ── the lines ──
const one = (over) => { const l = claudeVersionLines(io(over)); assert.equal(l.length, 1); return l[0]; };
check('a version that has woken on a folded tail is ok, and the path and its source are named', () => {
  const l = one({ runVersion: () => '2.1.309 (Claude Code)' });
  assert.match(l, /^ok {6}/); assert.match(l, /2\.1\.309/); assert.match(l, /\/cfg\/claude \(via paths\.claudeBin\)/);
});
check('a version no wake has run is amber, names what has, and says it is not a fault', () => {
  const l = one({ wakeCostsText: rows('2.1.308', '2.1.309') });
  assert.match(l, /^WARN {4}/); assert.match(l, /2\.1\.310/); assert.match(l, /woken: 2\.1\.308, 2\.1\.309/); assert.match(l, /not a fault/);
});
check('newness is membership: a version seen earlier but not last is ok (a rollback)', () => {
  const l = one({ runVersion: () => '2.1.309 (Claude Code)', wakeCostsText: rows('2.1.309', '2.1.310') });
  assert.match(l, /^ok {6}/);
});
check('no wake row carries a version yet: neutral, not amber', () => {
  for (const text of ['', rows(null, null)]) {
    const l = one({ wakeCostsText: text });
    assert.match(l, /^note {4}/); assert.match(l, /no baseline/); assert.doesNotMatch(l, /WARN/);
  }
});
check('the path found on PATH is named as such', () => {
  const l = one({ isExecutable: () => false });
  assert.match(l, /\/usr\/bin\/claude \(via PATH\)/);
  const withLabel = one({ isExecutable: () => false, lookupLabel: 'looked up by `zsh -ilc`, the shell the wake window runs' });
  assert.match(withLabel, /\(via PATH; looked up by `zsh -ilc`/, 'who looked is said, so the line never implies more than it has');
});
check('no claude anywhere is amber and names where it looked', () => {
  const l = one({ isExecutable: () => false, lookupPath: () => null });
  assert.match(l, /^WARN {4}/); assert.match(l, /\/cfg\/claude/); assert.match(l, /PATH/);
});
check('a --version that fails or prints something else is amber and shows what it printed', () => {
  const a = one({ runVersion: () => null }); assert.match(a, /^WARN {4}/); assert.match(a, /could not read a version/);
  const b = one({ runVersion: () => 'Claude, the assistant' }); assert.match(b, /^WARN {4}/); assert.match(b, /Claude, the assistant/);
});
check('never red: no case produces MISSING or BAD', () => {
  const cases = [{}, { wakeCostsText: '' }, { wakeCostsText: rows('1.0.0') }, { runVersion: () => null }, { isExecutable: () => false, lookupPath: () => null }, { runVersion: () => 'x' }];
  for (const c of cases) assert.doesNotMatch(one(c), /^(MISSING|BAD)/);
});

// ── which shell looks (Opus's measurement, 10/25: sh -lc and zsh -lc find the old
//    Homebrew cask, only an interactive login shell finds the live claude) ──
check('darwin looks as Terminal\'s window does: the user\'s shell, interactive login (-ilc)', () => {
  const c = lookupCommand({ kind: 'darwin', shell: '/bin/zsh' });
  assert.equal(c.bin, '/bin/zsh'); assert.deepEqual(c.args, ['-ilc', 'command -v claude']); assert.match(c.label, /-ilc/);
  assert.equal(lookupCommand({ kind: 'darwin', shell: '/opt/homebrew/bin/fish' }).bin, '/opt/homebrew/bin/fish');
});
check('darwin without a usable $SHELL falls back to zsh, still -ilc', () => {
  for (const shell of [undefined, '', 'zsh']) { const c = lookupCommand({ kind: 'darwin', shell }); assert.equal(c.bin, '/bin/zsh', String(shell)); assert.equal(c.args[0], '-ilc'); }
});
check('linux and wsl look as the window does: sh -lc with the node and configured-claude directories first', () => {
  for (const kind of ['linux', 'wsl']) {
    const c = lookupCommand({ kind, nodePath: '/home/u/.nvm/bin/node', claudeBin: '/home/u/.local/bin/claude' });
    assert.equal(c.bin, '/bin/sh'); assert.equal(c.args[0], '-lc');
    assert.match(c.args[1], /^PATH="\/home\/u\/\.nvm\/bin:\/home\/u\/\.local\/bin:\$PATH"; command -v claude$/); assert.match(c.label, /sh -lc/);
  }
});
check('an unknown platform says it is only Doctor\'s shell, and never claims the window\'s', () => {
  const c = lookupCommand({ kind: 'plan9' }); assert.match(c.label, /Doctor's shell/); assert.doesNotMatch(c.label, /as the wake window runs/);
});
check('realIo actually spawns the interactive login form on darwin (not what a stubbed lookupPath would hide)', () => {
  const calls = [];
  const r = realIo({ claudeBin: '/x', wakeCostsPath: join(scratch0, 'none'), kind: 'darwin', shell: '/bin/zsh', spawn: (bin, args) => { calls.push([bin, args]); return { status: 0, stdout: 'rc noise\n/etc/zshrc: loaded\n/opt/found/claude\n' }; } });
  assert.equal(r.lookupPath(), '/opt/found/claude', 'rc noise is skipped; the last path line wins');
  assert.deepEqual(calls, [['/bin/zsh', ['-ilc', 'command -v claude']]]);
  assert.match(r.lookupLabel, /-ilc/);
});
check('realIo: a failed lookup, or output with no path in it, is null', () => {
  const mk = (out) => realIo({ claudeBin: '/x', wakeCostsPath: join(scratch0, 'none'), kind: 'darwin', shell: '/bin/zsh', spawn: () => out });
  assert.equal(mk({ status: 1, stdout: '/a/claude\n' }).lookupPath(), null);
  assert.equal(mk({ status: 0, stdout: 'claude not found\n' }).lookupPath(), null);
  assert.equal(mk({ status: 0, stdout: '' }).lookupPath(), null);
});
{
  // The real thing, hermetic: a throwaway ZDOTDIR whose .zshrc puts a stub claude first on PATH.
  // An interactive login zsh reads .zshrc; `zsh -lc` does not. The control proves this can tell them apart.
  const haveZsh = existsSync('/bin/zsh');
  if (!haveZsh) console.log('  - skipped: the real-shell check needs /bin/zsh');
  else {
    const zd = mkdtempSync(join(tmpdir(), 'nw-zdot-')); const bind = join(zd, 'bin'); mkdirSync(bind);
    const fake = join(bind, 'claude'); writeFileSync(fake, '#!/bin/sh\necho "0.0.1 (Claude Code)"\n'); chmodSync(fake, 0o755);
    writeFileSync(join(zd, '.zshrc'), `export PATH="${bind}:$PATH"\n`);
    const saved = process.env.ZDOTDIR; process.env.ZDOTDIR = zd;
    try {
      check('the real interactive login zsh reads .zshrc and finds the claude put there', () => {
        const r = realIo({ claudeBin: '/x', wakeCostsPath: join(scratch0, 'none'), kind: 'darwin', shell: '/bin/zsh' });
        assert.equal(r.lookupPath(), fake);
      });
      check('control: a non-interactive login zsh (-lc) does NOT find it, so the check can tell the shells apart', () => {
        const c = spawnSync('/bin/zsh', ['-lc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 });
        assert.notEqual(String(c.stdout).trim().split('\n').pop(), fake);
      });
    } finally { if (saved === undefined) delete process.env.ZDOTDIR; else process.env.ZDOTDIR = saved; rmSync(zd, { recursive: true, force: true }); }
  }
}

// ── real I/O ──
const scratch = mkdtempSync(join(tmpdir(), 'nw-versioncheck-'));
const stub = (name, body) => { const f = join(scratch, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
check('realIo runs the binary it is given and reads its stdout', () => {
  const s = stub('claude-ok', 'echo "9.9.9 (Claude Code)"');
  assert.equal(parseVersion(realIo({ claudeBin: s, wakeCostsPath: join(scratch, 'none') }).runVersion(s)), '9.9.9');
});
check('realIo: a binary that exits nonzero reads as no output', () => {
  const s = stub('claude-bad', 'echo "9.9.9 (Claude Code)"; exit 3');
  assert.equal(realIo({ claudeBin: s, wakeCostsPath: join(scratch, 'none') }).runVersion(s), null);
});
check('realIo: isExecutable is false for a missing file and for a file without the bit', () => {
  const r = realIo({ claudeBin: '/x', wakeCostsPath: join(scratch, 'none') });
  const plain = join(scratch, 'plain'); writeFileSync(plain, 'x');
  assert.equal(r.isExecutable(join(scratch, 'absent')), false); assert.equal(r.isExecutable(plain), false);
});
check('realIo: a missing wake-costs file reads as empty', () => {
  assert.equal(realIo({ claudeBin: '/x', wakeCostsPath: join(scratch, 'none') }).wakeCostsText, '');
});

// ── the wiring: the nightshift's own --preflight ──
function preflightLines(wakeCostsText, claudeBinOk = true) {
  const hub = mkdtempSync(join(tmpdir(), 'nw-vc-hub-'));
  try {
    for (const d of ['wakecycle', 'ladder', 'projects', 'sessions']) mkdirSync(join(hub, d), { recursive: true });
    const s = stub('claude-hub', 'echo "2.1.310 (Claude Code)"');
    writeFileSync(join(hub, 'checkpoint.md'), '# checkpoint\n');
    writeFileSync(join(hub, 'wakecycle', 'nightshift.armed'), ''); // preflight reads it unguarded; empty = disarmed
    writeFileSync(join(hub, 'ladder', 'wake-costs.jsonl'), wakeCostsText);
    const cfg = { weftRoot: hub, defaultLane: 'main', lanes: { main: { targetTokens: 250000 } }, notify: { macos: false },
      paths: { workdir: hub, machinery: MACHINERY, transcripts: join(hub, 'projects'), sessions: join(hub, 'sessions'), claudeBin: claudeBinOk ? s : join(hub, 'no-such-claude') } };
    writeFileSync(join(hub, 'nightwatch.config.json'), JSON.stringify(cfg));
    const env = { ...process.env, WEFT_CONFIG: join(hub, 'nightwatch.config.json'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
    for (const k of ['NIGHTWATCH_CONFIG', 'WEFT_LANE', 'NIGHTWATCH_LANE']) delete env[k];
    const r = spawnSync(process.execPath, [join(MACHINERY, 'nightshift.mjs'), '--preflight'], { env, encoding: 'utf8', timeout: 60000 });
    return { code: r.status, lines: r.stdout.split('\n'), err: r.stderr, stub: s };
  } finally { rmSync(hub, { recursive: true, force: true }); }
}
check('preflight carries the check: an unseen version is amber and the stub path is named', () => {
  const r = preflightLines(rows('2.1.309'));
  assert.equal(r.code, 0, r.err);
  const l = r.lines.find((x) => /^\w+\s+claude /.test(x)); assert.ok(l, r.lines.join('\n'));
  assert.match(l, /^WARN/); assert.match(l, /claude-hub \(via paths\.claudeBin\)/); assert.match(l, /woken: 2\.1\.309/);
  assert.ok(r.lines.some((x) => /preflight complete/.test(x)), 'the rest of the preflight still runs');
});
check('preflight: a version that has woken is ok; no baseline is a note', () => {
  assert.match(preflightLines(rows('2.1.310')).lines.find((x) => /claude 2\.1\.310/.test(x)), /^ok/);
  assert.match(preflightLines('').lines.find((x) => /claude 2\.1\.310/.test(x)), /^note/);
});
check('preflight: a configured claude that is missing falls through to PATH, and says so', () => {
  const r = preflightLines(rows('2.1.310'), false);
  assert.equal(r.code, 0, r.err);
  const l = r.lines.find((x) => /claude /.test(x) && /^(ok|WARN|note)/.test(x));
  assert.ok(l && /via PATH|no paths\.claudeBin/.test(l), r.lines.join('\n'));
});

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
