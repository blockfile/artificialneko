'use strict';

// What is claimable right now — WITHOUT a private key.
//
//   node scripts/claimable.js                 # uses TOKEN_ADDRESS from .env
//   node scripts/claimable.js 0xTOKEN         # or an explicit token
//
// `npm run check` is the fuller preflight, but it requires DRY_RUN=false, and
// evm/provider builds a signer at module load — so checking the chain means
// putting the wallet key on the box first. That is the wrong order: you want to
// confirm the launch pays the address you think it does BEFORE the key for that
// address is sitting in a file on a server.
//
// So this reads only. It never constructs a Wallet, never signs, never sends.
//
// The three contracts answer three different questions, and it is easy to look
// at the wrong one:
//
//   FACTORY  who gets the fees, and where this launch's curve lives
//   ESCROW   what is claimable RIGHT NOW  (claimToken happens here, not on the
//            factory — the factory has no claim function at all)
//   CURVE    what is pending, i.e. earned but not yet swept into the escrow

const { JsonRpcProvider, Contract, formatUnits, isAddress } = require('ethers');
const config = require('../src/config');
const { FACTORY_V2_ABI, CURVE_ABI, ESCROW_ABI } = require('../src/evm/abi');
const { getQuotePrice } = require('../src/services/quoteprice');

const show = (v) => (v === null || v === undefined ? '—' : v);
const hr = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 60 - t.length))}`);

const BPS = 10000n;

/**
 * The creator's share of a pending bucket, after the protocol's cut.
 * Transcribed from PonsV2BondingCurve._sweepFees — the same arithmetic as
 * src/evm/sweep.js, repeated here only because importing that module pulls in
 * evm/provider, which needs a key. sweep.js remains the source of truth.
 */
function creatorShareRaw(pendingRaw, protocolFeeShareBps) {
  const pending = BigInt(pendingRaw);
  if (pending <= 0n) return 0n;
  return (pending * (BPS - BigInt(protocolFeeShareBps))) / BPS;
}

async function main() {
  const token = (process.argv[2] || config.tokenAddress || '').trim().toLowerCase();
  if (!token) {
    console.error('No token. Pass one:  node scripts/claimable.js 0xTOKEN');
    console.error('(or set TOKEN_ADDRESS in .env)');
    process.exit(1);
  }
  if (!isAddress(token)) {
    console.error(`Not an address: ${token}`);
    process.exit(1);
  }

  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
  const factory = new Contract(config.v2Factory, FACTORY_V2_ABI, provider);

  hr('LAUNCH (from the factory)');
  let rec;
  try {
    rec = await factory.getLaunchedToken(token);
  } catch (err) {
    console.error(`  could not read the launch record: ${err.shortMessage || err.message}`);
    console.error(`  RPC ${config.rpcUrl} · factory ${config.v2Factory}`);
    process.exit(1);
  }
  if (!rec.exists) {
    console.error(`  ${token} was not launched via the pons v2 factory.`);
    process.exit(1);
  }

  const curve = new Contract(rec.curve, CURVE_ABI, provider);
  const graduated = await curve.graduated();

  console.log(`  token      : ${token}`);
  console.log(`  phase      : ${graduated ? 'v4 (graduated)' : 'curve (pre-graduation)'}`);
  console.log(`  curve      : ${rec.curve}`);
  console.log(`  pairToken  : ${rec.pairToken}`);
  console.log(`  feeRecip.  : ${rec.creatorFeeRecipient}`);
  console.log(
    `  buyback    : ${rec.buybackEnabled ? 'ENABLED — ⚠️ this bot cannot sweep; pons\'s operator must' : 'disabled (the bot can sweep)'}`
  );

  // Whoever the launch names is who the escrow pays. Checking any other address
  // answers a question nobody asked.
  const recipient = rec.creatorFeeRecipient;

  hr('ESCROW — claimable RIGHT NOW');
  const escrow = new Contract(config.feeEscrow, ESCROW_ABI, provider);
  const inEscrowRaw = await escrow.balanceOfToken(recipient, config.quoteTokenAddress);
  const inEscrow = Number(formatUnits(inEscrowRaw, config.quoteDecimals));
  console.log(`  escrow     : ${config.feeEscrow}`);
  console.log(`  recipient  : ${recipient}`);
  console.log(`  claimable  : ${inEscrow} ${config.quoteSymbol}`);

  hr('CURVE — pending, earned but NOT yet swept');
  let pending = 0;
  if (graduated) {
    console.log('  graduated — fees now accrue on the hook, not the curve.');
    console.log('  Post-graduation the creator usually cannot sweep: a BUY takes its fee');
    console.log("  in the memecoin, which locks the sweep to pons's operator. The fees are");
    console.log('  not lost — the operator moves them to the escrow and the bot claims them.');
  } else {
    const [quoteFee, tax, buyback, protocolBps] = await Promise.all([
      curve.quoteFeeBalance(),
      curve.creatorTaxBalance(),
      curve.buybackQuoteBalance(),
      curve.protocolFeeShareBps(),
    ]);
    const bucket = creatorShareRaw(quoteFee, Number(protocolBps));
    const earmark = rec.buybackEnabled ? (buyback < bucket ? buyback : bucket) : 0n;
    const pendingRaw = bucket - earmark + tax;
    pending = Number(formatUnits(pendingRaw, config.quoteDecimals));
    console.log(`  pending    : ${pending} ${config.quoteSymbol}  ("Collect curve fees" moves this to the escrow)`);
    console.log(`  protocol   : ${Number(protocolBps) / 100}% of fees before the creator's share`);
  }

  hr('AGAINST YOUR TRIGGER');
  const total = inEscrow + pending;
  let priceUsd = null;
  try {
    priceUsd = (await getQuotePrice()).priceUsd;
  } catch (err) {
    console.log(`  ⚠️ ${config.quoteSymbol} price unavailable (${err.message}) — the bot HOLDS rather than claiming blind`);
  }
  const usd = typeof priceUsd === 'number' ? total * priceUsd : null;
  console.log(`  total      : ${total} ${config.quoteSymbol}${usd === null ? '' : ` ≈ $${usd.toFixed(2)}`}`);
  console.log(`  threshold  : $${config.claimEveryUsd}  on "${config.triggerSchedule}"`);
  if (usd !== null) {
    console.log(
      `  verdict    : ${usd >= config.claimEveryUsd ? 'READY — the next trigger tick will fire' : `holding — $${(config.claimEveryUsd - usd).toFixed(2)} short`}`
    );
  }
  console.log(`  price      : ${show(priceUsd === null ? null : `$${priceUsd}`)} per ${config.quoteSymbol}`);
  console.log('');
}

main().catch((err) => {
  console.error('\nfailed:', err.shortMessage || err.message);
  process.exit(1);
});
