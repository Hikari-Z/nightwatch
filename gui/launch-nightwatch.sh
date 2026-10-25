#!/bin/bash
# Nightwatch phase-A wrapper: ensure the viewer server, then open a
# chromeless app window. A dedicated user-data-dir guarantees a fresh
# Chrome instance, so the --app flag can't be dropped by single-instance
# handoff. Phase B (Tauri, self-contained) replaces this.
# No ?desk=1 (the fixture's fake desktop, for stills only) and no default
# ?skin=: the page remembers the last skin chosen in its View menu, and a
# skin in the URL would override that on every launch. NIGHTWATCH_SKIN still
# forces one when set.
URL="http://127.0.0.1:7352/${NIGHTWATCH_SKIN:+?skin=$NIGHTWATCH_SKIN}"
# This script's own gui/ dir, so the server, log and profile come from the
# tree the script lives in — not a hard-coded path to one machine's old copy.
# One readlink hop first: invoked through a symlink, $0 is the link, and its
# dirname would land outside any tree (marginalia's review note).
SELF="$0"; [ -L "$SELF" ] && SELF="$(readlink "$SELF")"
HERE="$(cd "$(dirname "$SELF")" && pwd -P)"
if ! curl -s -m 2 -o /dev/null "http://127.0.0.1:7352/"; then
  NIGHTWATCH_PORT=7352 nohup "${NIGHTWATCH_NODE:-node}" "$HERE/server.mjs" \
    >> "$HERE/viewer.log" 2>&1 &
  for i in $(seq 1 20); do
    curl -s -m 1 -o /dev/null "http://127.0.0.1:7352/" && break
    sleep 0.5
  done
fi
exec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --app="$URL" --window-size=1100,1000 --user-data-dir="$HERE/.chrome-profile" \
  >/dev/null 2>&1
