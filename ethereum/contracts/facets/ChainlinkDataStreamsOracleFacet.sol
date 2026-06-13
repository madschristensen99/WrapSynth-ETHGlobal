// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {wsXmrStorage} from "../core/wsXmrStorage.sol";
import {IOracleFacet} from "../interfaces/facets/IOracleFacet.sol";
import {IDataStreamsVerifier} from "../interfaces/external/IDataStreamsVerifier.sol";
import {IDataStreamsFeeManager} from "../interfaces/external/IDataStreamsFeeManager.sol";

/**
 * @title ChainlinkDataStreamsOracleFacet
 * @notice Oracle using Chainlink Data Streams pull-based reports, verified on-chain
 * @dev Signed `fullReport` blobs are fetched off-chain from the Data Streams
 *      Aggregation Network and passed to updateOraclePrices. Each report is
 *      cryptographically verified by the chain's VerifierProxy before its price
 *      is accepted. Verification fees (if a FeeManager is configured) are paid
 *      in LINK from the hub's balance.
 */
contract ChainlinkDataStreamsOracleFacet is wsXmrStorage, IOracleFacet {
    using SafeERC20 for IERC20;

    // ========== ERRORS ==========

    error InvalidUpdateData();
    error UnexpectedFeedId();
    error ReportExpired();
    error InvalidReportPrice();

    // ========== REPORT SCHEMA ==========

    /// @dev Chainlink Data Streams report schema V3 (crypto streams)
    struct ReportV3 {
        bytes32 feedId;
        uint32 validFromTimestamp;
        uint32 observationsTimestamp;
        uint192 nativeFee;
        uint192 linkFee;
        uint32 expiresAt;
        int192 price;
        int192 bid;
        int192 ask;
    }

    // ========== IMMUTABLES ==========

    /// @dev Stream IDs differ per environment (testnet staging vs mainnet production),
    ///      so they are constructor args rather than constants.
    bytes32 public immutable xmrFeedId;
    bytes32 public immutable daiFeedId;

    /// @dev Data Streams report prices are 18 decimals; storage keeps 8 (RedStone legacy)
    uint256 private constant REPORT_TO_STORAGE_DIVISOR = 1e10;

    // ========== CONSTRUCTOR ==========

    constructor(address _wsxmrToken, address _verifierProxy, bytes32 _xmrFeedId, bytes32 _daiFeedId)
        wsXmrStorage(_wsxmrToken, _verifierProxy)
    {
        xmrFeedId = _xmrFeedId;
        daiFeedId = _daiFeedId;
    }

    // ========== PRICE UPDATE ==========

    /// @inheritdoc IOracleFacet
    /// @dev updateData[0] = XMR/USD fullReport, updateData[1] = DAI/USD fullReport
    function updateOraclePrices(bytes[] calldata updateData) external payable {
        if (updateData.length != 2) revert InvalidUpdateData();

        ReportV3 memory xmrReport = _verifyReport(updateData[0], xmrFeedId);
        ReportV3 memory daiReport = _verifyReport(updateData[1], daiFeedId);

        // Convert 18-decimal report prices to the 8-decimal storage format
        uint256 xmrPrice = uint256(uint192(xmrReport.price)) / REPORT_TO_STORAGE_DIVISOR;
        uint256 daiPrice = uint256(uint192(daiReport.price)) / REPORT_TO_STORAGE_DIVISOR;
        if (xmrPrice == 0 || daiPrice == 0) revert InvalidReportPrice();

        uint256 newPrice = xmrPrice * 1e10;

        _assertDeviation(newPrice);

        lastXmrPrice = int192(int256(xmrPrice));
        lastXmrPriceTimestamp = uint256(xmrReport.observationsTimestamp);

        _updateEma(newPrice);

        lastCollateralPrice = int192(int256(daiPrice));
        lastCollateralPriceTimestamp = uint256(daiReport.observationsTimestamp);

        _refundSender();
    }

    /// @dev Verify a fullReport blob via the VerifierProxy and decode the V3 report.
    ///      Runs in delegatecall context: address(this) is the hub, which pays LINK fees.
    function _verifyReport(bytes calldata payload, bytes32 expectedFeedId)
        internal
        returns (ReportV3 memory report)
    {
        bytes memory parameterPayload = "";

        address feeManager = IDataStreamsVerifier(verifierProxy).s_feeManager();
        if (feeManager != address(0)) {
            (, bytes memory reportData) = abi.decode(payload, (bytes32[3], bytes));
            address linkToken = IDataStreamsFeeManager(feeManager).i_linkAddress();
            (IDataStreamsFeeManager.Asset memory fee,,) =
                IDataStreamsFeeManager(feeManager).getFeeAndReward(address(this), reportData, linkToken);
            if (fee.amount > 0) {
                IERC20(linkToken).forceApprove(IDataStreamsFeeManager(feeManager).i_rewardManager(), fee.amount);
            }
            parameterPayload = abi.encode(linkToken);
        }

        bytes memory verified = IDataStreamsVerifier(verifierProxy).verify(payload, parameterPayload);
        report = abi.decode(verified, (ReportV3));

        if (report.feedId != expectedFeedId) revert UnexpectedFeedId();
        if (block.timestamp > report.expiresAt) revert ReportExpired();
        if (report.price <= 0) revert InvalidReportPrice();
    }

    /// @dev H3: Deviation guard — compare against EMA (smoother) rather than last spot.
    function _assertDeviation(uint256 newPrice) internal view {
        uint256 timeSinceUpdate = block.timestamp - lastXmrPriceTimestamp;
        if (timeSinceUpdate >= 90 seconds) return;
        uint256 oldPrice = uint256(uint192(lastXmrPrice)) * 1e10;
        uint256 baselinePrice = xmrEmaPrice > 0 ? xmrEmaPrice : oldPrice;
        if (baselinePrice == 0) return;
        uint256 diff = baselinePrice > newPrice ? baselinePrice - newPrice : newPrice - baselinePrice;
        if ((diff * BPS_DENOMINATOR) / baselinePrice > MAX_PRICE_DEVIATION_BPS) revert PriceDeviationTooHigh();
    }

    /// @dev M1: Update on-chain EMA accumulator
    function _updateEma(uint256 newPrice) internal {
        if (xmrEmaPrice == 0) {
            xmrEmaPrice = newPrice;
        } else {
            xmrEmaPrice = (EMA_ALPHA_NUMERATOR * newPrice + (EMA_DENOMINATOR - EMA_ALPHA_NUMERATOR) * xmrEmaPrice) / EMA_DENOMINATOR;
        }
    }

    /// @dev Refund any sent ETH (fees are paid in LINK, not native)
    function _refundSender() internal {
        if (msg.value > 0) {
            (bool success, ) = msg.sender.call{value: msg.value}("");
            if (!success) revert RefundFailed();
        }
    }

    // ========== VIEW FUNCTIONS ==========

    /// @inheritdoc IOracleFacet
    function getXmrPrice() external view returns (uint256) {
        return getXmrPriceWithAge(2 minutes);
    }

    /// @inheritdoc IOracleFacet
    function getXmrPriceWithAge(uint256 maxAge) public view returns (uint256) {
        if (block.timestamp > lastXmrPriceTimestamp + maxAge) revert StalePrice();
        int192 price = lastXmrPrice;
        if (price <= 0) revert StalePrice();
        // Storage uses 8 decimals, normalize to 18
        uint256 normalized = uint256(uint192(price)) * 1e10;
        if (normalized == 0) revert PriceNormalizedToZero();
        return normalized;
    }

    /// @inheritdoc IOracleFacet
    function getCollateralPrice() external view returns (uint256) {
        return getCollateralPriceWithAge(2 minutes);
    }

    /// @inheritdoc IOracleFacet
    function getCollateralPriceWithAge(uint256 maxAge) public view returns (uint256) {
        if (block.timestamp > lastCollateralPriceTimestamp + maxAge) revert StalePrice();
        int192 price = lastCollateralPrice;
        if (price <= 0) revert StalePrice();
        // Storage uses 8 decimals, normalize to 18
        uint256 normalized = uint256(uint192(price)) * 1e10;
        if (normalized == 0) revert PriceNormalizedToZero();
        return normalized;
    }

    /// @inheritdoc IOracleFacet
    function getXmrEmaPrice() external view returns (uint256) {
        if (block.timestamp > lastXmrPriceTimestamp + 2 minutes) revert StalePrice();
        if (xmrEmaPrice == 0) revert StalePrice();
        return xmrEmaPrice;
    }

    /// @inheritdoc IOracleFacet
    /// @dev Returns the total LINK fee for verifying the given reports
    function getUpdateFee(bytes[] calldata updateData) external view returns (uint256) {
        address feeManager = IDataStreamsVerifier(verifierProxy).s_feeManager();
        if (feeManager == address(0)) return 0;

        address linkToken = IDataStreamsFeeManager(feeManager).i_linkAddress();
        uint256 total;
        for (uint256 i = 0; i < updateData.length; i++) {
            (, bytes memory reportData) = abi.decode(updateData[i], (bytes32[3], bytes));
            (IDataStreamsFeeManager.Asset memory fee,,) =
                IDataStreamsFeeManager(feeManager).getFeeAndReward(address(this), reportData, linkToken);
            total += fee.amount;
        }
        return total;
    }

    /// @inheritdoc IOracleFacet
    function normalizeDebt(uint256 actualDebt) external view returns (uint256) {
        if (globalDebtIndex == 0) return actualDebt;
        return (actualDebt * 1e18) / globalDebtIndex;
    }

    /// @inheritdoc IOracleFacet
    function denormalizeDebt(uint256 normalizedDebt) external view returns (uint256) {
        return (normalizedDebt * globalDebtIndex) / 1e18;
    }

    // ========== DIAMOND INTROSPECTION ==========

    /// @notice Returns all function selectors implemented by this facet
    function selectors() external pure returns (bytes4[] memory) {
        bytes4[] memory sels = new bytes4[](8);
        sels[0] = this.updateOraclePrices.selector;
        sels[1] = this.getXmrPrice.selector;
        sels[2] = this.getXmrPriceWithAge.selector;
        sels[3] = this.getCollateralPrice.selector;
        sels[4] = this.getCollateralPriceWithAge.selector;
        sels[5] = this.getXmrEmaPrice.selector;
        sels[6] = this.getUpdateFee.selector;
        sels[7] = this.normalizeDebt.selector;
        return sels;
    }
}
