# Hourly distribution trigger

**Date:** 2026-09-04
**Status:** approved, not yet implemented

## What we want

A distribution happens **at most once an hour**, and only when the claimable
fees are worth at least `CLAIM_EVERY_USD` ($100) at that moment. If the hour
arrives and the fees are short, nothing is claimed and the check rolls over to
the next hour.

Meanwhile the site's fee gauge keeps updating **every minute**, so a visitor
watching the tank fill sees it climb continuously rather than jumping once an
hour.

```
13:00  $40   trigger  → short, skip; next evaluation at 14:00
13:01  $41   gauge    → tank 41%
13:20  $77   gauge    → tank 77%
13:47  $103  gauge    → tank 100%, status "ready" — does NOT fire
14:00  $118  trigger  → FIRE: sweep, claim, split, pay
14:01  $2    gauge    → tank 2%
```

Fees never reset. Unclaimed NVDA stays in the escrow and keeps accruing, so a
quiet hour rolls its balance into the next one and the total climbs until it
clears the threshold. That is the chain's behaviour, not a choice we are making.

## Why this is not just a config change

`TRIGGER_MODE=accumulation` + `CLAIM_EVERY_USD=100` already means "fire once the
fees are worth $100, otherwise skip and look again later". Setting
`POLL_SCHEDULE=0 * * * *` would give the requested trigger with no code at all.

The reason that is not enough: the poll does **two** jobs. It decides whether to
fire, and it writes the fee gauge that `GET /distribution` serves
(`scheduler.js` `recordGauge`). Slowing the poll to hourly freezes the site's
progress bar for an hour at a time.

So the work is to **separate those two jobs**, not to add a threshold.

## Approach: two cron schedules

`POLL_SCHEDULE` keeps its current job — read the chain, price it, write the
gauge — but is never allowed to run a cycle. A new `TRIGGER_SCHEDULE` runs the
same pass with firing enabled.

Chosen over an elapsed-time window (`CLAIM_WINDOW_MIN` + a `lastEvaluatedAt`
marker checked inside `shouldFire`) because:

- **Restart-safe by construction.** Cron is anchored to the wall clock. An
  elapsed-time marker held in memory is lost on `pm2 restart`, and PM2 is
  configured to auto-restart with `max_restarts: 10` — a crash loop could
  evaluate, and therefore pay out, far more often than hourly. Avoiding that
  with the marker approach means persisting it to Mongo, and the write that
  persists it is deliberately non-fatal (`recordGauge` swallows Mongo errors so
  a hiccup cannot stop a claim), so the marker could silently fail to advance.
- **No new state at all.** Nothing to persist, nothing to recover, nothing to
  get out of sync.
- **Reuses what is there.** `node-cron` is already a dependency and `start()`
  already validates a cron string.
- **Any cadence later** — every two hours, twice a day — is a cron string
  rather than another config key.

## Changes

### 1. Config — `src/config.js`

| Key | Default | Meaning |
| --- | --- | --- |
| `POLL_SCHEDULE` | `* * * * *` *(was `*/5 * * * *`)* | How often the chain is read and the gauge written. Never fires a cycle. |
| `TRIGGER_SCHEDULE` | `0 * * * *` *(new)* | When a distribution may actually happen. |

`triggerSchedule` reads from `process.env.TRIGGER_SCHEDULE` with the same shape
as `pollSchedule`.

### 2. Scheduler — `src/jobs/scheduler.js`

**`pollOnce(trigger, deps)` gains `deps.mayFire`, defaulting to `true`.** When
false, the poll does everything it does today — accrue the sim vault under
DRY_RUN, read what is claimable, price it, evaluate the gate, write the gauge —
and then returns without calling `runCycle`, whatever the gate said. Defaulting
to `true` means every existing call site and every existing test keeps its
current behaviour.

The gauge's status line becomes `gate.fire && mayFire ? 'distributing' :
'collecting'`, so a full tank at 13:40 does not announce a distribution twenty
minutes before one can happen.

A gauge tick that meets the threshold returns
`{ ran: false, reason: 'threshold met — waiting for the next trigger window' }`
rather than reusing a "below threshold" reason, so the log distinguishes "not
enough yet" from "enough, but not yet time".

**`start()` schedules two tasks**, validating both cron strings before either is
registered:

```js
state.task        = cron.schedule(pollSchedule,    () => pollOnce('gauge', { mayFire: false }))
state.triggerTask = cron.schedule(triggerSchedule, () => pollOnce('trigger'))
```

Both callbacks keep the existing `.catch(err => console.error(...))` — an
unhandled rejection in a cron tick must not take the bot down.

**Guard: identical schedules collapse to one task** with firing enabled. An
operator who wants "just check hourly" would naturally set both keys to
`0 * * * *`; two tasks firing in the same second would race on the `isRunning`
flag and randomly swallow the trigger tick, which is a bug that would show up as
"it sometimes skips an hour".

`_resetState()` clears `triggerTask` alongside `task`.

### 3. Nothing else changes

- **`shouldFire` is untouched.** The threshold gate, the hold-when-price-is-
  unavailable rule, and the interval-mode path are all already correct. They
  just get consulted for real once an hour instead of every tick.
- **`runCycle` is untouched.** What a distribution *does* is unchanged.
- **The site needs no change.** `buildMeter` in `src/routes/rewards.js` already
  maps at-or-above-threshold to `ready`, so a tank that is full and waiting for
  the hour reads as "ready" — which is exactly what is true.
- **`TRIGGER_MODE` keeps both values.** The trigger schedule is mode-agnostic:
  `interval` plus an hourly trigger means "claim whatever has accrued, once an
  hour", which is a coherent setting.

## Tests — `src/jobs/scheduler.test.js`

Extending the existing `pollOnce` deps-injection block:

1. `mayFire: false` does not run a cycle even far above the threshold.
2. `mayFire: false` still writes the gauge, and writes it with status
   `collecting`, not `distributing`.
3. `mayFire: false` above the threshold reports the waiting-for-window reason,
   not the below-threshold one.
4. `mayFire` omitted fires exactly as it does today (guards the default).

And in `src/config.test.js`: `TRIGGER_SCHEDULE` defaults to `0 * * * *`, and
`POLL_SCHEDULE` defaults to `* * * * *`.

Existing tests must pass unmodified. If one needs editing, the default is wrong.

## Docs to update

- **`README.md`**, "The trigger: $100 of accrued NVDA" — document the two
  schedules and why they are separate.
- **`.env.example`** — add `TRIGGER_SCHEDULE`, change the `POLL_SCHEDULE`
  default, and explain which one pays money out.
- **`DEPLOY.md`**, operational watch-list — a distribution now lands on the
  hour, so "nothing happened in the last 20 minutes" is not a symptom.

## Operational notes

**The server's `.env` must be edited too.** It pins
`POLL_SCHEDULE=*/5 * * * *`, which overrides the code default — changing the
default alone changes nothing on the box, and `TRIGGER_SCHEDULE` will be absent
and fall back to `0 * * * *`.

**RPC load rises ~5×**, from roughly 140 reads an hour to roughly 700 (each poll
does `getLaunch` plus the escrow, sweepable and pending-credit reads). Fine for
a public RPC, but it is a real jump. The DexScreener price is cached with a 30s
TTL, so it refetches about once a minute — well inside their limits.

**A cycle still running at the top of the hour skips that hour.** The
`isRunning` guard returns early, no evaluation happens, and the next trigger
tick is an hour later. This is acceptable: a cycle running at 14:00 means one
fired recently, so skipping 14:00 is arguably correct.

**A missing NVDA price at the top of the hour costs an hour.** `shouldFire`
holds rather than claiming blind, and the next evaluation is not for another
hour. This is rare — `quoteprice` is a stale-while-error cache that only throws
when it has never succeeded — and the cost is a delayed payout, not a lost one.
