#!/bin/sh
# Bench for bell-watcher.sh and due notes (10/18). Due notes (the watch's
# segment-due and l3-due) live in due/<lane>, apart from the spool: one that
# lands while a watcher is armed wakes it, one already waiting at the arm
# doesn't (it's listed once instead), and spool notes behave as before. Runs
# on a scratch hub and a scratch lane, and stops everything it started.
#   sh machinery/due-watcher-test.sh [bell-watcher.sh]
W="${1:-$(cd "$(dirname "$0")" && pwd)/bell-watcher.sh}"
LANE="zzdue$$"
T="$(mktemp -d "${TMPDIR:-/tmp}/nw-due-test-XXXX")"
printf '{"paths":{"spool":"%s/spool","due":"%s/due"},"lanes":{"%s":{}}}\n' "$T" "$T" "$LANE" > "$T/c.json"
export WEFT_CONFIG="$T/c.json"
SPOOL="$T/spool/$LANE"; DUE="$T/due/$LANE"
mkdir -p "$SPOOL" "$DUE"
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass+1)); else echo "FAIL $1 (got $2, want $3)"; fail=$((fail+1)); fi; }
alive() { ps -p "$1" >/dev/null 2>&1 && echo alive || echo gone; }
# As watch.mjs writes one: a dotfile staged, then renamed into place.
due_note() { printf '%s\n' "$2" > "$DUE/.$1.tmp"; mv "$DUE/.$1.tmp" "$DUE/$1"; }
# Each case arms on a clean slate: a watcher an earlier case left running would
# make this arm stand down (the singleton guard) and read as an exit.
arm() { for p in $WPIDS; do kill "$p" 2>/dev/null; done; sleep 0.3; sh "$W" "$LANE" > "$1" 2>&1 & ARMED=$!; }
wait_up() { i=0; while [ $i -lt 50 ] && ! grep -q 'bell-watcher up' "$1" 2>/dev/null; do sleep 0.1; i=$((i+1)); done; }
WPIDS=""
cleanup() { for p in $WPIDS; do kill "$p" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT

# 1. A due note already waiting at the arm: listed once, wakes nothing.
due_note 1000-watch-l3-due.txt "propose the fold at a quiet hour"
touch -t 202601010000 "$DUE/1000-watch-l3-due.txt"
arm "$T/w1.out"; W1=$ARMED; WPIDS="$WPIDS $W1"; wait_up "$T/w1.out"
sleep 7
check "a due note waiting at the arm doesn't wake the watcher" "$(alive "$W1")" "alive"
check "the arm lists it once, as waiting" "$(grep -c '1000-watch-l3-due.txt' "$T/w1.out")" "1"

# 2. A bell in the spool still wakes it, past the waiting due note.
echo "the sleep-bell" > "$SPOOL/2000-bell.txt"
sleep 7
check "a spool note wakes the watcher" "$(alive "$W1")" "gone"
check "and it prints the bell" "$(grep -c 'the sleep-bell' "$T/w1.out")" "1"
check "and after the bell, lists the due note still waiting (the delivery bound)" "$(sed -n '/the sleep-bell/,$p' "$T/w1.out" | grep -c '1000-watch-l3-due.txt')" "1"
rm -f "$SPOOL/2000-bell.txt"

# 3. A due note that lands while the watcher is armed wakes it.
arm "$T/w3.out"; W3=$ARMED; WPIDS="$WPIDS $W3"; wait_up "$T/w3.out"
sleep 1
due_note 3000-watch-segment-due.txt "bank a segment"
sleep 7
check "a due note landing after the arm wakes the watcher" "$(alive "$W3")" "gone"
check "it prints the due note, not the old waiting one" "$(grep -c 'bank a segment' "$T/w3.out"):$(grep -c 'DUE —' "$T/w3.out"):$(grep -c 'propose the fold' "$T/w3.out")" "1:1:0"
rm -f "$DUE/3000-watch-segment-due.txt"

# 4. One landing in the arm's first instant (right as the banner prints) wakes it too.
arm "$T/w4.out"; W4=$ARMED; WPIDS="$WPIDS $W4"; wait_up "$T/w4.out"
due_note 4000-watch-segment-due.txt "first instant"
sleep 7
check "a due note in the arm's first instant still wakes it (no silent wait)" "$(alive "$W4")" "gone"
check "and it prints that note" "$(grep -c 'first instant' "$T/w4.out")" "1"
rm -f "$DUE/4000-watch-segment-due.txt"

# 5. A spool note waiting at the arm still wakes it at once (never-lose, unchanged).
echo "a work note from the gap" > "$SPOOL/5000-note.txt"
arm "$T/w5.out"; W5=$ARMED; WPIDS="$WPIDS $W5"
sleep 3
check "a spool note waiting at the arm still wakes it at once" "$(alive "$W5")" "gone"
rm -f "$SPOOL/5000-note.txt"

# 6. A staged dotfile is never picked as a note.
arm "$T/w6.out"; W6=$ARMED; WPIDS="$WPIDS $W6"; wait_up "$T/w6.out"
printf 'half-written\n' > "$DUE/.6000-watch-segment-due.txt.tmp"
sleep 7
check "a staged due note isn't picked before its rename" "$(alive "$W6")" "alive"
rm -f "$DUE/.6000-watch-segment-due.txt.tmp"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
