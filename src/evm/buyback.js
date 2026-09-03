'use strict';

// Buy NEKO with NVDA, then burn what was bought.
//
// This is the one place the bot swaps. The reward leg never does — fees arrive
// already denominated in NVDA, which is what holders are paid — so slippage,
// quoting and venue dispatch exist ONLY for the buyback.
//
// The venue follows the launch's phase, exactly as the sweep does:
//
//   curve (pre-graduation)   curve.buy(quoteIn, minOut, us), quoted from reserves,
//                            funded by a plain ERC-20 allowance to the curve.
//   v4    (post-graduation)  UniversalRouter exact-in swap, quoted by V4Quoter,
//                            funded through Permit2.
//
// Amounts bought are measured from the wallet's balance DELTA rather than a
// return value, so a fee-on-transfer or rounding surprise cannot make the bot
// try to burn more than it actually received.
//
// The burn is a real `burn(uint256)` on the token — verified present on a live
// pons v2 launch — not a transfer to a dead address. It reduces totalSupply, so
// holders can watch the supply shrink on the explorer, and the burned tokens
// stop appearing in holder snapshots entirely.

const { Contract, parseUnits, formatUnits } = require('ethers');
const config = require('../config');
const { provider, wallet } = require('./provider');
const { ERC20_ABI } = require('./abi');
const { getDecimals, readTokenBalance } = require('./erc20');
const { buildPoolKey, poolIdOf, isZeroForOne, quoteExactInSingle, NATIVE } = require('./pool');
const { swapExactInSingle } = require('./v4router');
const { buyViaV4Buyer } = require('./v4buyer');
const { quoteCurveOut, buyOnCurve } = require('./curve');
const { sendTx } = require('./send');
const { toUnitString } = require('./units');
const repo = require('../db/repository');

const BUY_ATTEMPTS = 3;
const BURN_ATTEMPTS = 3;
const BPS = 10000n;

function fakeSig(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Lower a quoted output by the configured slippage tolerance. */
function applySlippage(quoted, slippagePct) {
  if (!(slippagePct >= 0 && slippagePct < 100)) {
    throw new Error(`SLIPPAGE_PCT must be in [0, 100): ${slippagePct}`);
  }
  return (BigInt(quoted) * BigInt(Math.round((100 - slippagePct) * 100))) / BPS;
}

/**
 * Pure: how much of `wanted` can actually be spent, given the balance `held`.
 *
 * Never more than is there. The legs of a claim are computed as decimal Numbers
 * rounded to 9 places, so they can sum to marginally more than the claim was in
 * wei, and whichever leg runs last inherits the whole discrepancy.
 */
function clampToBalance(wanted, held) {
  return wanted <= held ? wanted : held;
}

/** Pure: a one-line description of what the buyback did. */
function describeOutcome(r) {
  if (r.skipped) return `buyback skipped: ${r.reason}`;
  if (r.burned) return `buyback bought ${r.tokensBought} ${config.tokenSymbol} for ${r.quoteSpent} NVDA and burned it`;
  if (r.bought) return `buyback bought ${r.tokensBought} ${config.tokenSymbol} but the BURN failed (${r.error}) — the tokens are in the wallet`;
  // Deliberately NOT "retried next cycle": the next cycle computes a fresh
  // share from a fresh claim, so this amount is not automatically re-attempted.
  // It stays in the wallet until a later cycle's clamp happens to use it or an
  // operator acts on it, and saying otherwise would hide idle funds.
  return `buyback FAILED (${r.error}) — the NVDA stays in the wallet, NOT auto-retried`;
}

/** Buy `quoteAmountRaw` worth of the launch token, on whichever venue it trades. */
async function buyToken({ launch, quoteAmountRaw }) {
  const token = launch.token;
  const quoteToken = launch.pairToken;

  // Re-quote on every attempt. A one-block price move makes the minimum-output
  // check revert, which is the protection working — but it must not lose the
  // cycle, so wait out the move and try again against a fresh quote.
  let lastErr;
  for (let attempt = 1; attempt <= BUY_ATTEMPTS; attempt += 1) {
    try {
      const before = await readTokenBalance(token, wallet.address);
      let signature;

      if (launch.graduated) {
        const poolKey =
          launch.poolKey ||
          buildPoolKey({
            token,
            quoteToken: quoteToken || NATIVE,
            fee: launch.poolFee,
            tickSpacing: launch.tickSpacing,
            hooks: config.memeHook,
          });
        const zeroForOne = isZeroForOne(poolKey, quoteToken || NATIVE);
        const quoted = await quoteExactInSingle({ poolKey, zeroForOne, amountIn: quoteAmountRaw });
        if (quoted <= 0n) throw new Error(`v4 pool quoted zero for ${token}`);
        // The UniversalRouter cannot swap into a pons pool quoted in an ERC-20,
        // so prefer our own buyer whenever one is configured.
        const swap = config.v4BuyerAddress ? buyViaV4Buyer : swapExactInSingle;
        const tx = await swap({
          poolKey,
          zeroForOne,
          amountIn: quoteAmountRaw,
          amountOutMinimum: applySlippage(quoted, config.slippagePct),
        });
        await tx.wait();
        console.log(`[tx] buyback ${token} on v4 (pool ${poolIdOf(poolKey).slice(0, 10)}…): ${tx.hash}`);
        signature = tx.hash;
      } else {
        const quoted = await quoteCurveOut({ curve: launch.curve, quoteAmountRaw });
        if (quoted <= 0n) throw new Error(`curve quoted zero for ${token}`);
        const res = await buyOnCurve({
          curve: launch.curve,
          token,
          quoteToken,
          quoteAmountRaw,
          minTokensOut: applySlippage(quoted, config.slippagePct),
          isNativeQuote: !quoteToken || quoteToken.toLowerCase() === NATIVE,
        });
        signature = res.signature;
      }

      const boughtRaw = (await readTokenBalance(token, wallet.address)) - before;
      return { signature, boughtRaw, venue: launch.graduated ? 'v4' : 'curve' };
    } catch (err) {
      lastErr = err;
      console.warn(
        `[buyback] attempt ${attempt}/${BUY_ATTEMPTS} failed on ${launch.graduated ? 'v4' : 'curve'}: ${
          err.shortMessage || err.message
        }`
      );
      if (attempt < BUY_ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

/**
 * Burn `raw` base units of the launch token held by this wallet.
 *
 * Retried like the buy is. A live cycle bought 626,015 tokens and then lost
 * them to a single "could not coalesce error" — an ethers-level RPC hiccup, not
 * a revert; the same burn simulated fine moments later. Giving the buy three
 * attempts and the burn none meant one blip stranded everything it had just
 * bought.
 */
async function burnToken({ token, raw }) {
  let lastErr;
  for (let attempt = 1; attempt <= BURN_ATTEMPTS; attempt += 1) {
    try {
      const tx = await sendTx(() => new Contract(token, ERC20_ABI, wallet).burn(raw));
      await tx.wait();
      console.log(`[tx] burn ${raw} of ${token}: ${tx.hash}`);
      return tx.hash;
    } catch (err) {
      lastErr = err;
      console.warn(`[buyback] burn attempt ${attempt}/${BURN_ATTEMPTS} failed: ${err.shortMessage || err.message}`);
      if (attempt < BURN_ATTEMPTS) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

/**
 * Buy the launch token with `quoteAmount` NVDA and burn every token bought.
 *
 * Never throws: by the time this runs the escrow has been claimed and the
 * holders have been paid, so a failure here means the NVDA is still ours,
 * sitting in the wallet, to retry next cycle. Failing the cycle over that would
 * mark a successful airdrop as failed.
 *
 * @param {{launch: object, quoteAmount: number}} opts
 */
async function buybackAndBurn({ launch, quoteAmount }) {
  const base = {
    skipped: false,
    bought: false,
    burned: false,
    quoteSpent: quoteAmount,
    tokensBought: 0,
    buySignature: null,
    burnSignature: null,
  };

  if (!(quoteAmount > 0)) {
    return { ...base, skipped: true, reason: 'burn share of this claim is zero' };
  }

  if (config.dryRun) {
    const tokensBought = +(quoteAmount * 1_000_000 * (0.97 + Math.random() * 0.06)).toFixed(0);
    return {
      ...base,
      bought: true,
      burned: true,
      tokensBought,
      buySignature: fakeSig('buyback'),
      burnSignature: fakeSig('burn'),
      venue: 'sim',
    };
  }

  const wanted = parseUnits(toUnitString(quoteAmount, config.quoteDecimals), config.quoteDecimals);
  if (wanted <= 0n) {
    return { ...base, skipped: true, reason: 'burn share rounds to zero base units' };
  }

  // Clamp to what the wallet actually holds.
  //
  // The legs are computed as decimal Numbers and rounded to 9 places, so their
  // sum can exceed the claim by a few wei — and this leg runs LAST, absorbing
  // every earlier rounding. A live cycle failed on exactly that: it asked for
  // 0.218952125 while holding 0.218952123727002065, short by 1.27e-9, and the
  // token reverted ERC20InsufficientBalance three times.
  //
  // Spending what is there instead is both correct and self-limiting: the
  // shortfall is always dust, and the dev cut is untouched because a clamp can
  // only ever reduce this leg, never reach past it.
  const held = await readTokenBalance(config.quoteTokenAddress, wallet.address);
  const quoteRaw = clampToBalance(wanted, held);
  if (quoteRaw <= 0n) {
    return { ...base, skipped: true, reason: 'the wallet holds no NVDA to buy back with' };
  }
  if (quoteRaw < wanted) {
    console.warn(
      `[buyback] wallet holds ${formatUnits(held, config.quoteDecimals)} NVDA but the share is ` +
        `${formatUnits(wanted, config.quoteDecimals)} — spending what is there (rounding dust)`
    );
  }

  let buy;
  try {
    buy = await buyToken({ launch, quoteAmountRaw: quoteRaw });
  } catch (err) {
    return { ...base, error: err.shortMessage || err.message };
  }

  if (buy.boughtRaw <= 0n) {
    return { ...base, error: 'the swap succeeded but delivered zero tokens', buySignature: buy.signature };
  }

  const decimals = await getDecimals(launch.token);
  const tokensBought = Number(formatUnits(buy.boughtRaw, decimals));

  // Add anything a previous cycle bought but failed to burn. Tracked as tokens
  // THIS BOT BOUGHT, never as "whatever the wallet holds": the signing wallet
  // is also the dev wallet and may hold the token personally, which must never
  // be burned. Without this, a failed burn stranded 626,015 tokens permanently,
  // because the next cycle only ever burns what it just bought.
  let pending = 0n;
  try {
    pending = await repo.getPendingBurn();
  } catch (_err) {
    pending = 0n;
  }
  const burnRaw = buy.boughtRaw + pending;
  if (pending > 0n) {
    console.log(`[buyback] also burning ${formatUnits(pending, decimals)} carried over from an earlier failed burn`);
  }

  // The buy succeeded — from here the tokens are ours either way, so a failed
  // burn is reported without discarding the fact that the buy landed.
  try {
    const burnSignature = await burnToken({ token: launch.token, raw: burnRaw });
    await repo.setPendingBurn(0n).catch(() => {});
    return {
      ...base,
      bought: true,
      burned: true,
      tokensBought: Number(formatUnits(burnRaw, decimals)),
      buySignature: buy.signature,
      burnSignature,
      venue: buy.venue,
    };
  } catch (err) {
    // Remember what is owed, so the next cycle burns it too rather than
    // leaving it in the wallet forever.
    await repo.setPendingBurn(burnRaw).catch(() => {});
    return {
      ...base,
      bought: true,
      burned: false,
      tokensBought,
      buySignature: buy.signature,
      venue: buy.venue,
      error: err.shortMessage || err.message,
    };
  }
}

module.exports = {
  buybackAndBurn, buyToken, burnToken, applySlippage, describeOutcome,
  clampToBalance, BUY_ATTEMPTS, BURN_ATTEMPTS,
};
