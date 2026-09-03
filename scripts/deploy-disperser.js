'use strict';

// Compile and deploy contracts/TokenDisperser.sol.
//
//   node scripts/deploy-disperser.js            # compile only, print the bytecode size
//   node scripts/deploy-disperser.js --confirm  # actually deploy (sends a transaction)
//
// Requires solc, which is NOT a dependency of this project — it is needed once,
// for a deployment that happens once:
//
//   npm i solc --no-save
//
// Compiled against evmVersion "paris" on purpose. Later targets emit PUSH0,
// which some chains and forks do not implement; paris avoids it at no
// meaningful cost, and a disperser that reverts on every call because of an
// unsupported opcode is a bad way to find out.

const fs = require('node:fs');
const path = require('node:path');
const { ContractFactory, formatEther } = require('ethers');
const config = require('../src/config');
const { provider, wallet } = require('../src/evm/provider');

const SOURCE = path.join(__dirname, '..', 'contracts', 'TokenDisperser.sol');
const NAME = 'TokenDisperser';

function compile() {
  let solc;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    solc = require('solc');
  } catch (_err) {
    console.error('solc is not installed. It is needed only for this one-off deployment:\n');
    console.error('    npm i solc --no-save\n');
    process.exit(1);
  }

  const source = fs.readFileSync(SOURCE, 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'TokenDisperser.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };

  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage);
    process.exit(1);
  }
  for (const w of (out.errors || []).filter((e) => e.severity !== 'error')) {
    console.warn(w.formattedMessage);
  }

  const c = out.contracts['TokenDisperser.sol'][NAME];
  return { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}`, solcVersion: solc.version() };
}

async function main() {
  const confirm = process.argv.includes('--confirm');

  const { abi, bytecode, solcVersion } = compile();
  console.log(`compiled ${NAME}`);
  console.log(`  solc      : ${solcVersion}`);
  console.log(`  bytecode  : ${(bytecode.length - 2) / 2} bytes`);
  console.log(`  functions : ${abi.filter((f) => f.type === 'function').map((f) => f.name).join(', ')}`);

  if (!confirm) {
    console.log('\nDry run — nothing sent. Re-run with --confirm to deploy.');
    return;
  }

  const net = await provider.getNetwork();
  const balance = await provider.getBalance(wallet.address);
  console.log('\ndeploying');
  console.log(`  chain     : ${Number(net.chainId)}`);
  console.log(`  from      : ${wallet.address}`);
  console.log(`  balance   : ${formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.error('\nThat wallet has no ETH — fund it before deploying.');
    process.exit(1);
  }

  const factory = new ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy();
  console.log(`  tx        : ${contract.deploymentTransaction().hash}`);
  await contract.waitForDeployment();
  const address = await contract.getAddress();

  console.log(`\n✅ deployed at ${address}`);
  console.log('\nNext:');
  console.log(`  1. put it in .env  ->  DISPERSE_ADDRESS=${address}`);
  console.log('  2. pm2 restart artificialneko-bot --update-env');
  console.log(`  3. the bot approves ${config.quoteSymbol || 'NVDA'} to it automatically on the next airdrop`);
}

main().catch((err) => {
  console.error('\ndeploy failed:', err.shortMessage || err.message);
  process.exit(1);
});
