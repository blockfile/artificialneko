// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Send one ERC-20 to many addresses in a single transaction.
 *
 * The airdrop otherwise sends one transfer per holder. That is fine at a few
 * hundred recipients and expensive at a few thousand: every transfer pays the
 * 21,000 gas base cost again, occupies its own nonce, and is its own chance to
 * be rate-limited or dropped by the RPC. Batching pays the base cost once.
 *
 * `pons-launcher/contracts/Disperse.sol` cannot be used for this — it disperses
 * native ETH only. This is its ERC-20 sibling, with the signature the bot
 * already calls:
 *
 *     disperseToken(address token, address[] recipients, uint256[] values)
 *
 * The caller must `approve()` this contract for the token first: it PULLS with
 * transferFrom rather than holding a balance.
 *
 * No owner, no admin, no upgrade path, nothing to rescue, and no balance held
 * between transactions — every unit moves from the caller to a recipient inside
 * one call, or the whole call reverts. That is deliberate. A disperser with
 * privileged functions is a disperser someone has to trust, and this one is
 * handling other people's rewards.
 */
contract TokenDisperser {
    error LengthMismatch(uint256 recipients, uint256 values);
    error NoRecipients();
    error TransferFailed(address token, address to, uint256 value);

    event Dispersed(address indexed token, address indexed from, uint256 recipients, uint256 total);

    /**
     * @param token      the ERC-20 to send
     * @param recipients who to send it to, in order
     * @param values     how much each receives, index-matched to `recipients`
     *
     * Reverts as a whole if any transfer fails, so a batch is all-or-nothing.
     * A partially-applied airdrop would be far worse than a failed one: the
     * caller could not tell who had already been paid without reading receipts.
     */
    function disperseToken(
        address token,
        address[] calldata recipients,
        uint256[] calldata values
    ) external {
        if (recipients.length != values.length) revert LengthMismatch(recipients.length, values.length);
        if (recipients.length == 0) revert NoRecipients();

        uint256 total;
        for (uint256 i; i < recipients.length; ++i) {
            total += values[i];
            _safeTransferFrom(token, msg.sender, recipients[i], values[i]);
        }

        emit Dispersed(token, msg.sender, recipients.length, total);
    }

    /**
     * transferFrom that treats a silent failure as a failure.
     *
     * A standard ERC-20 returns a bool, but plenty of real tokens return
     * nothing at all, and a few return false instead of reverting. Trusting the
     * call's success flag alone would let a token that quietly refuses look
     * like a completed airdrop — the caller would mark holders paid who never
     * received anything.
     */
    function _safeTransferFrom(address token, address from, address to, uint256 value) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(bytes4(keccak256("transferFrom(address,address,uint256)")), from, to, value)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TransferFailed(token, to, value);
        }
    }
}
