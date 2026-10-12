# Stage words, countdowns, notifications, and the midday cycle

A design pass for Ra's read before anything is built. Sources: `docs/polish-queue.md` ("Fold-cycle stage
invisible", Ra 10/9; "Gentle midday cycle", Ra 10/9).

## What's there today

The card already prints the lane's raw state in its badge (`belled`, `folding`, `sleeping`, `failed`, …), with a
tooltip from `STATE_TIP` in `gui/emitter.mjs`. Four of the six skins (Minimal, Glass, Amber, Metal) hide the word when the lane is plainly awake; Brassworks and Wacky show it. So the gap Ra
named on 10/9 is half closed: the stage is visible, but in the machinery's vocabulary, and two stages of the
night have no word at all.

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

## The midday cycle

As the polish queue describes it, composed from parts that exist:
- **Setting:** `lanes.<id>.middayCycle: { atPct, graceMin }`. On for the opus lane, off for fable's (one long
  coordination context per day, by design).
- **Trigger:** the context watch already computes the window ratio. At `atPct` or above, outside the nightly
  window and at most once per lane per few hours, it rings the ordinary bell with `source: 'midday'`.
- **The ritual is the same:** the agent folds at its own seam and writes its own rung; then the refresh path
  reopens the lane at once instead of waiting for 08:00. The orphan floor backstops it after `graceMin`.
- **The card** says Cycling, so a midday fold never reads as the nightly one.
- **Bench:** the trigger, the once-per-window limit, the night-window exclusion, and the refresh after a met fold.

## Decisions for Ra

1. The words above, especially "Rung written" (a new stage), "Refreshing" and "Cycling".
2. Notifications: only act-on-this banners, or also the single morning banner?
3. Midday cycle numbers: `atPct` 85 (where the context alert fires today, `contextWarn: 0.85` in config.mjs)? `graceMin` 20? At most once per how
   many hours?
4. Should the midday bell also go quiet during the hours you're usually away, or is any time fine?

*Written by: claude-opus-5-5, 2026-10-12. A proposal; nothing built yet.*
