// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockSavingsDAI
 * @notice Testnet stand-in for Savings DAI (sDAI) on chains without it
 * @dev 1:1 shares-to-assets (no yield accrual), implements the ISavingsDAI /
 *      ERC4626 subset used by the protocol (deposit, redeem, convertTo*)
 */
contract MockSavingsDAI is ERC20 {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;

    constructor(address _asset) ERC20("Savings DAI (Mock)", "sDAI") {
        asset = IERC20(_asset);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        asset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, assets);
        return assets;
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        if (owner != msg.sender) {
            _spendAllowance(owner, msg.sender, shares);
        }
        _burn(owner, shares);
        asset.safeTransfer(receiver, shares);
        return shares;
    }

    function convertToShares(uint256 assets) external pure returns (uint256 shares) {
        return assets;
    }

    function convertToAssets(uint256 shares) external pure returns (uint256 assets) {
        return shares;
    }
}
