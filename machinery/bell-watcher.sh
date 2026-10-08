#!/bin/sh
# bell-watcher — how a persona hears the bell. Generic: no Discord, no
# routing, no assumptions beyond the hub config. The nightshift delivers
# every bell (sleep-bell, fold-now) as a note file in the hub's spool;
# this script waits for the next note for ONE lane and exits when it
# lands, printing it. Run it as a background task from a session: the
# task's completion notification IS the bell. The note itself says what
# to do (the ritual, in order). Deleting the note and re-arming are the
# session's own acts, on purpose — hearing a bell should be witnessed,
# never silently consumed.
#
#   WEFT_CONFIG=<hub config> sh bell-watcher.sh <lane>
#
# Exits 0 with the note on stdout when one lands. Runs until then; a
# harness timeout (the usual 2h background cap) just means re-arm.
set -e
MACHINERY_DIR="$(cd "$(dirname "$0")" && pwd)"
LANE="$1"
[ -n "$LANE" ] || { echo "usage: bell-watcher.sh <lane>"; exit 2; }
SPOOL_BASE="$(node "$MACHINERY_DIR/config.mjs" get paths.spool)" || {
  echo "bell-watcher: hub config unreadable (set WEFT_CONFIG to the hub's config file)"; exit 3; }
SPOOL="$SPOOL_BASE/$LANE"
mkdir -p "$SPOOL"
echo "bell-watcher up: lane=$LANE spool=$SPOOL poll=5s (exits on first note)"
while :; do
  NOTE="$(ls "$SPOOL" 2>/dev/null | head -1)"
  if [ -n "$NOTE" ]; then
    echo "BELL — read the note, run what it says, delete the file, re-arm the watcher:"
    echo "--- $SPOOL/$NOTE"
    cat "$SPOOL/$NOTE"
    exit 0
  fi
  sleep 5
done
