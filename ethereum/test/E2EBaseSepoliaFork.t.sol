// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {ChainlinkDataStreamsOracleFacet} from "../contracts/facets/ChainlinkDataStreamsOracleFacet.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
import {YieldFacet} from "../contracts/facets/YieldFacet.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {IOracleFacet} from "../contracts/interfaces/facets/IOracleFacet.sol";
import {IDataStreamsVerifier} from "../contracts/interfaces/external/IDataStreamsVerifier.sol";
import {IDataStreamsFeeManager} from "../contracts/interfaces/external/IDataStreamsFeeManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title E2EBaseSepoliaFork
 * @notice Fork-tests the entire Chainlink Data Streams oracle stack against the
 *         real Base Sepolia VerifierProxy and live signed reports fetched via
 *         FFI from the report-proxy server.
 *
 * Skips automatically when BASE_SEPOLIA_RPC_URL is unset so this test is opt-in.
 * Run with: BASE_SEPOLIA_RPC_URL=https://sepolia.base.org forge test --match-contract E2EBaseSepoliaFork -vv
 */
contract E2EBaseSepoliaForkTest is Test {
    // Base Sepolia
    address constant VERIFIER_PROXY = 0x8Ac491b7c118a0cdcF048e0f707247fD8C9575f9;
    bytes32 constant XMR_FEED_ID = 0x0003c70558bd921b1559d37b8e347797f121d1240e7386e68b2bee9b731b0833;
    bytes32 constant ETH_FEED_ID = 0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782;

    wsXmrHub hub;
    wsXMR wsxmr;
    ChainlinkDataStreamsOracleFacet oracleFacet;

    function setUp() public {
        string memory rpcUrl = vm.envOr("BASE_SEPOLIA_RPC_URL", string(""));
        if (bytes(rpcUrl).length == 0) {
            vm.skip(true);
        }
        vm.createSelectFork(rpcUrl);

        wsxmr = new wsXMR();
        hub = new wsXmrHub(address(wsxmr), VERIFIER_PROXY);

        oracleFacet = new ChainlinkDataStreamsOracleFacet(
            address(wsxmr), VERIFIER_PROXY, XMR_FEED_ID, ETH_FEED_ID
        );

        VaultFacet vaultFacet = new VaultFacet(address(wsxmr), VERIFIER_PROXY);
        MintFacet mintFacet = new MintFacet(address(wsxmr), VERIFIER_PROXY);
        BurnFacet burnFacet = new BurnFacet(address(wsxmr), VERIFIER_PROXY);
        LiquidationFacet liquidationFacet = new LiquidationFacet(address(wsxmr), VERIFIER_PROXY);
        YieldFacet yieldFacet = new YieldFacet(address(wsxmr), VERIFIER_PROXY);

        hub.registerFacets(
            address(vaultFacet),
            address(mintFacet),
            address(burnFacet),
            address(liquidationFacet),
            address(yieldFacet),
            address(oracleFacet)
        );
        wsxmr.setHub(address(hub));
    }

    function _fetchReport(bytes32 feedId) internal returns (bytes memory) {
        string[] memory inputs = new string[](3);
        inputs[0] = "node";
        inputs[1] = "../frontend/report-proxy/fetchReportHex.js";
        inputs[2] = vm.toString(feedId);
        return vm.ffi(inputs);
    }

    function _hubView(bytes memory data) internal returns (bytes memory) {
        (bool success, bytes memory result) = address(hub).call(data);
        require(success, "hub view call failed");
        return result;
    }

    function test_RealReportVerificationAndStorage() public {
        bytes[] memory updateData = new bytes[](2);
        updateData[0] = _fetchReport(XMR_FEED_ID);
        updateData[1] = _fetchReport(ETH_FEED_ID);

        // Fund the hub with LINK for verification fees
        address feeManager = IDataStreamsVerifier(VERIFIER_PROXY).s_feeManager();
        if (feeManager != address(0)) {
            address link = IDataStreamsFeeManager(feeManager).i_linkAddress();
            uint256 needed;
            for (uint256 i = 0; i < updateData.length; i++) {
                (, bytes memory reportData) = abi.decode(updateData[i], (bytes32[3], bytes));
                (IDataStreamsFeeManager.Asset memory fee,,) =
                    IDataStreamsFeeManager(feeManager).getFeeAndReward(address(hub), reportData, link);
                needed += fee.amount;
            }
            deal(link, address(hub), needed * 2);
            console.log("Funded hub with LINK fee budget:", needed);
        }

        IOracleFacet(address(hub)).updateOraclePrices(updateData);

        uint256 xmrPrice = abi.decode(
            _hubView(abi.encodeWithSelector(IOracleFacet.getXmrPrice.selector)),
            (uint256)
        );
        uint256 ethPrice = abi.decode(
            _hubView(abi.encodeWithSelector(IOracleFacet.getCollateralPrice.selector)),
            (uint256)
        );

        console.log("XMR price (18-dec, USD wei):", xmrPrice);
        console.log("ETH price (18-dec, USD wei):", ethPrice);
        assertGt(xmrPrice, 100e18, "XMR > $100 sanity floor");
        assertLt(xmrPrice, 10_000e18, "XMR < $10k sanity ceiling");
        assertGt(ethPrice, 500e18, "ETH > $500 sanity floor");
        assertLt(ethPrice, 20_000e18, "ETH < $20k sanity ceiling");
    }
}
