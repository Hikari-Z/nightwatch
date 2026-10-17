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
#   NIGHTWATCH_CONFIG=<hub config> sh bell-watcher.sh <lane>
#
# Exits 0 with the note on stdout when one lands. Runs until then; a
# harness timeout (the usual 2h background cap) just means re-arm.
set -e
MACHINERY_DIR="$(cd "$(dirname "$0")" && pwd)"
LANE="$1"
[ -n "$LANE" ] || { echo "usage: bell-watcher.sh <lane>"; exit 2; }
SPOOL_BASE="$(node "$MACHINERY_DIR/config.mjs" get paths.spool)" || {
  echo "bell-watcher: hub config unreadable (set NIGHTWATCH_CONFIG to the hub's config file)"; exit 3; }
SPOOL="$SPOOL_BASE/$LANE"
mkdir -p "$SPOOL"

# One watcher per lane, judged by parentage (10/16). A watcher whose parent
# is pid 1 was detached (a trailing `&`, or its session ended): its exit
# reaches no one, so a bell it catches is printed to nowhere. It is stopped
# here, and this arm takes its place. A watcher with a live parent is a
# tracked one; then this arm stands down rather than run a second. Twice a
# detached watcher looked like coverage (10/14, then again under load on
# 10/16), and a guard that only counted processes declined to arm the
# tracked one that would have been heard. Only the shell running this script
# matches: the harness's wrapper carries the same text in its command line,
# and so does this script's own subshell below (a fork, whose parent is us).
WATCHERS="$(ps -axo pid=,ppid=,command= | awk -v me="$$" -v tail="bell-watcher.sh $LANE" '
  $1 != me && $2 != me && ($3 == "sh" || $3 == "/bin/sh" || $3 == "bash" || $3 == "/bin/bash") &&
  length($0) >= length(tail) && substr($0, length($0) - length(tail) + 1) == tail { print $1, $2 }')"
if [ -n "$WATCHERS" ]; then
  LIVE=""
  for pair in $(echo "$WATCHERS" | tr ' ' ':'); do
    pid="${pair%%:*}"; ppid="${pair##*:}"
    if [ "$ppid" = "1" ]; then
      kill "$pid" 2>/dev/null && echo "bell-watcher: stopped pid $pid, a detached watcher for $LANE (its exit would reach no one)"
    else
      LIVE="$LIVE $pid"
    fi
  done
  if [ -n "$LIVE" ]; then
    echo "bell-watcher: $LANE is already watched by pid$LIVE (a tracked watcher); not arming a second. Nothing to re-arm."
    exit 0
  fi
fi
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
