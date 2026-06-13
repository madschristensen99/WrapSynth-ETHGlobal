// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {wsXMR} from "../contracts/wsXMR.sol";
import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
import {ChainlinkDataStreamsOracleFacet} from "../contracts/facets/ChainlinkDataStreamsOracleFacet.sol";
import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
import {YieldFacet} from "../contracts/facets/YieldFacet.sol";

contract UpdateOracleFeed is Script {
    address constant VERIFIER_PROXY = 0x8Ac491b7c118a0cdcF048e0f707247fD8C9575f9;
    bytes32 constant XMR_USD_FEED_ID = 0x0003c70558bd921b1559d37b8e347797f121d1240e7386e68b2bee9b731b0833;
    bytes32 constant ETH_USD_FEED_ID = 0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        // Existing deployment addresses (Base Sepolia)
        address wsxmrAddr = 0x268f782B6755F70902930C629A14F3c351C44BE9;
        address hubAddr = 0xcA012c47B8B82512244C2D4eBaf1A8Ca66aA80Ff;

        console.log("Updating oracle feed to ETH/USD...");
        console.log("wsXMR:", wsxmrAddr);
        console.log("Hub:", hubAddr);
        console.log("Deployer:", deployer);

        vm.startBroadcast(deployerPrivateKey);

        ChainlinkDataStreamsOracleFacet newOracle = new ChainlinkDataStreamsOracleFacet(
            wsxmrAddr, VERIFIER_PROXY, XMR_USD_FEED_ID, ETH_USD_FEED_ID
        );
        console.log("New OracleFacet:", address(newOracle));

        // Existing facet addresses
        address vaultAddr = 0xcF0998CD7eD54CF26CF07eF0d671aE9e727Fd079;
        address mintAddr = 0x174963025EFc9E2d266eD96FD0e615dd24A1bADD;
        address burnAddr = 0x2Cc3063F3314989518203994438e560180Bf759f;
        address liqAddr = 0x394D0087232526bae716b6d32558f51f4395274d;
        address yieldAddr = 0xeB8bdCBFaD73198B55F6D489beA2f2D0eF65aCA3;

        wsXmrHub hub = wsXmrHub(payable(hubAddr));
        hub.registerFacets(vaultAddr, mintAddr, burnAddr, liqAddr, yieldAddr, address(newOracle));
        console.log("Facets re-registered with new oracle");

        vm.stopBroadcast();

        console.log("");
        console.log("============================================================");
        console.log("ORACLE FEED UPDATED");
        console.log("============================================================");
        console.log("New OracleFacet:", address(newOracle));
        console.log("XMR/USD feed:", vm.toString(XMR_USD_FEED_ID));
        console.log("ETH/USD feed:", vm.toString(ETH_USD_FEED_ID));
        console.log("");
        console.log("Update deployment.json with new OracleFacet address.");
    }
}
