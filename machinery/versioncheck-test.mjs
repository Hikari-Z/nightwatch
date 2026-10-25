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
import { resolveClaude, parseVersion, seenVersions, claudeVersionLines, realIo, lookupCommand, flagLines, WAKE_FLAGS } from './versioncheck.mjs';
import { platformKind } from './platform.mjs';

const MACHINERY = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

const scratch0 = tmpdir();
// A help text shaped like claude's: each flag DEFINED at the start of a line, and also named in prose elsewhere.
// `omit` removes the definition line but leaves the prose mention (the case a loose match would miss).
const HELP_LINES = {
  '--append-system-prompt': '  --append-system-prompt <prompt>       Append a system prompt to the default',
  '--resume': '  -r, --resume [value]                  Resume a conversation by session ID',
  '--fork-session': '  --fork-session                        When resuming, create a new session ID',
  '--model': '  --model <model>                       Model for the current session',
  '--system-prompt-snapshot': '  --system-prompt-snapshot <on|off>     Record the system prompt once per conversation',
};
const HELP = (omit = []) => ['Usage: claude [options]', 'Options:', ...Object.entries(HELP_LINES).filter(([f]) => !omit.includes(f)).map(([, l]) => l),
  '  --bare                                Minimal mode. Provide context via --append-system-prompt[-file], and see --resume, --model, --fork-session, --system-prompt-snapshot'].join('\n') + '\n';
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
check('darwin without a usable shell falls back to zsh, still -ilc', () => {
  // null, empty and a bare name are unusable. undefined is NOT passed here: it means "use $SHELL", and
  // the CI runner's $SHELL is /bin/bash, so asserting zsh for it passed on a Mac by coincidence (10/25).
  for (const shell of [null, '', 'zsh']) { const c = lookupCommand({ kind: 'darwin', shell }); assert.equal(c.bin, '/bin/zsh', String(shell)); assert.equal(c.args[0], '-ilc'); }
});
check('darwin with no shell argument looks as the environment\'s $SHELL does', () => {
  const saved = process.env.SHELL;
  try {
    process.env.SHELL = '/bin/bash'; assert.equal(lookupCommand({ kind: 'darwin' }).bin, '/bin/bash');
    process.env.SHELL = '/bin/zsh'; assert.equal(lookupCommand({ kind: 'darwin' }).bin, '/bin/zsh');
    delete process.env.SHELL; assert.equal(lookupCommand({ kind: 'darwin' }).bin, '/bin/zsh');
  } finally { if (saved === undefined) delete process.env.SHELL; else process.env.SHELL = saved; }
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

// ── the flags wake.sh passes, in claude --help ──
const flagOne = (over) => { const l = flagLines(io({ runHelp: () => HELP(), ...over })); assert.equal(l.length, 1); return l[0]; };
check('flags: every flag wake.sh passes is listed: ok, the path and its source named, and the family caveat said', () => {
  const l = flagOne({});
  assert.match(l, /^ok {6}/); assert.match(l, /\/cfg\/claude \(via paths\.claudeBin\)/);
  for (const { flag } of WAKE_FLAGS) assert.ok(l.includes(flag), flag);
  assert.match(l, /listed as a family/);
});
for (const flag of Object.keys(HELP_LINES)) {
  check(`flags: ${flag} no longer defined in --help is amber and names exactly it, even though prose still mentions it`, () => {
    const l = flagOne({ runHelp: () => HELP([flag]) });
    assert.match(l, /^WARN {4}/); assert.match(l, /before 08:00/);
    const shown = flag === '--append-system-prompt' ? '--append-system-prompt[-file]' : flag;
    assert.ok(l.includes(`no longer lists ${shown}`), l);
    // only that flag is named in the "no longer lists ..." part, never the others
    const namedPart = l.split(', which wake.sh passes')[0];
    for (const other of WAKE_FLAGS.map((f) => f.flag).filter((f) => f !== shown)) assert.ok(!namedPart.includes(other), `${other} wrongly named in: ${l}`);
  });
}
check('flags: two flags gone are both named', () => {
  const l = flagOne({ runHelp: () => HELP(['--fork-session', '--model']) });
  assert.match(l, /^WARN {4}/); assert.match(l, /no longer lists --model, --fork-session|no longer lists --fork-session, --model/);
});
check('flags: --append-system-prompt-file need not be its own line (claude does not list it): the family definition is enough', () => {
  assert.match(flagOne({ runHelp: () => HELP() }), /^ok {6}/);
});
check('flags: help that cannot be read is amber, not ok', () => {
  for (const out of [null, '']) assert.match(flagOne({ runHelp: () => out }), /^WARN {4}.*could not read/);
});
check('flags: no claude to ask gives no line (the version lines already said so)', () => {
  assert.deepEqual(flagLines(io({ isExecutable: () => false, lookupPath: () => null, runHelp: () => HELP() })), []);
});
check('flags: never red', () => {
  for (const c of [{}, { runHelp: () => null }, { runHelp: () => HELP(Object.keys(HELP_LINES)) }]) assert.doesNotMatch(flagOne(c), /^(MISSING|BAD)/);
});

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
check('realIo.runHelp reads a binary\'s --help; a nonzero exit or empty output is null', () => {
  const ok = stub('claude-help-ok', 'echo "  --system-prompt-snapshot <on|off>  x"'); const bad = stub('claude-help-bad', 'echo "x"; exit 2'); const empty = stub('claude-help-empty', 'exit 0');
  const r = realIo({ claudeBin: ok, wakeCostsPath: join(scratch, 'none') });
  assert.match(r.runHelp(ok), /system-prompt-snapshot/); assert.equal(r.runHelp(bad), null); assert.equal(r.runHelp(empty), null);
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
// fallThrough: the configured claude is MISSING and a stub `claude` is findable only by the lookup the wake
// window's shell would do. On macOS that is an interactive login zsh, so a throwaway ZDOTDIR/.zshrc puts the
// stub dir first on PATH; on Linux and WSL the lookup prefixes the configured claude's own directory, so the
// stub sits there. Either way the stub is not on the child's PATH, so only the fall-through can find it.
function preflightLines(wakeCostsText, claudeBinOk = true, { fallThrough = false, omit = [] } = {}) {
  const hub = mkdtempSync(join(tmpdir(), 'nw-vc-hub-'));
  try {
    for (const d of ['wakecycle', 'ladder', 'projects', 'sessions']) mkdirSync(join(hub, d), { recursive: true });
    const s = stub('claude-hub', `case "$1" in --help) cat <<'NW_HELP_EOF'\n${HELP(omit)}NW_HELP_EOF\n;; *) echo "2.1.310 (Claude Code)";; esac`);
    writeFileSync(join(hub, 'checkpoint.md'), '# checkpoint\n');
    writeFileSync(join(hub, 'wakecycle', 'nightshift.armed'), ''); // preflight reads it unguarded; empty = disarmed
    writeFileSync(join(hub, 'ladder', 'wake-costs.jsonl'), wakeCostsText);
    let claudeBin = claudeBinOk ? s : join(hub, 'no-such-claude'); let found = null; const extraEnv = {};
    if (fallThrough) {
      const bin = join(hub, 'stubbin'); mkdirSync(bin);
      found = join(bin, 'claude'); writeFileSync(found, '#!/bin/sh\necho "2.1.310 (Claude Code)"\n'); chmodSync(found, 0o755);
      claudeBin = join(bin, 'claude-missing'); // not there: wake.sh would fall through; on linux/wsl its directory is prefixed onto the lookup's PATH
      if (platformKind() === 'darwin') {
        const zd = join(hub, 'zdot'); mkdirSync(zd); writeFileSync(join(zd, '.zshrc'), `export PATH="${bin}:$PATH"\n`);
        extraEnv.ZDOTDIR = zd; extraEnv.SHELL = '/bin/zsh';
      }
    }
    const cfg = { weftRoot: hub, defaultLane: 'main', lanes: { main: { targetTokens: 250000 } }, notify: { macos: false },
      paths: { workdir: hub, machinery: MACHINERY, transcripts: join(hub, 'projects'), sessions: join(hub, 'sessions'), claudeBin } };
    writeFileSync(join(hub, 'nightwatch.config.json'), JSON.stringify(cfg));
    const env = { ...process.env, ...extraEnv, WEFT_CONFIG: join(hub, 'nightwatch.config.json'), PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
    for (const k of ['NIGHTWATCH_CONFIG', 'WEFT_LANE', 'NIGHTWATCH_LANE']) delete env[k];
    const r = spawnSync(process.execPath, [join(MACHINERY, 'nightshift.mjs'), '--preflight'], { env, encoding: 'utf8', timeout: 60000 });
    return { code: r.status, lines: r.stdout.split('\n'), err: r.stderr, stub: s, found };
  } finally { rmSync(hub, { recursive: true, force: true }); }
}
check('preflight carries the check: an unseen version is amber and the stub path is named', () => {
  const r = preflightLines(rows('2.1.309'));
  assert.equal(r.code, 0, r.err);
  const l = r.lines.find((x) => /^\w+\s+claude /.test(x)); assert.ok(l, r.lines.join('\n'));
  assert.match(l, /^WARN/); assert.match(l, /claude-hub \(via paths\.claudeBin\)/); assert.match(l, /woken: 2\.1\.309/);
  assert.ok(r.lines.some((x) => /preflight complete/.test(x)), 'the rest of the preflight still runs');
});
check('preflight carries the flag check: a --help that lists them is ok, naming the stub; one missing a flag is amber and names it', () => {
  const ok = preflightLines(rows('2.1.310'));
  assert.ok(ok.lines.some((x) => /^ok {6}claude .*claude-hub.*`--help` still lists the flags/.test(x)), ok.lines.join('\n'));
  const gone = preflightLines(rows('2.1.310'), true, { omit: ['--system-prompt-snapshot'] });
  assert.equal(gone.code, 0, gone.err);
  assert.ok(gone.lines.some((x) => /^WARN {4}claude .*no longer lists --system-prompt-snapshot/.test(x)), gone.lines.join('\n'));
  assert.ok(!gone.lines.some((x) => /^(MISSING|BAD)/.test(x) && /claude/.test(x)), 'never red');
});
check('preflight: a version that has woken is ok; no baseline is a note', () => {
  assert.match(preflightLines(rows('2.1.310')).lines.find((x) => /claude 2\.1\.310/.test(x)), /^ok/);
  assert.match(preflightLines('').lines.find((x) => /claude 2\.1\.310/.test(x)), /^note/);
});
check('preflight: a configured claude that is missing is never reported as the binary, and the line says what was found', () => {
  // Machine-independent and NOT the fall-through test (Opus, 10/25: this passes with the fall-through removed):
  // a box with a claude on PATH says "via PATH"; one without (the CI runner) says none was found.
  const r = preflightLines(rows('2.1.310'), false);
  assert.equal(r.code, 0, r.err);
  const l = r.lines.find((x) => /^(ok|WARN|note)\s+claude/.test(x));
  assert.ok(l && /via PATH|no paths\.claudeBin/.test(l) && !/via paths\.claudeBin/.test(l), r.lines.join('\n'));
});
if (platformKind() === 'darwin' && !existsSync('/bin/zsh')) console.log('  - skipped: the fall-through wiring check needs /bin/zsh on macOS');
else check('preflight: a missing configured claude falls through to the claude the wake window\'s shell finds, on every machine, and the line names it', () => {
  const r = preflightLines(rows('2.1.310'), false, { fallThrough: true });
  assert.equal(r.code, 0, r.err);
  const l = r.lines.find((x) => /^(ok|WARN|note)\s+claude/.test(x));
  assert.ok(l, r.lines.join('\n'));
  assert.ok(l.startsWith('ok') && l.includes(`claude 2.1.310 ${r.found} (via PATH`), l);
});

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
