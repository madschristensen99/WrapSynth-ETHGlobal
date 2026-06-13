// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IDataStreamsFeeManager
 * @notice Minimal interface for the Chainlink Data Streams FeeManager
 * @dev Compatible with IFeeManager from chainlink/contracts but with relaxed pragma
 */
interface IDataStreamsFeeManager {
    struct Asset {
        address assetAddress;
        uint256 amount;
    }

    /**
     * @notice Calculate the verification fee (and node reward) for a report
     * @param subscriber Address paying the fee (the hub, since facets run via delegatecall)
     * @param report The report data (without the outer reportContext wrapper)
     * @param quoteAddress Fee token to quote in (LINK or native wrapper)
     */
    function getFeeAndReward(
        address subscriber,
        bytes memory report,
        address quoteAddress
    ) external view returns (Asset memory fee, Asset memory reward, uint256 discount);

    function i_linkAddress() external view returns (address);

    function i_nativeAddress() external view returns (address);

    function i_rewardManager() external view returns (address);
}
