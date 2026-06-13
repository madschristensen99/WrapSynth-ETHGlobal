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
import {MockWXDAI} from "../contracts/mocks/MockWXDAI.sol";
import {MockSavingsDAI} from "../contracts/mocks/MockSavingsDAI.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title DeployBaseSepolia
 * @notice ETHGlobal hackathon deployment: WrapSynth on Base Sepolia with
 *         Chainlink Data Streams as the bridging oracle.
 *
 * Two-phase deployment (facets bake GnosisAddresses.XDAI/SDAI into bytecode):
 *
 *   Phase A — collateral mocks are not yet at the addresses in GnosisAddresses.sol:
 *     deploys MockWXDAI + MockSavingsDAI and prints the constants to paste into
 *     contracts/GnosisAddresses.sol (XDAI / SDAI). Re-run after updating.
 *
 *   Phase B — constants point at deployed mocks:
 *     deploys wsXMR, hub, and all facets (with ChainlinkDataStreamsOracleFacet),
 *     registers facets, and prints the deployment summary.
 *
 * Usage:
 *   forge script script/DeployBaseSepolia.s.sol --rpc-url base_sepolia --broadcast
 *
 * After Phase B:
 *   - Fund the hub with Base Sepolia LINK (faucets.chain.link) to pay Data
 *     Streams verification fees.
 *   - Push an initial price via the frontend or cast (see report-proxy README).
 */
contract DeployBaseSepolia is Script {
    // Chainlink Data Streams on Base Sepolia
    // Verifier proxy: https://docs.chain.link/data-streams/crypto-streams (Stream Addresses)
    address constant VERIFIER_PROXY = 0x8Ac491b7c118a0cdcF048e0f707247fD8C9575f9;
    // LINK token on Base Sepolia
    address constant LINK = 0xE4aB69C077896252FAFBD49EFD26B5D171A32410;

    // Stream IDs served by the testnet data engine
    bytes32 constant XMR_USD_FEED_ID = 0x0003c70558bd921b1559d37b8e347797f121d1240e7386e68b2bee9b731b0833; // XMR/USD-RefPrice-testnet-production
    bytes32 constant ETH_USD_FEED_ID = 0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782; // ETH/USD-RefPrice-testnet-production

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("============================================================");
        console.log("WrapSynth Base Sepolia Deployment (Chainlink Data Streams)");
        console.log("============================================================");
        console.log("Deployer:", deployer);
        console.log("Balance:", deployer.balance / 1e15, "milli-ETH");
        console.log("");

        // ---------- Phase A: collateral mocks ----------
        if (GnosisAddresses.XDAI.code.length == 0 || GnosisAddresses.SDAI.code.length == 0) {
            console.log("Phase A: collateral mocks missing at GnosisAddresses constants.");
            console.log("Deploying MockWXDAI + MockSavingsDAI...");

            vm.startBroadcast(deployerPrivateKey);
            MockWXDAI wxdai = new MockWXDAI();
            MockSavingsDAI sdai = new MockSavingsDAI(address(wxdai));
            vm.stopBroadcast();

            console.log("");
            console.log("MockWXDAI:     ", address(wxdai));
            console.log("MockSavingsDAI:", address(sdai));
            console.log("");
            console.log("ACTION REQUIRED: update contracts/GnosisAddresses.sol:");
            console.log("  XDAI = <MockWXDAI address above>");
            console.log("  SDAI = <MockSavingsDAI address above>");
            console.log("Then re-run this script for Phase B.");
            return;
        }

        // ---------- Phase B: protocol ----------
        console.log("Phase B: deploying protocol...");
        vm.startBroadcast(deployerPrivateKey);

        wsXMR wsxmr = new wsXMR();
        console.log("wsXMR:            ", address(wsxmr));

        // Collateral on Base Sepolia is wxDAI (plain ERC20, tracked 1:1 as shares).
        address collateral = GnosisAddresses.XDAI;

        wsXmrHub hub = new wsXmrHub(address(wsxmr), VERIFIER_PROXY, collateral);
        console.log("wsXmrHub:         ", address(hub));

        ChainlinkDataStreamsOracleFacet oracleFacet = new ChainlinkDataStreamsOracleFacet(
            address(wsxmr), VERIFIER_PROXY, collateral, XMR_USD_FEED_ID, ETH_USD_FEED_ID
        );
        console.log("OracleFacet:      ", address(oracleFacet));

        VaultFacet vaultFacet = new VaultFacet(address(wsxmr), VERIFIER_PROXY, collateral);
        console.log("VaultFacet:       ", address(vaultFacet));

        MintFacet mintFacet = new MintFacet(address(wsxmr), VERIFIER_PROXY, collateral);
        console.log("MintFacet:        ", address(mintFacet));

        BurnFacet burnFacet = new BurnFacet(address(wsxmr), VERIFIER_PROXY, collateral);
        console.log("BurnFacet:        ", address(burnFacet));

        LiquidationFacet liquidationFacet = new LiquidationFacet(address(wsxmr), VERIFIER_PROXY, collateral);
        console.log("LiquidationFacet: ", address(liquidationFacet));

        YieldFacet yieldFacet = new YieldFacet(address(wsxmr), VERIFIER_PROXY, collateral);
        console.log("YieldFacet:       ", address(yieldFacet));

        hub.registerFacets(
            address(vaultFacet),
            address(mintFacet),
            address(burnFacet),
            address(liquidationFacet),
            address(yieldFacet),
            address(oracleFacet)
        );
        console.log("Facets registered");

        wsxmr.setHub(address(hub));
        console.log("Hub set as wsXMR minter");

        vm.stopBroadcast();

        uint256 hubLink = IERC20(LINK).balanceOf(address(hub));

        console.log("");
        console.log("============================================================");
        console.log("DEPLOYMENT SUMMARY (Base Sepolia, ChainID 84532)");
        console.log("============================================================");
        console.log("wsXMR:            ", address(wsxmr));
        console.log("wsXmrHub:         ", address(hub));
        console.log("OracleFacet:      ", address(oracleFacet));
        console.log("VaultFacet:       ", address(vaultFacet));
        console.log("MintFacet:        ", address(mintFacet));
        console.log("BurnFacet:        ", address(burnFacet));
        console.log("LiquidationFacet: ", address(liquidationFacet));
        console.log("YieldFacet:       ", address(yieldFacet));
        console.log("WXDAI (mock):     ", GnosisAddresses.XDAI);
        console.log("sDAI (mock):      ", GnosisAddresses.SDAI);
        console.log("VerifierProxy:    ", VERIFIER_PROXY);
        console.log("LINK:             ", LINK);
        console.log("Hub LINK balance: ", hubLink);
        console.log("");
        console.log("Next steps:");
        console.log("1. Send Base Sepolia LINK to the hub (faucets.chain.link)");
        console.log("2. Update deployment.json + frontend/deployment.json");
        console.log("3. Start frontend/report-proxy and push initial prices");
    }
}
