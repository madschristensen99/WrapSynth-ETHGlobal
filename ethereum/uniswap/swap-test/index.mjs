/**
 * Uniswap Trading API round-trip test — tWSXMR → WETH on Base Sepolia
 *
 * Flow:
 *   1. POST /check_approval
 *   2. POST /quote  (force classic AMM: protocols=["V3","V2"])
 *   --- ROUTING GATE: stop if routing !== "CLASSIC" ---
 *   3. Sign permitData if present (signTypedData via viem)
 *   4. POST /swap  (spread quote into body, add signature+permitData or neither)
 *   5. Validate swap.data is non-empty hex
 *   6. Broadcast tx, print hash + BaseScan link
 *
 * Requires: .env with PRIVATE_KEY, TWSXMR_ADDRESS, UNISWAP_API_KEY
 * Run: node index.mjs  (or: npm test)
 */

import 'dotenv/config';
import {
    createWalletClient,
    createPublicClient,
    http,
    parseAbi,
    isHex,
    isAddress,
    formatUnits,
} from 'viem';
import { baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// ─── Config ───────────────────────────────────────────────────────────────────
const UNISWAP_BASE = 'https://trade-api.gateway.uniswap.org/v1';
const CHAIN_ID = 84532; // Base Sepolia
const WETH     = '0x4200000000000000000000000000000000000006';
const EXPLORER = 'https://sepolia.basescan.org';

function requireEnv(name) {
    const v = process.env[name];
    if (!v || v.startsWith('0x...') || v === '') {
        throw new Error(`Missing required env var: ${name}`);
    }
    return v;
}

const PRIVATE_KEY    = requireEnv('PRIVATE_KEY');
const TWSXMR_ADDRESS = requireEnv('TWSXMR_ADDRESS');
const API_KEY        = requireEnv('UNISWAP_API_KEY');
const RPC            = process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org';

// ─── Clients ──────────────────────────────────────────────────────────────────
const account = privateKeyToAccount(PRIVATE_KEY);
const walletClient = createWalletClient({
    account,
    chain: baseSepolia,
    transport: http(RPC),
});
const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC),
});

console.log('Wallet address:', account.address);
console.log('tWSXMR address:', TWSXMR_ADDRESS);
console.log('');

// ─── Uniswap API helpers ──────────────────────────────────────────────────────
const HEADERS = {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY,
    'x-universal-router-version': '2.0',
    'Origin': 'https://app.uniswap.org',
};

async function uniswapPost(path, body) {
    const url = `${UNISWAP_BASE}${path}`;
    console.log(`  → POST ${path}`);
    const resp = await fetch(url, {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) {
        console.error(`  ✗ ${resp.status}:`, JSON.stringify(data, null, 2));
        throw new Error(`Uniswap API error ${resp.status} on ${path}: ${data.errorCode ?? data.detail ?? JSON.stringify(data)}`);
    }
    console.log(`  ✓ ${resp.status}`);
    return data;
}

// ─── ERC-20 helper ────────────────────────────────────────────────────────────
const erc20Abi = parseAbi([
    'function balanceOf(address) view returns (uint256)',
]);

async function getBalance(tokenAddress, owner) {
    return publicClient.readContract({
        address: tokenAddress,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [owner],
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
    // ── Pre-flight balance check ───────────────────────────────────────────────
    const balance = await getBalance(TWSXMR_ADDRESS, account.address);
    console.log(`tWSXMR balance: ${formatUnits(balance, 8)} tWSXMR`);
    if (balance === 0n) {
        throw new Error('No tWSXMR balance — mint some first: call TestWSXMR.mint(address, amount)');
    }

    // Swap 1 tWSXMR = 1e8 base units
    const swapAmount = 1n * 10n ** 8n;
    console.log(`Swapping: ${formatUnits(swapAmount, 8)} tWSXMR → WETH`);
    console.log('');

    // ── Step 1: Check approval ─────────────────────────────────────────────────
    console.log('[Step 1] Check approval...');
    const approvalRes = await uniswapPost('/check_approval', {
        token: TWSXMR_ADDRESS,
        amount: swapAmount.toString(),
        walletAddress: account.address,
        chainId: CHAIN_ID,
    });

    if (approvalRes.approval) {
        console.log('  Approval required — sending approval tx...');
        const { to, data: approveData, value: approveValue } = approvalRes.approval;

        const approveTxHash = await walletClient.sendTransaction({
            to,
            data: approveData,
            value: BigInt(approveValue ?? '0'),
        });
        console.log('  Approval tx:', approveTxHash);
        console.log('  Waiting for confirmation...');
        await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
        console.log('  ✓ Approval confirmed');
    } else {
        console.log('  ✓ Token already approved (no approval tx needed)');
    }
    console.log('');

    // ── Step 2: Get quote (CLASSIC only) ──────────────────────────────────────
    console.log('[Step 2] Fetching quote...');
    const quoteRes = await uniswapPost('/quote', {
        type: 'EXACT_INPUT',
        amount: swapAmount.toString(),
        tokenIn: TWSXMR_ADDRESS,
        tokenOut: WETH,
        tokenInChainId: CHAIN_ID,
        tokenOutChainId: CHAIN_ID,
        swapper: account.address,
        slippageTolerance: 0.5,
        routingPreference: 'BEST_PRICE',
        protocols: ['V3', 'V2'],  // force classic AMM only — UniswapX not on testnet
    });

    // ── ROUTING GATE ──────────────────────────────────────────────────────────
    if (!quoteRes.routing) {
        console.error('Unexpected quote response shape:', JSON.stringify(quoteRes, null, 2));
        throw new Error('Quote response missing routing field — possible API format change');
    }
    if (quoteRes.routing !== 'CLASSIC') {
        console.error('');
        console.error('⛔ ROUTING GATE: Non-classic route returned:', quoteRes.routing);
        console.error('   This usually means no liquidity found on classic V2/V3 pools.');
        console.error('   Full response:', JSON.stringify(quoteRes, null, 2));
        console.error('');
        console.error('   Troubleshooting:');
        console.error('   • Confirm the pool was created (SeedPool.s.sol ran successfully)');
        console.error('   • Confirm TWSXMR_ADDRESS matches the deployed contract');
        console.error('   • The pool may need more liquidity or time to index');
        process.exit(1);
    }

    const outAmount = quoteRes.quote.output.amount;
    const slippage  = quoteRes.quote.slippage;
    const gasUSD    = quoteRes.quote.gasFeeUSD;

    console.log(`  Routing:      ${quoteRes.routing}`);
    console.log(`  Output:       ${formatUnits(BigInt(outAmount), 18)} WETH`);
    console.log(`  Slippage:     ${slippage}%`);
    console.log(`  Gas (USD):    $${gasUSD}`);
    console.log('');

    // ── Step 3: Sign Permit2 if needed ────────────────────────────────────────
    const { permitData, permitTransaction, ...cleanQuote } = quoteRes;
    let signature;

    if (permitData && typeof permitData === 'object') {
        console.log('[Step 3] Signing Permit2 typed data...');
        signature = await walletClient.signTypedData({
            domain: permitData.domain,
            types: permitData.types,
            primaryType: Object.keys(permitData.types).find(k => k !== 'EIP712Domain') || Object.keys(permitData.types)[0],
            message: permitData.values ?? permitData.message,
        });
        console.log('  ✓ Permit2 signature:', signature.slice(0, 20) + '...');
    } else {
        console.log('[Step 3] No Permit2 required — skipping signature');
    }
    console.log('');

    // ── Step 4: Get swap calldata ──────────────────────────────────────────────
    console.log('[Step 4] Fetching swap calldata...');

    // CRITICAL: spread the full quote response into the body (NOT {quote: quoteRes})
    const swapBody = { ...cleanQuote };

    // CLASSIC: both signature+permitData required, or neither
    if (signature && permitData && typeof permitData === 'object') {
        swapBody.signature = signature;
        swapBody.permitData = permitData;
    }
    // Do NOT set permitData: null — omit entirely

    const swapRes = await uniswapPost('/swap', swapBody);

    // ── Step 5: Validate calldata ─────────────────────────────────────────────
    const swap = swapRes.swap;
    if (!swap?.data || swap.data === '' || swap.data === '0x') {
        throw new Error('swap.data is empty — quote likely expired. Re-run the script.');
    }
    if (!isHex(swap.data)) {
        throw new Error('swap.data is not valid hex');
    }
    if (!isAddress(swap.to)) {
        throw new Error('swap.to is not a valid address');
    }
    if (swap.value === undefined || swap.value === null) {
        throw new Error('swap.value is missing');
    }
    console.log('  ✓ Calldata validated');
    console.log(`  To:       ${swap.to}`);
    console.log(`  Value:    ${swap.value}`);
    console.log(`  GasLimit: ${swap.gasLimit ?? 'not provided (will estimate)'}`);
    console.log('');

    // ── Step 6: Broadcast ─────────────────────────────────────────────────────
    console.log('[Step 6] Broadcasting swap transaction...');
    const txHash = await walletClient.sendTransaction({
        to:    swap.to,
        data:  swap.data,
        value: BigInt(swap.value ?? '0'),
        ...(swap.gasLimit ? { gas: BigInt(swap.gasLimit) } : {}),
    });

    console.log('');
    console.log('✅ Swap broadcast!');
    console.log('   Tx hash:', txHash);
    console.log('   BaseScan:', `${EXPLORER}/tx/${txHash}`);
    console.log('');
    console.log('Waiting for confirmation...');

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status === 'reverted') {
        throw new Error('Transaction reverted on-chain');
    }
    console.log('✅ Confirmed in block', receipt.blockNumber.toString());
    console.log('');
    console.log('tWSXMR swapped for WETH on Base Sepolia via Uniswap Trading API.');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
