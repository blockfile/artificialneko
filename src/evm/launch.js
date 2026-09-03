'use strict';

// One read of the pons v2 launch record per cycle. Every phase decision
// downstream reads THIS object, so a cycle cannot half-believe it is on the
// curve and half-believe it is on the pool.

const { Contract } = require('ethers');
const config = require('../config');
const { provider } = require('./provider');
const { FACTORY_V2_ABI, CURVE_ABI } = require('./abi');
const { buildPoolKey, poolIdOf, NATIVE } = require('./pool');

function factory() {
  return new Contract(config.v2Factory, FACTORY_V2_ABI, provider);
}

function curveAt(address) {
  return new Contract(address, CURVE_ABI, provider);
}

async function getLaunch(token = config.tokenAddress) {
  if (!token) throw new Error('TOKEN_ADDRESS (NEKO) is required');

  if (config.dryRun) {
    return {
      token,
      curve: '0x00000000000000000000000000000000000c0f1e',
      deployer: config.wallet.address,
      creatorFeeRecipient: config.wallet.address,
      pairToken: NATIVE,
      graduationThreshold: 42n * 10n ** 17n, // 4.2 ETH
      poolFee: 0,
      tickSpacing: 200,
      creatorTaxBps: 100,
      buybackEnabled: false,
      exists: true,
      graduated: false,
      poolKey: null,
      poolId: null,
    };
  }

  const rec = await factory().getLaunchedToken(token);
  if (!rec.exists) throw new Error(`token ${token} was not launched via the pons v2 factory`);

  const graduated = await curveAt(rec.curve).graduated();

  // The pool only exists after graduation. Deriving a key before then would
  // produce a valid-looking id for a pool that has never been initialized.
  let poolKey = null;
  let poolId = null;
  if (graduated) {
    poolKey = buildPoolKey({
      token,
      quoteToken: rec.pairToken,
      fee: Number(rec.poolFee),
      tickSpacing: Number(rec.tickSpacing),
      hooks: config.memeHook,
    });
    poolId = poolIdOf(poolKey);
  }

  return {
    token,
    curve: rec.curve,
    deployer: rec.deployer,
    creatorFeeRecipient: rec.creatorFeeRecipient,
    pairToken: rec.pairToken,
    graduationThreshold: rec.graduationThreshold,
    poolFee: Number(rec.poolFee),
    tickSpacing: Number(rec.tickSpacing),
    creatorTaxBps: Number(rec.creatorTaxBps),
    buybackEnabled: rec.buybackEnabled,
    exists: true,
    graduated,
    poolKey,
    poolId,
  };
}

function describePhase(launch) {
  return launch && launch.graduated ? 'v4' : 'curve';
}

module.exports = { getLaunch, describePhase, curveAt, factory };
