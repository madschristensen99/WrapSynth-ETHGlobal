// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ed25519} from "../Ed25519.sol";

contract Ed25519Helper {
    function scalarMultBase(uint256 scalar) external view returns (uint256 x, uint256 y) {
        return Ed25519.scalarMultBase(scalar);
    }

    function computeCommitment(bytes32 secret) external view returns (bytes32) {
        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(secret));
        return keccak256(abi.encodePacked(px, py));
    }

    function compressPublicKey(uint256 px, uint256 py) external pure returns (uint256) {
        return Ed25519.compressPoint(px, py);
    }
}
