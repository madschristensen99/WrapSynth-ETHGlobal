// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

/**
 * @title BaseSepoliaAddresses
 * @notice Base Sepolia testnet contract addresses
 * @dev Uniswap V3 is not natively deployed on Base Sepolia; tests that need it
 *      must deploy V3 contracts in their setUp or use mock implementations.
 */
library BaseSepoliaAddresses {
    // WETH (canonical on Base Sepolia)
    address public constant WETH = 0x4200000000000000000000000000000000000006;

    // USDC (Base Sepolia testnet)
    address public constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    // Uniswap V3 — NOT deployed on Base Sepolia at standard addresses.
    // These must be deployed by tests/scripts if needed.
    address public constant UNI_V3_FACTORY = address(0);
    address public constant UNI_V3_POSITION_MANAGER = address(0);
    address public constant UNI_V3_SWAP_ROUTER_02 = address(0);
    address public constant UNI_V3_QUOTER_V2 = address(0);

    // Pyth Oracle (Base Sepolia)
    address public constant PYTH_ORACLE = address(0); // TODO: configure before deployment
}
