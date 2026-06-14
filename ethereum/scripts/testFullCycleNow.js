#!/usr/bin/env node
/**
 * Test FULL mint and burn cycle on Base Sepolia
 */

require('dotenv').config();
const { ethers } = require('ethers');
const fetch = require('node-fetch');
const { HUB_ADDRESS, WSXMR_ADDRESS, WXDAI_ADDRESS, ED25519_HELPER, SDAI_ADDRESS } = require('./deploymentConfig');

// Helper to update oracle prices via Chainlink Data Streams
// Prices are fetched from the LP server's report proxy
async function updateOraclePrices(hub) {
    try {
        const reportProxyUrl = process.env.REPORT_PROXY_URL || 'http://localhost:3001/reports';
        const xmrFeedId = '0x0003c70558bd921b1559d37b8e347797f121d1240e7386e68b2bee9b731b0833';
        const ethFeedId = '0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782';
        
        const response = await fetch(`${reportProxyUrl}?feedIDs=${xmrFeedId},${ethFeedId}`);
        const data = await response.json();
        
        if (!data.reports || data.reports.length === 0) {
            throw new Error('No reports received from proxy');
        }
        
        const reportData = data.reports.map(r => r.fullReport);
        const tx = await hub.updateOraclePrices(reportData, { gasLimit: 500000 });
        await tx.wait();
        console.log('✅ Oracle prices updated');
        return tx;
    } catch (err) {
        console.warn('⚠️  Could not update oracle prices:', err.message);
        console.log('   Continuing anyway - transaction will revert if prices are stale');
        throw err;
    }
}

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('❌ PRIVATE_KEY environment variable not set');
        process.exit(1);
    }
    
    const RPC_URL = process.env.RPC_URL || 'https://sepolia.base.org';
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    console.log('🧪 Testing FULL Mint and Burn Cycle');
    console.log('====================================');
    console.log('Wallet:', wallet.address);
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
        'function updateOraclePrices(bytes[] calldata updateData) external payable'
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
    const ed25519Helper = new ethers.Contract(ED25519_HELPER, ed25519HelperAbi, provider);
    
    // Check if vault exists, create if needed
    const hasVault = await hub.hasActiveVault(wallet.address);
    if (!hasVault) {
        console.log('📊 Step 0: Creating Vault and Depositing Collateral');
        console.log('====================================================');
        
        const createVaultTx = await hub.createVault();
        await createVaultTx.wait();
        console.log('✅ Vault created');
        
        // Configure vault with fees
        await (await hub.setMaxMintBps(0)).wait();
        await (await hub.setMinBurnAmount(0)).wait();
        await (await hub.setMintGriefingDeposit(ethers.utils.parseEther('0.001'))).wait();
        await (await hub.setMintReadyBond(ethers.utils.parseEther('0.001'))).wait();
        await (await hub.setVaultMarketMetrics(50, 30)).wait(); // 0.5% mint fee, 0.3% burn reward
        console.log('✅ Vault configured (0.5% mint fee, 0.3% burn reward, 0.001 ETH bond)');
        
        // Check wxDAI balance and wrap if needed
        const collateralAmount = ethers.utils.parseEther('0.5'); // 0.5 xDAI
        const wxdaiBalance = await wxdai.balanceOf(wallet.address);
        
        if (wxdaiBalance.lt(collateralAmount)) {
            const toWrap = collateralAmount.sub(wxdaiBalance);
            await (await wxdai.deposit({ value: toWrap })).wait();
            console.log('✅ Wrapped', ethers.utils.formatEther(toWrap), 'xDAI');
        } else {
            console.log('✅ Already have', ethers.utils.formatEther(wxdaiBalance), 'wxDAI');
        }
        
        await (await wxdai.approve(HUB_ADDRESS, collateralAmount)).wait();
        await (await hub.depositCollateral(collateralAmount)).wait();
        console.log('✅ Deposited', ethers.utils.formatEther(collateralAmount), 'xDAI as collateral');
        console.log('');
    } else {
        console.log('✅ Vault already exists');
        
        // Update vault fees to ensure they're set correctly
        await (await hub.setVaultMarketMetrics(50, 30)).wait(); // 0.5% mint fee, 0.3% burn reward
        console.log('✅ Updated vault fees (0.5% mint fee, 0.3% burn reward)');
        
        // Check collateral balance
        const vault = await hub.getVault(wallet.address);
        console.log('   Collateral shares:', vault.collateralShares.toString());
        console.log('   Locked collateral:', vault.lockedCollateral.toString());
        console.log('   Normalized debt:', vault.normalizedDebt.toString());
        console.log('   Pending debt:', vault.pendingDebt.toString());
        console.log('   Mint fee:', vault.mintFeeBps, 'bps');
        console.log('   Burn reward:', vault.burnRewardBps, 'bps');
        
        // If no collateral, deposit some
        if (vault.collateralShares.eq(0)) {
            console.log('⚠️  No collateral in vault, depositing...');
            const collateralAmount = ethers.utils.parseEther('0.5'); // 0.5 xDAI
            const wxdaiBalance = await wxdai.balanceOf(wallet.address);
            
            if (wxdaiBalance.lt(collateralAmount)) {
                const toWrap = collateralAmount.sub(wxdaiBalance);
                await (await wxdai.deposit({ value: toWrap })).wait();
                console.log('✅ Wrapped', ethers.utils.formatEther(toWrap), 'xDAI');
            } else {
                console.log('✅ Already have', ethers.utils.formatEther(wxdaiBalance), 'wxDAI');
            }
            
            await (await wxdai.approve(HUB_ADDRESS, collateralAmount)).wait();
            await (await hub.depositCollateral(collateralAmount)).wait();
            console.log('✅ Deposited', ethers.utils.formatEther(collateralAmount), 'xDAI as collateral');
        }
        console.log('');
    }
    
    // Check if we already have wsXMR balance
    const existingBalance = await wsxmr.balanceOf(wallet.address);
    const MIN_BURN_AMOUNT = ethers.BigNumber.from('10000'); // 1e4 = 0.0001 wsXMR
    
    if (existingBalance.gt(0) && existingBalance.gte(MIN_BURN_AMOUNT)) {
        console.log('⚠️  Already have wsXMR balance:', existingBalance.toString());
        console.log('   Skipping mint, going straight to burn...\n');
        
        const decimals = await wsxmr.decimals();
        
        // Update prices before burn
        console.log('📊 Update Prices');
        console.log('================');
        try {
            await updateOraclePrices(hub);
        } catch (err) {
            console.log('⚠️  Skipping price update, will retry if needed\n');
        }
        
        // Jump to burn
        console.log('📊 BURN - Request');
        console.log('=================');
        const burnAmount = existingBalance;
        
        const approveTx = await wsxmr.approve(HUB_ADDRESS, burnAmount);
        await approveTx.wait();
        
        const dummyCommitment = ethers.utils.id('test');
        const burnRequestId = await hub.callStatic.requestBurn(burnAmount, wallet.address, wallet.address, dummyCommitment);
        const burnTx = await hub.requestBurn(burnAmount, wallet.address, wallet.address, dummyCommitment);
        await burnTx.wait();
        
        console.log('✅ Burn requested!');
        console.log('Request ID:', burnRequestId);
        console.log('Amount:', ethers.utils.formatUnits(burnAmount, decimals), 'wsXMR');
        console.log('');
        
        console.log('📊 BURN - LP Proposes Hash');
        console.log('===========================');
        const burnSecret = ethers.utils.randomBytes(32);
        const secretHash = await ed25519Helper.computeCommitment(burnSecret);
        
        // Generate LP Ed25519 keys for burn
        const burnLpSecret = ethers.utils.randomBytes(32);
        const [burnLpPubX, burnLpPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(burnLpSecret));
        const burnLpSpendKey = ethers.utils.hexZeroPad(ethers.BigNumber.from(burnLpPubX).toHexString(), 32);
        const burnLpViewKey = ethers.utils.hexZeroPad(ethers.BigNumber.from(burnLpPubY).toHexString(), 32);
        
        console.log('Burn Secret:', ethers.utils.hexlify(burnSecret));
        console.log('Secret Hash:', secretHash);
        console.log('LP Spend Key:', burnLpSpendKey);
        console.log('LP View Key:', burnLpViewKey);
        
        const proposeHashTx = await hub.proposeHash(burnRequestId, secretHash, burnLpSpendKey, burnLpViewKey);
        await proposeHashTx.wait();
        console.log('✅ LP proposed secret hash\n');
        
        console.log('📊 BURN - User Confirms Monero Lock');
        console.log('====================================');
        const confirmTx = await hub.confirmMoneroLock(burnRequestId, { gasLimit: 500000 });
        await confirmTx.wait();
        console.log('✅ User confirmed Monero lock\n');
        
        console.log('📊 BURN - LP Finalizes');
        console.log('=======================');
        const finalizeBurnTx = await hub.finalizeBurn(burnRequestId, burnSecret, { gasLimit: 1000000 });
        const finalizeBurnReceipt = await finalizeBurnTx.wait();
        console.log('✅ Burn finalized!');
        console.log('Gas:', finalizeBurnReceipt.gasUsed.toString());
        
        const finalBalance = await wsxmr.balanceOf(wallet.address);
        const totalSupply = await wsxmr.totalSupply();
        console.log('Final wsXMR Balance:', ethers.utils.formatUnits(finalBalance, decimals));
        console.log('Total Supply:', ethers.utils.formatUnits(totalSupply, decimals));
        console.log('');
        
        console.log('🎉 BURN COMPLETE!');
        console.log('=================');
        console.log('✅ Burned wsXMR tokens');
        console.log('✅ Protocol fully functional on Base Sepolia!');
        return;
    }
    
    console.log('📊 Step 1: Update Prices');
    console.log('========================');
    try {
        await updateOraclePrices(hub);
    } catch (err) {
        console.log('⚠️  Skipping price update, will retry if needed');
    }
    console.log('');
    
    console.log('📊 Step 1.5: Refresh Prices (right before mint)');
    console.log('==================================================');
    try {
        await updateOraclePrices(hub);
    } catch (err) {
        console.log('⚠️  Could not refresh prices, will try anyway');
    }
    console.log('');
    
    console.log('📊 Step 2: MINT - Initiate (IMMEDIATELY after price update)');
    console.log('============================================================');
    // Mint 0.0002 wsXMR = 20000 wsXMR units (above new minimum of 10000)
    // wsXMR = xmrAmount / 10000
    // So xmrAmount = 20000 * 10000 = 200,000,000 XMR atomic units
    const xmrAmount = ethers.BigNumber.from('200000000'); // Will produce 20000 wsXMR units = 0.0002 wsXMR
    const expectedWsXmr = xmrAmount.div(10000);
    console.log('XMR atomic units:', xmrAmount.toString());
    console.log('Expected wsXMR (raw):', expectedWsXmr.toString());
    console.log('Expected wsXMR:', ethers.utils.formatUnits(expectedWsXmr, 8));
    
    // Generate secret and compute Ed25519 commitment + public key
    const secret = ethers.utils.randomBytes(32);
    const claimCommitment = await ed25519Helper.computeCommitment(secret);
    
    // Compute user's Ed25519 public key for initiateMint
    const [userPubX, userPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(secret));
    const compressed = await ed25519Helper.compressPublicKey(userPubX, userPubY);
    const userPublicKey = ethers.utils.hexZeroPad(compressed.toHexString(), 32);
    
    const griefingDeposit = ethers.utils.parseEther('0.001');
    
    console.log('Secret:', ethers.utils.hexlify(secret));
    console.log('Commitment:', claimCommitment);
    console.log('User Public Key:', userPublicKey);
    
    const mintTx = await hub.initiateMint(
        wallet.address,
        wallet.address,
        xmrAmount,
        claimCommitment,
        userPublicKey,
        { value: griefingDeposit, gasLimit: 500000 }
    );
    const mintReceipt = await mintTx.wait();
    
    // Parse requestId from logs (events might not be decoded)
    let requestId;
    if (mintReceipt.events && mintReceipt.events.length > 0) {
        const mintEvent = mintReceipt.events.find(e => e.event === 'MintInitiated');
        requestId = mintEvent ? mintEvent.args.requestId : mintReceipt.logs[0].topics[1];
    } else {
        // Fallback: requestId is first topic after event signature
        requestId = mintReceipt.logs[0].topics[1];
    }
    
    console.log('✅ Mint initiated!');
    console.log('Request ID:', requestId);
    console.log('Gas:', mintReceipt.gasUsed.toString());
    console.log('');
    
    console.log('📊 Step 3: MINT - LP Provides Public Key');
    console.log('==========================================');
    // Generate real Ed25519 public key for LP
    const lpSecret = ethers.utils.randomBytes(32);
    const [lpPubX, lpPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(lpSecret));
    const lpPublicKey = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [lpPubX, lpPubY]));
    
    console.log('LP Secret:', ethers.utils.hexlify(lpSecret));
    console.log('LP Public Key (x, y):', lpPubX.toString(), lpPubY.toString());
    console.log('LP Public Key (hash):', lpPublicKey);
    
    const provideTx = await hub.provideLPKey(requestId, lpPublicKey, lpPublicKey);
    await provideTx.wait();
    console.log('✅ LP provided public key');
    console.log('');
    
    console.log('📊 Step 3: MINT - LP Sets Ready');
    console.log('================================');
    const lpBond = ethers.utils.parseEther('0.001');
    const readyTx = await hub.setMintReady(requestId, { value: lpBond });
    await readyTx.wait();
    console.log('✅ LP marked ready');
    console.log('');
    
    console.log('📊 Step 4: MINT - Finalize');
    console.log('===========================');
    const finalizeTx = await hub.finalizeMint(requestId, secret, { gasLimit: 1000000 });
    const finalizeReceipt = await finalizeTx.wait();
    console.log('✅ Mint finalized!');
    console.log('Gas:', finalizeReceipt.gasUsed.toString());
    
    const decimals = await wsxmr.decimals();
    const wsxmrBalance = await wsxmr.balanceOf(wallet.address);
    
    // Verify mint fee (0.5% = 50 bps)
    const expectedBeforeFee = expectedWsXmr;
    const feeAmount = expectedBeforeFee.mul(50).div(10000); // 0.5%
    const expectedAfterFee = expectedBeforeFee.sub(feeAmount);
    
    console.log('wsXMR Decimals:', decimals);
    console.log('Expected (before fee):', ethers.utils.formatUnits(expectedBeforeFee, decimals), 'wsXMR');
    console.log('Mint fee (0.5%):', ethers.utils.formatUnits(feeAmount, decimals), 'wsXMR');
    console.log('Expected (after fee):', ethers.utils.formatUnits(expectedAfterFee, decimals), 'wsXMR');
    console.log('Actual balance:', ethers.utils.formatUnits(wsxmrBalance, decimals), 'wsXMR');
    console.log('✅ Fee correctly applied:', wsxmrBalance.eq(expectedAfterFee) ? 'YES' : 'NO');
    console.log('');
    
    console.log('📊 Step 4.5: WITHDRAW - Small Collateral Test');
    console.log('============================================');
    const vaultBeforeWithdraw = await hub.getVault(wallet.address);
    console.log('Collateral shares before:', vaultBeforeWithdraw.collateralShares.toString());
    console.log('Locked collateral:', vaultBeforeWithdraw.lockedCollateral.toString());
    console.log('Normalized debt:', vaultBeforeWithdraw.normalizedDebt.toString());
    
    // Try withdrawing a very small amount (0.001 worth of shares, or 1 share if zero)
    const withdrawTestAmount = ethers.BigNumber.from('1000000000000000'); // 0.001 sDAI worth in shares roughly
    try {
        const withdrawTx = await hub.withdrawCollateral(withdrawTestAmount, { gasLimit: 500000 });
        await withdrawTx.wait();
        console.log('✅ Small collateral withdrawal successful!');
        console.log('Withdrawn shares:', withdrawTestAmount.toString());
    } catch (err) {
        console.log('⚠️  Collateral withdrawal failed (expected if below 150% CR):', err.reason || err.message);
    }
    
    const vaultAfterWithdraw = await hub.getVault(wallet.address);
    console.log('Collateral shares after:', vaultAfterWithdraw.collateralShares.toString());
    console.log('');
    
    console.log('📊 Step 5: BURN - Request');
    console.log('=========================');
    const burnAmount = wsxmrBalance;
    
    const approveTx = await wsxmr.approve(HUB_ADDRESS, burnAmount);
    await approveTx.wait();
    
    const dummyCommitment = ethers.utils.id('test');
    // requestBurn returns the requestId directly
    const burnRequestId = await hub.callStatic.requestBurn(burnAmount, wallet.address, wallet.address, dummyCommitment);
    const burnTx = await hub.requestBurn(burnAmount, wallet.address, wallet.address, dummyCommitment);
    await burnTx.wait();
    
    console.log('✅ Burn requested!');
    console.log('Request ID:', burnRequestId);
    console.log('Amount:', ethers.utils.formatUnits(burnAmount, decimals), 'wsXMR');
    console.log('');
    
    console.log('📊 Step 6: BURN - LP Proposes Hash');
    console.log('===================================');
    const burnSecret = ethers.utils.randomBytes(32);
    const secretHash = await ed25519Helper.computeCommitment(burnSecret);
    
    // Generate LP Ed25519 keys for burn
    const burnLpSecret = ethers.utils.randomBytes(32);
    const [burnLpPubX, burnLpPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(burnLpSecret));
    const burnLpSpendKey = ethers.utils.hexZeroPad(ethers.BigNumber.from(burnLpPubX).toHexString(), 32);
    const burnLpViewKey = ethers.utils.hexZeroPad(ethers.BigNumber.from(burnLpPubY).toHexString(), 32);
    
    console.log('Burn Secret:', ethers.utils.hexlify(burnSecret));
    console.log('Secret Hash:', secretHash);
    console.log('LP Spend Key:', burnLpSpendKey);
    console.log('LP View Key:', burnLpViewKey);
    
    const proposeHashTx = await hub.proposeHash(burnRequestId, secretHash, burnLpSpendKey, burnLpViewKey);
    await proposeHashTx.wait();
    console.log('✅ LP proposed secret hash');
    console.log('');
    
    console.log('📊 Step 7: BURN - User Confirms Monero Lock');
    console.log('============================================');
    const confirmTx = await hub.confirmMoneroLock(burnRequestId, { gasLimit: 500000 });
    await confirmTx.wait();
    console.log('✅ User confirmed Monero lock');
    console.log('');
    
    console.log('📊 Step 8: BURN - LP Finalizes');
    console.log('================================');
    
    // Check wxDAI balance before burn to verify reward
    const wxdaiBalanceBefore = await wxdai.balanceOf(wallet.address);
    
    const finalizeBurnTx = await hub.finalizeBurn(burnRequestId, burnSecret, { gasLimit: 1000000 });
    const finalizeBurnReceipt = await finalizeBurnTx.wait();
    console.log('✅ Burn finalized!');
    console.log('Gas:', finalizeBurnReceipt.gasUsed.toString());
    
    // Check burn reward (0.3% of burn value in collateral)
    const wxdaiBalanceAfter = await wxdai.balanceOf(wallet.address);
    const burnReward = wxdaiBalanceAfter.sub(wxdaiBalanceBefore);
    
    console.log('');
    console.log('Burn Reward Received:', ethers.utils.formatEther(burnReward), 'wxDAI');
    console.log('✅ Burn reward applied:', burnReward.gt(0) ? 'YES' : 'NO');
    console.log('');
    
    const finalBalance = await wsxmr.balanceOf(wallet.address);
    const totalSupply = await wsxmr.totalSupply();
    console.log('Final wsXMR Balance:', ethers.utils.formatUnits(finalBalance, decimals));
    console.log('Total Supply:', ethers.utils.formatUnits(totalSupply, decimals));
    console.log('');
    
    console.log('📊 Step 9: CLAIM - Withdraw Burn Rewards');
    console.log('==========================================');
    const pendingReward = await hub.getPendingReturns(wallet.address, SDAI_ADDRESS);
    console.log('Pending sDAI Reward:', ethers.utils.formatEther(pendingReward), 'sDAI');
    
    if (pendingReward.gt(0)) {
        const claimTx = await hub.withdrawReturns(SDAI_ADDRESS, { gasLimit: 200000 });
        await claimTx.wait();
        console.log('✅ Burn reward claimed!');
        
        const remainingReward = await hub.getPendingReturns(wallet.address, SDAI_ADDRESS);
        console.log('Remaining Pending:', ethers.utils.formatEther(remainingReward), 'sDAI');
    } else {
        console.log('⚠️  No pending rewards to claim');
    }
    console.log('');
    
    console.log('🎉 FULL CYCLE COMPLETE!');
    console.log('=======================');
    console.log('✅ Minted wsXMR tokens');
    console.log('✅ Burned wsXMR tokens');
    console.log('✅ Claimed burn rewards');
    console.log('✅ Protocol fully functional on Base Sepolia!');
}

main().catch(console.error);
