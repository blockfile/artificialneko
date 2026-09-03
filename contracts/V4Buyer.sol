// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Buy a token from a Uniswap v4 pool, talking to the PoolManager directly.
 *
 * The UniversalRouter cannot do this for a pons pool whose quote asset is an
 * ERC-20: NVDA -> NEKO reverts with empty data at every size, in both swap
 * directions, under every action ordering, with the wallet funded and Permit2
 * fully approved. The same router handles NVDA -> ETH on a hookless pool and
 * ETH -> memecoin on the same pons hook, so the failure is specific to
 * ERC-20-in + hooked-pool. The V4Quoter executes that exact swap — hook and all
 * — without complaint, which places the fault after the swap, in the router's
 * settlement, not in the pool.
 *
 * So this skips the router. Pull the input, unlock the PoolManager, swap,
 * settle what we owe, take what we are owed, and forward it. No allowances to
 * anything but this contract, no Permit2, no aggregator.
 *
 * No owner and no admin. It holds nothing between calls: every unit that comes
 * in is spent or returned inside the same transaction.
 */
interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

contract V4Buyer {
    // Pinned rather than passed in: this address is the one thing that makes the
    // contract chain-specific, and a buyer pointed at the wrong PoolManager
    // would take funds and swap them somewhere nobody intended.
    IPoolManager public constant poolManager = IPoolManager(0x8366a39CC670B4001A1121B8F6A443A643e40951);

    // v4 TickMath bounds; a swap must name a limit strictly inside them.
    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

    error NotPoolManager();
    error TooLittleReceived(uint256 got, uint256 minimum);
    error TransferFailed();
    error Overspend(uint256 owed, uint256 authorised);

    struct CallbackData {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        address payer;
        address recipient;
    }

    /**
     * Swap `amountIn` of the pool's input currency for at least `minAmountOut`
     * of the other, delivered to `recipient`.
     *
     * The caller must approve this contract for the input token first. Reverts
     * as a whole if the output falls short, so a bad price cannot quietly spend
     * the funds.
     */
    function buy(
        PoolKey calldata key,
        bool zeroForOne,
        uint128 amountIn,
        uint128 minAmountOut,
        address recipient
    ) external returns (uint256 amountOut) {
        bytes memory res = poolManager.unlock(
            abi.encode(CallbackData(key, zeroForOne, amountIn, msg.sender, recipient))
        );
        amountOut = abi.decode(res, (uint256));
        if (amountOut < minAmountOut) revert TooLittleReceived(amountOut, minAmountOut);
    }

    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        CallbackData memory d = abi.decode(raw, (CallbackData));

        address currencyIn = d.zeroForOne ? d.key.currency0 : d.key.currency1;
        address currencyOut = d.zeroForOne ? d.key.currency1 : d.key.currency0;

        int256 delta = poolManager.swap(
            d.key,
            SwapParams({
                zeroForOne: d.zeroForOne,
                // negative = exact input
                amountSpecified: -int256(uint256(d.amountIn)),
                sqrtPriceLimitX96: d.zeroForOne ? MIN_SQRT_PRICE + 1 : MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // BalanceDelta packs amount0 in the high 128 bits, amount1 in the low.
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        int128 outDelta = d.zeroForOne ? amount1 : amount0;
        // The hook's afterSwap takes its cut of the output before we see it, so
        // this is already net of the fee — which is exactly what we want to take.
        uint256 amountOut = outDelta > 0 ? uint256(uint128(outDelta)) : 0;

        // Pay in exactly what the swap consumed, which is not always the whole
        // input: a swap stopped by the price limit leaves part unspent, and
        // settling the full amount would hand the difference to the pool with
        // no way to get it back. Never more than the caller authorised.
        int128 inDelta = d.zeroForOne ? amount0 : amount1;
        uint256 owed = inDelta < 0 ? uint256(uint128(-inDelta)) : 0;
        if (owed > d.amountIn) revert Overspend(owed, d.amountIn);

        poolManager.sync(currencyIn);
        if (owed != 0) {
            if (!IERC20(currencyIn).transferFrom(d.payer, address(poolManager), owed)) {
                revert TransferFailed();
            }
        }
        poolManager.settle();

        // Collect the output.
        if (amountOut != 0) poolManager.take(currencyOut, d.recipient, amountOut);

        return abi.encode(amountOut);
    }
}
