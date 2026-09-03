'use strict';

// ABIs for the pons v2 protocol and Uniswap v4 periphery on Robinhood Chain.
// Transcribed from VERIFIED sources on Blockscout, 2026-08-14:
//   PonsV2LaunchFactory  0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e
//   V2MemeHook           0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044
//   V2FeeEscrow          0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e
//   PonsV2BondingCurve   one per launch
// Struct field ORDER matters — abi.encode of PoolKey is what produces poolId.

const POOL_KEY_TYPE = '(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const EXACT_IN_SINGLE_TYPE =
  `(${POOL_KEY_TYPE} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`;
const QUOTE_SINGLE_TYPE = `(${POOL_KEY_TYPE} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)`;

const FACTORY_V2_ABI = [
  'function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))',
  'function feeEscrow() view returns (address)',
  'function memeHook() view returns (address)',
  'function buybackVault() view returns (address)',
  'function maxCreatorTaxBps() view returns (uint256)',
];

const CURVE_ABI = [
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sweepFees(uint256 minBuybackTokensOut)',
  'function graduated() view returns (bool)',
  'function readyToGraduate() view returns (bool)',
  'function isNativeQuote() view returns (bool)',
  'function pairToken() view returns (address)',
  'function token() view returns (address)',
  'function deployer() view returns (address)',
  'function feeEscrow() view returns (address)',
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function realQuoteReserve() view returns (uint256)',
  'function graduationThreshold() view returns (uint256)',
  'function quoteFeeBalance() view returns (uint256)',
  'function creatorTaxBalance() view returns (uint256)',
  'function buybackQuoteBalance() view returns (uint256)',
  'function protocolFeeShareBps() view returns (uint16)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function sellableTokens() view returns (uint256)',
  'error InternalSwapRequiresOperator()',
  'error NotFeeSweepOperator()',
];

// LaunchInfo field order, from V2MemeHook.sol:48.
const HOOK_ABI = [
  'function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)',
  'function launches(bytes32) view returns (bool registered, bool memecoinIsCurrency0, address memecoin, address quoteToken, address creator, address buybackCreatorRecipient, address protocolFeeRecipient, uint16 creatorTaxBps, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps, bool buybackEnabled)',
  'function pendingFees(bytes32, address) view returns (uint256)',
  'function pendingCreatorTax(bytes32, address) view returns (uint256)',
  'function pendingBuyback(bytes32, address) view returns (uint256)',
  'function poolManager() view returns (address)',
  'function feeEscrow() view returns (address)',
  'function feeSweepOperator() view returns (address)',
  'error InternalSwapRequiresOperator()',
  'error NotFeeSweepOperator()',
];

// V2FeeEscrow, taken from the verified contract at
// 0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e.
//
// `claimToken` is OVERLOADED on the deployed contract — `claimToken(address)`
// and `claimToken(address,uint256)` — so ONLY the one-arg form is declared
// here. With both present, ethers rejects a bare `.claimToken(token)` call as
// ambiguous and every call site would have to spell out the full signature.
//
// The native `claim()` / `balanceOf()` pair is kept for completeness but is
// never called by this project: NEKO is quoted in NVDA, so its fees land on
// the TOKEN ledger and the native one always reads zero.
const ESCROW_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function balanceOfToken(address, address) view returns (uint256)',
  'function claim() returns (uint256)',
  'function claimToken(address token) returns (uint256)',
  'event Claimed(address indexed recipient, uint256 amount)',
  'event ClaimedToken(address indexed recipient, address indexed token, uint256 amount)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function symbol() view returns (string)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  // pons v2 tokens expose a real burn. Verified against a live launch: calling
  // it reverts with ERC20InsufficientBalance rather than an unknown selector,
  // so the function exists. Burning REDUCES totalSupply, which a transfer to a
  // dead address does not — holders can see the supply shrink on the explorer.
  'function burn(uint256 value)',
];

// Permit2. The v4 UniversalRouter pulls ERC-20 inputs through Permit2 rather
// than a direct allowance, so paying with NVDA needs two approvals: a one-time
// ERC-20 approve of NVDA to Permit2, then a Permit2 allowance naming the router
// as spender. Native ETH needed neither, which is why this did not exist while
// the bot only ever spent ETH.
const PERMIT2_ABI = [
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
];

const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
];

// Quoting reverts internally to return its result, so it is NOT view — it must
// be reached with staticCall.
const V4_QUOTER_ABI = [
  `function quoteExactInputSingle(${QUOTE_SINGLE_TYPE} params) returns (uint256 amountOut, uint256 gasEstimate)`,
];

const STATE_VIEW_ABI = [
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128)',
];

const DISPERSE_ABI = [
  'function disperseToken(address token, address[] recipients, uint256[] values)',
];

module.exports = {
  POOL_KEY_TYPE, EXACT_IN_SINGLE_TYPE, QUOTE_SINGLE_TYPE,
  FACTORY_V2_ABI, CURVE_ABI, HOOK_ABI, ESCROW_ABI, ERC20_ABI,
  UNIVERSAL_ROUTER_ABI, V4_QUOTER_ABI, STATE_VIEW_ABI, DISPERSE_ABI, PERMIT2_ABI,
};
