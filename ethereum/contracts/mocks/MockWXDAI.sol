// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockWXDAI
 * @notice Testnet stand-in for Wrapped xDAI on chains without it (e.g. Base Sepolia)
 * @dev Open faucet mint for hackathon testing; also wraps native ETH 1:1 like WETH
 */
contract MockWXDAI is ERC20 {
    constructor() ERC20("Wrapped xDAI (Mock)", "WXDAI") {}

    /// @notice Open faucet for testnet use
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function deposit() public payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    receive() external payable {
        deposit();
    }
}
