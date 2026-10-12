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
 * Kinds: 'darwin' (the lived platform), 'wsl' (Windows 11 + WSL2, the Terra
 * pilot — Windows interop binaries are reachable from inside WSL on the
 * default config), 'linux' (untested here; the shapes follow the SETUP
 * doc's systemd section). Anything else gets 'linux' answers and loud
 * errors where no answer exists.
 *
 * The CLI serves shell callers (wake.sh):
 *   node platform.mjs kind
 *   node platform.mjs close-tty /dev/ttys003
 */
import { execFileSync as realExecFileSync, spawn as realSpawn } from 'node:child_process';
import { release, homedir } from 'node:os';
import { writeFileSync as realWriteFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * Terminal through interop; Linux asks the Debian alternatives name.
 */
export function summonWindowArgv({ title, shellCommand, activate = true, scriptFile }, kind = platformKind()) {
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
  return [{ bin: 'x-terminal-emulator', args: ['-e', 'sh', '-lc', String(shellCommand)] }];
}

/** Open the window now. Throws when the platform's terminal refuses — the
 *  callers (wake retry, launch-leg test) own that loudness. */
export function summonWindow({ title, shellCommand, activate, scriptDir }, io = {}) {
  const exec = io.execFileSync ?? realExecFileSync;
  const kind = io.kind ?? platformKind();
  let scriptFile;
  if (kind === 'wsl' && scriptDir) {
    // One path crosses the interop chain instead of a quoted command.
    scriptFile = join(scriptDir, 'wake-summon.sh');
    (io.writeFileSync ?? realWriteFileSync)(scriptFile, `#!/bin/sh\n${shellCommand}\n`, { mode: 0o755 });
  }
  for (const { bin, args } of summonWindowArgv({ title, shellCommand, activate, scriptFile }, kind)) exec(bin, args);
}

/**
 * The background-job definition for a hub: what file to write and how to
 * load it. Pure. `kind` 'nightshift' | 'watch' (watch.mjs beside it).
 * Darwin: the launchd plist this house runs, byte-identical to plistFor's.
 * WSL/Linux: a systemd user unit (SETUP.md's shape; WSL2 needs
 * [boot] systemd=true, which the install recipe checks).
 */
export function daemonJob({ slug, hub, jobKind = 'nightshift', node = process.execPath, machineryDir, configPath }, kind = platformKind()) {
  const script = jobKind === 'watch' ? 'watch.mjs' : 'nightshift.mjs';
  const errFile = join(hub, jobKind === 'watch' ? 'watch.err' : 'nightshift.err');
  const cfg = configPath ?? join(hub, 'nightwatch.config.json');
  const label = jobKind === 'watch' ? `house.nightwatch.${slug}.watch` : `house.nightwatch.${slug}`;
  if (kind === 'darwin') {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${join(machineryDir, script)}</string></array>
  <key>EnvironmentVariables</key><dict><key>WEFT_CONFIG</key><string>${cfg}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>300</integer>
  <key>StandardErrorPath</key><string>${errFile}</string>
</dict></plist>\n`;
    return {
      label,
      fileName: `${label}.plist`,
      content,
      installDir: join(homedir(), 'Library', 'LaunchAgents'),
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
  const content = `[Unit]
Description=Nightwatch ${jobKind} for ${slug}

[Service]
ExecStart="${sysd(node)}" "${sysd(join(machineryDir, script))}"
Environment="WEFT_CONFIG=${sysd(cfg)}"
Restart=always
RestartSec=300
StandardError=append:${sysd(errFile)}

[Install]
WantedBy=default.target
`;
  return {
    label,
    fileName: `${label}.service`,
    content,
    installDir: join(homedir(), '.config', 'systemd', 'user'),
    loadArgv: () => [
      { bin: 'systemctl', args: ['--user', 'daemon-reload'] },
      { bin: 'systemctl', args: ['--user', 'enable', '--now', `${label}.service`] },
    ],
    unloadArgv: () => [{ bin: 'systemctl', args: ['--user', 'disable', '--now', `${label}.service`] }],
  };
}

/** The per-user registry the app reads (hubs.json lives here). */
export function registryDir(kind = platformKind()) {
  if (kind === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Nightwatch');
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.length ? xdg : join(homedir(), '.config'), 'nightwatch');
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
