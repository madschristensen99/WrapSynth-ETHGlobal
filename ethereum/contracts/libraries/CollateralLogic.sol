// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./CollateralHelpers.sol";

/**
 * @title CollateralLogic
 * @notice Library for collateral ratio calculations
 */
library CollateralLogic {
    uint256 constant RATIO_PRECISION = 100;
    
    /**
     * @notice Calculate collateral ratio
     */
    function calculateCollateralRatio(
        uint256 collateralValueUsd,
        uint256 debtValueUsd
    ) internal pure returns (uint256 ratio) {
        if (debtValueUsd == 0) return type(uint256).max;
        ratio = (collateralValueUsd * RATIO_PRECISION) / debtValueUsd;
    }
    
    /**
     * @notice Convert collateral amount to USD value
     */
    function collateralToUsd(
        uint256 collateralAmount,
        uint256 collateralPrice
    ) internal pure returns (uint256 valueUsd) {
        valueUsd = (collateralAmount * collateralPrice) / 1e18;
    }
    
    /**
     * @notice Convert USD value to collateral amount
     */
    function usdToCollateral(
        uint256 valueUsd,
        uint256 collateralPrice
    ) internal pure returns (uint256 collateralAmount) {
        collateralAmount = (valueUsd * 1e18) / collateralPrice;
    }
    
    /**
     * @notice Calculate collateral value needed for debt
     */
    function getCollateralValueForDebt(
        uint256 debtAmount,
        uint256 xmrPrice,
        uint256 ratio
    ) internal pure returns (uint256 collateralValueUsd) {
        uint256 debtValueUsd = (debtAmount * xmrPrice) / 1e8; // wsXMR has 8 decimals
        collateralValueUsd = (debtValueUsd * ratio) / RATIO_PRECISION;
    }
    
    /**
     * @notice Calculate collateral ratio from collateral shares
     * @dev Converts shares to assets, then calculates USD values and ratio
     */
    function calculateRatioFromShares(
        uint256 collateralShares,
        uint256 debtAmount,
        address collateralToken,
        uint256 collateralPrice,
        uint256 xmrPrice
    ) internal view returns (uint256) {
        if (debtAmount == 0) return type(uint256).max;
        
        uint256 collateralAmount = CollateralHelpers.toAssets(collateralToken, collateralShares);
        
        uint256 collateralValueUsd = (collateralAmount * collateralPrice) / 1e18;
        uint256 debtValueUsd = (debtAmount * xmrPrice) / 1e8; // wsXMR has 8 decimals
        
        return (collateralValueUsd * RATIO_PRECISION) / debtValueUsd;
    }
    
    /**
     * @notice Calculate CR including idle collateral shares AND deployed pool positions.
     * @dev Position contents (positionCollateral, positionWsxmr) MUST be valued at oracle prices
     *      by the caller. This function trusts those inputs.
     * @param idleShares Collateral shares held directly by vault
     * @param positionCollateral Sum of collateral (1e18) across vault's active positions
     * @param debtAmount wsXMR debt
     * @param collateralToken Collateral token address
     * @param collateralPrice Collateral USD price (1e18)
     * @param xmrPrice XMR USD price (1e18)
     */
    function calculateVaultCRWithDeployment(
        uint256 idleShares,
        uint256 positionCollateral,
        uint256 /*positionWsxmr*/,
        uint256 debtAmount,
        address collateralToken,
        uint256 collateralPrice,
        uint256 xmrPrice
    ) internal view returns (uint256) {
        if (debtAmount == 0) return type(uint256).max;
        
        uint256 idleAssetAmount = CollateralHelpers.toAssets(collateralToken, idleShares);
        
        uint256 totalAssetAmount = idleAssetAmount + positionCollateral;
        uint256 collateralUsd = (totalAssetAmount * collateralPrice) / 1e18;
        // M2: Do NOT count deployed wsXMR as vault collateral. On unwind it goes
        // to the user (pendingReturns), not the vault.
        uint256 debtValueUsd = (debtAmount * xmrPrice) / 1e8;
        
        return (collateralUsd * RATIO_PRECISION) / debtValueUsd;
    }
}
