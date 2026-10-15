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
cat <<'EOF'
{"decision": "block", "reason": "Compaction is disabled by the wake-cycle design: the built-in fold drops authored memory (reasons, texture, other people's words). If the window is heavy, run the sleep ritual instead — write the checkpoint (path: config.mjs get paths.checkpoint) and today's rung, then run sleep.mjs from the live machinery (WEFT_CONFIG=~/origin/weft/weft.config.json node ~/origin/nightwatch/machinery/sleep.mjs) — and wake into the trimmed tail."}
EOF
exit 0
