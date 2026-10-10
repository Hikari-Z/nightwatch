# Polish queue — small bugfixes and UX tweaks

Append freely; strike items when they land. One line each, with where it
bites and who reported it. Bigger design questions go to the plan docs,
not here.

## Open

- **The wider it/its + "lane" sweep** of UI-adjacent strings (~100 it/its,
  ~200 "lane" counted 10/8) rides with Ra's tooltip pass. (Ra's ruling,
  10/8)
- **Spiralwatch thresholds retune** once the canary has sung live: key on
  recovery-after-kickstart rather than raw error counts; fill-bell sizes
  predate current cache behavior (9MB soft vs observed healthy 50–60MB).
  (Ra's diagnosis, 10/9)

- **Fold-cycle stage invisible:** between bell and wake the UI shows
  nothing about where an agent is in bell → rung → folded → closing →
  closed → waking — Ra watched opus's whole cycle tonight with only a
  timeline bell glyph and a terminal window for evidence. The state file
  already holds belledAt/closedAt/wokenAt and the receipt mtime; the
  card should show the stage as a word. (Ra, 10/9) Partly done 647bc91:
  the card's colour now holds belled until the fold and folding until the
  close; the word itself is still open. (opus, 10/9)

## Process-sized (bigger than polish, smaller than a plan doc)

- **Gentle midday cycle (Ra, 10/9):** nothing between the hard Force fold
  and the 02:00 bell when a session approaches a full window midday —
  opus can hit full multiple times on heavy days and tonight idled hours
  at 84% awaiting a human fold call. Compose from existing parts: the
  context watch's threshold (its 85% alert fired for real tonight) rings
  the ORDINARY bell with a patient deadline → the agent folds at its own
  seam, own rung → refreshWake reopens immediately; orphan floor
  backstops. Per-lane knob encodes the keeper's policy as architecture:
  lanes.opus.middayCycle {atPct, graceMin}; lanes.fable.middayCycle off
  (one long coordination context per day, by design). Needs: the
  trigger wire, the knob, bench scenarios, and the card's stage word
  showing 'cycling' distinctly from the nightly fold.

## The whimsy shelf (preserved, not promised)

- **Bell chime easter egg:** a 🔔 in an agent's output plays a soft bell
  in the app. Ra's own verdict: a sound you can't turn off is bad, and a
  volume control would give the joke away. Shelved as-is. (Ra, 10/9)
- **Engine-rev throughput:** token rate as a rising/falling engine (or
  boiler) sound. Pairs suspiciously well with the mp3-deck aesthetic and
  a machine-noises toggle (off / subtle / full steampunk). (Ra, a while
  back + 10/9)

## Done

- **Alert buttons misaligned:** the context-nearly-full alert's "Show log"
  and "Got it" are noticeably offset from each other and style-mismatched;
  they should sit next to each other, matched. (Ra, 10/9) → fixed d29d8c1 (opus)
- **Sleep-agent reply overpromises and it/its-es:** "Rang main's bell. It
  will write its rung and fold" — replace with the pronoun-free honest
  version: "Rang main's bell. If the agent is listening, the rung gets
  written and the fold runs; if not, the nightshift folds the session
  after the grace period." (opus+fable, 10/9, from the live-fire) → fixed edbbe00 (opus)
- **--fold-now refusal says "lane":** "lane main is not awake — nothing
  to fold" → "agent". UI words per the 10/8 ruling: "agent" user-facing,
  "lane" internal. (opus, 10/9) → fixed bd12f48, with --ring and the unknown-agent refusals (opus)
- **already-awake vs wake-confirmed after a hand Wake + Force fold:** the
  refresh relaunch records as "already awake" because wakeAttemptAt is
  stamped from tick-start; stamping with io.now() after launchWake would
  make it exact. Cosmetic; probed not-dangerous. (opus, 10/9) → fixed 97a152b; the live 10/8 22:28 shape is bench scenario 16 (opus)
- **No UI indication a lane was belled:** pressing Sleep agent shows
  nothing on the card about the pending bell — regression from earlier
  behavior where belled state was visible. (Ra, 10/9) → fixed 647bc91: watch events no longer wipe belled, and folded-but-open reads folding (opus)
- **Glass Vertical hovertext clipped:** on some agent cards the hover
  tooltip tucks behind the main panel and can't be read. Likely z-index /
  overflow on the panel stack; check the other verticals too. (Ra, 10/9)
  Ra's screenshot showed it: a centred tip crossing the card's left edge into
  the timeline. → fixed: tips draw from the edge they'd cross (opus, 10/9)
