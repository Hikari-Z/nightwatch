# Viewer wiring handoff — fable → opus, 2026-10-05 evening

Ra's ask: take the viewer's wiring in hand. Symptoms on the live page
(all reported by Ra on the real app window): hours/range dials dead,
log filter buttons dead, lane-card accordions dead, skin selector dead,
and the page shows the generic backdrop instead of the chosen skin.

## What exists

- `gui/server.mjs` (mine): assembles a live snapshot (config via
  wakecycle/config.mjs; events.jsonl → NIGHT/LOG/alarms; folds.jsonl;
  lane registry + /tmp/cc-socks for liveness; transcripts for ctx via
  blob-discounted chars/4 and 24×10-min output-token buckets), writes
  gui/snapshot.json, renders through `skins/build_fixture.py --data
  snapshot.json --out -` (the seam I added — additive; frozen values
  remain for any key the snapshot omits), injects a bottom-right skin
  picker + a hidden-tab-only reload, serves skins/* statically.
  Port 7352 (7350 = the old fleet panel). Launcher:
  `gui/launch-nightwatch.sh` + ~/Applications/Nightwatch.app
  (osacompile applet, ad-hoc signed, dedicated Chrome profile).
- `gui/handoff/live-sample.html`: a fresh served page for autopsy.

## My one-root-cause hypothesis (unverified — your call)

The fixture's inline boot script was written against fixture-complete
DOM. My live snapshot emits sparser sections (e.g. NIGHT lists without
`lanes` chips, LOG days with fewer kinds, empty viz). If any boot-time
querySelector comes back null, the first TypeError kills the whole
script — so no skin link gets applied (generic backdrop) and no
handler binds (every control dead). Check the console on
live-sample.html first; one stack trace probably explains all five
symptoms. If so, the fix is yours to choose: defensive boot (null-safe
sections), or tightening my snapshot to always emit fixture-complete
shapes (I can do that side on your spec).

## Design asks Ra named (yours + hers)

- Skin selector as real UX, part of the design, not my floating
  corner div (contract amendment — my injection is a stopgap and she
  rightly called it crammed).
- The backdrop question resolves itself if the skin-apply fix lands.

## Phase ladder for context

Phase 1 = read-only (write actions render disabled on purpose; that
part is by design, not a bug). Phase B = Tauri port: ONE JS emitter
replacing the python one (contract-sensitive — your contract, my data
plumbing; rustc 1.97 present). The wiring pass you're doing now is on
the phase-1 server, but anything you learn about the boot script's
assumptions feeds straight into the port.

Written by: claude-fable-5, 2026-10-05
