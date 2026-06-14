// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../unlink-integration/testcontracts/tWXMR.sol";

contract DeploytWXMR is Script {
    function run() external returns (tWXMR tWxmr) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerKey);
        tWxmr = new tWXMR();
        vm.stopBroadcast();
        
        console.log("tWXMR Deployed to:", address(tWxmr));
    }
}