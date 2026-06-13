// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {TestWSXMR} from "../src/TestWSXMR.sol";

contract DeployTestWSXMR is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);

        TestWSXMR token = new TestWSXMR(deployer);

        // Mint 100,000 tWSXMR to deployer for pool seeding and testing
        // 100,000 * 10^8 = 10_000_000_000_000 base units
        token.mint(deployer, 100_000 * 1e8);

        vm.stopBroadcast();

        console.log("=== TestWSXMR deployed ===");
        console.log("Address:  ", address(token));
        console.log("Deployer: ", deployer);
        console.log("Balance:   100,000 tWSXMR minted to deployer");
        console.log("");
        console.log("Next: update TWSXMR_ADDRESS in .env, then run SeedPool.s.sol");
    }
}
