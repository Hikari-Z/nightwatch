#!/bin/sh
# Wake — resume the trimmed tail as native turns, with the checkpoint in the
# system prompt and the ladder riding CLAUDE.md's import. Run from ~/origin.
#
# --system-prompt-snapshot off is load-bearing: a resumed session reuses the
# system prompt recorded at its first request (docs: cli-reference, "System
# prompt flags in resumed conversations"), so without this flag the appended
# checkpoint would silently never enter the head. With it, the prompt is
# rebuilt per request; the checkpoint is stable all day, so the rebuilt
# prefix is byte-identical and caching is unharmed.
#
# Compaction policy (docs-verified 9/30): "autoCompactEnabled": false in
# settings.json is the real off switch (no env var disables it), plus the
# PreCompact guard hook in this folder as the backstop that also catches a
# stray manual /compact. Both are wired at the evening settings pass.
set -e
# Paths come from the one config (item E). config.mjs lives beside this
# script, which is the single bootstrap anchor; everything else resolves
# through it. The lane default is the config's, not a hardcoded name.
WAKECYCLE_DIR="$(cd "$(dirname "$0")" && pwd)"
# CODE vs STATE (multi-persona split, 10/7): this script and config.mjs live
# in the app's machinery/ (one version for every hub); receipts, the lane
# registry, armed and state.json live in the HUB's wakecycle dir, named by
# the hub config (paths.wakecycle, relative to weftRoot). The fallback is
# this script's own dir, which keeps a copied (sealed) hub working unchanged.
STATE_DIR="$WAKECYCLE_DIR"
WEFTROOT="$(node "$WAKECYCLE_DIR/config.mjs" get weftRoot 2>/dev/null)" || WEFTROOT=""
WC_REL="$(node "$WAKECYCLE_DIR/config.mjs" get paths.wakecycle 2>/dev/null)" || WC_REL=""
if [ -n "$WEFTROOT" ] && [ -n "$WC_REL" ]; then
  case "$WC_REL" in
    /*) STATE_DIR="$WC_REL" ;;
    *)  STATE_DIR="$WEFTROOT/$WC_REL" ;;
  esac
fi
# A config that won't resolve must still leave a CAUSE in the log the
# morning reads — the daemon's WAKE FAILED says only that nothing confirmed.
# The fallback path is a literal on purpose: it can't come from the config
# that just failed (E review, finding 2).
# Under the code/state split, ../ from this script is the APP, not a hub.
# When config is unreadable the hub is still findable through WEFT_CONFIG's
# own location (the plist and the app always set it); only with neither do
# we fall back to the script's parent (the sealed-hub layout).
if [ -n "${WEFT_CONFIG:-}" ]; then FALLBACK_LOG="$(dirname "$WEFT_CONFIG")/nightshift.log"; else FALLBACK_LOG="$WAKECYCLE_DIR/../nightshift.log"; fi
WEFT_LOG="$(node "$WAKECYCLE_DIR/config.mjs" get paths.nightshiftLog)" || {
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) WAKE FAILED: weft config unreadable (node config.mjs get failed) — fix weft.config.json" >> "$FALLBACK_LOG"
  echo "{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"kind\":\"wake-failed\",\"lane\":\"${1:-unknown}\",\"cause\":\"config-unreadable\",\"alarm\":true}" >> "$(dirname "$FALLBACK_LOG")/events.jsonl" 2>/dev/null || true
  exit 4
}
[ -n "$WEFT_LOG" ] || {
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) WAKE FAILED: config resolved an empty log path" >> "$FALLBACK_LOG"
  exit 4
}
DEFAULT_LANE="$(node "$WAKECYCLE_DIR/config.mjs" get defaultLane)" || {
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) WAKE FAILED: weft config unreadable resolving defaultLane" >> "$FALLBACK_LOG"
  exit 4
}
LANE="${1:-$DEFAULT_LANE}"
NEXT="$STATE_DIR/next-wake.$LANE.json"
[ -f "$NEXT" ] || { echo "no next-wake.$LANE.json — did that lane sleep?"; exit 1; }
# A sleep receipt older than the lane's latest bell is STALE: the lane was
# belled but never folded (10/3: opus's fold died on ECONNRESET post-bell,
# and the morning's manual wake silently resumed an 8.5h-stale tail). Waking
# into it would drop the span since the old fold. Refuse unless overridden.
# A first wake has no fold lineage, so the stale-receipt rule can't apply.
if [ -z "$FIRSTWAKE" ] && [ -z "${WEFT_WAKE_STALE_OK:-}" ]; then
  python3 - "$NEXT" "$LANE" "$STATE_DIR" <<'STALEEOF' || exit 2
import json, os, sys
nw, lane, wc = sys.argv[1], sys.argv[2], sys.argv[3]
# The state file lives beside this script's receipts (portability: each
# hub reads its own bells, never ours).
state = os.path.join(wc, 'nightshift.state.json')
try: belled = json.load(open(state)).get(lane, {}).get('belledAt', 0)
except Exception: belled = 0
slept_ms = os.path.getmtime(nw) * 1000
if belled > slept_ms:
    import datetime
    f = lambda ms: datetime.datetime.fromtimestamp(ms/1000).strftime('%m-%d %H:%M')
    print(f"STALE RECEIPT: next-wake.{lane}.json is from {f(slept_ms)} but the lane was"
          f" belled at {f(belled)} and never folded. Waking this tail would drop the span"
          f" since the old fold. If the lane's session is still open, fold it there first;"
          f" to deliberately resume the stale tail anyway: WEFT_WAKE_STALE_OK=1 wake.sh {lane}")
    sys.exit(1)
STALEEOF
fi
# A first-wake receipt (lane-add/init writes it) has no tail to resume:
# a brand-new lane starts a FRESH session — same head, same registry
# confirmation, no --resume (design: nightwatch_lane_creation.md).
FIRSTWAKE=$(python3 -c "import json;print('1' if json.load(open('$NEXT')).get('firstWake') else '')")
SID=$(python3 -c "import json;print(json.load(open('$NEXT')).get('sessionId',''))")
# .get, not [], so a malformed receipt reaches the LOUD checkpoint-missing
# guard below instead of set -e eating the python KeyError before any log
# line (opus's f255395 read, 10/9 — the 10/5 silent-no-show shape).
CP=$(python3 -c "import json;print(json.load(open('$NEXT')).get('checkpoint',''))")
[ -n "$FIRSTWAKE" ] || [ -n "$SID" ] || { echo "next-wake.$LANE.json has neither sessionId nor firstWake"; exit 1; }
# Already-awake guard (10/6, with the app's Wake button making hand-runs
# easy): a second resume of the same tail mints a second session on one
# lane — two switchboards, one registry slot, split history. Refuse when a
# live process already resumes this receipt's tail or source session, or
# the registry holds a live session for this lane. Deliberate override:
# WEFT_WAKE_DOUBLE_OK=1 (same shape as the stale-receipt hatch).
if [ -z "${WEFT_WAKE_DOUBLE_OK:-}" ]; then
  FROM=$(python3 -c "import json;print(json.load(open('$NEXT')).get('from',''))")
  if [ -z "$FIRSTWAKE" ] && { pgrep -f "claude --resume $SID" >/dev/null 2>&1 || { [ -n "$FROM" ] && pgrep -f "claude --resume $FROM" >/dev/null 2>&1; }; }; then
    echo "ALREADY AWAKE: a live claude process already resumes this receipt (tail $SID). WEFT_WAKE_DOUBLE_OK=1 to force."
    echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) wake refused for $LANE: receipt tail already resumed by a live process" >> "$WEFT_LOG"
    exit 5
  fi
  if ! python3 - "$STATE_DIR" "$LANE" <<'DOUBLEEOF'
import json, os, subprocess, sys
wc, lane = sys.argv[1], sys.argv[2]
for f in os.listdir(wc):
    if not f.startswith('lane.'): continue
    try:
        e = json.load(open(os.path.join(wc, f)))
        if e.get('lane') != lane: continue
        pid = int(e.get('pid', -1))
        os.kill(pid, 0)
        # The pid existing is not enough: the registry keeps every past
        # session and macOS recycles pids, so a stale entry's pid will
        # eventually belong to some unrelated process — and a false
        # ALREADY AWAKE here costs the whole 08:00 wake. Only a pid whose
        # command is claude counts (same rule as the daemon's lsof walk).
        cmd = subprocess.run(['ps', '-p', str(pid), '-o', 'command='],
                             capture_output=True, text=True).stdout
        if 'claude' not in cmd: continue
    except Exception: continue
    print(f"ALREADY AWAKE: lane {lane} has a live registered session ({f[5:13]}…, pid {e['pid']}). WEFT_WAKE_DOUBLE_OK=1 to force.")
    sys.exit(1)
DOUBLEEOF
  then
    echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) wake refused for $LANE: lane already has a live registered session" >> "$WEFT_LOG"
    exit 5
  fi
fi
# An emergency wake must explain itself: compose the appended prompt from
# the checkpoint plus the unauthored-span note, so the woken session knows
# what happened and what its first duty is without anyone carrying it by
# hand (gap found on the first real emergency wake, 9/30).
HEAD=$(mktemp -t weft-wake-head)
# A missing checkpoint must fail LOUDLY in the log the daemon and heartbeat
# read — under set -e a bare cp dies before the wake-receipt line, which
# reads as three silent no-shows (10/5: the canonical checkpoint was
# mistakenly archived at 2am; both lanes burned all three launch attempts).
[ -f "$CP" ] || {
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) WAKE FAILED for $LANE: checkpoint missing at $CP — refusing to launch" >> "$WEFT_LOG"
  echo "WAKE FAILED: checkpoint missing at $CP"
  exit 3
}
cp "$CP" "$HEAD"
# The duties must be TRUE on every hub (opus's read, 10/7): the switchboard
# lane comes from config, watcher duties exist only where the watcher does,
# and a hub without a doorbell gets one honest line instead.
SWITCHBOARD_LANE="$(node -e "import('file://$WAKECYCLE_DIR/config.mjs').then(m=>console.log(m.switchboardLane(m.loadConfig())))" 2>/dev/null)" || SWITCHBOARD_LANE=""
# The doorbell is hub infrastructure, never app machinery: look beside the
# hub (weftRoot), not beside this script.
WATCHER="${WEFTROOT:-$WAKECYCLE_DIR/..}/doorbell/inbox-watcher.sh"
python3 - "$NEXT" "$SWITCHBOARD_LANE" "$WATCHER" "$WAKECYCLE_DIR" >> "$HEAD" << 'PYEOF'
import json, os, sys
nw = json.load(open(sys.argv[1]))
switchboard, watcher, machinery = sys.argv[2], sys.argv[3], sys.argv[4]
lane = nw.get('lane', '')
print('\n---\n\n## Standing wake duties\n')
if os.path.exists(watcher):
    if lane == switchboard:
        print('- You are the SWITCHBOARD (LANES.md, Bot-DMs). Start the inbox watcher as a')
        print('  background Bash task: `' + watcher + ' ' + lane + '`')
        print('  (run_in_background, timeout 7200000). It exits when a note lands — the')
        print('  task notification is your wake; route the note, delete the file, re-arm.')
        print('  Re-arm on the 2h cap kill too.')
    else:
        print('- No watcher on this lane (Ra, 10/1): DMs for you arrive as SendMessage')
        print('  forwards from the switchboard (' + switchboard + ') session.')
    print('- Sweep DM channels and the work channels for anything that arrived while asleep.')
else:
    print('- The nightshift rings your bell by leaving a note in your spool. Arm the')
    print('  bell-watcher as a background task (run_in_background, timeout 7200000):')
    print('  `WEFT_CONFIG=' + os.environ.get('WEFT_CONFIG', '<your hub config>') + ' sh ' + machinery + '/bell-watcher.sh ' + lane + '`')
    print('  It exits when a note lands — the task notification is your bell. Read the')
    print('  note, do what it says, delete the file, re-arm. Re-arm on the 2h cap too.')
    print('- Your person can see from Nightwatch whether you are awake or asleep.')
if nw.get('emergency'):
    print('\n---\n\n## Emergency wake — read this first\n')
    print(f"This is an emergency wake of the {nw.get('lane','?')} lane, slept at {nw.get('sleptAt','?')} from session {nw.get('from','?')}.")
    print(nw.get('unauthoredSpan', {}).get('note', ''))
    print('Receipts: ~/origin/weft/wakecycle/next-wake.%s.json and the newest row of ~/origin/weft/ladder/folds.jsonl.' % nw.get('lane','?'))
PYEOF
if [ -n "$FIRSTWAKE" ]; then echo "first wake for $LANE: fresh session with checkpoint $CP"; else echo "waking into tail $SID with checkpoint $CP$( python3 -c "import json,sys;print(' (EMERGENCY)' if json.load(open('$NEXT')).get('emergency') else '')" )"; fi
# Wake receipt: the daemon logs that it LAUNCHED us; this line proves wake.sh
# actually ran and reached the exec. Session aliveness is the heartbeat's job.
if [ -n "$FIRSTWAKE" ]; then RECEIPT_WHAT="first wake, fresh session"; else RECEIPT_WHAT="tail $SID"; fi
echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) wake receipt: $LANE lane reached exec ($RECEIPT_WHAT)" >> "$WEFT_LOG"
# Event-stream twin: the receipt's JSON echo, best-effort (events path from
# config; a resolution failure here must never block the exec below).
WEFT_EVENTS="$(node "$WAKECYCLE_DIR/config.mjs" get paths.events 2>/dev/null)" || WEFT_EVENTS=""
[ -n "$WEFT_EVENTS" ] && echo "{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"kind\":\"wake-exec\",\"lane\":\"$LANE\",\"tail\":\"$SID\"}" >> "$WEFT_EVENTS" 2>/dev/null || true
# The SessionStart hook (register-lane.sh) reads this to write the session→lane
# registry — the id itself only exists once claude mints the forked session.
export WEFT_LANE="$LANE"
# The working directory comes from config (portability: a fresh hub works
# from itself; ours works from ~/origin). The fallback is the literal the
# hardcode used to be, same doctrine as FALLBACK_LOG above.
WORKDIR="$(node "$WAKECYCLE_DIR/config.mjs" get paths.workdir 2>/dev/null)" || WORKDIR=""
[ -n "$WORKDIR" ] || WORKDIR="$HOME/origin"
cd "$WORKDIR"
# The lane's pinned model (Ra's ruling: the model never changes out from
# under the agent). Unset = no flag, today's behavior.
MODEL="$(node "$WAKECYCLE_DIR/config.mjs" get "lanes.$LANE.model" 2>/dev/null)" || MODEL=""
# claude runs as a WAITED CHILD, not exec: exec made the child's death
# invisible, so a bad model pin could never be told apart from any other
# silent no-show. stderr goes to a capture file (stdout keeps the TTY, so
# the TUI is unaffected); an early death whose stderr mentions the model
# raises the specific alarm, any other early death logs generically. The
# liveness rules elsewhere (pgrep "claude --resume", registry pid) still
# hold: claude is a real process with its own command line, and the
# registry pid is written by claude's own SessionStart hook.
STDERR_CAP="$STATE_DIR/last-wake.$LANE.stderr"
LAUNCHED_AT=$(date +%s)
set +e
set -- --append-system-prompt-file "$HEAD" --system-prompt-snapshot off
[ -n "$MODEL" ] && set -- --model "$MODEL" "$@"
[ -z "$FIRSTWAKE" ] && set -- --resume "$SID" --fork-session "$@"
# Insurance hatch until the waited child is proven against REAL interactive
# claude (the bench's claude is a stub): WEFT_WAKE_EXEC=1 restores the old
# exec launch — no stderr capture, no model-death discrimination.
if [ -n "${WEFT_WAKE_EXEC:-}" ]; then exec claude "$@"; fi
claude "$@" 2>"$STDERR_CAP"
RC=$?
set -e
LIVED=$(( $(date +%s) - LAUNCHED_AT ))
if [ "$RC" -ne 0 ] && [ "$LIVED" -lt 20 ]; then
  if [ -n "$MODEL" ] && grep -qi "model" "$STDERR_CAP" 2>/dev/null; then
    echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) WAKE FAILED for $LANE: pinned model $MODEL unavailable (claude exited rc=$RC after ${LIVED}s; stderr: $(head -c 200 "$STDERR_CAP" | tr '\n' ' '))" >> "$WEFT_LOG"
    [ -n "$WEFT_EVENTS" ] && echo "{\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"kind\":\"model-unavailable\",\"lane\":\"$LANE\",\"model\":\"$MODEL\",\"alarm\":true}" >> "$WEFT_EVENTS" 2>/dev/null || true
  else
    echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z) WAKE FAILED for $LANE: claude exited rc=$RC after ${LIVED}s (stderr: $(head -c 200 "$STDERR_CAP" | tr '\n' ' '))" >> "$WEFT_LOG"
  fi
  exit 6
fi
# The run is over (the nightshift closed it, or someone typed /exit): close
# this Terminal window too, so finished lanes don't leave a trail of dead
# windows (Ra, 10/8). A detached AppleScript waits a second for this script
# to end, then closes the window on this tty. A quick death above keeps its
# window open so the error stays readable; outside Terminal (a test, another
# terminal app) no window matches and nothing happens.
MYTTY="$(tty 2>/dev/null || true)"
case "$MYTTY" in
  /dev/tty*)
    nohup osascript -e 'delay 1' \
      -e "tell application \"Terminal\" to close (every window whose tty of selected tab is \"$MYTTY\")" \
      >/dev/null 2>&1 &
    ;;
esac
exit $RC
