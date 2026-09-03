'use strict';

// Pre-graduation the token has no pool — it trades against its own bonding
// curve.
//
// `buy(quoteIn, minTokensOut, recipient)` is payable, and on a NATIVE-quote
// launch the quote amount is passed both as the argument and as msg.value. This
// launch is not one of those: NEKO is quoted in NVDA, so `isNativeQuote()`
// is false, msg.value stays zero, and the curve pulls the NVDA with
// transferFrom — which means the wallet must approve the curve first.
//
// That approval is the whole difference between this file and the ETH-quoted
// version it was ported from, and forgetting it reverts the buy.

const { Contract, MaxUint256 } = require('ethers');
const { provider, wallet } = require('./provider');
const { CURVE_ABI, ERC20_ABI } = require('./abi');
const { readTokenBalance } = require('./erc20');
const { sendTx } = require('./send');

function curveAt(address, runner = provider) {
  return new Contract(address, CURVE_ABI, runner);
}

/** Constant-product quote against the curve's current reserves. */
async function quoteCurveOut({ curve, quoteAmountRaw }) {
  const [quoteReserve, tokenReserve] = await curveAt(curve).getReserves();
  if (quoteReserve <= 0n || tokenReserve <= 0n) return 0n;
  // x*y=k with no fee applied here; the curve charges feeBps internally, so the
  // caller's slippage tolerance absorbs the difference.
  return (quoteAmountRaw * tokenReserve) / (quoteReserve + quoteAmountRaw);
}

/**
 * Make sure the curve can pull `needed` of the quote asset. A plain ERC-20
 * allowance — the curve is not the UniversalRouter and does not use Permit2.
 */
async function ensureCurveAllowance({ curve, quoteToken, needed }) {
  const erc20 = new Contract(quoteToken, ERC20_ABI, provider);
  const allowance = await erc20.allowance(wallet.address, curve);
  if (allowance >= BigInt(needed)) return false;
  console.log(`[curve] approving ${quoteToken} to the curve ${curve}`);
  const tx = await sendTx(() => new Contract(quoteToken, ERC20_ABI, wallet).approve(curve, MaxUint256));
  await tx.wait();
  return true;
}

/**
 * Buy `token` from its curve with `quoteAmountRaw` of the quote asset.
 *
 * @param {{curve:string, token:string, quoteToken:string, quoteAmountRaw:bigint,
 *          minTokensOut:bigint, isNativeQuote?:boolean}} opts
 */
async function buyOnCurve({
  curve,
  token,
  quoteToken,
  quoteAmountRaw,
  minTokensOut,
  isNativeQuote = false,
}) {
  if (!isNativeQuote) {
    await ensureCurveAllowance({ curve, quoteToken, needed: quoteAmountRaw });
  }

  const before = await readTokenBalance(token, wallet.address);
  const tx = await sendTx(() =>
    curveAt(curve, wallet).buy(quoteAmountRaw, minTokensOut, wallet.address, {
      value: isNativeQuote ? quoteAmountRaw : 0n,
    })
  );
  await tx.wait();
  const after = await readTokenBalance(token, wallet.address);
  console.log(`[tx] buy ${token} on the curve: ${tx.hash}`);
  return { signature: tx.hash, tokensBoughtRaw: after - before };
}

module.exports = { curveAt, quoteCurveOut, buyOnCurve, ensureCurveAllowance };
