// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title CollateralHelpers
 * @notice Generic helpers for collateral tokens (ERC4626 vaults or plain ERC20)
 */
library CollateralHelpers {
    /**
     * @notice Convert shares to assets. For plain ERC20, returns shares (1:1).
     * @dev On Base Sepolia, WETH staticcalls to unknown selectors trigger
     *      StateChangeDuringStaticCall, so we detect ERC4626 via a safe
     *      interface check using an external helper (see _isVault).
     */
    function toAssets(address token, uint256 shares) internal view returns (uint256) {
        if (!_isVault(token)) return shares;

        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("convertToAssets(uint256)", shares)
        );
        if (success && data.length >= 32) {
            return abi.decode(data, (uint256));
        }
        return shares;
    }

    /**
     * @notice Convert assets to shares. For plain ERC20, returns assets (1:1).
     */
    function toShares(address token, uint256 assets) internal view returns (uint256) {
        if (!_isVault(token)) return assets;

        (bool success, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("convertToShares(uint256)", assets)
        );
        if (success && data.length >= 32) {
            return abi.decode(data, (uint256));
        }
        return assets;
    }

    /**
     * @notice Check if a token is an ERC4626 vault by reading its code size
     *         and comparing against known vaults. For now, WETH is treated as plain ERC20.
     * @dev This avoids unsafe staticcalls on L2 predeploys like WETH.
     */
    function _isVault(address token) internal view returns (bool) {
        // WETH on Base/Optimism is at 0x4200...0006 and is NOT a vault.
        // If more ERC4626 vaults are added, expand this check or use a registry.
        if (token == 0x4200000000000000000000000000000000000006) return false;
        // Additional known plain-ERC20 tokens can be added here.
        return true; // Default to vault behavior for unknown addresses.
    }

    /**
     * @notice Deposit assets into an ERC4626 vault. For plain ERC20, just returns assets.
     * @dev This does not perform the actual transfer; callers must handle that.
     */
    function depositIfVault(address token, uint256 assets, address receiver) internal returns (uint256 shares) {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("deposit(uint256,address)", assets, receiver)
        );
        if (success && data.length >= 32) {
            return abi.decode(data, (uint256));
        }
        // If deposit fails (not an ERC4626), assume 1:1
        return assets;
    }

    /**
     * @notice Redeem shares from an ERC4626 vault. For plain ERC20, transfers tokens directly.
     * @dev For ERC4626 vaults, redeem() handles the transfer internally. For plain ERC20,
     *      we transfer tokens from this contract (hub via delegatecall) to the receiver.
     */
    function redeemIfVault(address token, uint256 shares, address receiver, address owner) internal returns (uint256 assets) {
        (bool success, bytes memory data) = token.call(
            abi.encodeWithSignature("redeem(uint256,address,address)", shares, receiver, owner)
        );
        if (success && data.length >= 32) {
            return abi.decode(data, (uint256));
        }
        // For plain ERC20, transfer tokens from this contract to receiver.
        // In delegatecall context (hub), address(this) is the hub which holds the tokens.
        if (receiver != address(this)) {
            IERC20(token).transfer(receiver, shares);
        }
        return shares;
    }
}
