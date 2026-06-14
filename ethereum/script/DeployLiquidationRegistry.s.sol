// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {LiquidationAlertRegistry} from "../contracts/keeper/LiquidationAlertRegistry.sol";

/**
 * @title DeployLiquidationRegistry
 * @notice Deploys the {LiquidationAlertRegistry} that the Chainlink CRE
 *         "Liquidation Keeper" workflow writes to on Base Sepolia.
 *
 * Env vars:
 *   PRIVATE_KEY   - deployer key (hex, 0x-prefixed)
 *   HUB_ADDRESS   - wsXmrHub address (defaults to the live Base Sepolia hub)
 *   FORWARDER     - Chainlink Forwarder allowed to call onReport.
 *                   Defaults to address(0) (permissionless onReport).
 *                   Base Sepolia production forwarder:
 *                     0xF8344CFd5c43616a4366C34E3EEE75af79a74482
 *                   Base Sepolia simulation (mock) forwarder:
 *                     0x82300bd7c3958625581cc2f77bc6464dcecdf3e5
 *
 * Usage:
 *   forge script script/DeployLiquidationRegistry.s.sol \
 *     --rpc-url https://sepolia.base.org --broadcast
 */
contract DeployLiquidationRegistry is Script {
    // Live Base Sepolia wsXmrHub (see deployment.base-sepolia.json).
    address constant DEFAULT_HUB = 0x65D3b7ff17DFa21fd6BB1553D51336b66548a1C3;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address hub = vm.envOr("HUB_ADDRESS", DEFAULT_HUB);
        address forwarder = vm.envOr("FORWARDER", address(0));

        console.log("Deploying LiquidationAlertRegistry");
        console.log("  hub:      ", hub);
        console.log("  forwarder:", forwarder);

        vm.startBroadcast(deployerPrivateKey);
        LiquidationAlertRegistry registry = new LiquidationAlertRegistry(hub, forwarder);
        vm.stopBroadcast();

        console.log("LiquidationAlertRegistry:", address(registry));
        console.log("");
        console.log("Next steps:");
        console.log("1. Put this address in cre/liquidation-keeper/config.*.json -> registryAddress");
        console.log("2. (optional) After the CRE workflow is deployed, lock onReport down");
        console.log("   to the real forwarder via registry.setForwarder(<forwarder>)");
    }
}
