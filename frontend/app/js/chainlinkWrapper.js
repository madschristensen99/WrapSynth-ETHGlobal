// Chainlink Data Streams Oracle Price Update Helper
//
// Replaces redstoneWrapper.js for the Base Sepolia deployment.
//
// Flow:
//   1. Fetch signed `fullReport` blobs from the report-proxy server
//      (frontend/report-proxy/) — the API secret never reaches the browser.
//   2. ABI-encode `updateOraclePrices(bytes[])` with the two report blobs
//      (XMR/USD, ETH/USD) inside the args array.
//   3. Send the transaction; the hub delegatecalls
//      ChainlinkDataStreamsOracleFacet, which verifies each report via the
//      on-chain VerifierProxy and stores the resulting prices.

import { CONTRACTS, ORACLE_CONFIG } from './config.js';
import { getWalletClient, getPublicClient, getUserAddress } from './viemClient.js';

export async function updateOraclePrices() {
    console.log('Updating oracle prices with Chainlink Data Streams...');

    const { encodeFunctionData, parseAbi } = await import('https://esm.sh/viem@2.7.0');

    const walletClient = getWalletClient();
    const publicClient = getPublicClient();
    const account = getUserAddress();

    const proxyUrl = ORACLE_CONFIG.reportProxyUrl;
    const feedIDs = [ORACLE_CONFIG.xmrFeedId, ORACLE_CONFIG.ethFeedId].join(',');

    console.log(`Fetching reports from ${proxyUrl}...`);
    let res;
    try {
        res = await fetch(`${proxyUrl}/reports?feedIDs=${feedIDs}`);
    } catch (fetchErr) {
        if (fetchErr.message?.includes('Failed to fetch') || fetchErr.message?.includes('ECONNREFUSED')) {
            throw new Error(
                `Cannot reach report proxy at ${proxyUrl}. ` +
                `Make sure the LP server is running (npm start in lp-server/).`
            );
        }
        throw fetchErr;
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Report proxy ${res.status}: ${body || res.statusText}`);
    }
    const { reports } = await res.json();
    if (!Array.isArray(reports) || reports.length !== 2) {
        throw new Error(`Expected 2 reports, got ${reports?.length ?? 'none'}`);
    }

    // Preserve the [XMR, ETH] order the facet expects
    const sorted = [
        reports.find((r) => r.feedID.toLowerCase() === ORACLE_CONFIG.xmrFeedId.toLowerCase()),
        reports.find((r) => r.feedID.toLowerCase() === ORACLE_CONFIG.ethFeedId.toLowerCase()),
    ];
    if (!sorted[0] || !sorted[1]) throw new Error('Report proxy returned wrong feed IDs');
    const updateData = sorted.map((r) =>
        r.fullReport.startsWith('0x') ? r.fullReport : `0x${r.fullReport}`
    );

    console.log('Sending updateOraclePrices tx...');
    const oracleAbi = parseAbi(['function updateOraclePrices(bytes[] calldata) external payable']);
    const data = encodeFunctionData({
        abi: oracleAbi,
        functionName: 'updateOraclePrices',
        args: [updateData],
    });

    const hash = await walletClient.sendTransaction({
        to: CONTRACTS.hub,
        data,
        account,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log('Oracle prices updated. TX:', receipt.transactionHash);
    return true;
}
