// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Re-establishes the 0.01% (fee-100) tWSXMR/WETH pool as the deep active pool.
// The pool is already initialized (at ~0.2242) but empty, so: seed a deep full-range
// position at the current price, then a price-limited swap nudges it to exactly 0.21.
// (0.30% tier is unusable — a broken-price pool already occupies it; 0.01% is the
// cleanest LOWER fee than 0.30%.)
address constant NPM    = 0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2;
address constant ROUTER = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4;
address constant WETH   = 0x4200000000000000000000000000000000000006;
address constant POOL   = 0x1817b435b2815d9B052398dEf87BfA32a57dF095;
uint24  constant FEE    = 100;
int24   constant TICK_LOWER = -887272; // fee-100 tickSpacing 1 → raw min/max
int24   constant TICK_UPPER =  887272;

interface IUniswapV3Pool {
    function slot0() external view returns (uint160,int24,uint16,uint16,uint16,uint8,bool);
}
interface INonfungiblePositionManager {
    struct MintParams {
        address token0; address token1; uint24 fee; int24 tickLower; int24 tickUpper;
        uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min;
        address recipient; uint256 deadline;
    }
    function mint(MintParams calldata params)
        external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);
}
interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn; address tokenOut; uint24 fee; address recipient;
        uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

contract SetupPool100 is Script {
    function run() external {
        address tWSXMR  = vm.envAddress("TWSXMR_ADDRESS");
        uint160 target  = uint160(vm.envUint("TARGET_SQRT_PRICE_X96")); // 0.21
        uint256 wethSeed = vm.envUint("WETH_SEED");
        uint256 twsxmrSeed = vm.envUint("TWSXMR_SEED");
        uint256 swapMaxIn = vm.envUint("SWAP_MAX_IN"); // tWSXMR for the reprice nudge

        uint256 key = vm.envUint("PRIVATE_KEY");
        address me  = vm.addr(key);
        require(IERC20(WETH).balanceOf(me)   >= wethSeed,   "Insufficient WETH");
        require(IERC20(tWSXMR).balanceOf(me) >= twsxmrSeed + swapMaxIn, "Insufficient tWSXMR");

        vm.startBroadcast(key);

        // 1. Seed a deep full-range position at the pool's CURRENT price.
        IERC20(WETH).approve(NPM, wethSeed);
        IERC20(tWSXMR).approve(NPM, twsxmrSeed);
        (uint256 tokenId,, uint256 a0, uint256 a1) =
            INonfungiblePositionManager(NPM).mint(INonfungiblePositionManager.MintParams({
                token0: WETH, token1: tWSXMR, fee: FEE, tickLower: TICK_LOWER, tickUpper: TICK_UPPER,
                amount0Desired: wethSeed, amount1Desired: twsxmrSeed, amount0Min: 0, amount1Min: 0,
                recipient: me, deadline: block.timestamp + 3600
            }));
        console.log("Seeded tokenId:", tokenId);
        console.log("  WETH in:", a0); console.log("  tWSXMR in:", a1);

        // 2. Nudge price to exactly 0.21 (SELL tWSXMR raises price; limit = target).
        (uint160 cur,,,,,,) = IUniswapV3Pool(POOL).slot0();
        if (cur < target) {
            IERC20(tWSXMR).approve(ROUTER, swapMaxIn);
            ISwapRouter(ROUTER).exactInputSingle(ISwapRouter.ExactInputSingleParams({
                tokenIn: tWSXMR, tokenOut: WETH, fee: FEE, recipient: me,
                amountIn: swapMaxIn, amountOutMinimum: 0, sqrtPriceLimitX96: target
            }));
        }

        vm.stopBroadcast();

        (uint160 fin,,,,,,) = IUniswapV3Pool(POOL).slot0();
        console.log("final sqrtPriceX96:", uint256(fin));
        console.log("target sqrtPriceX96:", uint256(target));
    }
}
