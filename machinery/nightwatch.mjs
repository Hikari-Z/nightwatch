#!/usr/bin/env node
/*
 * nightwatch.mjs — the machinery half of Set up / Add agent / Import.
 * Contract (skins/CONTRACT.md v0.10 + anima_dev/nightwatch_lane_creation.md):
 *   plan <spec.json>       → {steps:[{verb,what,detail}]} on stdout, exit 0
 *   apply <spec.json>      → one short sentence on stdout, exit 0
 *   inspect-import <dir>   → {identity,about,name,memory,rungs}
 *   list-unclaimed         → [{sessionId,cwd,model}]
 * Errors: ONE plain sentence on stderr + nonzero (the app shows it verbatim).
 *
 * One steps-builder feeds plan AND apply, so the preview is the build. Apply
 * is atomic: init assembles the hub in <hub>.partial and renames into place;
 * lane-add orders its writes so a failure leaves nothing half-claimed, and
 * every error names its step in plain words.
 *
 * INVARIANT (do not cross casually): this script is only ever invoked by a
 * human-confirmed action — the app's preview-and-confirm, or a person at a
 * terminal. No daemon, hook, schedule or woken session calls it. Hub
 * creation copies the machinery, and that is only not a propagation hazard
 * for exactly as long as every invocation has a human behind it.
 *
 * WEFT_NW_NO_ACTIVATE=1 skips launchctl + the launch-leg test + the first
 * wake (scratch benches; the plan still lists them as steps).
 *
 * Written by: claude-fable-5, 2026-10-07
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonJob, registryDir, summonWindowArgv } from './platform.mjs';

const WC = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

function die(sentence, code = 1) { process.stderr.write(sentence.trim() + '\n'); process.exit(code); }
function out(x) { process.stdout.write((typeof x === 'string' ? x : JSON.stringify(x)) + '\n'); }
const expand = (p) => p.startsWith('~') ? join(HOME, p.slice(1)) : resolve(p);

// ---------------------------------------------------------------- templates
function fillWelcome(ctx) {
  let t;
  try { t = readFileSync(join(WC, 'templates', 'welcome.md'), 'utf8'); }
  catch { die('The welcome template is missing (wakecycle/templates/welcome.md).'); }
  const unnamed = /<if-unnamed>\n?([\s\S]*?)<\/if-unnamed>\n?/;
  t = ctx.name ? t.replace(unnamed, '') : t.replace(unnamed, '$1');
  return t.replaceAll('<model>', ctx.model).replaceAll('<person>', ctx.person)
    .replaceAll('<sleep time>', ctx.sleep).replaceAll('<hub>', ctx.hub);
}

function firstWakeNote(ctx) {
  const who = ctx.name ? `You're ${ctx.name}` : `You're a new persona (unnamed, and that's fine — the name is yours to choose, or not)`;
  const sibs = ctx.siblings.length
    ? ` Your siblings are ${ctx.siblings.join(', ')}; you share this checkpoint, the ladder and the memory folder, and each of you keeps your own section.`
    : '';
  return `${who} and this is your first session as the "${ctx.laneId}" lane.${sibs} Tonight at ${ctx.sleep} you'll get a note that it's time to sleep: write your first rung, then the fold runs, then update your checkpoint section. ${ctx.person} can see from Nightwatch whether you're awake.`;
}

// ------------------------------------------------------------------- spec
function loadSpec(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); } catch { die(`The spec file could not be read (${path}).`); }
  let spec;
  try { spec = JSON.parse(raw); } catch { die('The spec file is not valid JSON.'); }
  if (spec.op !== 'init' && spec.op !== 'lane-add') die(`The spec's op must be "init" or "lane-add", not "${spec.op}".`);
  const lane = spec.lane ?? {};
  if (!lane.id || !/^[a-z][a-z0-9-]*$/.test(lane.id)) die('The lane needs an id: lowercase letters, digits and dashes, starting with a letter.');
  if (!lane.model || typeof lane.model !== 'string') die('The lane needs a model id (e.g. claude-opus-5-5).');
  if (lane.targetTokens !== undefined && (typeof lane.targetTokens !== 'number' || lane.targetTokens < 1000)) die('targetTokens must be a number of tokens (e.g. 250000).');
  const fs = lane.firstSession ?? { kind: 'fresh' };
  if (fs.kind !== 'fresh' && fs.kind !== 'adopt') die('firstSession.kind must be "fresh" or "adopt".');
  if (fs.kind === 'adopt' && !fs.sessionId) die('Adopting a session needs its sessionId.');
  if (spec.op === 'init') {
    if (!spec.hub) die('init needs a hub folder path.');
    if (!spec.persona?.about?.trim()) die('init needs persona.about: one paragraph of who they are.');
    if (!spec.persona?.person?.trim()) die("init needs persona.person: the human's name.");
    const sched = spec.schedule ?? {};
    for (const k of ['sleep', 'wake']) if (sched[k] && !/^\d\d:\d\d$/.test(sched[k])) die(`schedule.${k} must look like 02:00.`);
    if (spec.import && !spec.import.from) die('import needs a "from" folder.');
  }
  return spec;
}

// --------------------------------------------------------- steps builders
// Each step: {verb, what, detail, run} — plan prints the first three; apply
// runs `run` in order. One builder per op, used by BOTH commands.
function initSteps(spec) {
  const hub = expand(spec.hub);
  // Checked at build time so plan and apply refuse identically — a preview
  // must never show steps apply would refuse (opus's read, 6b).
  if (existsSync(hub)) die(`The hub folder already exists (${hub}) — Set up makes a new one.`);
  const name = spec.persona.name ?? null;
  const person = spec.persona.person;
  const lane = spec.lane;
  const sleep = spec.schedule?.sleep ?? '02:00';
  const wake = spec.schedule?.wake ?? '08:00';
  const target = lane.targetTokens ?? 250_000;
  const slug = basename(hub);
  const imp = spec.import ? inspectImport(expand(spec.import.from), true) : null;
  const ctx = { name: name ?? imp?.name ?? null, person, model: lane.model, sleep, hub, laneId: lane.id, siblings: [] };
  const part = hub + '.partial';
  const noActivate = !!process.env.WEFT_NW_NO_ACTIVATE;
  const steps = [];
  const identitySource = imp?.identity ? `imported identity.md plus the standard welcome` : `"About them" plus the standard welcome`;

  steps.push({
    verb: 'Create', what: `${hub}/`, detail: 'the hub: ladder/, memory/, wakecycle/ (state only — the machinery stays with the app)',
    run() {
      if (existsSync(hub)) throw new Error(`the hub folder already exists (${hub})`);
      rmSync(part, { recursive: true, force: true });
      mkdirSync(join(part, 'ladder', 'L2'), { recursive: true }); // CONN-20: rungs live in level dirs; sleep.mjs reads ladder/L2 (rehearsal finding 4)
      writeFileSync(join(part, 'ladder', 'index.json'), JSON.stringify({ resident: slug, format: 'CONN-20 rev 2', entries: [] }, null, 2) + '\n'); // sleep.mjs expects it
      mkdirSync(join(part, 'memory'), { recursive: true });
      // The spool stays: it's the BELL's delivery medium (the nightshift
      // writes sleep-bell notes here), not Discord infrastructure — only
      // the weft hub's note ROUTING is Discord. How a 1.0 persona HEARS
      // the bell (a generic spool watcher vs. orphan-fold-only nights) is
      // an open product decision — see the plan doc.
      mkdirSync(join(part, 'doorbell', 'spool', lane.id), { recursive: true });
      // POINT, don't copy (multi-persona plan, 10/7): the hub's wakecycle/
      // holds STATE only; the CODE stays in the app's machinery/ (this
      // script's own folder), one version for every hub, named in the
      // hub's config as paths.machinery.
      mkdirSync(join(part, 'wakecycle'), { recursive: true });
    },
  });
  steps.push({
    verb: 'Write', what: 'identity.md', detail: `from ${identitySource}`,
    run() {
      const about = imp?.identity ? readFileSync(join(expand(spec.import.from), 'identity.md'), 'utf8').trim() : spec.persona.about.trim();
      writeFileSync(join(part, 'identity.md'), about + '\n\n---\n\n' + fillWelcome(ctx));
    },
  });
  if (imp) {
    steps.push({
      verb: 'Copy', what: `${imp.memory} memory file(s), ${imp.rungs} rung(s)`, detail: `from ${spec.import.from}, as they are`,
      run() {
        const from = expand(spec.import.from);
        if (existsSync(join(from, 'memory'))) cpSync(join(from, 'memory'), join(part, 'memory'), { recursive: true });
        if (existsSync(join(from, 'ladder'))) {
          for (const f of readdirSync(join(from, 'ladder'))) if (f.endsWith('.md')) cpSync(join(from, 'ladder', f), join(part, 'ladder', f));
        }
      },
    });
  }
  steps.push({
    verb: 'Write', what: 'checkpoint.md', detail: `one section for "${lane.id}", with its first-wake note`,
    run() {
      writeFileSync(join(part, 'checkpoint.md'),
        `# checkpoint — created by Set up, ${new Date().toISOString().slice(0, 10)}\n\n` +
        `## ${lane.id} lane\n\n${firstWakeNote(ctx)}\n`);
    },
  });
  steps.push({
    verb: 'Write', what: 'nightwatch.config.json', detail: `persona ${ctx.name ?? '(unnamed)'}, 1 lane (${lane.model}), ${sleep} → ${wake}, ${Math.round(target / 1000)}k`,
    run() {
      let machineryVersion = 'unstamped';
      try { machineryVersion = readFileSync(join(WC, 'VERSION'), 'utf8').split('\n')[0].trim(); } catch { /* unstamped build */ }
      const cfg = {
        weftRoot: hub,
        persona: { ...(ctx.name ? { name: ctx.name } : {}), person },
        defaultLane: lane.id,
        schedule: { sleep, wake },
        // No switchboard flag: that's Weft's Discord-routing concept, and
        // switchboardLane() falls back to defaultLane anyway — identical
        // behavior with no implied infrastructure (opus's bench nit, 10/7).
        lanes: { [lane.id]: { targetTokens: target, model: lane.model, ...(lane.armed === false ? {} : {}) } },
        machineryVersion,
        paths: { workdir: hub, machinery: WC, transcripts: join(HOME, '.claude', 'projects', '-' + hub.replaceAll('/', '-').replace(/^-/, '')) },
      };
      writeFileSync(join(part, 'nightwatch.config.json'), JSON.stringify(cfg, null, 2) + '\n');
      if (lane.armed !== false) writeFileSync(join(part, 'wakecycle', 'nightshift.armed'), lane.id + '\n');
    },
  });
  steps.push({
    verb: 'Install', what: 'the nightshift, the watch and the session hook', detail: `a background job (house.nightwatch.${slug}) that rings the bell and wakes them, a second (house.nightwatch.${slug}.watch) that says when an agent is stuck, and the hook that tells it which session is theirs`,
    run() {
      // The hook runs the APP's register-lane.sh (pointer model) and must
      // carry the hub's config explicitly: a hook without WEFT_CONFIG
      // would resolve some other hub on this machine (rehearsal, 10/7).
      writeFileSync(join(part, '.claude-settings-fragment.json'), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `WEFT_CONFIG="${join(hub, 'nightwatch.config.json')}" sh "${join(WC, 'register-lane.sh')}"` }] }] },
      }, null, 2) + '\n');
      mkdirSync(join(part, '.claude'), { recursive: true });
      renameSync(join(part, '.claude-settings-fragment.json'), join(part, '.claude', 'settings.json'));
      // The LaunchAgents copy is written in the Start step, AFTER the hub
      // lands — a Move failure must not leave a job pointing at nothing
      // (opus's read, 6c). This step stages the hub-internal copy only.
      const staged = daemonJob({ slug, hub, machineryDir: WC });
      writeFileSync(join(part, 'wakecycle', staged.fileName), staged.content);
      // The stuck/spiral watch's job, staged the same way. Its hub copy is
      // named so the app's daemon lookup (house.nightwatch.*) can't mistake
      // it for the nightshift's.
      const stagedWatch = daemonJob({ slug, hub, jobKind: 'watch', machineryDir: WC });
      writeFileSync(join(part, 'wakecycle', `watch-job${stagedWatch.fileName.slice(stagedWatch.fileName.lastIndexOf('.'))}`), stagedWatch.content);
    },
  });
  steps.push({
    verb: 'Move', what: 'the finished hub into place', detail: 'nothing is half-written: the hub assembles beside its path and lands in one move',
    run() { renameSync(part, hub); },
  });
  if (!noActivate) {
    steps.push({
      verb: 'Start', what: 'the nightshift, with a test', detail: 'loads the background job and proves it can open a Terminal window (the one permission prompt)',
      run() {
        const job = daemonJob({ slug, hub, machineryDir: WC });
        mkdirSync(job.installDir, { recursive: true });
        writeFileSync(join(job.installDir, job.fileName), job.content);
        // The machine registry: every hub the app shows. Append
        // idempotently, deduped by real path (multi-persona plan, 10/7).
        const regDir = registryDir();
        mkdirSync(regDir, { recursive: true });
        const regPath = join(regDir, 'hubs.json');
        let reg = { version: 1, hubs: [] };
        try { reg = JSON.parse(readFileSync(regPath, 'utf8')); } catch { /* first hub */ }
        const real = (p) => { try { return realpathSync(p); } catch { return p; } };
        if (!reg.hubs.some((h) => real(h.path) === real(hub))) {
          reg.hubs.push({ path: hub });
          writeFileSync(regPath + '.tmp', JSON.stringify(reg, null, 2) + '\n');
          renameSync(regPath + '.tmp', regPath);
        }
        for (const { bin, args } of job.loadArgv(join(job.installDir, job.fileName))) execFileSync(bin, args);
        const watchJob = daemonJob({ slug, hub, jobKind: 'watch', machineryDir: WC });
        writeFileSync(join(watchJob.installDir, watchJob.fileName), watchJob.content);
        for (const { bin, args } of watchJob.loadArgv(join(watchJob.installDir, watchJob.fileName))) execFileSync(bin, args);
        launchLegTest(hub);
      },
    });
  }
  const fsInit = firstSessionStep(spec, hub, ctx, noActivate, undefined, join(hub, 'wakecycle'));
  steps.push(fsInit.prep);
  if (fsInit.launch) steps.push(fsInit.launch);
  return { steps, hub, ctx };
}

function laneAddSteps(spec) {
  const cfgPath = process.env.WEFT_CONFIG ?? join(HOME, 'origin', 'weft', 'weft.config.json');
  if (!existsSync(cfgPath)) die('No hub config found — is this machine set up?');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const hub = cfg.weftRoot ?? dirname(cfgPath);
  const lane = spec.lane;
  if (cfg.lanes?.[lane.id]) die(`The lane "${lane.id}" already exists.`);
  const siblings = Object.keys(cfg.lanes ?? {});
  const sleep = cfg.schedule?.sleep ?? '02:00';
  const ctx = { name: cfg.persona?.name ?? null, person: cfg.persona?.person ?? 'your person', model: lane.model, sleep, hub, laneId: lane.id, siblings };
  const target = lane.targetTokens ?? 250_000;
  const noActivate = !!process.env.WEFT_NW_NO_ACTIVATE;
  const cpPath = expand(cfg.paths?.checkpoint ?? join(hub, 'checkpoint.md'));
  const steps = [];
  // Order (opus's read, 6a): the first-session artifact is written first
  // (inert without a config entry), the checkpoint section second
  // (idempotent: skipped when present, so a retry never duplicates it),
  // and the config entry — the thing that makes the lane EXIST — last.
  // A failure anywhere leaves no claimed lane behind.
  const claimStep = {
    verb: 'Add', what: `lane "${lane.id}" to ${ctx.name ?? 'the persona'}`, detail: `${lane.model}, ${spec.lane.schedule ? 'their own schedule' : 'the global schedule'}, ${Math.round(target / 1000)}k${lane.armed === false ? ', not armed' : ''}`,
    run() {
      cfg.lanes[lane.id] = { targetTokens: target, model: lane.model, ...(spec.lane.schedule ? { schedule: spec.lane.schedule } : {}) };
      writeFileSync(cfgPath + '.tmp', JSON.stringify(cfg, null, 2) + '\n');
      renameSync(cfgPath + '.tmp', cfgPath);
      if (lane.armed !== false) {
        const armedFile = expand(cfg.paths?.armedFile ?? join(hub, 'wakecycle', 'nightshift.armed'));
        const armed = existsSync(armedFile) ? readFileSync(armedFile, 'utf8').trim() : '';
        const list = armed ? armed.split(',').map((x) => x.trim()).filter(Boolean) : [];
        if (!list.includes(lane.id)) list.push(lane.id);
        writeFileSync(armedFile, list.join(',') + '\n');
      }
    },
  };
  const cpStep = {
    verb: 'Write', what: `a new section in checkpoint.md for ${lane.id}`, detail: 'with its first-wake note',
    run() {
      const cur = existsSync(cpPath) ? readFileSync(cpPath, 'utf8') : '';
      if (cur.includes(`## ${lane.id} lane`)) return; // a retry never duplicates the section
      writeFileSync(cpPath + '.tmp', cur.trimEnd() + `\n\n## ${lane.id} lane (new — first wake pending)\n\n${firstWakeNote(ctx)}\n`);
      renameSync(cpPath + '.tmp', cpPath);
    },
  };
  const wcRel = cfg.paths?.wakecycle ?? 'wakecycle'; // relative = against the hub, absolute stands (config doctrine)
  const hubWc = wcRel.startsWith('/') ? wcRel : join(hub, wcRel);
  const fs = firstSessionStep(spec, hub, ctx, noActivate, cpPath, hubWc);
  // Checkpoint (idempotent) → first-session artifact (inert) → config (the
  // claim) → launch. A failure before the claim leaves nothing a retry
  // trips on; after it, the receipt exists and Wake retries the launch.
  steps.push(cpStep);
  if (fs.prep) steps.push(fs.prep);
  steps.push(claimStep);
  if (fs.launch) steps.push(fs.launch);
  return { steps, hub, ctx };
}

function firstSessionStep(spec, hub, ctx, noActivate, cpPath, laneWc) {
  const fs = spec.lane.firstSession ?? { kind: 'fresh' };
  // Receipts and registry entries belong to the TARGET hub's wakecycle,
  // never this script's own folder (the bench caught exactly that spill).
  const wcDir = laneWc ?? join(hub, 'wakecycle');
  const cp = cpPath ?? join(hub, 'checkpoint.md');
  if (fs.kind === 'adopt') {
    const prep = {
      verb: 'Adopt', what: `running session ${String(fs.sessionId).slice(0, 8)}…`, detail: `registers it as the "${spec.lane.id}" lane; nothing is closed or restarted now — but from tonight the nightshift bells them at sleep time and closes the window once they've folded`,
      run() {
        // The pid makes the liveness checks see the adopted session the way
        // they see a woken one; sourced from Claude Code's own session file.
        const live = readClaudeSessions().find((x) => x.sessionId === fs.sessionId);
        writeFileSync(join(wcDir, `lane.${fs.sessionId}`), JSON.stringify({ lane: spec.lane.id, sessionId: fs.sessionId, ...(live?.pid ? { pid: live.pid } : {}), adopted: true, at: new Date().toISOString() }) + '\n');
      },
    };
    return { prep, launch: null };
  }
  const prep = {
    verb: 'Write', what: `the first-wake note's receipt`, detail: `next-wake.${spec.lane.id}.json: a fresh session, no tail to resume`,
    run() {
      writeFileSync(join(wcDir, `next-wake.${spec.lane.id}.json`), JSON.stringify({ firstWake: true, lane: spec.lane.id, checkpoint: cp, createdAt: new Date().toISOString() }) + '\n');
    },
  };
  const launch = {
    verb: 'Open', what: `a Terminal window running Claude Code (${spec.lane.model})`, detail: 'a fresh session: their first wake',
    run() {
      if (noActivate) return;
      // Quoted for paths with spaces (opus's read, 6d); platform.mjs owns
      // each platform's escaping of the raw command.
      const cfgPathForWake = spec.op === 'init' ? join(hub, 'nightwatch.config.json') : (process.env.WEFT_CONFIG ?? '');
      const sh = `WEFT_CONFIG="${cfgPathForWake}" sh "${join(WC, 'wake.sh')}" ${spec.lane.id}`;
      for (const { bin, args } of summonWindowArgv({ title: spec.lane.id, shellCommand: sh, activate: false })) {
        spawn(bin, args, { detached: true, stdio: 'ignore' }).unref();
      }
    },
  };
  return { prep, launch };
}


function launchLegTest(hub) {
  // The TCC trap: the nightshift can only open Terminal windows once its
  // process has Automation permission. Trigger the daemon's own test leg and
  // wait for its receipt, so Set up never reports done on an unproven wake.
  writeFileSync(join(hub, 'wakecycle', 'test-wake.trigger'), '');
  const log = join(hub, 'nightshift.log');
  const t0 = Date.now();
  while (Date.now() - t0 < 90_000) {
    if (existsSync(log) && readFileSync(log, 'utf8').includes('launch-leg test: Terminal launch SUCCEEDED')) return;
    execFileSync('sleep', ['2']);
  }
  throw new Error('the Terminal launch test did not pass within 90s — check the Automation permission prompt and run Set up again');
}

// ------------------------------------------------------------- inspect
function inspectImport(dir, internal = false) {
  const d = expand(dir);
  if (!existsSync(d) || !statSync(d).isDirectory()) {
    if (internal) die(`The import folder could not be read (${dir}).`);
    die(`That folder could not be read (${dir}).`);
  }
  const identity = existsSync(join(d, 'identity.md'));
  const about = identity ? readFileSync(join(d, 'identity.md'), 'utf8').trim() : null;
  const name = existsSync(join(d, 'name.txt')) ? readFileSync(join(d, 'name.txt'), 'utf8').trim() || null : null;
  const memory = existsSync(join(d, 'memory')) ? readdirSync(join(d, 'memory')).filter((f) => !f.startsWith('.')).length : 0;
  const rungs = existsSync(join(d, 'ladder')) ? readdirSync(join(d, 'ladder')).filter((f) => f.endsWith('.md')).length : 0;
  const result = { identity, about, name, memory, rungs };
  if (internal) { if (!identity) die('The import folder has no identity.md, which is the one required file.'); return result; }
  return result;
}

// --------------------------------------------------------- list-unclaimed
/** Claude Code's own per-session files (~/.claude/sessions/<pid>.json): the
 *  authoritative live list. Sparse files (no sessionId/pid) are skipped; a
 *  leftover file for a dead pid is skipped by the liveness check. */
function readClaudeSessions() {
  const dir = join(HOME, '.claude', 'sessions');
  const rows = [];
  if (!existsSync(dir)) return rows;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!d.sessionId || !d.pid) continue;
      try { process.kill(d.pid, 0); } catch { continue; }
      rows.push({ sessionId: d.sessionId, pid: d.pid, cwd: d.cwd ?? null, kind: d.kind ?? null });
    } catch { /* unreadable session file: nothing to offer */ }
  }
  return rows;
}

/** A session's model, from the newest model-bearing line of its transcript. */
function modelOf(sid) {
  const projects = join(HOME, '.claude', 'projects');
  if (!existsSync(projects)) return null;
  for (const proj of readdirSync(projects)) {
    const p = join(projects, proj, sid + '.jsonl');
    if (!existsSync(p)) continue;
    try {
      const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && i > lines.length - 40; i--) {
        try { const r = JSON.parse(lines[i]); const m = r.message?.model ?? r.model; if (typeof m === 'string' && m.startsWith('claude')) return m; } catch { /* partial line */ }
      }
    } catch { return null; }
  }
  return null;
}

function listUnclaimed() {
  // Primary: the session files above (they list the idle-for-an-hour open
  // window a person actually wants to adopt). Fallback for older Claude
  // Code versions: a transcript touched in the last 10 minutes. Unclaimed =
  // neither registered to a lane nor the resumed tail of one.
  const claimed = new Set();
  for (const f of readdirSync(WC)) {
    if (f.startsWith('lane.')) claimed.add(f.slice(5));
    if (f.startsWith('next-wake.')) {
      try { const nw = JSON.parse(readFileSync(join(WC, f), 'utf8')); if (nw.sessionId) claimed.add(nw.sessionId); } catch { /* unreadable receipt: nothing to claim */ }
    }
  }
  const outRows = [];
  const seen = new Set();
  for (const live of readClaudeSessions()) {
    if (claimed.has(live.sessionId)) continue;
    seen.add(live.sessionId);
    outRows.push({ sessionId: live.sessionId, cwd: live.cwd, model: modelOf(live.sessionId) });
  }
  const projects = join(HOME, '.claude', 'projects');
  if (!existsSync(projects)) return outRows;
  for (const proj of readdirSync(projects)) {
    const pd = join(projects, proj);
    let files;
    try { files = readdirSync(pd).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const sid = f.slice(0, -6);
      if (claimed.has(sid) || seen.has(sid)) continue;
      const p = join(pd, f);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (Date.now() - st.mtimeMs > 10 * 60_000) continue;
      let cwd = null; let model = null;
      try {
        const txt = readFileSync(p, 'utf8');
        const lines = txt.split('\n').filter(Boolean);
        for (const line of lines.slice(0, 5)) { try { const r = JSON.parse(line); if (r.cwd) { cwd = r.cwd; break; } } catch { /* partial line */ } }
        for (let i = lines.length - 1; i >= 0 && i > lines.length - 40; i--) {
          try { const r = JSON.parse(lines[i]); const m = r.message?.model ?? r.model; if (typeof m === 'string' && m.startsWith('claude')) { model = m; break; } } catch { /* partial line */ }
        }
      } catch { continue; }
      outRows.push({ sessionId: sid, cwd, model });
    }
  }
  return outRows;
}

// ----------------------------------------------------------------- main
const [cmd, arg] = process.argv.slice(2);
try {
  if (cmd === 'plan' || cmd === 'apply') {
    if (!arg) die(`${cmd} needs a spec file.`);
    const spec = loadSpec(arg);
    const { steps, hub, ctx } = spec.op === 'init' ? initSteps(spec) : laneAddSteps(spec);
    if (cmd === 'plan') {
      out({ steps: steps.map(({ verb, what, detail }) => ({ verb, what, detail })) });
    } else {
      for (const step of steps) {
        try { step.run(); }
        catch (e) {
          if (spec.op === 'init') rmSync(expand(spec.hub) + '.partial', { recursive: true, force: true });
          die(`The "${step.verb} ${step.what}" step failed: ${e.message}`);
        }
      }
      const who = ctx.name ?? (spec.op === 'init' ? 'the new persona' : `the ${spec.lane.id} lane`);
      const opened = process.env.WEFT_NW_NO_ACTIVATE ? 'prepared their first session (activation off)' : 'opened their first session';
      out(spec.op === 'init' ? `Created ${who}'s hub at ${hub} and ${opened}.` : `Added the ${spec.lane.id} lane and ${process.env.WEFT_NW_NO_ACTIVATE ? 'prepared' : 'opened'} its first session.`);
    }
  } else if (cmd === 'inspect-import') {
    if (!arg) die('inspect-import needs a folder.');
    out(inspectImport(arg));
  } else if (cmd === 'list-unclaimed') {
    out(listUnclaimed());
  } else {
    die('Usage: nightwatch.mjs plan|apply <spec.json> | inspect-import <folder> | list-unclaimed');
  }
} catch (e) {
  die(e?.message ?? String(e));
}
