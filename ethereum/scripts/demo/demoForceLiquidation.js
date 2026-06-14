#!/usr/bin/env node
'use strict';
/**
 * Demo: drive an LP vault on the DEMO hub below the 120% liquidation threshold
 * so the CRE Liquidation Keeper has something to detect and flag.
 *
 * Flow:
 *   1. Seed prices  XMR=$150, collateral=$1  (via the mock verifier).
 *   2. Open a vault, deposit wxDAI collateral.
 *   3. Mint wsXMR targeting ~150% CR (the protocol minimum / original allocation).
 *   4. Wait > 90s so the oracle deviation guard is bypassed.
 *   5. Crank XMR up -> CR drops below the 120% liquidation threshold.
 *   6. Assert isVaultLiquidatable(vault) == true and print the liquidation math.
 *
 * After this, run the CRE workflow (cre workflow simulate) to flag the vault,
 * then `node scripts/demo/liquidate.js` or `node scripts/demo/backstopVault.js`.
 *
 * Requires: PRIVATE_KEY (LP, funded with a little Base Sepolia ETH) in repo .env.
 */
const { ethers } = require('ethers');
const cfg = require('./demoConfig');
const { pushPrices } = require('./pushPrices');

const SEED_XMR_USD = process.env.DEMO_SEED_XMR_USD || '150';
const CRANK_XMR_USD = process.env.DEMO_CRANK_XMR_USD || '300';
const COLLATERAL_USD = process.env.DEMO_COLLATERAL_USD || '1';
const COLLATERAL_ETH = process.env.DEMO_COLLATERAL_ETH || '0.003'; // wxDAI to deposit
const MINT_DEPOSIT = process.env.DEMO_MINT_DEPOSIT || '0.001'; // griefing deposit + ready bond (each)
const TARGET_CR_PCT = parseInt(process.env.DEMO_TARGET_CR_PCT || '150', 10);
const WAIT_SECONDS = parseInt(process.env.DEMO_WAIT_SECONDS || '95', 10);

const E18 = ethers.constants.WeiPerEther;
const E8 = ethers.BigNumber.from('100000000');

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
  'function initiateMint(address lpVault, address initiator, uint256 wsxmrAmount, bytes32 claimCommitment, bytes32 userPublicKey) external payable returns (bytes32)',
  'function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
  'function setMintReady(bytes32 requestId) external payable',
  'function finalizeMint(bytes32 requestId, bytes32 secret) external',
  'function updateOraclePrices(bytes[] calldata updateData) external payable',
  'function getXmrPrice() external view returns (uint256)',
  'function getCollateralPrice() external view returns (uint256)',
  'function isVaultLiquidatable(address lpVault) external view returns (bool)',
  'function calculateLiquidation(address lpVault, uint256 debtToClear) external view returns (uint256 collateralSeized, uint256 actualDebtCleared)',
];
const wsxmrAbi = [
  'function balanceOf(address) external view returns (uint256)',
  'function decimals() external view returns (uint8)',
];
const wxdaiAbi = [
  'function balanceOf(address) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function deposit() external payable',
];
const ed25519HelperAbi = [
  'function computeCommitment(bytes32 secret) external view returns (bytes32)',
  'function scalarMultBase(uint256 scalar) external view returns (uint256 x, uint256 y)',
  'function compressPublicKey(uint256 px, uint256 py) external pure returns (uint256)',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function computeXmrAmountForCr(collateralAssets18, collateralPrice18, xmrPrice18, targetCrPct) {
  const collateralValueUsd18 = collateralAssets18.mul(collateralPrice18).div(E18);
  const debtUsd18 = collateralValueUsd18.mul(100).div(targetCrPct);
  const wsXmr8 = debtUsd18.mul(E8).div(xmrPrice18);
  return { xmrAmount: wsXmr8.mul(10000), wsXmr8 };
}

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error('PRIVATE_KEY not set in repo .env');
    process.exit(1);
  }
  const provider = cfg.getProvider();
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log('CRE Liquidation Keeper — force-liquidation demo');
  console.log('================================================');
  console.log('Demo hub:', cfg.HUB);
  console.log('LP/vault:', wallet.address);
  console.log('');

  const hub = new ethers.Contract(cfg.HUB, hubAbi, wallet);
  const wsxmr = new ethers.Contract(cfg.WSXMR, wsxmrAbi, wallet);
  const wxdai = new ethers.Contract(cfg.WXDAI, wxdaiAbi, wallet);
  const hasHelper = cfg.ED25519_HELPER && cfg.ED25519_HELPER !== ethers.constants.AddressZero;
  const ed = new ethers.Contract(hasHelper ? cfg.ED25519_HELPER : ethers.constants.AddressZero, ed25519HelperAbi, provider);

  // 1. Seed prices
  console.log(`[1/6] Seeding prices  XMR=$${SEED_XMR_USD}  collateral=$${COLLATERAL_USD}`);
  await pushPrices(wallet, ethers.utils.parseUnits(SEED_XMR_USD, 18), ethers.utils.parseUnits(COLLATERAL_USD, 18));
  console.log('      done\n');

  // 2. Vault + collateral
  const collateralAmount = ethers.utils.parseEther(COLLATERAL_ETH);
  const mintDepositWei = ethers.utils.parseEther(MINT_DEPOSIT);
  if (!(await hub.hasActiveVault(wallet.address))) {
    console.log('[2/6] Creating vault');
    await (await hub.createVault()).wait();
  } else {
    console.log('[2/6] Vault already exists — reusing');
  }
  // (Re)apply vault config every run so amounts are deterministic and the
  // griefing deposit / ready bond match the (possibly reduced) MINT_DEPOSIT.
  await (await hub.setMaxMintBps(10000)).wait();
  await (await hub.setMinBurnAmount(0)).wait();
  await (await hub.setMintGriefingDeposit(mintDepositWei)).wait();
  await (await hub.setMintReadyBond(mintDepositWei)).wait();
  await (await hub.setVaultMarketMetrics(50, 30)).wait();

  let vault = await hub.getVault(wallet.address);
  if (vault.collateralShares.eq(0)) {
    // Only wrap the ETH shortfall — reuse any wxDAI already held (e.g. from a
    // previous partial run) so we don't burn extra testnet ETH.
    const have = await wxdai.balanceOf(wallet.address);
    if (have.lt(collateralAmount)) {
      const short = collateralAmount.sub(have);
      await (await wxdai.deposit({ value: short })).wait();
      console.log(`      wrapped ${ethers.utils.formatEther(short)} ETH -> wxDAI`);
    } else {
      console.log(`      reusing existing wxDAI balance (${ethers.utils.formatEther(have)})`);
    }
    await (await wxdai.approve(cfg.HUB, collateralAmount)).wait();
    await (await hub.depositCollateral(collateralAmount)).wait();
    console.log(`      deposited ${COLLATERAL_ETH} wxDAI collateral`);
  } else {
    console.log(`      existing collateral shares: ${vault.collateralShares.toString()}`);
  }
  console.log('');

  const existing = await wsxmr.balanceOf(wallet.address);
  if (existing.gt(0)) {
    console.log('[3/6] Vault already has wsXMR debt — skipping mint');
  } else {
    vault = await hub.getVault(wallet.address);
    const xmrPrice = await hub.getXmrPrice();
    const collPrice = await hub.getCollateralPrice();
    const { xmrAmount, wsXmr8 } = computeXmrAmountForCr(vault.collateralShares, collPrice, xmrPrice, TARGET_CR_PCT);
    console.log(`[3/6] Minting wsXMR targeting ~${TARGET_CR_PCT}% CR`);
    console.log(`      xmrAmount(atomic)=${xmrAmount.toString()}  ~wsXMR=${ethers.utils.formatUnits(wsXmr8, 8)}`);

    const secret = ethers.utils.randomBytes(32);
    let commitment, userPub;
    if (hasHelper) {
      commitment = await ed.computeCommitment(secret);
      const [px, py] = await ed.scalarMultBase(ethers.BigNumber.from(secret));
      userPub = ethers.utils.hexZeroPad((await ed.compressPublicKey(px, py)).toHexString(), 32);
    } else {
      commitment = ethers.utils.id(ethers.utils.hexlify(secret));
      userPub = ethers.utils.hexZeroPad(ethers.BigNumber.from(secret).toHexString(), 32);
    }

    const mintTx = await hub.initiateMint(
      wallet.address, wallet.address, xmrAmount, commitment, userPub,
      { value: mintDepositWei, gasLimit: 600000 }
    );
    const rcpt = await mintTx.wait();
    const requestId = rcpt.logs[0] && rcpt.logs[0].topics && rcpt.logs[0].topics[1];
    console.log('      mint initiated, requestId:', requestId);

    // Refresh prices (same values -> deviation guard passes) before setMintReady
    await pushPrices(wallet, ethers.utils.parseUnits(SEED_XMR_USD, 18), ethers.utils.parseUnits(COLLATERAL_USD, 18));

    let lpKey;
    if (hasHelper) {
      const lpSecret = ethers.utils.randomBytes(32);
      const [lx] = await ed.scalarMultBase(ethers.BigNumber.from(lpSecret));
      lpKey = ethers.utils.hexZeroPad(ethers.BigNumber.from(lx).toHexString(), 32);
    } else {
      lpKey = ethers.utils.hexZeroPad(ethers.utils.randomBytes(32), 32);
    }
    await (await hub.provideLPKey(requestId, lpKey, lpKey)).wait();
    await (await hub.setMintReady(requestId, { value: mintDepositWei })).wait();
    await (await hub.finalizeMint(requestId, secret, { gasLimit: 1000000 })).wait();

    const bal = await wsxmr.balanceOf(wallet.address);
    console.log(`      minted ${ethers.utils.formatUnits(bal, 8)} wsXMR`);
  }
  console.log('');

  // Sanity: vault should be healthy right now
  const healthyNow = await hub.isVaultLiquidatable(wallet.address);
  console.log(`[4/6] Post-mint isVaultLiquidatable = ${healthyNow} (expect false)`);
  console.log(`      Waiting ${WAIT_SECONDS}s so the 90s oracle deviation guard is bypassed...`);
  await sleep(WAIT_SECONDS * 1000);
  console.log('');

  // 5. Crank the XMR price up to push the vault underwater
  console.log(`[5/6] Cranking XMR price to $${CRANK_XMR_USD} (collateral stays $${COLLATERAL_USD})`);
  await pushPrices(wallet, ethers.utils.parseUnits(CRANK_XMR_USD, 18), ethers.utils.parseUnits(COLLATERAL_USD, 18));
  console.log('      new on-chain XMR/USD: $' + ethers.utils.formatUnits(await hub.getXmrPrice(), 18));
  console.log('');

  // 6. Verify
  const liquidatable = await hub.isVaultLiquidatable(wallet.address);
  console.log('[6/6] RESULT');
  console.log('      isVaultLiquidatable =', liquidatable);
  if (liquidatable) {
    const [seized, cleared] = await hub.calculateLiquidation(wallet.address, ethers.constants.MaxUint256);
    console.log('      full-clear would seize collateral shares:', seized.toString());
    console.log('      full-clear would clear wsXMR debt:        ', ethers.utils.formatUnits(cleared, 8));
    console.log('');
    console.log('Vault is now flaggable by the CRE keeper. Next:');
    console.log('  - point cre/liquidation-keeper/config.staging.json hubAddress at this demo hub');
    console.log('  - run the keeper: (cd cre && cre workflow simulate liquidation-keeper --env .env --broadcast)');
    console.log('  - then: node scripts/demo/liquidate.js   OR   node scripts/demo/backstopVault.js');
  } else {
    console.log('      Unexpected: vault still healthy. Try a larger DEMO_CRANK_XMR_USD.');
    process.exit(2);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
