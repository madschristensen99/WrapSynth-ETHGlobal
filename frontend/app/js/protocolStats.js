// Protocol Stats - Calculate real-time protocol metrics

import { getPublicClient, readHub } from './viemClient.js';
import { CONTRACTS, DEPLOYMENT_BLOCK } from './config.js';
import { formatUnits } from 'https://esm.sh/viem@2.7.0';

const ethPriceCache = {
    value: null,
    timestamp: 0,
    ttlMs: 5 * 60 * 1000
};

async function fetchEthPrice(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && ethPriceCache.value && (now - ethPriceCache.timestamp) < ethPriceCache.ttlMs) {
        return ethPriceCache.value;
    }
    try {
        const resp = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
            const data = await resp.json();
            if (data.ethereum?.usd) {
                ethPriceCache.value = data.ethereum.usd;
                ethPriceCache.timestamp = now;
                return ethPriceCache.value;
            }
        }
    } catch (e) { /* ignore */ }
    try {
        const resp = await fetch('https://api.coincap.io/v2/assets/ethereum', { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
            const data = await resp.json();
            if (data.data?.priceUsd) {
                ethPriceCache.value = parseFloat(data.data.priceUsd);
                ethPriceCache.timestamp = now;
                return ethPriceCache.value;
            }
        }
    } catch (e) { /* ignore */ }
    return ethPriceCache.value || 1681.13;
}

// Correct inline event definition matching the deployed contract ABI
const MINT_INITIATED_EVENT = {
    anonymous: false,
    inputs: [
        { indexed: true, internalType: 'bytes32', name: 'requestId', type: 'bytes32' },
        { indexed: true, internalType: 'address', name: 'initiator', type: 'address' },
        { indexed: true, internalType: 'address', name: 'recipient', type: 'address' },
        { indexed: false, internalType: 'address', name: 'lpVault', type: 'address' },
        { indexed: false, internalType: 'uint256', name: 'xmrAmount', type: 'uint256' },
        { indexed: false, internalType: 'uint256', name: 'wsxmrAmount', type: 'uint256' },
        { indexed: false, internalType: 'uint256', name: 'feeAmount', type: 'uint256' },
        { indexed: false, internalType: 'bytes32', name: 'claimCommitment', type: 'bytes32' },
        { indexed: false, internalType: 'bytes32', name: 'userPublicKey', type: 'bytes32' },
        { indexed: false, internalType: 'uint256', name: 'timeout', type: 'uint256' }
    ],
    name: 'MintInitiated',
    type: 'event'
};

const MAX_BLOCK_RANGE = 2000n; // Matches Base Sepolia public RPC limit

export async function updateProtocolStats() {
    try {
        const publicClient = getPublicClient();
        const currentBlock = await publicClient.getBlockNumber();
        const fromBlock = DEPLOYMENT_BLOCK > 0n ? DEPLOYMENT_BLOCK : currentBlock - MAX_BLOCK_RANGE;

        // Total Minted Ever: paginate through all MintInitiated events since deployment
        let totalMinted = 0;
        let scanBlock = fromBlock;
        while (scanBlock <= currentBlock) {
            const toBlock = scanBlock + MAX_BLOCK_RANGE > currentBlock ? currentBlock : scanBlock + MAX_BLOCK_RANGE;
            try {
                const mintEvents = await publicClient.getLogs({
                    address: CONTRACTS.hub,
                    event: MINT_INITIATED_EVENT,
                    fromBlock: scanBlock,
                    toBlock
                });
                for (const event of mintEvents) {
                    const wsxmrAmount = event.args?.wsxmrAmount || 0n;
                    totalMinted += Number(wsxmrAmount) / 1e8;
                }
            } catch (err) {
                console.warn(`[Protocol Stats] Mint events fetch failed for blocks ${scanBlock}-${toBlock}:`, err);
            }
            scanBlock = toBlock + 1n;
        }

        // Fetch all vault data in one pass: collateral, debt, and fee settings
        const {
            collateralRatio,
            avgMintFee,
            avgBurnReward
        } = await fetchVaultAggregates();

        updateStatsUI(totalMinted, collateralRatio, avgMintFee, avgBurnReward);
    } catch (error) {
        console.error('Error updating protocol stats:', error);
    }
}

async function fetchVaultAggregates() {
    // Gather vault addresses
    const vaultAddresses = [];
    try {
        const vaultCount = await readHub('getVaultCount');
        for (let i = 0n; i < vaultCount; i++) {
            try {
                const addr = await readHub('getVaultAtIndex', [i]);
                if (addr) vaultAddresses.push(addr);
            } catch (e) {
                break;
            }
        }
    } catch (e) {
        console.warn('[Protocol Stats] getVaultCount failed, using fallback');
    }

    if (vaultAddresses.length === 0 && CONTRACTS.defaultLpVault) {
        vaultAddresses.push(CONTRACTS.defaultLpVault);
    }

    // Fetch oracle prices (auto-update once on StalePrice)
    let xmrPrice = 150;      // fallback USD per XMR
    let collateralPrice = 2500;  // fallback USD per ETH
    try {
        const xmrPriceWei = await readHub('getXmrPrice');
        const collPriceWei = await readHub('getCollateralPrice');
        xmrPrice = Number(xmrPriceWei) / 1e18;
        collateralPrice = Number(collPriceWei) / 1e18;
    } catch (e) {
        const msg = (e && e.message) || '';
        if (msg.includes('StalePrice') || msg.includes('0x19abf40e')) {
            console.warn('[Protocol Stats] StalePrice, updating oracle prices...');
            try {
                const { updateOraclePrices } = await import('./chainlinkWrapper.js?v=' + Date.now());
                await updateOraclePrices();
                const xmrPriceWei = await readHub('getXmrPrice');
                const collPriceWei = await readHub('getCollateralPrice');
                xmrPrice = Number(xmrPriceWei) / 1e18;
                collateralPrice = Number(collPriceWei) / 1e18;
            } catch (retryErr) {
                console.warn('[Protocol Stats] Price update retry failed:', retryErr.message);
            }
        } else {
            console.warn('[Protocol Stats] Oracle price fetch failed, trying CoinGecko...');
        }
        const fetchedEth = await fetchEthPrice();
        if (fetchedEth) {
            collateralPrice = fetchedEth;
            console.log('[Protocol Stats] Using fetched ETH price:', collateralPrice);
        }
    }

    // Sum across all active vaults
    let totalCollateral = 0n;
    let totalDebt = 0n;
    let totalMintFeeBps = 0;
    let totalBurnRewardBps = 0;
    let activeCount = 0;

    for (const lpAddress of vaultAddresses) {
        try {
            const vault = await readHub('getVault', [lpAddress]);
            if (vault.active) {
                totalCollateral += BigInt(vault.collateralShares.toString());
                totalDebt += BigInt(vault.normalizedDebt.toString());
                totalMintFeeBps += Number(vault.mintFeeBps);
                totalBurnRewardBps += Number(vault.burnRewardBps);
                activeCount++;
            }
        } catch (e) {
            console.warn(`[Protocol Stats] Failed to fetch vault ${lpAddress}:`, e);
        }
    }

    // Collateral ratio
    const collateralValueUsd = Number(formatUnits(totalCollateral, 18)) * collateralPrice;
    const debtValueUsd = Number(formatUnits(totalDebt, 8)) * xmrPrice;
    const collateralRatio = debtValueUsd > 0 ? (collateralValueUsd / debtValueUsd) * 100 : 0;

    // Fee/reward rates directly from vault settings (bps / 100 = percent)
    const avgMintFee = activeCount > 0 ? totalMintFeeBps / activeCount / 100 : 0;
    const avgBurnReward = activeCount > 0 ? totalBurnRewardBps / activeCount / 100 : 0;

    console.log('[Protocol Stats]', {
        activeVaults: activeCount,
        collateralRatio: Math.round(collateralRatio) + '%',
        avgMintFee: avgMintFee.toFixed(2) + '%',
        avgBurnReward: avgBurnReward.toFixed(2) + '%'
    });

    return { collateralRatio, avgMintFee, avgBurnReward };
}

function updateStatsUI(totalMinted, collateralRatio, avgMintFee, avgBurnReward) {
    const totalMintedEl = document.getElementById('total-minted');
    const collateralRatioEl = document.getElementById('collateral-ratio-stat');
    const avgMintFeeEl = document.getElementById('avg-mint-fee');
    const avgBurnRewardEl = document.getElementById('avg-burn-reward');

    if (totalMintedEl) {
        totalMintedEl.textContent = `${totalMinted.toFixed(6)} wsXMR`;
    }

    if (collateralRatioEl) {
        if (collateralRatio > 0) {
            collateralRatioEl.textContent = `${Math.round(collateralRatio)}%`;

            if (collateralRatio >= 200) {
                collateralRatioEl.style.color = '#22c55e'; // Green
            } else if (collateralRatio >= 150) {
                collateralRatioEl.style.color = '#fb923c'; // Orange
            } else {
                collateralRatioEl.style.color = '#ef4444'; // Red
            }
        } else {
            collateralRatioEl.textContent = '>200%';
            collateralRatioEl.style.color = '#22c55e';
        }
    }

    if (avgMintFeeEl) {
        avgMintFeeEl.textContent = `${avgMintFee.toFixed(2)}%`;
    }

    if (avgBurnRewardEl) {
        avgBurnRewardEl.textContent = `${avgBurnReward.toFixed(2)}%`;
    }
}
