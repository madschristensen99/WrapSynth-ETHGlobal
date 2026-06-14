#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const fetch = require('node-fetch');

const HUB_ADDRESS = '0x0454983E17b803a2C6ff0d98d5D58676525F4A92';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006'; // Correct collateral token on Base Sepolia
const REPORT_PROXY_URL = process.env.REPORT_PROXY_URL || 'http://localhost:3002/reports';

async function main() {
    const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    console.log('💰 Depositing Collateral to Base Sepolia Vault');
    console.log('================================================');
    console.log('Wallet:', wallet.address);
    console.log('');
    
    const wethAbi = [
        'function deposit() external payable',
        'function approve(address,uint256) external returns (bool)',
        'function balanceOf(address) external view returns (uint256)'
    ];
    const hubAbi = [
        'function depositCollateral(uint256 amount) external',
        'function updateOraclePrices(bytes[] calldata updateData) external payable',
        'function hasActiveVault(address) external view returns (bool)',
        'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active))'
    ];
    
    const weth = new ethers.Contract(WETH_ADDRESS, wethAbi, wallet);
    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
    
    // Check vault status
    const hasVault = await hub.hasActiveVault(wallet.address);
    if (!hasVault) {
        console.log('❌ No active vault found. Please create a vault first.');
        process.exit(1);
    }
    
    const vault = await hub.getVault(wallet.address);
    console.log('Current Vault Status:');
    console.log('  Collateral shares:', ethers.utils.formatEther(vault.collateralShares));
    console.log('  Locked collateral:', ethers.utils.formatEther(vault.lockedCollateral));
    console.log('  Normalized debt:', vault.normalizedDebt.toString());
    console.log('');
    
    // Check existing wETH balance
    let balance = await weth.balanceOf(wallet.address);
    console.log('Step 1: Checking wETH balance...');
    console.log('  wETH balance:', ethers.utils.formatEther(balance));
    
    if (balance.eq(0)) {
        console.log('  No wETH balance, wrapping 0.003 ETH...');
        const wrapTx = await weth.deposit({ value: ethers.utils.parseEther('0.003') });
        await wrapTx.wait();
        console.log('✅ Wrapped! TX:', wrapTx.hash);
        balance = await weth.balanceOf(wallet.address);
        console.log('  New wETH balance:', ethers.utils.formatEther(balance));
    }
    
    const depositAmount = balance;
    console.log('  Will deposit:', ethers.utils.formatEther(depositAmount), 'wETH');
    
    if (depositAmount.eq(0)) {
        console.log('❌ No wETH to deposit!');
        process.exit(1);
    }
    console.log('');
    
    // Update oracle prices
    console.log('Step 2: Updating oracle prices...');
    try {
        const xmrFeedId = '0x0003c70558bd921b1559d37b8e347797f121d1240e7386e68b2bee9b731b0833';
        const ethFeedId = '0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782';
        
        const response = await fetch(`${REPORT_PROXY_URL}?feedIDs=${xmrFeedId},${ethFeedId}`);
        const data = await response.json();
        
        if (!data.reports || data.reports.length === 0) {
            throw new Error('No reports received from proxy');
        }
        
        const reportData = data.reports.map(r => r.fullReport);
        const priceTx = await hub.updateOraclePrices(reportData, { gasLimit: 500000 });
        await priceTx.wait();
        console.log('✅ Prices updated! TX:', priceTx.hash);
    } catch (err) {
        console.log('⚠️  Could not update prices:', err.message);
        console.log('   Continuing anyway...');
    }
    console.log('');
    
    // Approve and deposit
    console.log('Step 3: Approving wETH...');
    const approveTx = await weth.approve(HUB_ADDRESS, depositAmount);
    await approveTx.wait();
    console.log('✅ Approved!');
    console.log('');
    
    console.log('Step 4: Depositing collateral...');
    const depositTx = await hub.depositCollateral(depositAmount, { gasLimit: 300000 });
    await depositTx.wait();
    console.log('✅ Deposited! TX:', depositTx.hash);
    console.log('');
    
    // Show updated vault
    const updatedVault = await hub.getVault(wallet.address);
    console.log('Updated Vault Status:');
    console.log('  Collateral shares:', ethers.utils.formatEther(updatedVault.collateralShares));
    console.log('  Locked collateral:', ethers.utils.formatEther(updatedVault.lockedCollateral));
    console.log('  Normalized debt:', updatedVault.normalizedDebt.toString());
    console.log('');
    console.log('🎉 Deposit complete!');
}

main().catch(console.error);
