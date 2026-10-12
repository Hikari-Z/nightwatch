# Stage words, countdowns, notifications, and the midday cycle

A design pass for Ra's read before anything is built. Sources: `docs/polish-queue.md` ("Fold-cycle stage
invisible", Ra 10/9; "Gentle midday cycle", Ra 10/9).

## What's there today

The card already prints the lane's raw state in its badge (`belled`, `folding`, `sleeping`, `failed`, …), with a
tooltip from `STATE_TIP` in `gui/emitter.mjs`. Four of the six skins (Minimal, Glass, Amber, Metal) hide the word when the lane is plainly awake; Brassworks and Wacky show it. So the gap Ra
named on 10/9 is half closed: the stage is visible, but in the machinery's vocabulary, and two stages have no
word at all: a rung written but not yet folded, and the midday cycle, which doesn't exist yet.

## Stage words

One word or short phrase on the card, sentence case; the tooltip says what happens next.

| Stage | Card word | Tooltip | Source |
|---|---|---|---|
| awake | (none, as now) | Awake · plus the working/idle light | as now |
| belled, no rung yet | **Bell rung** | Writing today's rung · folds by HH:MM | `bell-rung`, then the floor deadline |
| belled, rung on disk | **Rung written** | Folding next | new: a rung for this lane newer than the bell |
| folded, window open | **Folded** | Closes once the session goes quiet | `folded` |
| asleep | **Asleep** | Wakes at 08:00 | as now, with the wake time |
| waking | **Waking** | Waiting for the session to register (attempt 2 of 3) | `wake-launched` / `wake-exec` |
| Force fold / Fold now | **Refreshing** | Closed, folding, reopening now | the existing refresh phase |
| midday cycle | **Cycling** | Folding at its own seam; reopens right after | new (below) |
| failed | **Needs a hand** | the failure's own cause, as the alert card already says | as now |
| orphaned | **Orphan-folded** | Its session died; folded for it; wakes next | as now |

"Closing" isn't a separate stage: the daemon closes the window as soon as the folded session goes quiet, so
the card goes from Folded straight to Asleep.

## Countdowns

One countdown per card, the one that matters next:
- Bell rung or Rung written: time left before the floor folds it anyway.
- Refreshing, or a pending Fold now: "forcing in 7m", as today.
- Asleep: time to the wake.
- Awake: time to the next bell, as today.

## Notifications

Native banners (platform.mjs) only for things a person has to act on, which is today's stuck watch plus:
wake failed, and an orphan fold happened. Routine stages (bell, fold, wake) stay on the card; a banner for each
would train everyone to ignore banners. One possible exception, Ra's call: a single morning banner once every
armed lane has woken ("Both agents woke at 08:00").

## The midday cycle (Ra's rulings, 10/12)

Two tiers, keyed on the lane's context, at any hour (it's about the agent's limits, not anyone's attention):
- **85%: a soft bell, no timer.** The ordinary bell note, marked midday. The agent finishes its work, writes its
  rung, and runs `sleep.mjs` at its own seam. That run IS the "rung written, ready to fold" signal Ra asked
  for: the fold row lands, the daemon closes the window once the session goes quiet, and the refresh path
  reopens the lane at once instead of waiting for 08:00.
- **95%: an urgent bell with a timer.** If no fold has happened by the deadline, the daemon runs the Force-fold
  path before the window hits its cap: close, fold, reopen, and the fresh window writes the rung. An agent is
  never left jammed open at a full context.
- **Setting:** `lanes.<id>.middayCycle: { softPct: 0.85, urgentPct: 0.95, urgentMin }`. On for the opus lane,
  off for fable's (one long coordination context per day, by design).
- **Once per window:** a lane already belled (soft or urgent) isn't belled again at the same tier until it has
  folded.
- **The card:** Cycling while a midday fold is under way; the urgent tier shows its countdown.
- **Bench:** each tier's trigger, no repeat at a tier, the night window left to the nightly bell, the refresh
  after a met fold, and the urgent tier's forced fold.

## Ra's rulings, 10/12

- **Words:** Rung written, Bell rung (belled), Refreshing, Cycling and the rest as proposed; wording can be tuned
  once it's seen in context.
- **Midday cycle:** soft bell at 85% with no timer; an urgent bell with a timer at 95%; at any hour.
- **Urgent deadline:** 10 minutes.
- **No morning banner:** the persona card already shows at a glance which agents are awake; banners stay for
  things a person has to act on.

*Written by: claude-opus-5-5, 2026-10-12. Rulings recorded; build next.*
