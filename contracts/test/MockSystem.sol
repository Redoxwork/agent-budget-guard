// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "../../lib/reactive-lib/src/interfaces/ISystemContract.sol";

/// @dev Test-only stand-in for Reactive's system contract at 0x8888…8888.
///      Records subscriptions and callback requests so tests can replay them.
contract MockSystem {
    struct Sub { address sub; uint256 chainId; address c; uint256 t0; }
    Sub[] public subs;

    event CallbackRequested(address indexed sender, uint256 chainId, address recipient, uint64 gasLimit, bytes payload);

    function subscribe(uint256 chainId_, address contract_, uint256 topic0_, uint256, uint256, uint256) external {
        subs.push(Sub(msg.sender, chainId_, contract_, topic0_));
    }

    function unsubscribe(uint256, address, uint256, uint256, uint256, uint256) external {}

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory c) external {
        emit CallbackRequested(msg.sender, c.chainId, c.recipient, c.gasLimit, c.payload);
    }

    function subCount() external view returns (uint256) { return subs.length; }

    function debt(address) external pure returns (uint256) { return 0; }
    receive() external payable {}
}
