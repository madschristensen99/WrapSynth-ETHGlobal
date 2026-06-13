#!/usr/bin/env node
/**
 * Test Co-LP (Co-Liquidity Provider) positions on Base Sepolia
 * Opens a real Co-LP position and unwinds it
 */

const { ethers } = require('ethers');

const HUB_ADDRESS = '0x15bb9ba8236De055090a262F45a7e213F6040320';
const WSXMR_ADDRESS = '0x9B8d1851bCc06ac265c1c1ACaBD0F71E69DD312c';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const ED25519_HELPER = '0xd821a7d919e007b6b39925f672f1219db4865fba';

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY environment variable not set');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider('https://sepolia.base.org');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    console.log('Co-LP Base Sepolia Test');
    console.log('=======================');
    console.log('Wallet:', wallet.address);
    console.log('');

    const hubAbi = [
        'function createVault() external',
        'function depositCollateral(uint256 amount) external',
        'function hasActiveVault(address lpAddress) external view returns (bool)',
        'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps))',
        'function setMaxMintBps(uint16 maxMintBps) external',
        'function setMinBurnAmount(uint256 minAmount) external',
        'function setMintGriefingDeposit(uint256 deposit) external',
        'function setMintReadyBond(uint256 bond) external',
        'function setVaultMarketMetrics(uint16 mintFeeBps, uint16 burnRewardBps) external',
        'function userOpenCoLP(address lpVault, uint256 wsxmrAmount, uint256 deadline) external returns (uint256 tokenId)',
        'function unwindCoLP(uint256 tokenId, uint256 deadline) external',
        'function liquidityRouter() external view returns (address)',
        'function getPendingReturns(address user, address token) external view returns (uint256)',
        'function withdrawReturns(address token) external',
        'function initiateMint(address lpVault, address initiator, uint256 wsxmrAmount, bytes32 claimCommitment, bytes32 userPublicKey) external payable returns (bytes32)',
        'function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
        'function setMintReady(bytes32 requestId) external payable',
        'function finalizeMint(bytes32 requestId, bytes32 secret) external',
        'function updatePrices(uint256 xmrPrice, uint256 daiPrice) external',
        'event CoLPDeployed(address indexed lpVault, address indexed user, uint256 indexed tokenId, uint256 sDAIShares, uint256 wsxmrAmount, uint16 rangeBps)',
        'event CoLPUnwound(uint256 indexed tokenId, address indexed vaultOwner, address indexed user, uint256 sDAIReturned, uint256 wsxmrReturned)'
    ];

    const wsxmrAbi = [
        'function balanceOf(address) external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function decimals() external view returns (uint8)'
    ];

    const wethAbi = [
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
    const weth = new ethers.Contract(WETH_ADDRESS, wethAbi, wallet);
    const ed25519Helper = new ethers.Contract(ED25519_HELPER, ed25519HelperAbi, provider);

    // Log deployed router info
    const routerAddr = await hub.liquidityRouter();
    console.log('Hub liquidityRouter:', routerAddr);

    // --- STEP 0: Ensure vault exists ---
    const hasVault = await hub.hasActiveVault(wallet.address);
    if (!hasVault) {
        console.log('Creating vault...');
        await (await hub.createVault({ gasLimit: 300000 })).wait();
        await (await hub.setMaxMintBps(0, { gasLimit: 200000 })).wait();
        await (await hub.setMinBurnAmount(0, { gasLimit: 200000 })).wait();
        await (await hub.setMintGriefingDeposit(ethers.utils.parseEther('0.001'), { gasLimit: 200000 })).wait();
        await (await hub.setMintReadyBond(ethers.utils.parseEther('0.001'), { gasLimit: 200000 })).wait();
        await (await hub.setVaultMarketMetrics(50, 30, { gasLimit: 200000 })).wait();
        console.log('Vault created and configured');
    } else {
        console.log('Vault exists');
    }

    // --- STEP 1: Push fresh prices ---
    console.log('Step 1: Push fresh oracle prices');
    const priceTx = await hub.updatePrices(390_00000000, 2500_00000000, { gasLimit: 500000 });
    await priceTx.wait();
    console.log('  Prices updated: XMR=$390, WETH=$2500');
    console.log('');

    // Check existing vault collateral
    const vault = await hub.getVault(wallet.address);
    console.log('Vault collateral shares:', ethers.utils.formatEther(vault.collateralShares));
    console.log('');

    // --- STEP 2: Mint some wsXMR if needed ---
    let wsxmrBalance = await wsxmr.balanceOf(wallet.address);
    console.log('Initial wsXMR balance:', ethers.utils.formatUnits(wsxmrBalance, 8));
    if (wsxmrBalance.lt(150000000)) { // Need 1.5 wsXMR for CoLP
        console.log('Step 2: Mint wsXMR for Co-LP deposit');
        const secret = ethers.utils.randomBytes(32);
        const commitment = await ed25519Helper.computeCommitment(secret);
        const xmrAmount = ethers.BigNumber.from('1500000000'); // 15 XMR atomic units → 1.5 wsXMR
        const griefingDeposit = ethers.utils.parseEther('0.001');

        const [userPubX, userPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(secret));
        const compressed = await ed25519Helper.compressPublicKey(userPubX, userPubY);
        const userPublicKey = ethers.utils.hexZeroPad(ethers.BigNumber.from(compressed).toHexString(), 32);

        const mintTx = await hub.initiateMint(
            wallet.address,
            wallet.address,
            xmrAmount,
            commitment,
            userPublicKey,
            { value: griefingDeposit, gasLimit: 500000 }
        );
        const mintReceipt = await mintTx.wait();
        console.log('  Mint initiated:', mintTx.hash);
        const requestId = mintReceipt.logs[0].topics[1];
        console.log('  Request ID:', requestId);

        // Refresh prices
        console.log('  Refreshing prices...');
        const refreshTx = await hub.updatePrices(390_00000000, 2500_00000000, { gasLimit: 500000 });
        await refreshTx.wait();
        console.log('  Prices refreshed:', refreshTx.hash);

        // LP provides key
        const lpSecret = ethers.utils.randomBytes(32);
        const [lpPubX, lpPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(lpSecret));
        const lpPublicKey = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [lpPubX, lpPubY]));
        console.log('  LP Public Key:', lpPublicKey);

        const provideTx = await hub.provideLPKey(requestId, lpPublicKey, lpPublicKey, { gasLimit: 200000 });
        await provideTx.wait();
        console.log('  LP key provided:', provideTx.hash);

        const readyTx = await hub.setMintReady(requestId, { value: griefingDeposit, gasLimit: 200000 });
        await readyTx.wait();
        console.log('  Mint ready:', readyTx.hash);

        const finalizeTx = await hub.finalizeMint(requestId, secret, { gasLimit: 1000000 });
        await finalizeTx.wait();
        console.log('  Mint finalized:', finalizeTx.hash);

        wsxmrBalance = await wsxmr.balanceOf(wallet.address);
        console.log('  wsXMR balance after mint:', ethers.utils.formatUnits(wsxmrBalance, 8));
        console.log('');
    } else {
        console.log('Step 2: Already have', ethers.utils.formatUnits(wsxmrBalance, 8), 'wsXMR');
        console.log('');
    }

    // --- STEP 3: Approve hub and open Co-LP position ---
    console.log('Step 3: Open Co-LP position');
    const wsxmrToDeposit = wsxmrBalance.div(2);
    console.log('  wsxmrToDeposit:', ethers.utils.formatUnits(wsxmrToDeposit, 8));

    if (wsxmrToDeposit.eq(0)) {
        console.log('ERROR: wsxmrToDeposit is 0, cannot open Co-LP');
        process.exit(1);
    }

    console.log('  Depositing', ethers.utils.formatUnits(wsxmrToDeposit, 8), 'wsXMR into Co-LP');

    const approveTx = await wsxmr.approve(HUB_ADDRESS, wsxmrToDeposit);
    await approveTx.wait();
    console.log('  Approved:', approveTx.hash);

    // Ensure prices are fresh before Co-LP
    console.log('  Pushing fresh prices before Co-LP...');
    const preCoLPTx = await hub.updatePrices(390_00000000, 2500_00000000, { gasLimit: 500000 });
    await preCoLPTx.wait();
    console.log('  Prices pushed:', preCoLPTx.hash);

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    console.log('  Calling userOpenCoLP...');
    const coLPTx = await hub.userOpenCoLP(wallet.address, wsxmrToDeposit, deadline, { gasLimit: 2000000 });
    const coLPReceipt = await coLPTx.wait();
    console.log('  Co-LP TX:', coLPTx.hash);

    let tokenId = null;
    if (coLPReceipt.events) {
        const evt = coLPReceipt.events.find(e => e.event === 'CoLPDeployed');
        if (evt) tokenId = evt.args.tokenId;
    }
    if (!tokenId) {
        for (const log of coLPReceipt.logs) {
            try {
                const parsed = hub.interface.parseLog(log);
                if (parsed.name === 'CoLPDeployed') {
                    tokenId = parsed.args.tokenId;
                    break;
                }
            } catch (e) {}
        }
    }

    console.log('  Token ID:', tokenId ? ethers.BigNumber.from(tokenId).toString() : 'unknown');
    console.log('  View on Basescan:', `https://sepolia.basescan.org/tx/${coLPTx.hash}`);

    const vaultAfter = await hub.getVault(wallet.address);
    console.log('  deployedSDAIShares:', vaultAfter.deployedSDAIShares.toString());
    console.log('  collateralShares:', vaultAfter.collateralShares.toString());
    console.log('');

    // --- STEP 4: Unwind Co-LP position ---
    console.log('Step 4: Unwind Co-LP position');
    const unwindTx = await hub.unwindCoLP(tokenId, deadline, { gasLimit: 2000000 });
    const unwindReceipt = await unwindTx.wait();
    console.log('  Unwind TX:', unwindTx.hash);
    console.log('  View on Basescan:', `https://sepolia.basescan.org/tx/${unwindTx.hash}`);

    const pendingWsxmr = await hub.getPendingReturns(wallet.address, WSXMR_ADDRESS);
    console.log('  Pending wsXMR returns:', ethers.utils.formatUnits(pendingWsxmr, 8));

    if (pendingWsxmr.gt(0)) {
        const withdrawTx = await hub.withdrawReturns(WSXMR_ADDRESS, { gasLimit: 200000 });
        await withdrawTx.wait();
        console.log('  Withdrawn:', withdrawTx.hash);
    }

    const finalBalance = await wsxmr.balanceOf(wallet.address);
    console.log('  Final wsXMR balance:', ethers.utils.formatUnits(finalBalance, 8));
    console.log('');

    console.log('Co-LP test complete!');
    console.log('Check your transactions on Basescan:');
    console.log(`  https://sepolia.basescan.org/address/${wallet.address}`);
}

main().catch(console.error);
