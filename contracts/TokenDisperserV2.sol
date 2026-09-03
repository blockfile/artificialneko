// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Send one ERC-20 to many addresses, WITHOUT the payer appearing as the sender
 * of every transfer.
 *
 * TokenDisperser (v1) pulls straight from the caller to each recipient:
 *
 *     transferFrom(payer, recipient[i], value[i])
 *
 * which is cheap and correct, but records `from = payer` on all N Transfer
 * events. Repeated every cycle across 160+ holders, that draws a star on
 * bubblemap tools centred on the operator's wallet — the shape used to argue a
 * token is sybil-distributed or insider-controlled. It is a reporting artifact
 * of the pull, not a fact about the distribution, but it is what people see.
 *
 * So take custody for the length of the call instead: pull the total ONCE, then
 * pay each recipient from this contract's own balance.
 *
 *     transferFrom(payer, address(this), total)   // 1 event from the payer
 *     transfer(recipient[i], value[i])            // N events from this contract
 *
 * pons's own fee-sharing distributor works this way — verified on-chain, a
 * 99-recipient payout whose transfers all originate at the distributor while
 * the keeper wallet only pays gas.
 *
 * Same `disperseToken` signature as v1, so switching is an address change and
 * nothing more.
 *
 * Custody lasts only for the transaction. The pull is for exactly the sum of
 * the payouts, every unit is forwarded before the call returns, and any failure
 * reverts the whole batch. There is no owner, no admin, no upgrade path and no
 * way to move a balance that outlives the call -- so a stray balance sent here
 * by mistake is unrecoverable, which is the price of having nothing privileged.
 */
contract TokenDisperserV2 {
    error LengthMismatch(uint256 recipients, uint256 values);
    error NoRecipients();
    error PullFailed(address token, address from, uint256 total);
    error TransferFailed(address token, address to, uint256 value);

    event Dispersed(address indexed token, address indexed from, uint256 recipients, uint256 total);

    /**
     * @param token      the ERC-20 to send
     * @param recipients who to send it to, in order
     * @param values     how much each receives, index-matched to `recipients`
     *
     * The caller must `approve()` this contract for at least the sum of
     * `values` first. All-or-nothing: a partially applied airdrop would leave
     * the caller unable to tell who had already been paid.
     */
    function disperseToken(
        address token,
        address[] calldata recipients,
        uint256[] calldata values
    ) external {
        if (recipients.length != values.length) revert LengthMismatch(recipients.length, values.length);
        if (recipients.length == 0) revert NoRecipients();

        uint256 total;
        for (uint256 i; i < recipients.length; ++i) total += values[i];

        // One inbound transfer, so the payer shows a single edge per batch.
        if (!_call(token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), total))) {
            revert PullFailed(token, msg.sender, total);
        }

        for (uint256 i; i < recipients.length; ++i) {
            // transfer(), not transferFrom(): the tokens are ours right now, and
            // that is the entire point -- it is what puts this contract in the
            // `from` field instead of the caller.
            if (!_call(token, abi.encodeWithSelector(0xa9059cbb, recipients[i], values[i]))) {
                revert TransferFailed(token, recipients[i], values[i]);
            }
        }

        emit Dispersed(token, msg.sender, recipients.length, total);
    }

    /**
     * A call that treats a silent failure as a failure.
     *
     * Plenty of real ERC-20s return nothing, and a few return false rather than
     * reverting. Trusting the call's success flag alone would let a token that
     * quietly refuses look like a completed airdrop.
     */
    function _call(address token, bytes memory payload) private returns (bool) {
        (bool ok, bytes memory data) = token.call(payload);
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }
}
