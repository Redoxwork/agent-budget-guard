// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "../lib/reactive-lib/src/interfaces/IPayable.sol";
import { AbstractCallback } from "../lib/reactive-lib/src/base/AbstractCallback.sol";

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title AgentWallet
/// @notice The wallet an AI agent spends from. One per chain (Base Sepolia, Unichain Sepolia).
///         Local rules (allowlist, per-payment cap) are checked here, synchronously.
///         The cross-chain daily budget is enforced by BudgetGuard on Reactive Network,
///         which can freeze every AgentWallet at once through a Reactive callback.
contract AgentWallet is AbstractCallback {
    // ---- reasons ----
    uint8 public constant BLOCK_NOT_ALLOWED = 1;   // recipient not on allowlist
    uint8 public constant BLOCK_OVER_TX_CAP = 2;   // single payment too big

    IERC20Min public immutable token;
    address public owner;
    address public agent;

    bool public frozen;
    uint8 public frozenReason;
    uint256 public perTxCap;
    uint256 public nonce;
    mapping(address => bool) public allowed;

    event Spent(address indexed agent, address indexed to, uint256 amount, uint256 nonce);
    event Blocked(address indexed agent, address indexed to, uint256 amount, uint8 reason);
    event Frozen(uint8 reason, uint256 originChainId);
    event Unfrozen();
    event PolicyUpdated(uint256 perTxCap);
    event RecipientSet(address indexed who, bool ok, string label);
    event AgentSet(address indexed agent);

    error NotOwner();
    error NotAgent();
    error WalletFrozen(uint8 reason);
    error NotCallbackProxy();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier onlyAgent() { if (msg.sender != agent) revert NotAgent(); _; }

    /// @dev Checks BOTH that the tx came through this chain's Reactive callback proxy
    ///      and that the injected sender is our BudgetGuard.
    modifier onlyGuard(address rvmSender) {
        if (msg.sender != address(_SERVICE_PROVIDER)) revert NotCallbackProxy();
        _onlyCallbackSender(rvmSender);
        _;
    }

    /// @param callbackProxy_ Reactive callback proxy on this chain.
    /// @param guard_         BudgetGuard address on Reactive Lasna.
    constructor(
        IPayable callbackProxy_,
        address guard_,
        IERC20Min token_,
        address agent_,
        uint256 perTxCap_
    ) payable AbstractCallback(callbackProxy_, guard_) {
        owner = msg.sender;
        token = token_;
        agent = agent_;
        perTxCap = perTxCap_;
        emit AgentSet(agent_);
        emit PolicyUpdated(perTxCap_);
    }

    // ------------------------------------------------------------------
    // Agent
    // ------------------------------------------------------------------

    /// @notice Agent pays someone. Policy breaks don't revert: they emit `Blocked`
    ///         so Reactive sees the attempt and can freeze every chain.
    function spend(address to, uint256 amount) external onlyAgent returns (bool) {
        if (frozen) revert WalletFrozen(frozenReason);

        if (!allowed[to]) {
            emit Blocked(msg.sender, to, amount, BLOCK_NOT_ALLOWED);
            return false;
        }
        if (amount > perTxCap) {
            emit Blocked(msg.sender, to, amount, BLOCK_OVER_TX_CAP);
            return false;
        }

        require(token.transfer(to, amount), "transfer failed");
        emit Spent(msg.sender, to, amount, ++nonce);
        return true;
    }

    // ------------------------------------------------------------------
    // Reactive callbacks
    // ------------------------------------------------------------------

    function freeze(address rvmSender, uint8 reason, uint256 originChainId) external onlyGuard(rvmSender) {
        frozen = true;
        frozenReason = reason;
        emit Frozen(reason, originChainId);
    }

    function unfreezeFromGuard(address rvmSender) external onlyGuard(rvmSender) {
        _unfreeze();
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    function unfreeze() external onlyOwner { _unfreeze(); }

    function setPerTxCap(uint256 cap) external onlyOwner {
        perTxCap = cap;
        emit PolicyUpdated(cap);
    }

    function setRecipient(address who, bool ok, string calldata label) external onlyOwner {
        allowed[who] = ok;
        emit RecipientSet(who, ok, label);
    }

    function setAgent(address agent_) external onlyOwner {
        agent = agent_;
        emit AgentSet(agent_);
    }

    /// @notice Owner pulls funds out (works even when frozen — funds, never stuck).
    function withdraw(address to, uint256 amount) external onlyOwner {
        require(token.transfer(to, amount), "transfer failed");
    }

    function withdrawGas(address payable to, uint256 amount) external onlyOwner {
        _pay(to, amount);
    }

    function _unfreeze() internal {
        frozen = false;
        frozenReason = 0;
        emit Unfrozen();
    }
}
