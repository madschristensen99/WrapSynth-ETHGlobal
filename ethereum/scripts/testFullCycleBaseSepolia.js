#!/usr/bin/env node
/**
 * Test FULL mint and burn cycle on Base Sepolia (Chainlink Data Streams)
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { execSync } = require('child_process');
const path = require('path');
const {
    HUB_ADDRESS, WSXMR_ADDRESS, WXDAI_ADDRESS, ED25519_HELPER, RPC_URL
} = require('./deploymentConfig');

const PROXY_DIR = path.join(__dirname, '../../frontend/report-proxy');
const XMR_FEED = '0x0003c70558bd921b1559d37b8e347797f121d1240e7386e68b2bee9b731b0833';
const ETH_FEED = '0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782';

function fetchReport(feedId) {
    const out = execSync(`node "${path.join(PROXY_DIR, 'fetchReportHex.js')}" ${feedId}`, {
        encoding: 'utf8',
        env: { ...process.env, NODE_NO_WARNINGS: '1' }
    });
    return out.trim();
}

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY not set');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    console.log('Testing FULL Mint and Burn Cycle (Base Sepolia / Chainlink)');
    console.log('============================================================');
    console.log('Wallet:', wallet.address);
    console.log('RPC:', RPC_URL);
    console.log('Hub:', HUB_ADDRESS);
    console.log('');

    const hubAbi = [
        'function createVault() external',
        'function depositCollateral(uint256 amount) external',
        'function hasActiveVault(address lpAddress) external view returns (bool)',
        'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active))',
        'function setMaxMintBps(uint16 maxMintBps) external',
        'function setMinBurnAmount(uint256 minAmount) external',
        'function setMintGriefingDeposit(uint256 deposit) external',
        'function setMintReadyBond(uint256 bond) external',
        'function setVaultMarketMetrics(uint16 mintFeeBps, uint16 burnRewardBps) external',
        'function getPendingReturns(address user, address token) external view returns (uint256)',
        'function withdrawReturns(address token) external',
        'function withdrawCollateral(uint256 amount) external',
        'function initiateMint(address lpVault, address initiator, uint256 wsxmrAmount, bytes32 claimCommitment, bytes32 userPublicKey) external payable returns (bytes32)',
        'function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
        'function setMintReady(bytes32 requestId) external payable',
        'function finalizeMint(bytes32 requestId, bytes32 secret) external',
        'function requestBurn(uint256 wsxmrAmount, address lpVault, address burnRecipient, bytes32 claimCommitment) external returns (bytes32)',
        'function proposeHash(bytes32 requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
        'function confirmMoneroLock(bytes32 requestId) external',
        'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
        'function updateOraclePrices(bytes[] calldata updateData) external payable',
        'function getXmrPrice() external view returns (uint256)',
        'function getCollateralPrice() external view returns (uint256)'
    ];

    const wsxmrAbi = [
        'function balanceOf(address) external view returns (uint256)',
        'function totalSupply() external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function decimals() external view returns (uint8)'
    ];

    const wxdaiAbi = [
        'function balanceOf(address) external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function deposit() external payable',
        'function withdraw(uint256 amount) external'
    ];

    const ed25519HelperAbi = [
        'function computeCommitment(bytes32 secret) external view returns (bytes32)',
        'function scalarMultBase(uint256 scalar) external view returns (uint256 x, uint256 y)',
        'function compressPublicKey(uint256 px, uint256 py) external pure returns (uint256)'
    ];

    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, wsxmrAbi, wallet);
    const wxdai = new ethers.Contract(WXDAI_ADDRESS, wxdaiAbi, wallet);
    const ed25519Helper = new ethers.Contract(ED25519_HELPER || ethers.constants.AddressZero, ed25519HelperAbi, provider);

    // Check if vault exists, create if needed
    const hasVault = await hub.hasActiveVault(wallet.address);
    if (!hasVault) {
        console.log('Step 0: Creating Vault and Depositing Collateral');
        console.log('=================================================');

        const createVaultTx = await hub.createVault();
        await createVaultTx.wait();
        console.log('Vault created');

        await (await hub.setMaxMintBps(10000)).wait();
        await (await hub.setMinBurnAmount(0)).wait();
        await (await hub.setMintGriefingDeposit(ethers.utils.parseEther('0.001'))).wait();
        await (await hub.setMintReadyBond(ethers.utils.parseEther('0.001'))).wait();
        await (await hub.setVaultMarketMetrics(50, 30)).wait();
        console.log('Vault configured (0.5% mint fee, 0.3% burn reward, 0.001 ETH bond)');

        const collateralAmount = ethers.utils.parseEther('0.001');
        await (await wxdai.deposit({ value: collateralAmount })).wait();
        console.log('Wrapped', ethers.utils.formatEther(collateralAmount), 'ETH -> WXDAI');

        await (await wxdai.approve(HUB_ADDRESS, collateralAmount)).wait();
        await (await hub.depositCollateral(collateralAmount)).wait();
        console.log('Deposited', ethers.utils.formatEther(collateralAmount), 'as collateral');
        console.log('');
    } else {
        console.log('Vault already exists');
        await (await hub.setMaxMintBps(10000)).wait();
        await (await hub.setMinBurnAmount(0)).wait();
        await (await hub.setMintGriefingDeposit(ethers.utils.parseEther('0.001'))).wait();
        await (await hub.setMintReadyBond(ethers.utils.parseEther('0.001'))).wait();
        await (await hub.setVaultMarketMetrics(50, 30)).wait();
        const vault = await hub.getVault(wallet.address);
        console.log('Collateral shares:', vault.collateralShares.toString());

        if (vault.collateralShares.eq(0)) {
            console.log('No collateral, depositing...');
            const collateralAmount = ethers.utils.parseEther('0.001');
            await (await wxdai.deposit({ value: collateralAmount })).wait();
            await (await wxdai.approve(HUB_ADDRESS, collateralAmount)).wait();
            await (await hub.depositCollateral(collateralAmount)).wait();
            console.log('Deposited', ethers.utils.formatEther(collateralAmount));
        }
        console.log('');
    }

    const existingBalance = await wsxmr.balanceOf(wallet.address);
    const MIN_BURN_AMOUNT = ethers.BigNumber.from('10000');

    if (existingBalance.gt(0) && existingBalance.gte(MIN_BURN_AMOUNT)) {
        console.log('Already have wsXMR balance:', existingBalance.toString(), '- skipping mint, going to burn');
    } else {
        // --- MINT FLOW ---
        console.log('Step 1: Fetch Chainlink reports & update prices');
        console.log('==================================================');
        const xmrBlob = fetchReport(XMR_FEED);
        const ethBlob = fetchReport(ETH_FEED);
        console.log('XMR report:', xmrBlob.slice(0, 20) + '...');
        console.log('ETH report:', ethBlob.slice(0, 20) + '...');

        const updateTx = await hub.updateOraclePrices([xmrBlob, ethBlob]);
        await updateTx.wait();
        console.log('Prices updated. TX:', updateTx.hash);

        const xmrPrice = await hub.getXmrPrice();
        const ethPrice = await hub.getCollateralPrice();
        console.log('XMR/USD:', ethers.utils.formatEther(xmrPrice));
        console.log('ETH/USD:', ethers.utils.formatEther(ethPrice));
        console.log('');

        console.log('Step 2: MINT - Initiate');
        console.log('========================');
        const xmrAmount = ethers.BigNumber.from('200000000');
        const expectedWsXmr = xmrAmount.div(10000);
        console.log('XMR atomic units:', xmrAmount.toString());
        console.log('Expected wsXMR:', ethers.utils.formatUnits(expectedWsXmr, 8));

        const secret = ethers.utils.randomBytes(32);
        let claimCommitment, userPublicKey;

        if (ED25519_HELPER && ED25519_HELPER !== ethers.constants.AddressZero) {
            claimCommitment = await ed25519Helper.computeCommitment(secret);
            const [userPubX, userPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(secret));
            const compressed = await ed25519Helper.compressPublicKey(userPubX, userPubY);
            userPublicKey = ethers.utils.hexZeroPad(compressed.toHexString(), 32);
        } else {
            claimCommitment = ethers.utils.id(ethers.utils.hexlify(secret));
            userPublicKey = ethers.utils.hexZeroPad(ethers.BigNumber.from(secret).toHexString(), 32);
        }

        const griefingDeposit = ethers.utils.parseEther('0.001');
        console.log('Secret:', ethers.utils.hexlify(secret));
        console.log('Commitment:', claimCommitment);

        const mintTx = await hub.initiateMint(
            wallet.address, wallet.address, xmrAmount, claimCommitment, userPublicKey,
            { value: griefingDeposit, gasLimit: 500000 }
        );
        const mintReceipt = await mintTx.wait();
        const requestId = mintReceipt.logs[0]?.topics?.[1];
        console.log('Mint initiated! Request ID:', requestId);
        console.log('Gas:', mintReceipt.gasUsed.toString());
        console.log('');

        console.log('Step 3: Refresh prices before setMintReady');
        console.log('=============================================');
        const xmrBlob2 = fetchReport(XMR_FEED);
        const ethBlob2 = fetchReport(ETH_FEED);
        const updateTx2 = await hub.updateOraclePrices([xmrBlob2, ethBlob2]);
        await updateTx2.wait();
        console.log('Prices refreshed. TX:', updateTx2.hash);
        console.log('');

        console.log('Step 4: LP Provides Public Key');
        console.log('===============================');
        let lpPublicKey;
        if (ED25519_HELPER && ED25519_HELPER !== ethers.constants.AddressZero) {
            const lpSecret = ethers.utils.randomBytes(32);
            const [lpPubX, lpPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(lpSecret));
            lpPublicKey = ethers.utils.hexZeroPad(ethers.BigNumber.from(lpPubX).toHexString(), 32);
        } else {
            lpPublicKey = ethers.utils.hexZeroPad(ethers.utils.randomBytes(32), 32);
        }
        const provideTx = await hub.provideLPKey(requestId, lpPublicKey, lpPublicKey);
        await provideTx.wait();
        console.log('LP key provided');
        console.log('');

        console.log('Step 5: LP Sets Ready');
        console.log('======================');
        const lpBond = ethers.utils.parseEther('0.001');
        const readyTx = await hub.setMintReady(requestId, { value: lpBond });
        await readyTx.wait();
        console.log('LP marked ready');
        console.log('');

        console.log('Step 6: Finalize Mint');
        console.log('======================');
        const finalizeTx = await hub.finalizeMint(requestId, secret, { gasLimit: 1000000 });
        const finalizeReceipt = await finalizeTx.wait();
        console.log('Mint finalized! Gas:', finalizeReceipt.gasUsed.toString());

        const decimals = await wsxmr.decimals();
        const wsxmrBalance = await wsxmr.balanceOf(wallet.address);
        console.log('wsXMR balance:', ethers.utils.formatUnits(wsxmrBalance, decimals));
        console.log('');
    }

    // --- BURN FLOW ---
    const decimals = await wsxmr.decimals();
    const wsxmrBalance = await wsxmr.balanceOf(wallet.address);
    if (wsxmrBalance.lt(MIN_BURN_AMOUNT)) {
        console.log('Insufficient wsXMR to burn. Exiting.');
        return;
    }

    console.log('Step 7: BURN - Request');
    console.log('=======================');
    const burnAmount = wsxmrBalance;
    await (await wsxmr.approve(HUB_ADDRESS, burnAmount)).wait();

    const dummyCommitment = ethers.utils.id('test');
    const burnRequestId = await hub.callStatic.requestBurn(burnAmount, wallet.address, wallet.address, dummyCommitment);
    const burnTx = await hub.requestBurn(burnAmount, wallet.address, wallet.address, dummyCommitment);
    await burnTx.wait();
    console.log('Burn requested! ID:', burnRequestId);
    console.log('Amount:', ethers.utils.formatUnits(burnAmount, decimals));
    console.log('');

    console.log('Step 8: LP Proposes Hash');
    console.log('=========================');
    const burnSecret = ethers.utils.randomBytes(32);
    let secretHash;
    if (ED25519_HELPER && ED25519_HELPER !== ethers.constants.AddressZero) {
        secretHash = await ed25519Helper.computeCommitment(burnSecret);
    } else {
        secretHash = ethers.utils.id(ethers.utils.hexlify(burnSecret));
    }
    const burnLpKey = ethers.utils.hexZeroPad(ethers.utils.randomBytes(32), 32);
    const proposeTx = await hub.proposeHash(burnRequestId, secretHash, burnLpKey, burnLpKey);
    await proposeTx.wait();
    console.log('LP proposed hash');
    console.log('');

    console.log('Step 9: User Confirms Monero Lock');
    console.log('====================================');
    const confirmTx = await hub.confirmMoneroLock(burnRequestId, { gasLimit: 500000 });
    await confirmTx.wait();
    console.log('User confirmed Monero lock');
    console.log('');

    console.log('Step 10: LP Finalizes Burn');
    console.log('===========================');
    const wxdaiBefore = await wxdai.balanceOf(wallet.address);
    const finalizeBurnTx = await hub.finalizeBurn(burnRequestId, burnSecret, { gasLimit: 1000000 });
    const finalizeBurnReceipt = await finalizeBurnTx.wait();
    console.log('Burn finalized! Gas:', finalizeBurnReceipt.gasUsed.toString());

    const wxdaiAfter = await wxdai.balanceOf(wallet.address);
    const burnReward = wxdaiAfter.sub(wxdaiBefore);
    console.log('Burn reward:', ethers.utils.formatEther(burnReward), 'WXDAI');
    console.log('');

    const finalBalance = await wsxmr.balanceOf(wallet.address);
    const totalSupply = await wsxmr.totalSupply();
    console.log('Final wsXMR balance:', ethers.utils.formatUnits(finalBalance, decimals));
    console.log('Total supply:', ethers.utils.formatUnits(totalSupply, decimals));
    console.log('');

    console.log('FULL CYCLE COMPLETE!');
    console.log('====================');
    console.log('Minted and burned wsXMR on Base Sepolia with Chainlink Data Streams');
}

main().catch(console.error);
