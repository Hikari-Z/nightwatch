// platform-test.mjs — the platform seams, pinned per OS without any OS.
// Every assertion is on pure argv/content shapes; the darwin goldens are
// copied from the live call sites this module replaced, so a drift here is
// a behavior change on the machine the house runs on.
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  platformKind, summonWindowArgv, summonWindow, writeSummonScript, summonArgvFor, daemonJob, registryDir, registryFile,
  bannerArgv, notifyBanner, closeTtyArgv, withToolPath, withNode, TMUX_SUMMON,
} from './platform.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.message}`); }
}

// ── kind detection ──
check('darwin is darwin', () =>
  assert.equal(platformKind({ platform: 'darwin' }), 'darwin'));
check('linux with a microsoft kernel release is wsl', () =>
  assert.equal(platformKind({ platform: 'linux', osRelease: '6.6.87.2-microsoft-standard-WSL2' }), 'wsl'));
check('plain linux is linux', () =>
  assert.equal(platformKind({ platform: 'linux', osRelease: '6.8.0-45-generic' }), 'linux'));
check('anything else gets linux answers', () =>
  assert.equal(platformKind({ platform: 'win32' }), 'linux'));

// ── window summoning ──
const RAW = 'WEFT_CONFIG="/h/cfg.json" sh "/m/wake.sh" main';
const WIRE = 'WEFT_CONFIG=\\"/h/cfg.json\\" sh \\"/m/wake.sh\\" main';
check('darwin summon is the two live osascript calls, byte-identical on the wire', () => {
  const argv = summonWindowArgv({ title: 'main', shellCommand: RAW }, 'darwin');
  assert.deepEqual(argv, [
    { bin: 'osascript', args: ['-e', `tell application "Terminal" to do script "${WIRE}"`] },
    { bin: 'osascript', args: ['-e', 'tell application "Terminal" to activate'] },
  ]);
});
check('a wsl summon with a scriptFile carries one path, quoting moot', () =>
  assert.equal(summonWindowArgv({ title: 'm', shellCommand: 'x', scriptFile: '/h/wake-summon.sh' }, 'wsl')[0].args.at(-1), 'sh "/h/wake-summon.sh"'));
check('summonWindow on wsl writes the script before summoning', () => {
  const writes = [], execs = [];
  summonWindow({ title: 'm', shellCommand: 'echo hi', scriptDir: '/h' }, {
    kind: 'wsl', mkdirSync: () => {},
    writeFileSync: (p, c, o) => writes.push([p, c, o.mode]),
    execFileSync: (bin, args) => execs.push(args.at(-1)),
  });
  assert.deepEqual(writes, [['/h/wake-summon-m.sh', '#!/bin/sh\necho hi\n', 0o755]]);
  assert.deepEqual(execs, ['sh "/h/wake-summon-m.sh"']);
});
check('the summon script is named per lane, so near-simultaneous wakes cannot share one', () => {
  const writes = [];
  summonWindow({ title: 'op us!', shellCommand: 'x', scriptDir: '/h' }, {
    kind: 'wsl', mkdirSync: () => {}, writeFileSync: (p) => writes.push(p), execFileSync: () => {},
  });
  assert.deepEqual(writes, ['/h/wake-summon-op_us_.sh']);
});
check('writeSummonScript makes the summons dir itself (a fresh hub has none) and returns the path', () => {
  const dirs = [], writes = [];
  const p = writeSummonScript({ title: 'lark', shellCommand: 'x', scriptDir: '/hub/wakecycle/summons' }, {
    mkdirSync: (d, o) => dirs.push([d, o.recursive]), writeFileSync: (f) => writes.push(f),
  });
  assert.deepEqual(dirs, [['/hub/wakecycle/summons', true]]);
  assert.equal(p, '/hub/wakecycle/summons/wake-summon-lark.sh');
  assert.deepEqual(writes, [p]);
});
check('summonArgvFor on wsl writes the script and the argv carries its path (the first-wake path)', () => {
  const writes = [];
  const argv = summonArgvFor({ title: 'lark', shellCommand: 'echo hi', activate: false, scriptDir: '/hub/wc/summons' }, 'wsl', {
    mkdirSync: () => {}, writeFileSync: (p) => writes.push(p),
  });
  assert.deepEqual(writes, ['/hub/wc/summons/wake-summon-lark.sh']);
  assert.equal(argv[0].args.at(-1), 'sh "/hub/wc/summons/wake-summon-lark.sh"');
});
check('summonArgvFor on darwin writes nothing and returns the live osascript argv', () => {
  const argv = summonArgvFor({ title: 'lark', shellCommand: 'echo hi', activate: false, scriptDir: '/hub/wc/summons' }, 'darwin', {
    mkdirSync: () => { throw new Error('no mkdir on darwin'); },
    writeFileSync: () => { throw new Error('no write on darwin'); },
  });
  assert.equal(argv[0].bin, 'osascript');
});
check('summonWindow off wsl never writes a script, scriptDir or not', () => {
  const writes = [];
  summonWindow({ title: 'm', shellCommand: 'echo hi', scriptDir: '/h' }, {
    kind: 'darwin', mkdirSync: () => { throw new Error('no mkdir on darwin'); },
    writeFileSync: (p) => writes.push(p), execFileSync: () => {},
  });
  assert.deepEqual(writes, []);
});
check('wsl summon carries the RAW command, unescaped', () =>
  assert.equal(summonWindowArgv({ title: 'm', shellCommand: RAW }, 'wsl')[0].args.at(-1), RAW));
check('wsl summon goes through Windows Terminal interop with the lane title', () => {
  const argv = summonWindowArgv({ title: 'main', shellCommand: 'sh /m/wake.sh main' }, 'wsl');
  assert.deepEqual(argv, [{ bin: 'wt.exe', args: ['nt', '--title', 'main', 'wsl.exe', '--cd', '~', '--', 'sh', '-lc', 'sh /m/wake.sh main'] }]);
});
check('linux with a desktop session uses the alternatives terminal', () => {
  const argv = summonWindowArgv({ title: 'x', shellCommand: 'echo hi' }, 'linux', { DISPLAY: ':0' });
  assert.deepEqual(argv, [{ bin: 'x-terminal-emulator', args: ['-e', 'sh', '-lc', 'echo hi'] }]);
  assert.deepEqual(summonWindowArgv({ title: 'x', shellCommand: 'echo hi' }, 'linux', { WAYLAND_DISPLAY: 'wayland-0' }), argv);
});
check('headless linux summons into tmux, title and command as positional args', () => {
  const argv = summonWindowArgv({ title: 'main', shellCommand: RAW }, 'linux', {});
  assert.deepEqual(argv, [{ bin: 'sh', args: ['-c', TMUX_SUMMON, 'nightwatch-summon', 'main', RAW] }]);
});
check('summonArgvFor threads an injected env through (headless linux, no script written)', () => {
  let wrote = false;
  const argv = summonArgvFor({ title: 'main', shellCommand: 'echo hi', scriptDir: '/s' }, 'linux', { env: {}, writeFileSync: () => { wrote = true; }, mkdirSync: () => {} });
  assert.equal(argv[0].bin, 'sh');
  assert.equal(wrote, false);
});
check('the tmux summons really opens a window, then a second lane joins the same session', () => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch { console.log('    (tmux not installed — skipped)'); return; }
  // A private socket dir: the test never touches a tmux server a human is using.
  const dir = mkdtempSync(join(tmpdir(), 'nw-tmux-'));
  const env = { ...process.env, TMUX_TMPDIR: dir, TMUX: '' };
  try {
    for (const lane of ['main', 'opus']) {
      const [{ bin, args }] = summonWindowArgv({ title: lane, shellCommand: `echo woke > "${dir}/${lane}"; sleep 5` }, 'linux', {});
      execFileSync(bin, args, { env });
    }
    const t0 = Date.now();
    while (!(existsSync(join(dir, 'main')) && existsSync(join(dir, 'opus'))) && Date.now() - t0 < 5000) execFileSync('sleep', ['0.1']);
    assert.equal(readFileSync(join(dir, 'main'), 'utf8').trim(), 'woke');
    assert.equal(readFileSync(join(dir, 'opus'), 'utf8').trim(), 'woke');
    const windows = execFileSync('tmux', ['list-windows', '-t', 'nightwatch', '-F', '#W'], { env, encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(windows.filter((w) => w !== 'bash' && w !== 'sh').sort(), ['main', 'opus']);
  } finally {
    try { execFileSync('tmux', ['kill-server'], { env, stdio: 'ignore' }); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
check('withToolPath prefixes the daemon node dir, and claude\'s when distinct', () => {
  assert.equal(withToolPath('sh w.sh main', { nodePath: '/n/bin/node', kind: 'linux' }), 'PATH="/n/bin:$PATH" NIGHTWATCH_NODE="/n/bin/node" sh w.sh main');
  assert.equal(withToolPath('x', { nodePath: '/n/bin/node', claudeBin: '/c/bin/claude', kind: 'wsl' }), 'PATH="/n/bin:/c/bin:$PATH" NIGHTWATCH_NODE="/n/bin/node" x');
  assert.equal(withToolPath('x', { nodePath: '/n/bin/node', claudeBin: '/n/bin/claude', kind: 'linux' }), 'PATH="/n/bin:$PATH" NIGHTWATCH_NODE="/n/bin/node" x');
});
check('withToolPath keeps a summons runnable when the login shell has no node', () => {
  // The bug it fixes: sh -lc under nvm finds no node. Run the prefixed
  // command with a PATH that lacks node and prove node resolves.
  const out = execFileSync('/bin/sh', ['-c', withToolPath('node -e "console.log(1+1)"', { kind: 'linux' })], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(out.trim(), '2');
});
check('withToolPath leaves darwin\'s PATH alone: only the daemon\'s node is named (10/25)', () => {
  // #1's lesson stands: prefixing PATH on darwin put /opt/homebrew/bin (a stale cask claude) first. The node
  // travels by name instead, so the command is main's plus NIGHTWATCH_NODE and nothing reorders PATH.
  const cmd = 'WEFT_CONFIG="/h/weft.config.json" sh "/m/wake.sh" main';
  const out = withToolPath(cmd, { nodePath: '/u/.local/node22/bin/node', claudeBin: '/u/.local/bin/claude', kind: 'darwin' });
  assert.equal(out, `NIGHTWATCH_NODE="/u/.local/node22/bin/node" ${cmd}`);
  assert.doesNotMatch(out, /PATH=/);
  assert.deepEqual(
    summonWindowArgv({ title: 'main', shellCommand: out }, 'darwin'),
    summonWindowArgv({ title: 'main', shellCommand: withNode(cmd, { nodePath: '/u/.local/node22/bin/node' }) }, 'darwin'));
});
check('withNode hands a shell the exact node path, however it is spelled', () => {
  // Through a real sh, read by a CHILD as wake.sh reads it (the prefix sets the child's environment; the
  // same command line's own $NIGHTWATCH_NODE would expand before it): spaces, quotes, $ and backticks arrive
  // as written, never expanded.
  const odd = '/a b/"q"/$HOME/`x`/node';
  const out = execFileSync('/bin/sh', ['-c', withNode(`/bin/sh -c 'printf %s "$NIGHTWATCH_NODE"'`, { nodePath: odd })], { encoding: 'utf8' });
  assert.equal(out, odd);
  assert.equal(withNode('x', { nodePath: '/n/node' }), 'NIGHTWATCH_NODE="/n/node" x');
});
check('activate: false drops only the focus steal (the app-driven wake)', () => {
  const argv = summonWindowArgv({ title: 'm', shellCommand: 'c', activate: false }, 'darwin');
  assert.equal(argv.length, 1);
  assert.ok(argv[0].args[1].includes('do script'));
});
check('summonWindow executes the argv in order through injected io', () => {
  const ran = [];
  summonWindow({ title: 't', shellCommand: 'c' }, { kind: 'darwin', execFileSync: (bin, args) => ran.push([bin, args[0]]) });
  assert.equal(ran.length, 2);
  assert.equal(ran[0][0], 'osascript');
});

// ── daemon jobs ──
const J = { slug: 'weft', hub: '/h', machineryDir: '/m', node: '/usr/local/bin/node' };
check('darwin nightshift job is the live plist, byte-identical', () => {
  const job = daemonJob(J, 'darwin');
  assert.equal(job.fileName, 'house.nightwatch.weft.plist');
  assert.equal(job.installDir, join(homedir(), 'Library', 'LaunchAgents'));
  assert.equal(job.content, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>house.nightwatch.weft</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>/m/nightshift.mjs</string></array>
  <key>EnvironmentVariables</key><dict><key>NIGHTWATCH_CONFIG</key><string>/h/nightwatch.config.json</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>300</integer>
  <key>StandardErrorPath</key><string>/h/nightshift.err</string>
</dict></plist>\n`);
  assert.deepEqual(job.loadArgv('/L/x.plist'), [{ bin: 'launchctl', args: ['load', '/L/x.plist'] }]);
});
check('darwin watch job differs only where it should', () => {
  const job = daemonJob({ ...J, jobKind: 'watch' }, 'darwin');
  assert.equal(job.fileName, 'house.nightwatch.weft.watch.plist');
  assert.ok(job.content.includes('/m/watch.mjs'));
  assert.ok(job.content.includes('/h/watch.err'));
  assert.ok(job.content.includes('<string>house.nightwatch.weft.watch</string>'));
});
check('wsl job is a systemd user unit, enabled now, quoted against spaces and %', () => {
  const job = daemonJob(J, 'wsl');
  assert.equal(job.fileName, 'house.nightwatch.weft.service');
  assert.equal(job.installDir, join(homedir(), '.config', 'systemd', 'user'));
  assert.ok(job.content.includes('ExecStart="/usr/local/bin/node" "/m/nightshift.mjs"'));
  assert.ok(job.content.includes('Environment="NIGHTWATCH_CONFIG=/h/nightwatch.config.json"'));
  const spaced = daemonJob({ ...J, hub: '/h/My Agent 100%' }, 'wsl');
  assert.ok(spaced.content.includes('Environment="NIGHTWATCH_CONFIG=/h/My Agent 100%%/nightwatch.config.json"'));
  assert.ok(job.content.includes('Restart=always'));
  assert.deepEqual(job.loadArgv(), [
    { bin: 'systemctl', args: ['--user', 'daemon-reload'] },
    { bin: 'systemctl', args: ['--user', 'enable', '--now', 'house.nightwatch.weft.service'] },
  ]);
  assert.deepEqual(job.unloadArgv(), [{ bin: 'systemctl', args: ['--user', 'disable', '--now', 'house.nightwatch.weft.service'] }]);
});
check("a systemd unit carries the installer's PATH (wt.exe/msg.exe under WSL interop, nvm's node)", () => {
  const job = daemonJob({ ...J, path: '/n/bin:/usr/bin:/mnt/c/Program Files/x:/mnt/c/Users/T/AppData/Local/Microsoft/WindowsApps' }, 'wsl');
  assert.ok(job.content.includes('Environment="PATH=/n/bin:/usr/bin:/mnt/c/Program Files/x:/mnt/c/Users/T/AppData/Local/Microsoft/WindowsApps"\n'), job.content);
  assert.ok(daemonJob({ ...J, path: '/a/50%' }, 'linux').content.includes('Environment="PATH=/a/50%%"'));
  assert.ok(daemonJob({ ...J, path: '/q"x' }, 'linux').content.includes('Environment="PATH=/q\\"x"'));
  assert.ok(!daemonJob({ ...J, path: '' }, 'wsl').content.includes('PATH='), 'no PATH line when none is known');
  assert.ok(!daemonJob({ ...J, path: '/n/bin' }, 'darwin').content.includes('/n/bin'), 'darwin plist unchanged');
});
check('an explicit configPath overrides the hub default', () =>
  assert.ok(daemonJob({ ...J, configPath: '/elsewhere/weft.config.json' }, 'darwin').content.includes('/elsewhere/weft.config.json')));

// ── registry ──
check('darwin registry is Application Support', () =>
  assert.equal(registryDir('darwin'), join(homedir(), 'Library', 'Application Support', 'Nightwatch')));
check('linux registry honors XDG_CONFIG_HOME', () => {
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = '/x';
  try { assert.equal(registryDir('linux'), join('/x', 'nightwatch')); }
  finally { if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev; }
});
check('the registry file is hubs.json in the registry dir, per platform (issue #6)', () => {
  assert.equal(registryFile('darwin'), join(homedir(), 'Library', 'Application Support', 'Nightwatch', 'hubs.json'));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = '/x';
  try { assert.equal(registryFile('linux'), join('/x', 'nightwatch', 'hubs.json')); }
  finally { if (prev === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prev; }
});
// A script run outside every hub, with no config named, on a scratch HOME
// that holds a registered hub AND a config where the old default looked
// (~/origin/weft/weft.config.json, the way this house's machine does): it
// must find no hub at all (issues #5 and #7).
const noHubProbe = (expr) => {
  const home = mkdtempSync(join(tmpdir(), 'nw-cfg-nohub-'));
  try {
    const hub = join(home, 'Nightwatch', 'lark');
    for (const d of [hub, join(home, '.config', 'nightwatch'), join(home, 'Library', 'Application Support', 'Nightwatch'), join(home, 'origin', 'weft')]) execFileSync('mkdir', ['-p', d]);
    writeFileSync(join(hub, 'nightwatch.config.json'), JSON.stringify({ persona: { name: 'Lark' } }));
    const reg = JSON.stringify({ version: 1, hubs: [{ path: hub }] });
    writeFileSync(join(home, '.config', 'nightwatch', 'hubs.json'), reg);
    writeFileSync(join(home, 'Library', 'Application Support', 'Nightwatch', 'hubs.json'), reg);
    writeFileSync(join(home, 'origin', 'weft', 'weft.config.json'), JSON.stringify({ persona: { name: 'Weft' } }));
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') };
    delete env.WEFT_CONFIG; delete env.NIGHTWATCH_CONFIG;
    return execFileSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(new URL('./config.mjs', import.meta.url).href)}); ${expr}`],
    { encoding: 'utf8', env, cwd: home }).trim();
  } finally { rmSync(home, { recursive: true, force: true }); }
};
check('outside any hub, with no config named, there is no hub: not the registry\'s, not ~/origin/weft (issues #5, #7)', () =>
  assert.equal(noHubProbe(`console.log(JSON.stringify(m.loadConfigOrNone()))`), 'null'));
check('…and loadConfig refuses, naming NIGHTWATCH_CONFIG', () =>
  assert.equal(noHubProbe(`try { m.loadConfig(); console.log('loaded'); } catch (e) { console.log(/NIGHTWATCH_CONFIG/.test(e.message) ? 'refused' : e.message); }`), 'refused'));

// ── a hub's own defaults (issue #7) ──
{
  const { loadConfigFrom, transcriptsFor, hublessConfig } = await import('./config.mjs');
  const hub = mkdtempSync(join(tmpdir(), 'nw-cfg-hub-'));
  try {
    writeFileSync(join(hub, 'nightwatch.config.json'), JSON.stringify({ lanes: { main: {} }, defaultLane: 'main' }));
    const real = execFileSync('realpath', [hub], { encoding: 'utf8' }).trim();
    const cfg = loadConfigFrom(join(hub, 'nightwatch.config.json'));
    check('a hub works from itself unless its config says otherwise', () => assert.equal(cfg.paths.workdir, real));
    check('its transcripts are where Claude Code keeps that workdir\'s', () => assert.equal(cfg.paths.transcripts, transcriptsFor(real)));
    writeFileSync(join(hub, 'nightwatch.config.json'), JSON.stringify({ lanes: { main: {} }, defaultLane: 'main', paths: { workdir: '/elsewhere/work' } }));
    const cfg2 = loadConfigFrom(join(hub, 'nightwatch.config.json'));
    check('a workdir the config names stands, and transcripts follow it', () => {
      assert.equal(cfg2.paths.workdir, '/elsewhere/work');
      assert.equal(cfg2.paths.transcripts, transcriptsFor('/elsewhere/work'));
    });
  } finally { rmSync(hub, { recursive: true, force: true }); }
  check('the hubless config names no hub path and no house\'s folder', () => {
    const h = hublessConfig();
    assert.equal(h.weftRoot, null);
    assert.equal(h.paths.checkpoint, null);
    assert.equal(h.paths.workdir, null);
    assert.ok(!JSON.stringify(h).includes('origin/weft'));
  });
}

// ── the config's env names (issue #7) ──
{
  const { configEnv, envWithConfig } = await import('./config.mjs');
  check('NIGHTWATCH_CONFIG is read, and WEFT_CONFIG from older installs too', () => {
    assert.equal(configEnv({ NIGHTWATCH_CONFIG: '/a.json' }), '/a.json');
    assert.equal(configEnv({ WEFT_CONFIG: '/b.json' }), '/b.json');
    assert.equal(configEnv({}), undefined);
    assert.equal(configEnv({ NIGHTWATCH_CONFIG: '', WEFT_CONFIG: '' }), undefined, "'' counts as unset");
  });
  check('both names set to the same file pass, as every migration does', () =>
    assert.equal(configEnv({ NIGHTWATCH_CONFIG: '/a.json', WEFT_CONFIG: '/a.json' }), '/a.json'));
  check('both names set to different files is refused, naming both', () =>
    assert.throws(() => configEnv({ NIGHTWATCH_CONFIG: '/a.json', WEFT_CONFIG: '/b.json' }), /\/a\.json.*\/b\.json/));
  check('two spellings of one file (a symlink) are the same file', () => {
    const d = mkdtempSync(join(tmpdir(), 'nw-cfgenv-'));
    try {
      writeFileSync(join(d, 'real.json'), '{}');
      execFileSync('ln', ['-s', join(d, 'real.json'), join(d, 'link.json')]);
      assert.equal(configEnv({ NIGHTWATCH_CONFIG: join(d, 'link.json'), WEFT_CONFIG: join(d, 'real.json') }), join(d, 'link.json'));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  check("a child's environment names the config once, by the new name", () => {
    const env = envWithConfig('/h/c.json', { WEFT_CONFIG: '/h/c.json', PATH: '/bin' });
    assert.deepEqual(env, { PATH: '/bin', NIGHTWATCH_CONFIG: '/h/c.json' });
  });
}

// ── the due notes' knobs are settable (watch.mjs, #11) ──
check('config.mjs set takes lanes.<id>.segmentNoteEveryTokens and watch.l3HorizonDays, and reads them back', () => {
  const d = mkdtempSync(join(tmpdir(), 'nw-due-knobs-'));
  try {
    const cfg = join(d, 'nightwatch.config.json');
    writeFileSync(cfg, JSON.stringify({ defaultLane: 'main', lanes: { main: {} } }));
    const env = { ...process.env, NIGHTWATCH_CONFIG: cfg };
    delete env.WEFT_CONFIG;
    const cli = (...a) => execFileSync(process.execPath, [new URL('./config.mjs', import.meta.url).pathname, ...a], { encoding: 'utf8', env }).trim();
    cli('set', 'lanes.main.segmentNoteEveryTokens', '75000');
    cli('set', 'watch.l3HorizonDays', '7');
    assert.equal(cli('get', 'lanes.main.segmentNoteEveryTokens'), '75000');
    assert.equal(cli('get', 'watch.l3HorizonDays'), '7');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

// ── banners ──
check('darwin banner is the live osascript line with escaping', () => {
  const argv = bannerArgv({ title: 'Nightwatch', text: 'he said "hi" \\ there' }, 'darwin');
  assert.deepEqual(argv, [{ bin: 'osascript', args: ['-e',
    'display notification "he said \\"hi\\" \\\\ there" with title "Nightwatch"'] }]);
});
check('wsl banner is msg.exe as plain argv — nothing parses the text', () => {
  const argv = bannerArgv({ title: 't', text: 'ran $(Remove-Item C:\\x) and $env:USERNAME "quoted"' }, 'wsl');
  assert.deepEqual(argv, [{ bin: 'msg.exe', args: ['*', 't: ran $(Remove-Item C:\\x) and $env:USERNAME "quoted"'] }]);
});
check('linux banner is notify-send', () =>
  assert.deepEqual(bannerArgv({ title: 't', text: 'x' }, 'linux'), [{ bin: 'notify-send', args: ['t', 'x'] }]));
check('notifyBanner spawns with stdio ignored through injected io', () => {
  const ran = [];
  notifyBanner({ title: 't', text: 'x' }, { kind: 'darwin', spawn: (bin, args, o) => { ran.push([bin, o.stdio]); return { on() {} }; } });
  assert.deepEqual(ran, [['osascript', 'ignore']]);
});

// ── window self-close ──
check('darwin close-tty is the live wake.sh osascript, with its delay', () => {
  const argv = closeTtyArgv('/dev/ttys007', 'darwin');
  assert.deepEqual(argv, [{ bin: 'osascript', args: ['-e', 'delay 1', '-e',
    'tell application "Terminal" to close (every window whose tty of selected tab is "/dev/ttys007")'] }]);
});
check('a non-tty string closes nothing (the guard wake.sh had)', () =>
  assert.deepEqual(closeTtyArgv('not a tty', 'darwin'), []));
check('close-tty is a no-op off darwin', () =>
  assert.deepEqual(closeTtyArgv('/dev/ttys007', 'wsl'), []));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
