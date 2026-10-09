#!/bin/bash
# SessionStart hook: record which LANE this session belongs to, so the
# nightshift daemon can attribute sessions by registry instead of guessing
# from cwd history. wake.sh exports WEFT_LANE; a manually-opened panel has
# no WEFT_LANE, writes nothing, and the daemon falls back to its heuristic.
# Runs inside the new session because only here does the session id exist —
# wake.sh cannot know it (--fork-session mints it at launch).
# SessionStart stdout lands in the session's context, so this prints only
# one thing, on purpose: the lane's instruction to arm its OWN bell watcher
# (Ra's ruling, 10/8: no lane's Nightwatch bell may depend on another agent
# being up). Skipped for the switchboard lane, whose doorbell watcher
# already watches the same spool (it would otherwise fire on DM notes too).
set -u
# Registry dir from the one config (item E); fall back to the script's own
# directory, which is where the registry has always lived — a hook that
# fails to resolve config must still register the lane, not exit silently.
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
# The registry entry goes in the HUB's state dir. WEFT_CONFIG names the hub;
# without it we use this script's own folder (the sealed layout) and NEVER
# config.mjs's fallback chain — that chain can resolve to a DIFFERENT hub's
# config on this machine, and a session must never register into another
# hub's registry (rehearsal finding, 10/7).
if [ -n "${WEFT_CONFIG:-}" ]; then
  REG="$(node "$SELF_DIR/config.mjs" get paths.wakecycle 2>/dev/null || echo "$SELF_DIR")"
else
  REG="$SELF_DIR"
fi
# Prune stale entries so the registry never grows unboundedly.
find "$REG" -maxdepth 1 -name 'lane.*' -mtime +7 -delete 2>/dev/null
[ -z "${WEFT_LANE:-}" ] && exit 0
SESSION_ID=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0
# $PPID is the shell's parent: the claude process that spawned this hook.
printf '{"lane":"%s","pid":%d,"at":"%s"}\n' "$WEFT_LANE" "$PPID" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$REG/lane.$SESSION_ID"
SWITCH="$(node "$SELF_DIR/config.mjs" get "lanes.$WEFT_LANE.switchboard" 2>/dev/null || echo false)"
if [ "$SWITCH" != "true" ]; then
  CFGPFX=""
  [ -n "${WEFT_CONFIG:-}" ] && CFGPFX="WEFT_CONFIG=$WEFT_CONFIG "
  echo "Nightwatch: this session is the $WEFT_LANE lane. Arm your bell watcher now, as a background task: ${CFGPFX}sh $SELF_DIR/bell-watcher.sh $WEFT_LANE — its exit is your sleep-bell (or a Fold now). When it fires: read the note, do what it says, delete the note file, and re-arm the watcher if you're staying up."
fi
exit 0
