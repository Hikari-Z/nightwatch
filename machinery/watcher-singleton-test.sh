#!/bin/sh
# Bench for bell-watcher.sh's singleton guard (10/16). A watcher whose parent
# is pid 1 (detached) must be stopped by the next arm, which takes its place;
# a second arm beside a tracked watcher must stand down. Runs on a scratch hub
# config and a scratch lane, and stops everything it started.
#   sh machinery/watcher-singleton-test.sh [bell-watcher.sh]
W="${1:-$(cd "$(dirname "$0")" && pwd)/bell-watcher.sh}"
LANE="zzbench$$"
T="$(mktemp -d "${TMPDIR:-/tmp}/nw-watcher-test-XXXX")"
printf '{"paths":{"spool":"%s/spool"},"lanes":{"%s":{}}}\n' "$T" "$LANE" > "$T/c.json"
export WEFT_CONFIG="$T/c.json"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got $2, want $3)"; fail=$((fail+1)); fi; }
watchers() { ps -axo pid=,ppid=,command= | awk -v t="bell-watcher.sh $LANE" '($3=="sh"||$3=="/bin/sh") && substr($0,length($0)-length(t)+1)==t {print $1, $2}'; }
cleanup() { for p in $(watchers | awk '{print $1}'); do kill "$p" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT

# A detached watcher: double fork, so its parent becomes pid 1.
( sh "$W" "$LANE" > "$T/orphan.out" 2>&1 & )
sleep 2
check "the detached watcher's parent is pid 1" "$(watchers | awk '{print $2}')" "1"
ORPHAN="$(watchers | awk '{print $1}')"

# A tracked arm (a child of this shell) stops it and takes its place.
sh "$W" "$LANE" > "$T/tracked.out" 2>&1 &
TRACKED=$!
sleep 3
check "the detached watcher is stopped" "$(ps -p "$ORPHAN" >/dev/null 2>&1 && echo alive || echo gone)" "gone"
check "the tracked arm is running" "$(ps -p "$TRACKED" >/dev/null 2>&1 && echo alive || echo gone)" "alive"
check "the arm says why it stopped the other" "$(grep -c 'a detached watcher' "$T/tracked.out")" "1"

# A second arm beside the tracked watcher stands down.
out="$(sh "$W" "$LANE" 2>&1)"; code=$?
check "a second arm exits at once" "$code" "0"
check "and says the lane is already watched" "$(printf %s "$out" | grep -c 'already watched')" "1"
check "the tracked watcher is untouched" "$(ps -p "$TRACKED" >/dev/null 2>&1 && echo alive || echo gone)" "alive"
check "one watcher for the lane" "$(watchers | wc -l | tr -d ' ')" "1"

# The tracked watcher still hears a bell.
mkdir -p "$T/spool/$LANE" && echo "the bell" > "$T/spool/$LANE/1-bell.txt"
sleep 6
check "the tracked watcher exits on the bell" "$(ps -p "$TRACKED" >/dev/null 2>&1 && echo alive || echo gone)" "gone"
check "and prints it" "$(grep -c 'the bell' "$T/tracked.out")" "1"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
