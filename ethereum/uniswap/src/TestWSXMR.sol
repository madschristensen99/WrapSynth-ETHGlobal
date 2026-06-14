// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Test stand-in for wsXMR on Base Sepolia.
///         8 decimals to match the production token on Gnosis.
contract TestWSXMR is ERC20, Ownable {
    constructor(address initialOwner)
        ERC20("Test Wrapped Scaled XMR", "tWSXMR")
        Ownable(initialOwner)
    {}

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    /// @notice Open mint — anyone can call during testing.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }
}
