'use strict';
const { JsonRpcProvider, Wallet } = require('ethers');
const config = require('../config');

// staticNetwork: the chain id never changes, so skip ethers' per-call
// eth_chainId round trip. On a load-balanced RPC that doubled every read.
const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
const wallet = new Wallet(config.wallet.privateKey, provider);

function walletAddress() {
  return wallet.address;
}

module.exports = { provider, wallet, walletAddress };
