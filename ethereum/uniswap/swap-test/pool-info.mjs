// Live pool diagnostics for the tWSXMR/WETH Base Sepolia pool.
// Answers: current reserves (how much ETH/tWSXMR is in the pool), current price,
// liquidity, and gas estimates for BUY/SELL (to diagnose "exceeds max gas limit").
import { createPublicClient, http, formatUnits, getAddress, encodeFunctionData, keccak256, encodeAbiParameters } from 'viem';

const RPC      = 'https://sepolia.base.org';
const FACTORY  = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';
const QUOTER   = '0xC5290058841028F1614F3A6F0F5816cAd0df5E27';
const ROUTER   = '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4';
const WETH     = '0x4200000000000000000000000000000000000006';
const TWSXMR   = '0xdC8A3309e384d4b669feB350F97204c3e8404477';
const FEE      = 100;          // active deep pool (0.01% tier) at 0.21
const ETH_USD  = 1675.57;      // reference for the USD readout
const DEPLOYER = '0x15d265dc32a575755aca19b5eceab8018cdd26f1';
const ZERO     = '0x0000000000000000000000000000000000000000';

const pc = createPublicClient({ transport: http(RPC) });

const factoryAbi = [{ type:'function', name:'getPool', stateMutability:'view',
  inputs:[{type:'address'},{type:'address'},{type:'uint24'}], outputs:[{type:'address'}] }];
const poolAbi = [
  { type:'function', name:'slot0', stateMutability:'view', inputs:[], outputs:[
    {name:'sqrtPriceX96',type:'uint160'},{name:'tick',type:'int24'},{name:'observationIndex',type:'uint16'},
    {name:'observationCardinality',type:'uint16'},{name:'observationCardinalityNext',type:'uint16'},
    {name:'feeProtocol',type:'uint8'},{name:'unlocked',type:'bool'}] },
  { type:'function', name:'liquidity', stateMutability:'view', inputs:[], outputs:[{type:'uint128'}] },
];
const erc20Abi = [{ type:'function', name:'balanceOf', stateMutability:'view', inputs:[{type:'address'}], outputs:[{type:'uint256'}] }];
const routerAbi = [
  { type:'function', name:'exactInputSingle', stateMutability:'payable', inputs:[{name:'params',type:'tuple',components:[
    {name:'tokenIn',type:'address'},{name:'tokenOut',type:'address'},{name:'fee',type:'uint24'},{name:'recipient',type:'address'},
    {name:'amountIn',type:'uint256'},{name:'amountOutMinimum',type:'uint256'},{name:'sqrtPriceLimitX96',type:'uint160'}]}],
    outputs:[{name:'amountOut',type:'uint256'}] },
  { type:'function', name:'unwrapWETH9', stateMutability:'payable', inputs:[{name:'amountMinimum',type:'uint256'},{name:'recipient',type:'address'}], outputs:[] },
  { type:'function', name:'multicall', stateMutability:'payable', inputs:[{name:'deadline',type:'uint256'},{name:'data',type:'bytes[]'}], outputs:[{type:'bytes[]'}] },
];

(async () => {
  const pool = await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName:'getPool', args:[WETH, TWSXMR, FEE] });
  console.log('Pool address:', pool);
  console.log('BaseScan:    ', `https://sepolia.basescan.org/address/${pool}`);

  const wethBal   = await pc.readContract({ address: WETH,   abi: erc20Abi, functionName:'balanceOf', args:[pool] });
  const twsxmrBal = await pc.readContract({ address: TWSXMR, abi: erc20Abi, functionName:'balanceOf', args:[pool] });
  const slot0     = await pc.readContract({ address: pool,   abi: poolAbi,  functionName:'slot0' });
  const liq       = await pc.readContract({ address: pool,   abi: poolAbi,  functionName:'liquidity' });

  console.log('\n── Reserves (tokens physically held by the pool) ──');
  console.log(`  WETH   : ${formatUnits(wethBal, 18)} WETH  (= that much Sepolia ETH, wrapped)`);
  console.log(`  tWSXMR : ${formatUnits(twsxmrBal, 8)} tWSXMR`);
  console.log(`  in-range liquidity: ${liq.toString()}`);

  // price: token0=WETH(18), token1=tWSXMR(8). price_raw = (sqrtP/2^96)^2 = token1_raw/token0_raw
  const sqrtP = slot0[0];
  const priceRaw = (Number(sqrtP) / 2 ** 96) ** 2;      // tWSXMR_raw per WETH_raw
  const tWSXMRperETH = priceRaw * 10 ** (18 - 8);        // human tWSXMR per 1 ETH
  const tWSXMRinUSD = (1 / tWSXMRperETH) * ETH_USD;
  console.log('\n── Current price (from slot0) ──');
  console.log(`  1 ETH    = ${tWSXMRperETH.toLocaleString()} tWSXMR`);
  console.log(`  1 tWSXMR = ${(1 / tWSXMRperETH).toFixed(6)} WETH`);
  console.log(`  1 tWSXMR = $${tWSXMRinUSD.toFixed(2)}  (at ETH = $${ETH_USD})`);
  console.log(`  tick: ${slot0[1]}`);

  // ── Gas estimates ──
  console.log('\n── Gas estimates ──');
  const sellIn = 10n ** 7n;          // 0.1 tWSXMR
  const buyIn  = 10n ** 16n;         // 0.01 ETH

  // BUY: no approval needed
  const buyData = encodeFunctionData({ abi: routerAbi, functionName:'exactInputSingle',
    args:[{ tokenIn: WETH, tokenOut: TWSXMR, fee: FEE, recipient: DEPLOYER, amountIn: buyIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
  try {
    const g = await pc.estimateGas({ account: DEPLOYER, to: ROUTER, data: buyData, value: buyIn });
    console.log(`  BUY  (ETH→tWSXMR): ${g.toString()} gas`);
  } catch (e) { console.log('  BUY estimate failed:', e.shortMessage || e.message); }

  // SELL: needs allowance override (OZ ERC20 _allowances slot 1)
  const innerSlot = keccak256(encodeAbiParameters([{type:'address'},{type:'uint256'}], [DEPLOYER, 1n]));
  const allowSlot = keccak256(encodeAbiParameters([{type:'address'},{type:'bytes32'}], [ROUTER, innerSlot]));
  const swapCall = encodeFunctionData({ abi: routerAbi, functionName:'exactInputSingle',
    args:[{ tokenIn: TWSXMR, tokenOut: WETH, fee: FEE, recipient: ZERO, amountIn: sellIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }] });
  const unwrapCall = encodeFunctionData({ abi: routerAbi, functionName:'unwrapWETH9', args:[0n, DEPLOYER] });
  const sellData = encodeFunctionData({ abi: routerAbi, functionName:'multicall',
    args:[BigInt(Math.floor(Date.now()/1000)+1800), [swapCall, unwrapCall]] });
  try {
    const g = await pc.estimateGas({ account: DEPLOYER, to: ROUTER, data: sellData, value: 0n,
      stateOverride: [{ address: TWSXMR, stateDiff: [{ slot: allowSlot, value: '0x'+'ff'.repeat(32) }] }] });
    console.log(`  SELL (tWSXMR→ETH): ${g.toString()} gas`);
  } catch (e) { console.log('  SELL estimate failed:', e.shortMessage || e.message); }
})().catch(e => { console.error('Failed:', e.shortMessage || e.message); process.exit(1); });
