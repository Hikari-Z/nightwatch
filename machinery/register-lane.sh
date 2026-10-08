#!/bin/bash
# SessionStart hook: record which LANE this session belongs to, so the
# nightshift daemon can attribute sessions by registry instead of guessing
# from cwd history. wake.sh exports WEFT_LANE; a manually-opened panel has
# no WEFT_LANE, writes nothing, and the daemon falls back to its heuristic.
# Runs inside the new session because only here does the session id exist —
# wake.sh cannot know it (--fork-session mints it at launch).
# Prints nothing: SessionStart stdout lands in the session's context.
set -u
# Registry dir from the one config (item E); fall back to the script's own
# directory, which is where the registry has always lived — a hook that
# fails to resolve config must still register the lane, not exit silently.
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
REG="$(node "$SELF_DIR/config.mjs" get paths.wakecycle 2>/dev/null || echo "$SELF_DIR")"
# Prune stale entries so the registry never grows unboundedly.
find "$REG" -maxdepth 1 -name 'lane.*' -mtime +7 -delete 2>/dev/null
[ -z "${WEFT_LANE:-}" ] && exit 0
SESSION_ID=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
[ -z "$SESSION_ID" ] && exit 0
# $PPID is the shell's parent: the claude process that spawned this hook.
printf '{"lane":"%s","pid":%d,"at":"%s"}\n' "$WEFT_LANE" "$PPID" \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$REG/lane.$SESSION_ID"
exit 0
