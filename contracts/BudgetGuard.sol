// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "../lib/reactive-lib/src/interfaces/ISystemContract.sol";
import { IReactive } from "../lib/reactive-lib/src/interfaces/IReactive.sol";
import { AbstractReactive } from "../lib/reactive-lib/src/base/AbstractReactive.sol";

/// @title BudgetGuard (Reactive Lasna)
/// @notice Watches every AgentWallet on every chain, keeps ONE combined spend total,
///         and freezes all wallets everywhere the moment:
///           1. the combined spend for the window hits the limit, or
///           2. any wallet reports a blocked (policy-breaking) payment attempt.
///         No keeper, no bot, no server.
contract BudgetGuard is AbstractReactive {
    // keccak256("Spent(address,address,uint256,uint256)")
    uint256 public constant SPENT_TOPIC = uint256(keccak256("Spent(address,address,uint256,uint256)"));
    // keccak256("Blocked(address,address,uint256,uint8)")
    uint256 public constant BLOCKED_TOPIC = uint256(keccak256("Blocked(address,address,uint256,uint8)"));

    uint8 public constant REASON_BUDGET = 1; // combined daily budget used up
    uint8 public constant REASON_ATTACK = 2; // blocked attempt seen on some chain

    uint64 private constant CALLBACK_GAS_LIMIT = 300000;

    struct Wallet {
        uint256 chainId;
        address addr;
    }

    address public owner;
    uint256 public dailyLimit;
    uint256 public windowLength;
    uint256 public windowStart;
    uint256 public spentInWindow;

    bool public tripped;
    uint8 public trippedReason;
    uint256 public trippedOnChain;

    Wallet[] public wallets;
    mapping(bytes32 => bool) public isWallet;
    // windowStart => chainId => spent
    mapping(uint256 => mapping(uint256 => uint256)) public spentByChain;

    event WalletAdded(uint256 indexed chainId, address indexed wallet);
    event SpendRecorded(uint256 indexed chainId, address indexed wallet, uint256 amount, uint256 spentInWindow, uint256 dailyLimit);
    event AttackSeen(uint256 indexed chainId, address indexed wallet, address to, uint256 amount, uint8 reason);
    event Tripped(uint8 reason, uint256 originChainId, uint256 spentInWindow);
    event Resumed();
    event LimitUpdated(uint256 dailyLimit);
    event WindowRolled(uint256 windowStart);

    error NotOwner();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }

    constructor(uint256 dailyLimit_, uint256 windowLength_) payable {
        owner = msg.sender;
        dailyLimit = dailyLimit_;
        windowLength = windowLength_ == 0 ? 1 days : windowLength_;
        windowStart = block.timestamp;
        emit LimitUpdated(dailyLimit_);
    }

    // ------------------------------------------------------------------
    // Setup
    // ------------------------------------------------------------------

    /// @notice Register an AgentWallet and subscribe to its Spent + Blocked events.
    function addWallet(uint256 chainId_, address wallet_) external onlyOwner {
        bytes32 k = _key(chainId_, wallet_);
        require(!isWallet[k], "exists");
        isWallet[k] = true;
        wallets.push(Wallet(chainId_, wallet_));

        SYSTEM.subscribe(chainId_, wallet_, SPENT_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        SYSTEM.subscribe(chainId_, wallet_, BLOCKED_TOPIC, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        emit WalletAdded(chainId_, wallet_);
    }

    function setDailyLimit(uint256 limit_) external onlyOwner {
        dailyLimit = limit_;
        emit LimitUpdated(limit_);
    }

    /// @notice Owner clears the trip and sends unfreeze callbacks to every wallet.
    function resume() external onlyOwner {
        tripped = false;
        trippedReason = 0;
        trippedOnChain = 0;
        for (uint256 i = 0; i < wallets.length; i++) {
            _callback(wallets[i], abi.encodeWithSignature("unfreezeFromGuard(address)", address(0)));
        }
        emit Resumed();
    }

    /// @notice Start a fresh window right now (handy for demos).
    function resetWindow() external onlyOwner {
        _startWindow(block.timestamp);
    }

    // ------------------------------------------------------------------
    // Reactive entry point
    // ------------------------------------------------------------------

    /// @inheritdoc IReactive
    function react(LogRecord calldata log_) external onlySystem {
        if (!isWallet[_key(log_.chainId, log_.contractAddress)]) return;

        if (log_.topic0 == SPENT_TOPIC) {
            _rollWindowIfNeeded();
            (uint256 amount, ) = abi.decode(log_.data, (uint256, uint256));
            spentInWindow += amount;
            spentByChain[windowStart][log_.chainId] += amount;
            emit SpendRecorded(log_.chainId, log_.contractAddress, amount, spentInWindow, dailyLimit);

            if (!tripped && spentInWindow >= dailyLimit) {
                _trip(REASON_BUDGET, log_.chainId);
            }
        } else if (log_.topic0 == BLOCKED_TOPIC) {
            (uint256 amount, uint8 reason) = abi.decode(log_.data, (uint256, uint8));
            emit AttackSeen(log_.chainId, log_.contractAddress, address(uint160(log_.topic2)), amount, reason);
            if (!tripped) {
                _trip(REASON_ATTACK, log_.chainId);
            }
        }
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function walletCount() external view returns (uint256) { return wallets.length; }

    function status()
        external
        view
        returns (uint256 spent, uint256 limit, uint256 start, uint256 length, bool isTripped, uint8 reason, uint256 onChain)
    {
        bool expired = block.timestamp >= windowStart + windowLength;
        return (
            expired ? 0 : spentInWindow,
            dailyLimit,
            windowStart,
            windowLength,
            tripped,
            trippedReason,
            trippedOnChain
        );
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _trip(uint8 reason, uint256 originChainId) internal {
        tripped = true;
        trippedReason = reason;
        trippedOnChain = originChainId;
        emit Tripped(reason, originChainId, spentInWindow);
        for (uint256 i = 0; i < wallets.length; i++) {
            _callback(
                wallets[i],
                abi.encodeWithSignature("freeze(address,uint8,uint256)", address(0), reason, originChainId)
            );
        }
    }

    function _callback(Wallet storage w, bytes memory payload) internal {
        SYSTEM.requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0({
            chainId: w.chainId,
            recipient: w.addr,
            gasLimit: CALLBACK_GAS_LIMIT,
            payload: payload
        }));
    }

    function _rollWindowIfNeeded() internal {
        if (block.timestamp >= windowStart + windowLength) {
            // jump to the window that contains "now"
            uint256 elapsed = block.timestamp - windowStart;
            _startWindow(windowStart + (elapsed / windowLength) * windowLength);
        }
    }

    function _startWindow(uint256 start) internal {
        windowStart = start;
        spentInWindow = 0;
        emit WindowRolled(start);
    }

    function _key(uint256 chainId_, address a) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId_, a));
    }
}
