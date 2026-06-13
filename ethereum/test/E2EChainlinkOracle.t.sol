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
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IOracleFacet} from "../contracts/interfaces/facets/IOracleFacet.sol";
import {MockVerifierProxy} from "../contracts/mocks/MockVerifierProxy.sol";
import {MockWXDAI} from "../contracts/mocks/MockWXDAI.sol";
import {MockSavingsDAI} from "../contracts/mocks/MockSavingsDAI.sol";
import {GnosisAddresses} from "../contracts/GnosisAddresses.sol";
import {Ed25519} from "../contracts/Ed25519.sol";

/**
 * @title E2EChainlinkOracle
 * @notice Full mint -> burn cycle with prices supplied via
 *         Chainlink Data Streams reports instead of RedStone/SimpleOracle.
 *         Proves mint/burn read the Data Streams-sourced prices correctly.
 * @dev Self-contained (no fork). Mocks are etch-deployed at the hardcoded
 *      GnosisAddresses so the compiled facets can interact with them.
 */
contract E2EChainlinkOracleTest is Test {
    bytes32 constant XMR_FEED_ID = bytes32(uint256(0x0003c7) << 224);
    bytes32 constant ETH_FEED_ID = bytes32(uint256(0x000364) << 224);

    wsXmrHub public hub;
    wsXMR public wsxmr;
    ChainlinkDataStreamsOracleFacet public oracleFacet;
    MockVerifierProxy public verifier;

    address public lp;
    address public user;

    bytes32 public testSecret = bytes32(uint256(123456789));

    function setUp() public {
        lp = makeAddr("lp");
        user = makeAddr("user");
        vm.deal(lp, 1000 ether);
        vm.deal(user, 1000 ether);

        // Deploy local mocks and etch them at the hardcoded addresses in GnosisAddresses.
        // MockSavingsDAI must be constructed with the final etched address so its immutable
        // asset field points to the right place.
        MockWXDAI mockWXDAI = new MockWXDAI();
        MockSavingsDAI mockSDAI = new MockSavingsDAI(GnosisAddresses.XDAI);
        vm.etch(GnosisAddresses.XDAI, address(mockWXDAI).code);
        vm.etch(GnosisAddresses.SDAI, address(mockSDAI).code);

        // Fund test accounts with mocked WXDAI
        MockWXDAI(payable(GnosisAddresses.XDAI)).mint(lp, 1000 ether);
        MockWXDAI(payable(GnosisAddresses.XDAI)).mint(user, 1000 ether);

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

    /// @dev Push prices through the Data Streams path (signed report -> verify -> store)
    function _pushPrices(int192 xmrPrice18, int192 ethPrice18) internal {
        verifier.setPrice(XMR_FEED_ID, xmrPrice18);
        verifier.setPrice(ETH_FEED_ID, ethPrice18);
        bytes[] memory updateData = new bytes[](2);
        updateData[0] = verifier.buildPayload(XMR_FEED_ID);
        updateData[1] = verifier.buildPayload(ETH_FEED_ID);
        IOracleFacet(address(hub)).updateOraclePrices(updateData);
    }

    function test_FullCycleWithDataStreamsPrices() public {
        console.log("=== FULL MINT AND BURN CYCLE (Chainlink Data Streams) ===\n");

        // Push prices via Data Streams reports (before any vault operations)
        _pushPrices(390e18, 1e18);

        // LP creates vault and deposits
        vm.startPrank(lp);
        VaultFacet(address(hub)).createVault();
        VaultFacet(address(hub)).setMaxMintBps(0);
        VaultFacet(address(hub)).setMinBurnAmount(0);
        VaultFacet(address(hub)).setMintGriefingDeposit(0.001 ether);
        VaultFacet(address(hub)).setMintReadyBond(0.001 ether);

        (bool success,) = GnosisAddresses.XDAI.call{value: 100 ether}("");
        require(success);
        IERC20(GnosisAddresses.XDAI).approve(address(hub), 100 ether);
        VaultFacet(address(hub)).depositCollateral(100 ether);
        vm.stopPrank();
        console.log("[1] LP deposited 100 xDAI\n");

        // User initiates mint
        uint256 xmrAmount = 20000000000; // 0.002 XMR

        (uint256 px, uint256 py) = Ed25519.scalarMultBase(uint256(testSecret));
        bytes32 testCommitment = keccak256(abi.encodePacked(px, py));
        bytes32 userPublicKey = bytes32(Ed25519.compressPoint(px, py));

        vm.prank(user);
        bytes32 requestId = MintFacet(address(hub)).initiateMint{value: 0.001 ether}(
            lp, user, xmrAmount, testCommitment, userPublicKey);
        console.log("[2] User initiated mint\n");

        bytes32 lpPublicKey = bytes32(uint256(0xdeadbeef));
        vm.prank(lp);
        MintFacet(address(hub)).provideLPKey(requestId, lpPublicKey, lpPublicKey);
        console.log("[3] LP provided public key\n");

        vm.prank(lp);
        MintFacet(address(hub)).setMintReady{value: 0.001 ether}(requestId);
        console.log("[4] LP set mint READY\n");

        vm.prank(user);
        MintFacet(address(hub)).finalizeMint(requestId, testSecret);

        uint256 balance = wsxmr.balanceOf(user);
        console.log("[5] Mint finalized! Balance:", balance, "\n");
        assertTrue(balance > 0, "Should have wsXMR");

        // User burns half
        uint256 burnAmount = balance / 2;
        vm.prank(user);
        bytes32 burnId = BurnFacet(address(hub)).requestBurn(burnAmount, lp, user, bytes32(uint256(1)));
        console.log("[6] Burn requested:", burnAmount, "\n");

        bytes32 burnSecret = bytes32(uint256(0xcafebabe));
        (uint256 bpx, uint256 bpy) = Ed25519.scalarMultBase(uint256(burnSecret));
        bytes32 burnSecretHash = keccak256(abi.encodePacked(bpx, bpy));
        vm.prank(lp);
        BurnFacet(address(hub)).proposeHash(
            burnId,
            burnSecretHash,
            bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111)),
            bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222))
        );
        console.log("[7] LP proposed hash\n");

        vm.prank(user);
        BurnFacet(address(hub)).confirmMoneroLock(burnId);
        console.log("[8] User confirmed Monero lock\n");

        vm.prank(lp);
        BurnFacet(address(hub)).finalizeBurn(burnId, burnSecret);

        uint256 finalBalance = wsxmr.balanceOf(user);
        console.log("[9] Burn finalized! Final balance:", finalBalance, "\n");
        assertEq(finalBalance, balance - burnAmount, "Burn should reduce balance");

        console.log("=== SUCCESS: FULL CYCLE WITH DATA STREAMS PRICES ===");
    }
}
