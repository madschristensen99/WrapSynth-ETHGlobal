// Read-only validation of multi-hop V3 routing via WETH on Base Sepolia.
// Proves the "wsXMR ↔ any token, routed through WETH" design works with QuoterV2.
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult, encodePacked, keccak256, encodeAbiParameters, formatUnits } from 'viem';

const RPC    = 'https://sepolia.base.org';
const QUOTER = '0xC5290058841028F1614F3A6F0F5816cAd0df5E27';
const ROUTER = '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4';
const WETH   = '0x4200000000000000000000000000000000000006';
const TWSXMR = '0xdC8A3309e384d4b669feB350F97204c3e8404477';
const USDC   = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const FEE_TWSXMR = 100;   // tWSXMR/WETH pool
const FEE_USDC   = 3000;  // WETH/USDC deepest pool
const DEPLOYER = '0x15d265dc32a575755aca19b5eceab8018cdd26f1';

const ROUTER_ABI = [
  { type:'function', name:'exactInputSingle', stateMutability:'payable', inputs:[{name:'p',type:'tuple',components:[
    {name:'tokenIn',type:'address'},{name:'tokenOut',type:'address'},{name:'fee',type:'uint24'},{name:'recipient',type:'address'},
    {name:'amountIn',type:'uint256'},{name:'amountOutMinimum',type:'uint256'},{name:'sqrtPriceLimitX96',type:'uint160'}]}], outputs:[{type:'uint256'}] },
  { type:'function', name:'exactInput', stateMutability:'payable', inputs:[{name:'p',type:'tuple',components:[
    {name:'path',type:'bytes'},{name:'recipient',type:'address'},{name:'amountIn',type:'uint256'},{name:'amountOutMinimum',type:'uint256'}]}], outputs:[{type:'uint256'}] },
];
function allowanceSlot(owner, spender, mapSlot) {
  const inner = keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}], [owner, mapSlot]));
  return keccak256(encodeAbiParameters([{type:'address'},{type:'bytes32'}], [spender, inner]));
}

const pc = createPublicClient({ transport: http(RPC) });

const SINGLE_ABI = [{ type:'function', name:'quoteExactInputSingle', stateMutability:'nonpayable',
  inputs:[{name:'p',type:'tuple',components:[{name:'tokenIn',type:'address'},{name:'tokenOut',type:'address'},{name:'amountIn',type:'uint256'},{name:'fee',type:'uint24'},{name:'sqrtPriceLimitX96',type:'uint160'}]}],
  outputs:[{name:'amountOut',type:'uint256'},{type:'uint160'},{type:'uint32'},{type:'uint256'}] }];
const PATH_ABI = [{ type:'function', name:'quoteExactInput', stateMutability:'nonpayable',
  inputs:[{name:'path',type:'bytes'},{name:'amountIn',type:'uint256'}],
  outputs:[{name:'amountOut',type:'uint256'},{name:'a',type:'uint160[]'},{name:'b',type:'uint32[]'},{name:'g',type:'uint256'}] }];

async function single(tokenIn, tokenOut, amountIn, fee) {
  const data = encodeFunctionData({ abi: SINGLE_ABI, functionName:'quoteExactInputSingle', args:[{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] });
  const r = await pc.call({ to: QUOTER, data });
  return decodeFunctionResult({ abi: SINGLE_ABI, functionName:'quoteExactInputSingle', data: r.data })[0];
}
async function path(tokens, fees, amountIn) {
  // path = token0, fee0, token1, fee1, token2 ...
  const types = []; const vals = [];
  tokens.forEach((t,i)=>{ types.push('address'); vals.push(t); if(i<fees.length){ types.push('uint24'); vals.push(fees[i]); } });
  const p = encodePacked(types, vals);
  const data = encodeFunctionData({ abi: PATH_ABI, functionName:'quoteExactInput', args:[p, amountIn] });
  const r = await pc.call({ to: QUOTER, data });
  return decodeFunctionResult({ abi: PATH_ABI, functionName:'quoteExactInput', data: r.data })[0];
}

(async () => {
  console.log('Multi-hop routing via WETH on Base Sepolia:\n');

  // single hops
  const a = await single(WETH, USDC, 10n**16n, FEE_USDC);   // 0.01 WETH -> USDC
  console.log(`  [single] 0.01 WETH        -> ${formatUnits(a,6)} USDC`);
  const b = await single(TWSXMR, WETH, 10n**8n, FEE_TWSXMR); // 1 tWSXMR -> WETH
  console.log(`  [single] 1 tWSXMR         -> ${formatUnits(b,18)} WETH`);

  // multi-hop tWSXMR -> WETH -> USDC
  const c = await path([TWSXMR, WETH, USDC], [FEE_TWSXMR, FEE_USDC], 10n**8n); // 1 tWSXMR
  console.log(`  [multi ] 1 tWSXMR -> WETH -> ${formatUnits(c,6)} USDC`);

  // multi-hop USDC -> WETH -> tWSXMR
  const d = await path([USDC, WETH, TWSXMR], [FEE_USDC, FEE_TWSXMR], 10n**6n); // 1 USDC
  console.log(`  [multi ] 1 USDC   -> WETH -> ${formatUnits(d,8)} tWSXMR`);

  // ── Swap calldata gas-estimates (allowance overridden; mirrors the frontend) ──
  console.log('\nSwap calldata (estimateGas, no revert):');
  // single-hop WETH -> USDC (WETH9 allowance slot 4)
  const singleData = encodeFunctionData({ abi: ROUTER_ABI, functionName:'exactInputSingle',
    args:[{ tokenIn: WETH, tokenOut: USDC, fee: FEE_USDC, recipient: DEPLOYER, amountIn: 10n**15n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
  const g1 = await pc.estimateGas({ account: DEPLOYER, to: ROUTER, data: singleData, value: 0n,
    stateOverride: [{ address: WETH, stateDiff: [{ slot: allowanceSlot(DEPLOYER, ROUTER, 4n), value: '0x'+'ff'.repeat(32) }] }] });
  console.log(`  [single] WETH -> USDC               : ${g1} gas ✓`);

  // multi-hop tWSXMR -> WETH -> USDC (tWSXMR OZ allowance slot 1)
  const swapPath = encodePacked(['address','uint24','address','uint24','address'], [TWSXMR, FEE_TWSXMR, WETH, FEE_USDC, USDC]);
  const multiData = encodeFunctionData({ abi: ROUTER_ABI, functionName:'exactInput',
    args:[{ path: swapPath, recipient: DEPLOYER, amountIn: 10n**7n, amountOutMinimum: 0n }] });
  const g2 = await pc.estimateGas({ account: DEPLOYER, to: ROUTER, data: multiData, value: 0n,
    stateOverride: [{ address: TWSXMR, stateDiff: [{ slot: allowanceSlot(DEPLOYER, ROUTER, 1n), value: '0x'+'ff'.repeat(32) }] }] });
  console.log(`  [multi ] tWSXMR -> WETH -> USDC      : ${g2} gas ✓`);

  console.log('\n✅ Multi-hop quoting + single/multi swap calldata validated — wsXMR ↔ any token works.');
})().catch(e => { console.error('\n❌ Failed:', e.shortMessage || e.message); process.exit(1); });
