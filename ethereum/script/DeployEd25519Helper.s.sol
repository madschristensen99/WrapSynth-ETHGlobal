// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {Ed25519Helper} from "../contracts/mocks/Ed25519Helper.sol";

contract DeployEd25519Helper is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        console.log("Deploying Ed25519Helper...");
        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);
        Ed25519Helper helper = new Ed25519Helper();
        vm.stopBroadcast();

        console.log("Ed25519Helper deployed:", address(helper));
    }
}
