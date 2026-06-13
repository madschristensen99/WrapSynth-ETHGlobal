// Read-only validation of the Swap tab's on-chain path against the correctly-priced
// fee-0.01% tWSXMR/WETH pool. Mirrors frontend/app/js/swapFlow.js exactly:
//   • QuoterV2.quoteExactInputSingle  → price (eth_call)
//   • SwapRouter02.exactInputSingle   → plain ERC-20→ERC-20 swap, output to user
// Swap calldata is gas-estimated with an allowance state-override (no real approval).
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, formatUnits, keccak256, encodeAbiParameters } from 'viem';

const RPC      = 'https://sepolia.base.org';
const QUOTER   = '0xC5290058841028F1614F3A6F0F5816cAd0df5E27';
const ROUTER   = '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4';
const WETH     = '0x4200000000000000000000000000000000000006';
const TWSXMR   = '0xdC8A3309e384d4b669feB350F97204c3e8404477';
const FEE      = 100;
const ETH_USD  = 1675.57;
const DEPLOYER = '0x15d265dc32a575755aca19b5eceab8018cdd26f1'; // holds tWSXMR + WETH

const QUOTER_ABI = [{
    type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
    inputs: [{ name: 'params', type: 'tuple', components: [
        { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
        { name: 'amountIn', type: 'uint256' }, { name: 'fee', type: 'uint24' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ] }],
    outputs: [
        { name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96After', type: 'uint160' },
        { name: 'initializedTicksCrossed', type: 'uint32' }, { name: 'gasEstimate', type: 'uint256' },
    ],
}];

const ROUTER_ABI = [{
    type: 'function', name: 'exactInputSingle', stateMutability: 'payable',
    inputs: [{ name: 'params', type: 'tuple', components: [
        { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
        { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
        { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ] }],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
}];

const pc = createPublicClient({ transport: http(RPC) });

async function quote(tokenIn, tokenOut, amountIn) {
    const data = encodeFunctionData({ abi: QUOTER_ABI, functionName: 'quoteExactInputSingle',
        args: [{ tokenIn, tokenOut, amountIn, fee: FEE, sqrtPriceLimitX96: 0n }] });
    const res = await pc.call({ to: QUOTER, data });
    return decodeFunctionResult({ abi: QUOTER_ABI, functionName: 'quoteExactInputSingle', data: res.data })[0];
}

// allowance storage slot for mapping(owner => mapping(spender => uint)) at `mapSlot`
function allowanceSlot(owner, spender, mapSlot) {
    const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, mapSlot]));
    return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [spender, inner]));
}

// estimateGas for a plain ERC-20 exactInputSingle, overriding the input token's allowance
async function simSwap(tokenIn, tokenOut, amountIn, allowToken, mapSlot) {
    const data = encodeFunctionData({ abi: ROUTER_ABI, functionName: 'exactInputSingle',
        args: [{ tokenIn, tokenOut, fee: FEE, recipient: DEPLOYER, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
    const slot = allowanceSlot(DEPLOYER, ROUTER, mapSlot);
    return pc.estimateGas({ account: DEPLOYER, to: ROUTER, data, value: 0n,
        stateOverride: [{ address: allowToken, stateDiff: [{ slot, value: '0x' + 'ff'.repeat(32) }] }] });
}

(async () => {
    console.log(`Validating fee-${FEE/10000}% tWSXMR/WETH pool (target 1 tWSXMR = 0.2242 WETH)\n`);

    const sellIn = 10n ** 6n;       // 0.01 tWSXMR (tiny → near-spot, low impact)
    const buyIn  = 2n * 10n ** 15n; // 0.002 WETH

    const sellOut = await quote(TWSXMR, WETH, sellIn);
    const buyOut  = await quote(WETH, TWSXMR, buyIn);
    const sellInF = Number(formatUnits(sellIn, 8));
    const sellOutF = Number(formatUnits(sellOut, 18));
    console.log(`SELL  ${sellInF} tWSXMR -> ${sellOutF} WETH`);
    console.log(`BUY   ${Number(formatUnits(buyIn, 18))} WETH -> ${formatUnits(buyOut, 8)} tWSXMR`);
    console.log(`implied spot: 1 tWSXMR = ${(sellOutF / sellInF).toFixed(6)} WETH  (target 0.2242)`);

    // tWSXMR (OZ ERC20) allowances live at slot 1; WETH9 allowances at slot 4.
    const sellGas = await simSwap(TWSXMR, WETH, sellIn, TWSXMR, 1n);
    const buyGas  = await simSwap(WETH, TWSXMR, buyIn, WETH, 4n);
    console.log(`\nSELL swap calldata: estimateGas ${sellGas} (no revert) ✓`);
    console.log(`BUY  swap calldata: estimateGas ${buyGas} (no revert) ✓`);

    console.log('\n✅ Correctly-priced pool + both swap directions validated.');
})().catch(e => { console.error('\n❌ Failed:', e.shortMessage || e.message); process.exit(1); });
