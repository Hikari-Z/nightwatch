/**
 * platform.mjs — the one file that knows what OS it stands on.
 *
 * Three seams reach the operating system (the 10/11 audit, in the Terra
 * plan): summoning a terminal window, installing the background jobs, and
 * showing a notification banner. Everything else in the machinery is plain
 * node and shell. Those seams live here, each a pure "what to run" function
 * (testable without a window manager) plus a small effectful wrapper, so the
 * darwin paths this house has lived on move in unchanged and a WSL or Linux
 * install changes this file's answers, never its callers.
 *
 * Kinds: 'darwin' (the first lived platform), 'wsl' (Windows 11 + WSL2,
 * lived nightly at a sibling house since mid-October — Windows interop
 * binaries are reachable from inside WSL on the default config), 'linux'
 * (no house has run a real night on it yet; the shapes follow the SETUP
 * doc's systemd section). Anything else gets 'linux' answers and loud
 * errors where no answer exists.
 *
 * The CLI serves shell callers (wake.sh):
 *   node platform.mjs kind
 *   node platform.mjs close-tty /dev/ttys003
 */
import { execFileSync as realExecFileSync, spawn as realSpawn } from 'node:child_process';
import { release, homedir } from 'node:os';
import { writeFileSync as realWriteFileSync, mkdirSync as realMkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 'darwin' | 'wsl' | 'linux'. WSL is Linux wearing a Windows coat: the
 *  kernel release says microsoft. */
export function platformKind(opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') {
    const rel = opts.osRelease ?? release();
    return /microsoft/i.test(rel) ? 'wsl' : 'linux';
  }
  return 'linux';
}

/** Escape one string into an AppleScript double-quoted literal's innards. */
const asAppleScriptText = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * The commands that open a terminal window running `shellCommand` — a RAW sh
 * command line; each platform branch applies its own quoting (darwin's
 * AppleScript escaping happens here, so no caller ever pre-escapes). Pure:
 * returns [{ bin, args }...] in order. Darwin yields today's two osascript
 * calls byte-identically for the same wire command; WSL asks Windows
 * Terminal through interop; Linux asks the Debian alternatives name when a
 * desktop session exists, and tmux when it doesn't (`env` is injectable).
 */
export function summonWindowArgv({ title, shellCommand, activate = true, scriptFile }, kind = platformKind(), env = process.env) {
  if (kind === 'darwin') {
    return [
      { bin: 'osascript', args: ['-e', `tell application "Terminal" to do script "${asAppleScriptText(shellCommand)}"`] },
      // The app-driven first wake passes activate: false — summoning a window
      // mid-Set-up must not steal focus from the app doing the setting up.
      ...(activate ? [{ bin: 'osascript', args: ['-e', 'tell application "Terminal" to activate'] }] : []),
    ];
  }
  if (kind === 'wsl') {
    // wt.exe opens a new tab; `wsl.exe --cd ~` re-enters the default distro.
    // The window carries the lane's name so a human can tell wakes apart.
    // The command crosses WSL interop → a Windows command line → wt (which
    // reads ';' itself) → wsl.exe → sh, so a caller that can write a file
    // passes scriptFile and the whole chain carries one path instead — the
    // second read's quoting-moot suggestion. summonWindow writes it.
    const run = scriptFile ? `sh "${scriptFile}"` : String(shellCommand);
    return [{
      bin: 'wt.exe',
      args: ['nt', '--title', String(title ?? 'nightwatch'), 'wsl.exe', '--cd', '~', '--', 'sh', '-lc', run],
    }];
  }
  // Linux with a desktop session asks the Debian alternatives terminal. A
  // headless Linux (a server, a VM, no DISPLAY/WAYLAND_DISPLAY) has no window
  // to open, so the wake runs in tmux instead: one "nightwatch" session, a
  // window per lane, attachable with `tmux attach -t nightwatch`. Title and
  // command ride as positional args so no shell re-parses them; new-window
  // fails when the session doesn't exist yet, and new-session makes it.
  if (env.DISPLAY || env.WAYLAND_DISPLAY) {
    return [{ bin: 'x-terminal-emulator', args: ['-e', 'sh', '-lc', String(shellCommand)] }];
  }
  return [{
    bin: 'sh',
    args: ['-c', TMUX_SUMMON, 'nightwatch-summon', String(title ?? 'nightwatch'), String(shellCommand)],
  }];
}

/** The tmux leg of a headless Linux summons ($1 = window title, $2 = the raw
 *  command). Exported for the test that runs it against a real tmux. */
export const TMUX_SUMMON =
  'tmux new-window -d -t nightwatch -n "$1" "$2" 2>/dev/null || tmux new-session -d -s nightwatch -n "$1" "$2"';

/** A wake window starts from a login shell, not the daemon's environment, and
 *  on Linux that shell often can't see node: nvm (and an npm-installed
 *  claude beside it) lives on a PATH only an interactive bash adds, while the
 *  window runs `sh -lc`. wake.sh needs node from its first line, so callers
 *  prefix the daemon's own node dir, plus the configured claude's dir. Pure.
 *  Not on darwin: Terminal's login shell already finds both there, and the
 *  prefix only reorders PATH (review on #1: it put /opt/homebrew/bin, with a
 *  stale cask claude, ahead of the live one), so the command passes through. */
export function withToolPath(shellCommand, { nodePath = process.execPath, claudeBin, kind = platformKind() } = {}) {
  const cmd = withNode(shellCommand, { nodePath });
  if (kind === 'darwin') return cmd;
  const dirs = [...new Set([dirname(nodePath), ...(claudeBin ? [dirname(claudeBin)] : [])])];
  return `PATH="${dirs.join(':')}:$PATH" ${cmd}`;
}

/** The daemon's own node (its process.execPath, which the launchd plist or systemd unit pins) handed
 *  to the window by name, on every platform: the scripts run "$NIGHTWATCH_NODE" when it's set, so the
 *  window doesn't depend on its shell's PATH (10/25: Terminal's PATH found Homebrew's Node 20 while the
 *  daemon ran 22) and PATH isn't reordered for claude (the darwin lesson above). wake.sh exports it, so
 *  the claude it launches, that session's hooks and its agent shells inherit the same node. Pure. */
export function withNode(shellCommand, { nodePath = process.execPath } = {}) {
  const q = String(nodePath).replace(/["\\$`]/g, '\\$&');
  return `NIGHTWATCH_NODE="${q}" ${shellCommand}`;
}

/** On WSL, the summons crosses the interop chain as one file path instead of
 *  a quoted command. The file is named per title: both lanes wake seconds
 *  apart, and a shared name could be overwritten before a slow Windows
 *  Terminal tab reads it (the second read's race, 10/12) — two windows
 *  waking one lane. Returns the script path. Shared by summonWindow and the
 *  callers that spawn the argv themselves (nightwatch.mjs's first wake). */
export function writeSummonScript({ title, shellCommand, scriptDir }, io = {}) {
  const safe = String(title ?? 'nightwatch').replace(/[^A-Za-z0-9_-]/g, '_');
  const scriptFile = join(scriptDir, `wake-summon-${safe}.sh`);
  (io.mkdirSync ?? realMkdirSync)(scriptDir, { recursive: true });
  (io.writeFileSync ?? realWriteFileSync)(scriptFile, `#!/bin/sh\n${shellCommand}\n`, { mode: 0o755 });
  return scriptFile;
}

/** The write-if-wsl decision in one place: builds the summon argv, writing
 *  the script file first when the platform wants one. Callers that spawn
 *  the argv themselves (nightwatch.mjs's first wake) ride this instead of
 *  carrying a platform branch of their own (the second read's ask: that
 *  branch is Terra's actual first wake, and a silent fallback to the
 *  quoted-command path would degrade invisibly). */
export function summonArgvFor({ title, shellCommand, activate, scriptDir }, kind = platformKind(), io = {}) {
  const scriptFile = (kind === 'wsl' && scriptDir)
    ? writeSummonScript({ title, shellCommand, scriptDir }, io)
    : undefined;
  return summonWindowArgv({ title, shellCommand, activate, scriptFile }, kind, io.env ?? process.env);
}

/** Open the window now. Throws when the platform's terminal refuses — the
 *  callers (wake retry, launch-leg test) own that loudness. */
export function summonWindow({ title, shellCommand, activate, scriptDir }, io = {}) {
  const exec = io.execFileSync ?? realExecFileSync;
  const kind = io.kind ?? platformKind();
  for (const { bin, args } of summonArgvFor({ title, shellCommand, activate, scriptDir }, kind, io)) exec(bin, args);
}

/**
 * The background-job definition for a hub: what file to write and how to
 * load it. Pure. `kind` 'nightshift' | 'watch' (watch.mjs beside it).
 * Darwin: the launchd plist this house runs, byte-identical to plistFor's.
 * WSL/Linux: a systemd user unit (SETUP.md's shape; WSL2 needs
 * [boot] systemd=true, which the install recipe checks).
 */
export function daemonJob({ slug, hub, jobKind = 'nightshift', node = process.execPath, machineryDir, configPath, path = process.env.PATH }, kind = platformKind()) {
  const script = jobKind === 'watch' ? 'watch.mjs' : 'nightshift.mjs';
  const errFile = join(hub, jobKind === 'watch' ? 'watch.err' : 'nightshift.err');
  const cfg = configPath ?? join(hub, 'nightwatch.config.json');
  const label = jobKind === 'watch' ? `house.nightwatch.${slug}.watch` : `house.nightwatch.${slug}`;
  if (kind === 'darwin') {
    // XML-escaped like any real plist writer: a hub named "R&D" must not
    // write an invalid plist (launchctl refused it), and the sweep reads
    // files back with plutil, which sees entities as launchd does.
    const xml = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(join(machineryDir, script))}</string></array>
  <key>EnvironmentVariables</key><dict><key>NIGHTWATCH_CONFIG</key><string>${xml(cfg)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>300</integer>
  <key>StandardErrorPath</key><string>${xml(errFile)}</string>
</dict></plist>\n`;
    return {
      label,
      fileName: `${label}.plist`,
      content,
      installDir: process.env.NW_INSTALL_DIR || join(homedir(), 'Library', 'LaunchAgents'),
      loadArgv: (installedPath) => [{ bin: 'launchctl', args: ['load', installedPath] }],
      unloadArgv: (installedPath) => [{ bin: 'launchctl', args: ['unload', installedPath] }],
    };
  }
  // systemd user unit, WSL and Linux alike. Restart=always mirrors KeepAlive;
  // RestartSec mirrors ThrottleInterval's spirit without launchd's backoff.
  // systemd splits ExecStart on whitespace and reads % as a specifier, so
  // every path is quoted and % doubled (the second read's finding: a hub
  // named "My Agent" must not break its own unit).
  const sysd = (p) => String(p).replace(/%/g, '%%');
  // The installer's PATH rides into the unit. A systemd user service starts
  // with a bare PATH: on WSL that drops the Windows directories interop
  // appends to an interactive shell, so wt.exe (every wake), wsl.exe and
  // msg.exe (alerts) are ENOENT — found by the launch-leg test on the first
  // WSL install, 2026-10-16 — and on any Linux it drops nvm's node and claude.
  // Set up runs from a person's shell, whose PATH is the one that works.
  const pathLine = path ? `Environment="PATH=${sysd(path).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n` : '';
  const content = `[Unit]
Description=Nightwatch ${jobKind} for ${slug}

[Service]
ExecStart="${sysd(node)}" "${sysd(join(machineryDir, script))}"
Environment="NIGHTWATCH_CONFIG=${sysd(cfg)}"
${pathLine}Restart=always
RestartSec=300
StandardError=append:${sysd(errFile)}

[Install]
WantedBy=default.target
`;
  return {
    label,
    fileName: `${label}.service`,
    content,
    installDir: process.env.NW_INSTALL_DIR || join(homedir(), '.config', 'systemd', 'user'),
    loadArgv: () => [
      { bin: 'systemctl', args: ['--user', 'daemon-reload'] },
      { bin: 'systemctl', args: ['--user', 'enable', '--now', `${label}.service`] },
    ],
    unloadArgv: () => [{ bin: 'systemctl', args: ['--user', 'disable', '--now', `${label}.service`] }],
  };
}

/** The per-user registry the app reads (hubs.json lives here). */
export function registryDir(kind = platformKind()) {
  // NW_REGISTRY_DIR (with NW_INSTALL_DIR above) is a BENCH seam: tests point
  // both at scratch dirs so nothing user-global is touched. apply --live
  // refuses to run while either is set, so the seam can't misdirect a real
  // install (see nightwatch.mjs).
  if (process.env.NW_REGISTRY_DIR) return process.env.NW_REGISTRY_DIR;
  if (kind === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Nightwatch');
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length ? xdg : join(homedir(), '.config'), 'nightwatch');
}

/** The registry file itself: every reader and writer names it through here
 *  (Set up, Doctor, the viewer), so there is one place, per platform. Its
 *  twin in Rust is registry_file() in app/src-tauri/src/lib.rs, which follows
 *  the same rule by hand: change one, change both. */
export function registryFile(kind = platformKind()) {
  return join(registryDir(kind), 'hubs.json');
}

/**
 * A native notification banner. Darwin is today's osascript line
 * byte-identically; WSL raises a Windows toast through PowerShell interop;
 * Linux asks notify-send. Callers treat failure as log-worthy, never fatal
 * (watch.mjs's custom), and the config's generic notify.command remains the
 * platform-free alternative.
 */
export function bannerArgv({ title, text }, kind = platformKind()) {
  if (kind === 'darwin') {
    return [{
      bin: 'osascript',
      args: ['-e', `display notification "${asAppleScriptText(text)}" with title "${asAppleScriptText(title)}"`],
    }];
  }
  if (kind === 'wsl') {
    // msg.exe, as its own argv: no shell, no PowerShell, nothing that parses
    // the text. Banner text carries transcript-derived data (a classifier
    // denial quotes the denied command), so it must never cross a string any
    // interpreter reads — the second read's injection finding, 10/12. msg
    // shows a dialog rather than a toast; wsl-notify-send, when installed,
    // is the nicer upgrade and the install recipe offers it.
    return [{ bin: 'msg.exe', args: ['*', `${String(title)}: ${String(text)}`] }];
  }
  return [{ bin: 'notify-send', args: [String(title), String(text)] }];
}

export function notifyBanner({ title, text }, io = {}) {
  const spawn = io.spawn ?? realSpawn;
  const children = [];
  for (const { bin, args } of bannerArgv({ title, text }, io.kind)) {
    children.push(spawn(bin, args, { stdio: 'ignore' }));
  }
  return children;
}

/** Close the terminal window owning `tty` (the wake window tidying itself
 *  away). Darwin only; elsewhere the window belongs to the summoner and a
 *  no-op is honest. Pure variant returns [] when there is nothing to run. */
export function closeTtyArgv(tty, kind = platformKind()) {
  if (kind !== 'darwin' || !/^\/dev\/tty/.test(String(tty))) return [];
  return [{
    bin: 'osascript',
    args: ['-e', 'delay 1', '-e', `tell application "Terminal" to close (every window whose tty of selected tab is "${asAppleScriptText(tty)}")`],
  }];
}

// ── CLI for shell callers ──
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'kind') {
    console.log(platformKind());
  } else if (cmd === 'close-tty') {
    for (const { bin, args } of closeTtyArgv(rest[0])) {
      try { realSpawn(bin, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* cosmetic */ }
    }
  } else if (cmd !== undefined) {
    console.error(`platform.mjs: unknown command "${cmd}" (kind | close-tty <tty>)`);
    process.exit(1);
  }
}
