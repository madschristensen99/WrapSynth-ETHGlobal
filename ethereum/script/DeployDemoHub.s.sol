// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Script.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {ChainlinkDataStreamsOracleFacet} from "../contracts/facets/ChainlinkDataStreamsOracleFacet.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
import {YieldFacet} from "../contracts/facets/YieldFacet.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {MockVerifierProxy} from "../contracts/mocks/MockVerifierProxy.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";

/**
 * @title DeployDemoHub
 * @notice Deploys a SECOND, demo-only WrapSynth hub on Base Sepolia whose oracle
 *         is backed by a {MockVerifierProxy} instead of the real Chainlink Data
 *         Streams verifier. This lets the CRE Liquidation Keeper demo crank the
 *         XMR price at will to push a vault below the 120% liquidation threshold —
 *         something we can't do against the live, real-price hub.
 *
 *         Everything else (facets, vault math, collateral) is identical to the
 *         production deployment, so the keeper workflow exercises the exact same
 *         getLiquidatableVaults / isVaultLiquidatable / liquidate / backstopVault
 *         code paths.
 *
 * Reuses the already-deployed MockSavingsDAI (GnosisAddresses.SDAI) as collateral
 * and MockWXDAI (GnosisAddresses.XDAI) as the underlying.
 *
 * Usage:
 *   forge script script/DeployDemoHub.s.sol --rpc-url https://sepolia.base.org --broadcast
 *
 * Demo feed IDs are arbitrary (the mock verifier echoes whatever price you set
 * for a given feed id); we reuse the production stream ids for readability.
 */
contract DeployDemoHub is Script {
    bytes32 constant XMR_USD_FEED_ID = 0x0003c70558bd921b1559d37b8e347797f121d1240e7386e68b2bee9b731b0833;
    bytes32 constant DAI_USD_FEED_ID = 0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        // Collateral is wxDAI (a plain ERC20 on Base Sepolia): depositCollateral
        // pulls this token and tracks it 1:1 as shares, matching the live hub +
        // the proven testFullCycleBaseSepolia flow.
        address collateral = GnosisAddresses.XDAI;

        require(collateral.code.length > 0, "Mock wxDAI not deployed; run DeployBaseSepolia Phase A first");

        console.log("============================================================");
        console.log("WrapSynth DEMO Hub (MockVerifierProxy / controllable prices)");
        console.log("============================================================");
        console.log("Deployer:  ", deployer);
        console.log("Collateral:", collateral);
        console.log("");

        vm.startBroadcast(deployerPrivateKey);

        MockVerifierProxy verifier = new MockVerifierProxy();
        console.log("MockVerifierProxy:", address(verifier));

        wsXMR wsxmr = new wsXMR();
        wsXmrHub hub = new wsXmrHub(address(wsxmr), address(verifier), collateral);

        ChainlinkDataStreamsOracleFacet oracleFacet = new ChainlinkDataStreamsOracleFacet(
            address(wsxmr), address(verifier), collateral, XMR_USD_FEED_ID, DAI_USD_FEED_ID
        );
        VaultFacet vaultFacet = new VaultFacet(address(wsxmr), address(verifier), collateral);
        MintFacet mintFacet = new MintFacet(address(wsxmr), address(verifier), collateral);
        BurnFacet burnFacet = new BurnFacet(address(wsxmr), address(verifier), collateral);
        LiquidationFacet liquidationFacet = new LiquidationFacet(address(wsxmr), address(verifier), collateral);
        YieldFacet yieldFacet = new YieldFacet(address(wsxmr), address(verifier), collateral);

        hub.registerFacets(
            address(vaultFacet),
            address(mintFacet),
            address(burnFacet),
            address(liquidationFacet),
            address(yieldFacet),
            address(oracleFacet)
        );
        wsxmr.setHub(address(hub));

        vm.stopBroadcast();

        console.log("wsXMR:            ", address(wsxmr));
        console.log("wsXmrHub (DEMO):  ", address(hub));
        console.log("OracleFacet:      ", address(oracleFacet));
        console.log("VaultFacet:       ", address(vaultFacet));
        console.log("MintFacet:        ", address(mintFacet));
        console.log("BurnFacet:        ", address(burnFacet));
        console.log("LiquidationFacet: ", address(liquidationFacet));
        console.log("YieldFacet:       ", address(yieldFacet));
        console.log("");

        // Write a demo manifest the JS demo scripts read.
        string memory obj = "demoHub";
        vm.serializeAddress(obj, "wsXmrHub", address(hub));
        vm.serializeAddress(obj, "wsXMR", address(wsxmr));
        vm.serializeAddress(obj, "mockVerifierProxy", address(verifier));
        vm.serializeAddress(obj, "collateral", collateral);
        vm.serializeAddress(obj, "wxDAI", collateral);
        vm.serializeBytes32(obj, "xmrFeedId", XMR_USD_FEED_ID);
        string memory json = vm.serializeBytes32(obj, "daiFeedId", DAI_USD_FEED_ID);
        vm.writeJson(json, "./deployment.demo-hub.json");

        console.log("Wrote ./deployment.demo-hub.json (read by scripts/demo/*.js)");
        console.log("");
        console.log("Next:");
        console.log("1. cd ethereum && node scripts/demo/demoForceLiquidation.js");
        console.log("2. (CRE) point cre/liquidation-keeper/config.*.json hubAddress at the DEMO hub");
        console.log("3. node scripts/demo/liquidate.js   OR   node scripts/demo/backstopVault.js");
    }
}
