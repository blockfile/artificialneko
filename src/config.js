'use strict';
require('dotenv').config();
const { Wallet, isAddress } = require('ethers');

function num(v, d) {
  if (v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function bool(v, d) {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
const lowerOrNull = (v) => (v ? String(v).trim().toLowerCase() : null);
const lowerOr = (v, d) => lowerOrNull(v) || d;

function parseClusters(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(Array.isArray)
      .map((g) => g.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim()))
      .filter((g) => g.length > 0);
  } catch (_err) {
    console.warn('[artificialneko] CLUSTERS is not valid JSON — ignoring');
    return [];
  }
}

const DRY_RUN = bool(process.env.DRY_RUN, true);

// The signing wallet lives here so bot.js can use it and server.js never
// touches it. In DRY_RUN an ephemeral wallet stands in, so a dry run needs no
// key at all; a live run without one is refused rather than silently signing
// with a throwaway address that owns nothing.
function loadWallet() {
  const raw = process.env.WALLET_PRIVATE_KEY;
  if (!raw) {
    if (!DRY_RUN) throw new Error('WALLET_PRIVATE_KEY is required when DRY_RUN=false');
    return { wallet: Wallet.createRandom(), ephemeral: true };
  }
  const key = raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`;
  try {
    return { wallet: new Wallet(key), ephemeral: false };
  } catch (err) {
    throw new Error(`Could not parse WALLET_PRIVATE_KEY: ${err.message}`);
  }
}
// Resolved LAZILY, on first access — see the defineProperty calls at the bottom
// of this file. Loading it here instead meant `require('./config')` threw when
// no key was set, which crash-looped the PUBLIC API on a missing WALLET_PRIVATE
// _KEY even though server.js never signs anything and loads no EVM code at all.
let walletState = null;
function resolveWallet() {
  if (!walletState) walletState = loadWallet();
  return walletState;
}

// Where the dev cut is sent at the end of each cycle. Optional: blank leaves it
// in the bot wallet, which is the old behaviour.
//
// Validated HERE rather than at send time on purpose. A typo'd address would
// otherwise be discovered only once a cycle had already claimed and paid the
// holders, and — if the typo happened to be a valid-looking address — would send
// the dev cut somewhere unrecoverable, every cycle, silently.
const devPayoutAddress = lowerOrNull(process.env.DEV_PAYOUT_ADDRESS);
if (devPayoutAddress && !isAddress(devPayoutAddress)) {
  throw new Error(`DEV_PAYOUT_ADDRESS is not a valid address: ${process.env.DEV_PAYOUT_ADDRESS}`);
}

// The claim splits three ways. REWARD_PCT and BURN_PCT are configured; the dev
// cut is whatever is left, so it only exists when the other two total under 100.
// At the default 80/20 there is no dev cut at all — every NVDA collected goes
// back to holders or into the buyback.
const rewardPct = num(process.env.REWARD_PCT, 65);
const burnPct = num(process.env.BURN_PCT, 25);
const gasPct = num(process.env.GAS_PCT, 10);
if (!(rewardPct >= 0 && rewardPct <= 100)) {
  throw new Error(`invalid split: REWARD_PCT(${rewardPct}) must be within [0, 100]`);
}
if (!(burnPct >= 0 && burnPct <= 100)) {
  throw new Error(`invalid split: BURN_PCT(${burnPct}) must be within [0, 100]`);
}
if (!(gasPct >= 0 && gasPct <= 100)) {
  throw new Error(`invalid split: GAS_PCT(${gasPct}) must be within [0, 100]`);
}
if (rewardPct + burnPct + gasPct > 100) {
  throw new Error(
    `invalid split: REWARD_PCT(${rewardPct}) + BURN_PCT(${burnPct}) + GAS_PCT(${gasPct}) = ` +
    `${rewardPct + burnPct + gasPct} exceeds 100`
  );
}
// toFixed(6) keeps a fractional share from leaving float dust behind
// (100 - 80.1 is 19.900000000000006 in FP).
const devPct = +(100 - rewardPct - burnPct - gasPct).toFixed(6);

// Accumulation is the default: this launch's fees are worth hundreds of dollars
// per token, so firing on every tick would pay gas to move dust.
const triggerMode = ['interval', 'accumulation'].includes(String(process.env.TRIGGER_MODE || '').toLowerCase())
  ? String(process.env.TRIGGER_MODE).toLowerCase()
  : 'accumulation';

// Blockscout instance for Robinhood Chain — the holder count comes from here.
const explorerApi = (process.env.EXPLORER_API || 'https://robinhoodchain.blockscout.com').replace(/\/$/, '');

const config = {
  port: num(process.env.PORT, 3000),

  // NEKO's contract address. Blank until the token is launched — every stat
  // then resolves to null, which the site renders as "—" rather than a zero.
  tokenAddress: lowerOrNull(process.env.TOKEN_ADDRESS),
  // The site's ticker is $NEKO (SITE.ticker in its config/site.js).
  tokenSymbol: process.env.TOKEN_SYMBOL || 'NEKO',
  // Referenced in several places as `config.quoteSymbol || 'NVDA'` but never
  // actually defined, so every one of those fell through to the literal. Only
  // the burns feed, which had no fallback, exposed it - as a null where the
  // site expects a ticker.
  quoteSymbol: process.env.QUOTE_SYMBOL || 'NVDA',
  tokenName: process.env.TOKEN_NAME || 'Artificial Neko',
  // Whole-token total supply, used ONLY to compute the pre-graduation market
  // cap when Blockscout (the normal source of supply + decimals) is
  // unreachable. Blank = no fallback. Pons V2 launches mint 1,000,000,000.
  tokenTotalSupply: num(process.env.TOKEN_TOTAL_SUPPLY, null),
  tokenDecimals: num(process.env.TOKEN_DECIMALS, 18),

  explorerApi,
  // DexScreener's slug for the chain — the market cap comes from here.
  dexscreenerChainId: process.env.DEXSCREENER_CHAIN_ID || 'robinhood',

  // How long a fetched value is served before refreshing. The site polls /stats
  // every 30s per browser tab, so without this the upstreams would see one
  // request per visitor per 30s.
  // A DexScreener pair below this much liquidity is ignored. Any token can have
  // a dust pool nobody trades, and DexScreener quotes a price from it as
  // readily as from a real market - NEKO's $3.32 NEKO/ETH pair put the site
  // at $6.35K against a true $34.13K.
  // The pons chart endpoint answers in about 7 seconds for a 1.8 KB payload -
  // slow, but not broken. The default fetch timeout is tuned for a browser
  // waiting on /stats and cut it off on every single call, which silently
  // removed the only price source a pre-graduation token has.
  curveFetchTimeoutMs: num(process.env.CURVE_FETCH_TIMEOUT_MS, 15_000),
  minPairLiquidityUsd: num(process.env.MIN_PAIR_LIQUIDITY_USD, 500),
  marketTtlMs: num(process.env.MARKET_TTL_MS, 30_000),
  // The bot pages through every holder; that is inherently slower than any
  // single API read and must not inherit a browser-facing timeout.
  holdersFetchTimeoutMs: num(process.env.HOLDERS_FETCH_TIMEOUT_MS, 45_000),
  holdersTtlMs: num(process.env.HOLDERS_TTL_MS, 120_000),

  // ── Pons rewards ("Total NVDA Rewarded") ───────────────────────────────────
  // NEKO's 2% creator tax accrues in NVDA (tokenized SpaceX stock) and routes to a
  // per-token fee distributor that pushes payouts to holder wallets. The
  // cumulative "paid to holders" total comes from Pons's public API — the same
  // source their token page renders (see src/services/rewards.js).
  ponsApi: (process.env.PONS_API || 'https://www.ponsfamily.com').replace(/\/$/, ''),
  // NVDA (tokenized NVIDIA stock) — the launch's QUOTE asset. Creator fees
  // accrue in this and nothing else, so it is what the escrow pays out, what
  // buys the reward token, and what funds gas and the dev cut.
  //
  // Verified 0xd0601CE1… on chain 4663. At least five impostor NVDA tokens
  // exist here, some sharing the name; assertQuoteToken() in src/evm/tokens.js
  // checks the bytecode rather than trusting the symbol.
  quoteTokenAddress: lowerOrNull(process.env.QUOTE_TOKEN_ADDRESS) || '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
  quoteDecimals: num(process.env.QUOTE_DECIMALS, 18),

  // Artificial Inu — what holders are actually PAID. Unlike the SpaceInu
  // lineage this bot grew from, the reward is not the quote asset: each cycle
  // buys AI with claimed NVDA and airdrops that. AI is a Doppler token, not a
  // pons one, and its pool is an ordinary v4 pool the UniversalRouter can
  // settle into — unlike the pons pool, which needs V4Buyer.
  // Holders are paid NVDA - the SAME asset the creator fees arrive in. So the
  // reward token deliberately equals the quote token, and the cycle's buy step
  // becomes a no-op: there is nothing to swap, the claim is already in the
  // right asset. Point this at a different token and the buy leg switches on
  // by itself.
  rewardTokenAddress: lowerOrNull(process.env.REWARD_TOKEN_ADDRESS) || '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
  rewardDecimals: num(process.env.REWARD_DECIMALS, 18),
  rewardSymbol: process.env.REWARD_SYMBOL || 'NVDA',
  // The AI/NVDA v4 pool, recovered from the PoolManager Initialize event.
  // `fee` is the DYNAMIC_FEE_FLAG (0x800000), NOT the 7000 lpFee the pool
  // reports — using 7000 derives a different poolId that reads as empty.
  // How far below the quote a reward buy may fill before it is refused. The
  // quote does not model the hook's after-swap cut, so a tight bound would
  // reject every honest fill.
  rewardSlippageBps: num(process.env.REWARD_SLIPPAGE_BPS, 300),
  rewardPoolFee: num(process.env.REWARD_POOL_FEE, 8388608),
  rewardPoolTickSpacing: num(process.env.REWARD_POOL_TICK_SPACING, 8),
  rewardPoolHooks: lowerOr(process.env.REWARD_POOL_HOOKS, '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544'),
  rewardsTtlMs: num(process.env.REWARDS_TTL_MS, 60_000),

  // ── Rewards feed (GET /rewards) ────────────────────────────────────────────
  // Every payout is one this bot made, read straight from its own ledger (see
  // src/services/rewardsfeed.js). There is no DISTRIBUTOR_ADDRESS here on
  // purpose: pons's fee distributor and this bot are mutually exclusive, and
  // keeping the key around would suggest they can coexist.
  feedTtlMs: num(process.env.FEED_TTL_MS, 30_000),
  // Explorer link base for a transaction hash, sent with every payout row.
  // The site only falls back to its own (Ethereum) explorer when the API omits
  // txUrl, which is how reward links ended up pointing at etherscan.io for a
  // Robinhood Chain transaction. Trailing slash included.
  explorerTxBase: (process.env.EXPLORER_TX_BASE || 'https://rh-scan.com/tx/').replace(/\/*$/, '/'),

  // Comma-separated allowlist of browser origins. Non-browser requests (no
  // Origin header) always pass; "*" allows any origin.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // ── Bot: chain access ──────────────────────────────────────────────────────
  dryRun: DRY_RUN,
  rpcUrl: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
  chainId: num(process.env.CHAIN_ID, 4663),
  // `wallet` and `walletIsEphemeral` are attached below as lazy getters, not
  // set here — see the note at the bottom of this file.

  // pons v2 wiring (verified on chain; all overridable per deployment).
  v2Factory: lowerOr(process.env.PONS_V2_FACTORY, '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e'),
  memeHook: lowerOr(process.env.MEME_HOOK, '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'),
  feeEscrow: lowerOr(process.env.FEE_ESCROW, '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e'),
  buybackVault: lowerOr(process.env.BUYBACK_VAULT, '0x42df2a798f82289e177311362e8f5ccc45c1219c'),
  poolManager: lowerOr(process.env.POOL_MANAGER, '0x8366a39cc670b4001a1121b8f6a443a643e40951'),
  deadAddress: lowerOr(process.env.DEAD_ADDRESS, '0x000000000000000000000000000000000000dead'),

  // ── Bot: split and eligibility ─────────────────────────────────────────────
  rewardPct,
  burnPct,
  gasPct,
  devPct,
  // Gas and the dev cut both need ETH, and NVDA has NO native-ETH v4 pool -
  // every fee/tickSpacing combination reads as empty. The route is Uniswap v3
  // to WETH and then unwrap. Verified on chain 4663: the fee-500 pool holds
  // ~98.6 WETH / ~487.9 NVDA.
  v3Router: lowerOr(process.env.V3_ROUTER, '0xcaf681a66d020601342297493863e78c959e5cb2'),
  wethAddress: lowerOr(process.env.WETH_ADDRESS, '0x0bd7d308f8e1639fab988df18a8011f41eacad73'),
  gasPoolFee: num(process.env.GAS_POOL_FEE, 500),
  // Skip the gas swap once the wallet holds this much ETH, so it does not
  // convert forever. 0 disables the ceiling — always swap.
  gasCeilingEth: num(process.env.GAS_CEILING_ETH, 0),
  // Slippage tolerance for the buyback swap, percent. Back in play now that the
  // bot buys again — the reward leg still never swaps.
  slippagePct: num(process.env.SLIPPAGE_PCT, 5),
  // Uniswap v4 periphery, needed only by the buyback swap.
  // Our own v4 router, used INSTEAD of the UniversalRouter when set. Required
  // for a pons pool quoted in an ERC-20: see src/evm/v4buyer.js.
  v4BuyerAddress: lowerOrNull(process.env.V4_BUYER_ADDRESS),
  universalRouter: lowerOr(process.env.UNIVERSAL_ROUTER, '0x8876789976decbfcbbbe364623c63652db8c0904'),
  v4Quoter: lowerOr(process.env.V4_QUOTER, '0x5c3db48cfd8352d845fac70009d714f0ce1d7914'),
  permit2: lowerOr(process.env.PERMIT2, '0x000000000022d473030f116ddee9f6b43ac78ba3'),
  minHold: num(process.env.MIN_HOLD, 100_000),
  rewardCapPct: num(process.env.REWARD_CAP_PCT, 0),
  clusters: parseClusters(process.env.CLUSTERS),
  airdropBatchSize: num(process.env.AIRDROP_BATCH_SIZE, 30),
  airdropGasLimit: num(process.env.AIRDROP_GAS_LIMIT, 120000),
  disperseAddress: lowerOrNull(process.env.DISPERSE_ADDRESS),
  airdropExclude: (process.env.AIRDROP_EXCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean),

  // ── Bot: trigger ───────────────────────────────────────────────────────────
  triggerMode,
  pollSchedule: process.env.POLL_SCHEDULE || '*/5 * * * *',
  // The gate is denominated in USD, not tokens: fees accrue in NVDA and one
  // NVDA is worth hundreds of dollars, so a token threshold is unusable.
  claimEveryUsd: num(process.env.CLAIM_EVERY_USD, 100),
  // DRY_RUN only: simulated NVDA accrued to the vault per tick.
  dryRunFeePerPoll: num(process.env.DRY_RUN_FEE_PER_POLL, 0.05),
  // Gas is NOT self-funding here: the dev cut is NVDA while gas is ETH. Below
  // this balance a cycle refuses to start rather than claiming and then failing
  // to pay anyone out.
  gasReserveEth: num(process.env.GAS_RESERVE_ETH, 0.01),
  // Cold address that receives the dev cut each cycle. Blank = it stays in the
  // bot wallet. Only an ADDRESS is needed, never a key: this wallet only
  // receives, so its key never has to touch the server.
  devPayoutAddress,

  // ── Bot: storage and control ───────────────────────────────────────────────
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017',
  mongoDb: process.env.MONGODB_DB || 'artificialneko',
  apiKey: process.env.API_KEY || null,
  botPort: num(process.env.BOT_PORT, 3100),
};

// The signing wallet, resolved on FIRST ACCESS rather than at require time.
//
// server.js requires this module and must never need a key — it loads no EVM
// code and signs nothing. Resolving eagerly made `require('./config')` throw
// whenever WALLET_PRIVATE_KEY was unset with DRY_RUN=false, which crash-looped
// the public API over a key it never uses, and quietly defeated the point of
// running the bot as a separate process.
//
// bot.js still fails fast: it requires evm/provider, which builds a signer at
// module load, so a missing key stops the bot at startup with the same error.
//
// Non-enumerable so that JSON.stringify or a spread of `config` cannot trigger
// the lookup — and therefore the throw — somewhere that never wanted a wallet.
Object.defineProperty(config, 'wallet', {
  get: () => resolveWallet().wallet,
  enumerable: false,
  configurable: true,
});
Object.defineProperty(config, 'walletIsEphemeral', {
  get: () => resolveWallet().ephemeral,
  enumerable: false,
  configurable: true,
});

module.exports = config;
