// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {ChainlinkDataStreamsOracleFacet} from "../contracts/facets/ChainlinkDataStreamsOracleFacet.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
import {YieldFacet} from "../contracts/facets/YieldFacet.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {MockVerifierProxy} from "../contracts/mocks/MockVerifierProxy.sol";
import {IOracleFacet} from "../contracts/interfaces/facets/IOracleFacet.sol";

contract ChainlinkDataStreamsOracleTest is Test {
    bytes32 constant XMR_FEED_ID = bytes32(uint256(0x0003c7) << 224); // arbitrary test id
    bytes32 constant ETH_FEED_ID = bytes32(uint256(0x000364) << 224);

    wsXmrHub hub;
    wsXMR wsxmr;
    MockVerifierProxy verifier;
    ChainlinkDataStreamsOracleFacet oracleFacet;

    function setUp() public {
        vm.warp(1_750_000_000);

        verifier = new MockVerifierProxy();
        wsxmr = new wsXMR();
        hub = new wsXmrHub(address(wsxmr), address(verifier));

        oracleFacet = new ChainlinkDataStreamsOracleFacet(
            address(wsxmr), address(verifier), XMR_FEED_ID, ETH_FEED_ID
        );
        VaultFacet vaultFacet = new VaultFacet(address(wsxmr), address(verifier));
        MintFacet mintFacet = new MintFacet(address(wsxmr), address(verifier));
        BurnFacet burnFacet = new BurnFacet(address(wsxmr), address(verifier));
        LiquidationFacet liquidationFacet = new LiquidationFacet(address(wsxmr), address(verifier));
        YieldFacet yieldFacet = new YieldFacet(address(wsxmr), address(verifier));

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

    function _updatePrices(int192 xmrPrice18, int192 ethPrice18) internal {
        verifier.setPrice(XMR_FEED_ID, xmrPrice18);
        verifier.setPrice(ETH_FEED_ID, ethPrice18);
        bytes[] memory updateData = new bytes[](2);
        updateData[0] = verifier.buildPayload(XMR_FEED_ID);
        updateData[1] = verifier.buildPayload(ETH_FEED_ID);
        IOracleFacet(address(hub)).updateOraclePrices(updateData);
    }

    /// @dev The hub's fallback uses TSTORE, which reverts under STATICCALL, so
    ///      view reads must go through a low-level call (matches eth_call behavior).
    function _hubView(bytes memory data) internal returns (bytes memory) {
        (bool success, bytes memory result) = address(hub).call(data);
        require(success, "hub view call failed");
        return result;
    }

    function _getXmrPrice() internal returns (uint256) {
        return abi.decode(_hubView(abi.encodeWithSelector(IOracleFacet.getXmrPrice.selector)), (uint256));
    }

    function _getCollateralPrice() internal returns (uint256) {
        return abi.decode(_hubView(abi.encodeWithSelector(IOracleFacet.getCollateralPrice.selector)), (uint256));
    }

    function _getXmrEmaPrice() internal returns (uint256) {
        return abi.decode(_hubView(abi.encodeWithSelector(IOracleFacet.getXmrEmaPrice.selector)), (uint256));
    }

    function test_UpdateAndReadPrices() public {
        _updatePrices(390e18, 1e18);

        // View functions normalize back to 18 decimals
        assertEq(_getXmrPrice(), 390e18, "XMR price");
        assertEq(_getCollateralPrice(), 1e18, "DAI price");
        // First update seeds the EMA at spot
        assertEq(_getXmrEmaPrice(), 390e18, "EMA seed");
    }

    function test_DecimalConversionTruncatesTo8Decimals() public {
        // $349.076855123456789012 -> stored as 349.07685512 (8 decimals)
        _updatePrices(349076855123456789012, 1e18);
        assertEq(_getXmrPrice(), 349_07685512 * 1e10);
    }

    function test_StalePriceReverts() public {
        _updatePrices(390e18, 1e18);
        vm.warp(block.timestamp + 121);
        (bool success, bytes memory result) = address(hub).call(
            abi.encodeWithSelector(IOracleFacet.getXmrPrice.selector)
        );
        assertFalse(success, "stale read must revert");
        assertEq(bytes4(result), IOracleFacet.StalePrice.selector, "StalePrice error");
    }

    function test_EmaConvergence() public {
        _updatePrices(390e18, 1e18);
        vm.warp(block.timestamp + 100); // > 90s so the deviation guard is skipped
        _updatePrices(400e18, 1e18);

        // EMA = 0.182 * 400 + 0.818 * 390 = 391.82
        assertEq(_getXmrEmaPrice(), (182 * 400e18 + 818 * 390e18) / 1000, "EMA blend");
    }

    function test_DeviationGuardBlocksSpike() public {
        _updatePrices(390e18, 1e18);

        // > 20% move within 90s must revert
        verifier.setPrice(XMR_FEED_ID, 500e18);
        verifier.setPrice(ETH_FEED_ID, 1e18);
        bytes[] memory updateData = new bytes[](2);
        updateData[0] = verifier.buildPayload(XMR_FEED_ID);
        updateData[1] = verifier.buildPayload(ETH_FEED_ID);

        vm.expectRevert(IOracleFacet.PriceDeviationTooHigh.selector);
        IOracleFacet(address(hub)).updateOraclePrices(updateData);
    }

    function test_DeviationGuardSkippedWhenStale() public {
        _updatePrices(390e18, 1e18);
        vm.warp(block.timestamp + 91);
        _updatePrices(500e18, 1e18); // re-anchor allowed after 90s
        assertEq(_getXmrPrice(), 500e18);
    }

    function test_WrongFeedOrderReverts() public {
        verifier.setPrice(XMR_FEED_ID, 390e18);
        verifier.setPrice(ETH_FEED_ID, 1e18);
        bytes[] memory updateData = new bytes[](2);
        updateData[0] = verifier.buildPayload(ETH_FEED_ID); // swapped
        updateData[1] = verifier.buildPayload(XMR_FEED_ID);

        vm.expectRevert(ChainlinkDataStreamsOracleFacet.UnexpectedFeedId.selector);
        IOracleFacet(address(hub)).updateOraclePrices(updateData);
    }

    function test_WrongUpdateDataLengthReverts() public {
        verifier.setPrice(XMR_FEED_ID, 390e18);
        bytes[] memory updateData = new bytes[](1);
        updateData[0] = verifier.buildPayload(XMR_FEED_ID);

        vm.expectRevert(ChainlinkDataStreamsOracleFacet.InvalidUpdateData.selector);
        IOracleFacet(address(hub)).updateOraclePrices(updateData);
    }

    function test_UpdateFeeZeroWithoutFeeManager() public {
        verifier.setPrice(XMR_FEED_ID, 390e18);
        verifier.setPrice(ETH_FEED_ID, 1e18);
        bytes[] memory updateData = new bytes[](2);
        updateData[0] = verifier.buildPayload(XMR_FEED_ID);
        updateData[1] = verifier.buildPayload(ETH_FEED_ID);
        bytes memory result = _hubView(abi.encodeWithSelector(IOracleFacet.getUpdateFee.selector, updateData));
        assertEq(abi.decode(result, (uint256)), 0);
    }

    function test_MsgValueRefunded() public {
        verifier.setPrice(XMR_FEED_ID, 390e18);
        verifier.setPrice(ETH_FEED_ID, 1e18);
        bytes[] memory updateData = new bytes[](2);
        updateData[0] = verifier.buildPayload(XMR_FEED_ID);
        updateData[1] = verifier.buildPayload(ETH_FEED_ID);

        address sender = makeAddr("sender");
        vm.deal(sender, 1 ether);
        vm.prank(sender);
        IOracleFacet(address(hub)).updateOraclePrices{value: 0.5 ether}(updateData);
        assertEq(sender.balance, 1 ether, "full refund");
    }
}
