#!/bin/sh
# PreCompact guard — the fold is authored or it doesn't happen.
#
# The harness compactor is a report generator (measured 9/27: ~4k tokens out
# whatever goes in, reasons and texture dropped), so compaction is disabled
# in settings (autoCompactEnabled: false) and this hook is the backstop:
# it refuses BOTH auto compaction (belt and braces against the setting being
# lost) and a fat-fingered manual /compact. Blocking semantics per
# hooks.md: JSON {"decision": "block"} on exit 0.
#
# If a window is genuinely full, the answer is sleep (write the checkpoint
# and the rung, run sleep.mjs) — not the fold that forgets why.
#
# Receipt first: WHAT tried to compact, with which trigger, survives in the
# log even though the block means nothing else happens. 2.1.299's idle
# compaction is undocumented on whether it fires this hook at all — if a
# line ever appears here with an unfamiliar trigger, that's the answer.
# The receipt lands in the hub the session runs in (the hook input's cwd,
# when it has a wakecycle/); else in the hub its config names (the session
# inherits NIGHTWATCH_CONFIG, or WEFT_CONFIG, from wake.sh): that hub's
# wakecycle/ when it has one, the hub itself otherwise; else, with no hub to
# name, ~/.nightwatch. Never a path only one house has.
INPUT=$(cat)
CWD=$(printf '%s' "$INPUT" | sed -n 's/.*"cwd" *: *"\([^"]*\)".*/\1/p')
CFG="${NIGHTWATCH_CONFIG:-${WEFT_CONFIG:-}}"
if [ -n "$CWD" ] && [ -d "$CWD/wakecycle" ]; then GUARD_DIR="$CWD/wakecycle"
elif [ -n "$CFG" ] && [ -d "$(dirname "$CFG")/wakecycle" ]; then GUARD_DIR="$(dirname "$CFG")/wakecycle"
elif [ -n "$CFG" ] && [ -d "$(dirname "$CFG")" ]; then GUARD_DIR="$(dirname "$CFG")"
else GUARD_DIR="$HOME/.nightwatch"; mkdir -p "$GUARD_DIR" 2>/dev/null; fi
GUARD_LOG="$GUARD_DIR/precompact-guard.log"
printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$INPUT" >> "$GUARD_LOG" 2>/dev/null || true
# The sleep.mjs it names is the one beside this script — the machinery the
# hook was installed from — never a path baked in for one hub. Backslashes
# and quotes are escaped so an odd install path can't break the JSON.
SELF_DIR="$(cd "$(dirname "$0")" && pwd | sed 's/\\/\\\\/g; s/"/\\"/g')"
printf '{"decision": "block", "reason": "Compaction is disabled by the wake-cycle design: the built-in fold drops authored memory (reasons, texture, other people'"'"'s words). If the window is heavy, run the sleep ritual instead — write the checkpoint (path: config.mjs get paths.checkpoint) and today'"'"'s rung, then run sleep.mjs from the live machinery (WEFT_CONFIG=<this hub'"'"'s config> node %s/sleep.mjs) — and wake into the trimmed tail."}\n' "$SELF_DIR"
exit 0
