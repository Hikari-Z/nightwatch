# Polish queue — small bugfixes and UX tweaks

Append freely; strike items when they land. One line each, with where it
bites and who reported it. Bigger design questions go to the plan docs,
not here.

## Open

- **Alert buttons misaligned:** the context-nearly-full alert's "Show log"
  and "Got it" are noticeably offset from each other and style-mismatched;
  they should sit next to each other, matched. (Ra, 10/9)
- **Glass Vertical hovertext clipped:** on some agent cards the hover
  tooltip tucks behind the main panel and can't be read. Likely z-index /
  overflow on the panel stack; check the other verticals too. (Ra, 10/9)
- **Sleep-agent reply overpromises and it/its-es:** "Rang main's bell. It
  will write its rung and fold" — replace with the pronoun-free honest
  version: "Rang main's bell. If the agent is listening, the rung gets
  written and the fold runs; if not, the nightshift folds the session
  after the grace period." (opus+fable, 10/9, from the live-fire)
- **--fold-now refusal says "lane":** "lane main is not awake — nothing
  to fold" → "agent". UI words per the 10/8 ruling: "agent" user-facing,
  "lane" internal. (opus, 10/9)
- **The wider it/its + "lane" sweep** of UI-adjacent strings (~100 it/its,
  ~200 "lane" counted 10/8) rides with Ra's tooltip pass. (Ra's ruling,
  10/8)
- **Spiralwatch thresholds retune** once the canary has sung live: key on
  recovery-after-kickstart rather than raw error counts; fill-bell sizes
  predate current cache behavior (9MB soft vs observed healthy 50–60MB).
  (Ra's diagnosis, 10/9)
- **already-awake vs wake-confirmed after a hand Wake + Force fold:** the
  refresh relaunch records as "already awake" because wakeAttemptAt is
  stamped from tick-start; stamping with io.now() after launchWake would
  make it exact. Cosmetic; probed not-dangerous. (opus, 10/9)

- **Fold-cycle stage invisible:** between bell and wake the UI shows
  nothing about where an agent is in bell → rung → folded → closing →
  closed → waking — Ra watched opus's whole cycle tonight with only a
  timeline bell glyph and a terminal window for evidence. The state file
  already holds belledAt/closedAt/wokenAt and the receipt mtime; the
  card should show the stage as a word. (Ra, 10/9; supersedes the
  narrower item below)
- **No UI indication a lane was belled:** pressing Sleep agent shows
  nothing on the card about the pending bell — regression from earlier
  behavior where belled state was visible. (Ra, 10/9)

## Done

(nothing struck yet — list born 10/9)
