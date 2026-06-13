// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Creates a FRESH, deep tWSXMR/WETH pool. The 0.01% / 0.05% / 0.30% tiers are all
// already initialized (0.30% at a broken price that can't be reset), so a brand-new
// pool uses the 1% tier. Wraps ETH → WETH and seeds a full-range position at 0.21.
address constant NPM  = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
address constant WETH = 0x4200000000000000000000000000000000000006;

uint24 constant FEE_TIER   = 10000;  // 1% — only fresh tier available
int24  constant TICK_LOWER = -887200; // full range, multiples of tickSpacing 200
int24  constant TICK_UPPER =  887200;

interface IWETH {
    function deposit() external payable;
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

interface INonfungiblePositionManager {
    struct MintParams {
        address token0; address token1; uint24 fee;
        int24 tickLower; int24 tickUpper;
        uint256 amount0Desired; uint256 amount1Desired;
        uint256 amount0Min; uint256 amount1Min;
        address recipient; uint256 deadline;
    }
    function mint(MintParams calldata params)
        external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
    function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96)
        external payable returns (address pool);
}

contract SetupPoolFresh is Script {
    function run() external {
        address tWSXMR = vm.envAddress("TWSXMR_ADDRESS");
        require(WETH < tWSXMR, "ordering"); // token0=WETH, token1=tWSXMR

        uint160 sqrtPriceX96 = uint160(vm.envUint("TARGET_SQRT_PRICE_X96"));
        uint256 wrapEth   = vm.envUint("WRAP_ETH");
        uint256 wethSeed  = vm.envUint("WETH_SEED");
        uint256 twsxmrSeed= vm.envUint("TWSXMR_SEED");

        uint256 key = vm.envUint("PRIVATE_KEY");
        address me  = vm.addr(key);
        require(me.balance >= wrapEth, "Insufficient native ETH to wrap");
        require(IERC20(tWSXMR).balanceOf(me) >= twsxmrSeed, "Insufficient tWSXMR");

        vm.startBroadcast(key);

        // 1. Wrap ETH → WETH for depth
        if (wrapEth > 0) IWETH(WETH).deposit{value: wrapEth}();
        require(IERC20(WETH).balanceOf(me) >= wethSeed, "Insufficient WETH after wrap");

        // 2. Create + initialize the fresh pool at the target price (0.21)
        address pool = INonfungiblePositionManager(NPM).createAndInitializePoolIfNecessary(
            WETH, tWSXMR, FEE_TIER, sqrtPriceX96);
        console.log("Fresh pool (fee 10000):", pool);

        // 3. Approve NPM + mint a deep full-range position
        IERC20(WETH).approve(NPM, wethSeed);
        IERC20(tWSXMR).approve(NPM, twsxmrSeed);
        (uint256 tokenId, uint128 liq, uint256 a0, uint256 a1) =
            INonfungiblePositionManager(NPM).mint(INonfungiblePositionManager.MintParams({
                token0: WETH, token1: tWSXMR, fee: FEE_TIER,
                tickLower: TICK_LOWER, tickUpper: TICK_UPPER,
                amount0Desired: wethSeed, amount1Desired: twsxmrSeed,
                amount0Min: 0, amount1Min: 0, recipient: me, deadline: block.timestamp + 3600
            }));

        vm.stopBroadcast();

        console.log("=== Fresh deep pool seeded at 0.21 ===");
        console.log("Pool:            ", pool);
        console.log("tokenId:         ", tokenId);
        console.log("liquidity:       ", uint256(liq));
        console.log("WETH deposited:  ", a0);
        console.log("tWSXMR deposited:", a1);
    }
}
