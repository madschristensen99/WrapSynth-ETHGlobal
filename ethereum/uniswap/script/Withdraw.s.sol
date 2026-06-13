// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";

address constant NPM = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;

// Removes all liquidity from an LP position and collects the tokens back to the owner.
// Used to reclaim WETH that landed in the broken-price fee-3000 pool.
interface INonfungiblePositionManager {
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external payable returns (uint256 amount0, uint256 amount1);

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    function collect(CollectParams calldata params)
        external payable returns (uint256 amount0, uint256 amount1);

    function positions(uint256 tokenId) external view returns (
        uint96 nonce, address operator, address token0, address token1, uint24 fee,
        int24 tickLower, int24 tickUpper, uint128 liquidity,
        uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128,
        uint128 tokensOwed0, uint128 tokensOwed1
    );
}

contract Withdraw is Script {
    function run() external {
        uint256 tokenId    = vm.envUint("TOKEN_ID");
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        ( , , , , , , , uint128 liquidity, , , , ) =
            INonfungiblePositionManager(NPM).positions(tokenId);
        console.log("Position liquidity:", uint256(liquidity));

        uint128 MAX = type(uint128).max;

        vm.startBroadcast(deployerKey);

        if (liquidity > 0) {
            INonfungiblePositionManager(NPM).decreaseLiquidity(
                INonfungiblePositionManager.DecreaseLiquidityParams({
                    tokenId: tokenId, liquidity: liquidity,
                    amount0Min: 0, amount1Min: 0, deadline: block.timestamp + 3600
                })
            );
        }
        (uint256 c0, uint256 c1) = INonfungiblePositionManager(NPM).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId, recipient: deployer, amount0Max: MAX, amount1Max: MAX
            })
        );

        vm.stopBroadcast();

        console.log("Collected token0 (WETH):  ", c0);
        console.log("Collected token1 (tWSXMR):", c1);
    }
}
