# artificialneko

**Creator-fee reward bot and stats API for [artificialneko.com](https://artificialneko.com).**

NEKO launches on the Pons V2 launchpad **paired with NVDA** (tokenized
SpaceX stock). Because pons pays creator fees in whatever a launch is priced in,
those fees accrue **as NVDA** — never as ETH. This repo claims them, airdrops
nearly all of them pro-rata to NEKO holders, keeps back only what it costs to
send them, and reports what it did to the site.

```
NEKO trades  →  creator fees accrue on-chain, denominated in NVDA
      ↓  sweep              push pending fees into the pons fee escrow
      ↓  claimToken(NVDA)   withdraw the escrow → the bot's wallet
      ├─ 10% → sell for native ETH, so the bot can pay its own gas
      ├─ 90% → airdrop NVDA pro-rata to NEKO holders
      ├─  0% → buyback + burn: BUILT, but not funded (BURN_PCT=0)
      └─  0% → dev cut: whatever the other three leave (none at 90/0/10)
```

The gas leg runs **first**. The airdrop that follows sends one transaction per
holder, so topping up beforehand is what stops a cycle running dry halfway
through paying people.

**The reward leg never swaps.** Fees arrive already denominated in NVDA, which
is exactly what holders are paid — so slippage, quoting and venue dispatch exist
only for the buyback, and a bad swap can never strand a holder payout.

**The buyback is off by choice, not missing.** `BURN_PCT=0`, so every NVDA
claimed goes to holders or to the gas that delivers it, and no cycle spends a
quarter of the claim buying its own token back. The machinery is intact and
tested — `evm/buyback.js`, a real `burn(uint256)` that reduces `totalSupply`
rather than a transfer to a dead address — it is simply not funded. Each cycle
records `burn share of this claim is zero` and moves on.

Funding it is one value: set `BURN_PCT` and lower `REWARD_PCT` to match. Until
then `totalBurned`, `burnedPctOfSupply` and `GET /burns` all report zero, and a
site rendering burn tiles should hide them rather than show a permanent 0.

## Two processes, one database

The public API must never hold a signing key, so the bot is a separate process:

| Process | Runs | Holds the wallet key | Exposed |
| --- | --- | --- | --- |
| `server.js` (`npm start`) | the site's API | **no** | nginx → `api.artificialneko.com` |
| `bot.js` (`npm run bot`) | scheduler + cycle | **yes** | `127.0.0.1` only |

They share one MongoDB: the bot writes payouts, the API reads them. A compromise
of the internet-facing service reaches no key, and `POST /run` — which pays real
money out — is not reachable from the internet at all.

## The trigger: $100 of accrued NVDA

`TRIGGER_MODE=accumulation` fires a cycle once the claimable NVDA is worth
`CLAIM_EVERY_USD` (default 100), priced from DexScreener's NVDA/USD. The gate is
in dollars rather than tokens because one NVDA is worth hundreds of dollars, so
a token threshold is unusable.

**If the NVDA price is briefly unavailable, the bot holds rather than firing.**
Claiming blind would empty the escrow at an unknown value and pay gas to do it,
while waiting costs nothing — the fees keep accruing for the next tick.

"Claimable" counts the escrow balance **plus** fees still pending on the curve or
hook. Gating on the escrow alone deadlocks: before the first sweep it reads zero
while the fees sit upstream, so the bot would never fire and therefore never
sweep.

`TRIGGER_MODE=interval` claims whatever has accrued on every tick, and needs no
price at all.

### How often it looks vs how often it pays

Two schedules, because those are two different questions and they want opposite
answers.

| Env | Default | Job |
| --- | --- | --- |
| `POLL_SCHEDULE` | `* * * * *` | read the chain, price it, write the fee gauge. **Never pays.** |
| `TRIGGER_SCHEDULE` | `0 * * * *` | when a distribution may actually happen. |

A distribution needs **both**: the trigger schedule comes round *and* the
claimable fees clear `CLAIM_EVERY_USD`. If the hour arrives and the tank is
short, nothing is claimed and the check rolls over to the next one — the fees
are not lost, they keep accruing on-chain until a check finds enough.

The cadence is an ordinary cron string, so it is whatever you want it to be:

```
0 * * * *      hourly, on the hour              (default)
*/30 * * * *   every 30 minutes, at :00 and :30
*/20 * * * *   every 20 minutes
*/5 * * * *    every 5 minutes — pays as soon as $100 lands
```

Prefer a divisor of 60. Cron's step operator restarts each hour, so `*/45` fires
at `:00` and `:45` and then jumps back to `:00` — a 45-minute gap followed by a
15-minute one, not "every 45 minutes".

**Why not one schedule.** The poll also writes the gauge behind the site's
progress bar (`GET /distribution`). Slowing it to hourly freezes the tank for an
hour at a time; speeding the trigger up pays out on every tick. Separating them
lets the site show a tank climbing every minute that empties on the hour.

Setting both keys to the same string is fine — they collapse to a single firing
task. Two tasks on the same minute would race for the run flag and silently drop
half the trigger ticks.

## The two things that will silently break it

**1. `creatorFeeRecipient` must be this bot's wallet.** It is the only address
allowed to sweep or claim. If it is wrong, the bot throws no error — it runs
forever, collects nothing, and looks healthy. Set it at launch, and check the
`feeRecip.` line of `npm run check`.

It is also **mutable after launch** (the factory exposes
`transferCreatorFeeRecipient`), so every cycle re-checks it and the operator
`/status` endpoint reports `feeRecipientOk`.

**2. Leave pons's "route creator fees to holders" toggle OFF.** Pons offers a
first-party version of this bot: a toggle that routes creator fees to a
per-token fee distributor which pushes payouts to holders automatically. It is a
perfectly good feature — Ryzen Kitty uses it — but **it is mutually exclusive
with this bot**, because switching it on reassigns `creatorFeeRecipient` to that
distributor contract and leaves the bot with nothing to claim.

Use the toggle if you want 100% to holders on pons's schedule and nothing else.
Use this bot if you want any of what the toggle cannot do: a **buyback and
burn**, a `MIN_HOLD` eligibility threshold, anti-sybil cluster caps, exclusions,
a dev cut, or your own trigger.

## The wallet

One wallet does everything: it is the launch's `creatorFeeRecipient`, and it is
what the bot signs with. `WALLET_PRIVATE_KEY` is that wallet's key, read by
`bot.js` only — `server.js` never loads it.

For this deployment that is the **dev/creator wallet**. On pons's create form,
leaving "Creator wallet" blank uses the connected wallet, so launching from the
dev wallet makes it the recipient automatically.

**What that means in practice:** the dev wallet's key lives in `.env` on the
server, so the box is as valuable as that wallet. Two things follow, and neither
is a reason not to do it — just things to know:

- Whoever holds the key gets whatever the wallet holds.
- They can also call `transferCreatorFeeRecipient` and permanently redirect the
  fee stream. From the verified factory source, only the CURRENT recipient may
  reassign it, so nothing else you control can undo that:

  ```solidity
  if (msg.sender != launch.creatorFeeRecipient) revert NotCreatorFeeRecipient();
  ```

  The only override is the protocol owner's, behind a 3-day timelock
  (`CREATOR_FEE_RECIPIENT_TIMELOCK`), which means asking pons.

So: `chmod 600 .env`, key-only SSH, nothing else on the box. `feeRecipientOk` on
`GET /status` is re-checked every cycle — it cannot prevent a theft, but it turns
"revenue quietly stopped" into a flag within one cycle rather than a mystery.

`DEV_PAYOUT_ADDRESS` stays blank in this setup: with an 80/20 split there is no
dev cut, and if you later move to a split that leaves one, pointing it at a cold
address is how you keep those earnings off the server.

## Gas funds itself

Everything the bot collects is NVDA; every transaction it sends costs ETH. The
`GAS_PCT` leg closes that gap by selling a slice of each claim for native ETH,
so the wallet refills itself instead of needing manual top-ups forever.

The route is an **independent** Uniswap v4 pool — NVDA is a tokenized equity
with its own markets, nothing to do with the pons launch pool — so its key is
configured (`GAS_POOL_FEE` / `GAS_POOL_TICK_SPACING` / `GAS_POOL_HOOKS`) rather
than derived. This is also the only place the bot ever **sells**; both other
legs only pay out or buy.

`GAS_CEILING_ETH` stops it converting forever once enough is banked (0 = always
swap). `GAS_RESERVE_ETH` remains the floor: below it a cycle refuses to *start*,
rather than claiming the escrow and then failing to pay anyone out. Seed the
wallet with a little ETH before the first live cycle — the leg cannot bootstrap
gas it does not yet have.

## API

The site's endpoints, unchanged by the bot's arrival. A field that cannot be
sourced is `null`, never `0` — the site hides a null tile but would render a
zero as a real number.

| Route | Returns |
| --- | --- |
| `GET /token` | name, ticker, contract address, chain |
| `GET /stats` | `marketCap`, `holders`, `totalRewarded`, `totalRewardedUsd`, `totalBurned`, `totalBurnedUsd`, `burnedPctOfSupply`, `priceUsd`, `liquidityUsd` |
| `GET /rewards?cursor&limit` | the payout ledger, served as `transactions`, `items` and `rows` |
| `GET /rewards/meter` | the same gauge in the site's own shape — `{ accumulatedUsd, thresholdUsd, secondsUntilCheck, state }` |
| `GET /distribution` | the fee gauge — `{ collectedUsd, thresholdUsd, status, lastDistributionId }` |
| `GET /health` | `{ ok, uptimeSec }` |

### The fee gauge

`GET /rewards/meter` and `GET /distribution` serve the same gauge in two
shapes. The meter is what the site's `RewardMeter` reads: `state` is
`charging` / `ready` / `distributing` / `idle`, and `secondsUntilCheck` counts
down to the next `TRIGGER_SCHEDULE` firing — the backend is the only side that
knows the schedule, so it is the only side that can answer. `ready` is the
state the hourly trigger made possible and the old code never had: over the
threshold, nothing paid yet, waiting for the window.

`GET /distribution` is what drives the site's "how full is the tank" meter and
its launch animation:

| Field | Is |
| --- | --- |
| `collectedUsd` | claimable NVDA × NVDA/USD — how much has accrued |
| `thresholdUsd` | `CLAIM_EVERY_USD`, the amount that fires a cycle |
| `status` | `collecting`, or `distributing` while a cycle runs |
| `lastDistributionId` / `lastDistributionAt` | move only when a cycle actually paid out |

The site resets its gauge whenever the last-distribution marker changes, so
those two fields stay **null until a payout genuinely lands** — a cycle that
claimed nothing must not look like a distribution. For the same reason the
timestamp is called `asOf` rather than `updatedAt`: the site would treat a field
of the latter name as a marker and reset the animation on every poll.

The numbers are produced by the **bot** (the only process that can read the
escrow and price NVDA) and persisted to Mongo each tick; the API just reads them
back. So the gauge is as fresh as the last poll, not as fresh as the request —
which is the right trade, since the alternative is an RPC call per visitor.

All are mounted at both `/` and `/api`, so the site works whether or not `/api`
is in its base URL.

**Market cap survives every stage of the token's life**: DexScreener's pair →
Blockscout's circulating market cap → the pons bonding-curve price × NVDA/USD.
The last of those is what keeps the tile alive before graduation, when
DexScreener has nothing to say.

**The burn fields**, for a burn tile:

| Field | Is |
| --- | --- |
| `totalBurned` | NEKO tokens destroyed — the headline number |
| `burnQuoteSpent` | what those buybacks **cost**, in NVDA |
| `totalBurnedUsd` | what the destroyed tokens are **worth today** |
| `burnedPctOfSupply` | share of the original mint that has been burned |
| `burns` | how many buyback cycles have run |

Cost and current value are deliberately separate fields: they answer different
questions and drift apart as the price moves. Only burns that actually
completed are counted — a buyback that bought but failed to burn leaves the
tokens in existence, so it is excluded.

**`totalRewarded` and `/rewards` read this bot's own ledger.** Only payouts
carrying a real on-chain transaction hash are served, so `DRY_RUN` payouts —
recorded with a fabricated signature — can never reach a visitor and link them
to a transaction that does not exist.

### Operator API (bot.js, localhost only)

| Route | Does |
| --- | --- |
| `GET /status` | `feeRecipientOk`, claimable NVDA and its USD value, wallet gas, scheduler state |
| `POST /run` | run one cycle now (409 if one is already running) |
| `POST /pause` / `POST /resume` | stop and restart the schedule |

All require `x-api-key: $API_KEY`.

## Quick start

```bash
npm install
cp .env.example .env      # defaults are safe: DRY_RUN=true, ephemeral wallet
npm test                  # unit + integration, no network needed
npm run check             # read-only preflight — sends nothing
npm start                 # the public API
npm run bot               # the bot (separate terminal)
```

`npm run check` is the fastest way to tell a config mistake apart from a token
that simply has not launched yet. It prints every upstream, the launch record,
the `creatorFeeRecipient` verdict, what is claimable right now against the $100
gate, and whether the wallet has gas.

Both processes need MongoDB (a local `mongod`, or set `MONGODB_URI`).

## Config

Everything is documented in `.env.example`. The ones worth knowing first:

| Env | Default | Meaning |
| --- | --- | --- |
| `WALLET_PRIVATE_KEY` | — | must be NEKO's `creatorFeeRecipient`; `bot.js` only |
| `TOKEN_ADDRESS` | — | blank until launch → every stat is null |
| `QUOTE_TOKEN_ADDRESS` | NVDA | the quote asset **and** the reward asset — one address, both roles |
| `CLAIM_EVERY_USD` | `100` | fire once the accrued NVDA is worth this |
| `POLL_SCHEDULE` | `* * * * *` | how often the chain is read and the gauge written; never pays |
| `TRIGGER_SCHEDULE` | `0 * * * *` | when a distribution may happen — `*/30 * * * *` for every half hour |
| `REWARD_PCT` | `90` | share airdropped to holders |
| `BURN_PCT` | `0` | share used to buy NEKO and burn it — **off by default here** |
| `GAS_PCT` | `10` | share sold for ETH to fund the bot's own gas |
| `GAS_CEILING_ETH` | `0` | stop converting above this ETH balance (0 = never) |
| `SLIPPAGE_PCT` | `5` | tolerance on the buyback swap only |
| `DEV_PAYOUT_ADDRESS` | — | cold address the dev cut is forwarded to; blank = it stays in the bot wallet |
| `MIN_HOLD` | `100000` | minimum NEKO balance to qualify |
| `REWARD_CAP_PCT` | `0` | per-wallet weight cap, % of supply (0 = pure pro-rata) |
| `DISPERSE_ADDRESS` | — | batch-transfer contract; blank → one transfer per recipient |
| `GAS_RESERVE_ETH` | `0.01` | below this the cycle refuses to start |
| `DRY_RUN` | `true` | simulate everything; the default everywhere |

## Airdrop at scale

Without `DISPERSE_ADDRESS`, the airdrop sends one ERC-20 transfer per recipient
(pipelined, up to `AIRDROP_BATCH_SIZE` in flight, with a locally-tracked nonce).
That is fine at a few hundred holders and expensive at a few thousand.

Setting `DISPERSE_ADDRESS` turns each batch into a single transaction. Two
things have to be true before you do, and both fail loudly *after* the escrow
has been claimed if they are not:

**1. It must be an ERC-20 disperser exposing exactly this signature:**

```solidity
function disperseToken(address token, address[] recipients, uint256[] values)
```

`pons-launcher/contracts/Disperse.sol` is **not** it — that contract is native
ETH only (`disperse` / `disperseEqual`, both `payable`) and has no
`disperseToken`. Pointing `DISPERSE_ADDRESS` at it makes every batch revert on
an unknown selector.

**2. The approval is handled for you.** The contract pulls with `transferFrom`,
so it needs an allowance — the bot now approves NVDA to `DISPERSE_ADDRESS` on
the first airdrop that uses it, because a forgotten approval used to fail
*after* the escrow had been claimed.

`contracts/TokenDisperser.sol` in this repo is that contract, with the exact
signature above. Deploy it with your own key:

```bash
npm i solc --no-save                          # needed once, for the deployment
node scripts/deploy-disperser.js              # compile only, sends nothing
node scripts/deploy-disperser.js --confirm    # deploys
```

It has no owner, no admin, no upgrade path and holds no balance between
transactions — every unit moves from the caller to a recipient in one call or
the whole call reverts. A batch is all-or-nothing on purpose: a partially
applied airdrop is worse than a failed one, because you cannot tell who was
already paid without reading receipts.

NVDA itself disperses fine — it is a standard OpenZeppelin-style ERC-20
(`approve`, `transfer` and `transferFrom` all verified against the live
contract; not paused; no allowlist, blacklist or transfer hook), despite being
a tokenized equity.

## Going live

1. Launch NEKO on pons v2 paired with NVDA, **connected as the dev wallet**.
   Leave "Creator wallet" blank so it defaults to that connected wallet, and
   leave the holder-fee-sharing toggle **off**. The confirm modal must read
   "Creator fees: Paid to the creator wallet" and show the dev wallet's address.
2. Set `TOKEN_ADDRESS` and `WALLET_PRIVATE_KEY` in `.env`.
3. Fund the wallet with ETH for gas.
4. `npm run check` — confirm the `feeRecip.` line shows ✓.
5. Watch a DRY_RUN cycle: `curl -H "x-api-key: $API_KEY" -XPOST localhost:3100/run`.
6. Set `DRY_RUN=false`, restart the bot, and watch the first live cycle.

## Deploying

See [`DEPLOY.md`](DEPLOY.md) — Ubuntu 24.04, Node 22, MongoDB, two PM2
processes, nginx and Certbot for `api.artificialneko.com`.

## Design

The spec is in
[`docs/superpowers/specs/2026-08-30-artificialneko-rewards-bot-design.md`](docs/superpowers/specs/2026-08-30-artificialneko-rewards-bot-design.md)
and the implementation plan in [`docs/superpowers/plans/`](docs/superpowers/plans/).
