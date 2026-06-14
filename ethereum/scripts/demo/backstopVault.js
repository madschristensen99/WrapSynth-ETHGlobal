#!/usr/bin/env node
'use strict';
/**
 * Backstop path: a DIFFERENT LP takes over the underwater vault's debt +
 * collateral in one shot (no wsXMR sourcing needed), restoring the protocol's
 * overcollateralization. The new vault must end up healthy (>= 150% CR), so the
 * backstopper deposits ample collateral first.
 *
 * This is the alternative to liquidate() that the CRE keeper's flag enables.
 *
 * Usage:
 *   node scripts/demo/backstopVault.js [oldVaultAddress]
 *
 * Env:
 *   BACKSTOP_PRIVATE_KEY  REQUIRED — a second funded Base Sepolia key (the new LP)
 *   PRIVATE_KEY           used only to derive the default old-vault address
 *   VAULT                 old (underwater) vault (defaults to PRIVATE_KEY's address)
 *   BACKSTOP_COLLATERAL_ETH  wxDAI the backstopper deposits (default 0.02)
 */
const { ethers } = require('ethers');
const cfg = require('./demoConfig');

const BACKSTOP_COLLATERAL_ETH = process.env.BACKSTOP_COLLATERAL_ETH || '0.02';

const hubAbi = [
  'function createVault() external',
  'function depositCollateral(uint256 amount) external',
  'function hasActiveVault(address lpAddress) external view returns (bool)',
  'function setMaxMintBps(uint16 maxMintBps) external',
  'function isVaultLiquidatable(address lpVault) external view returns (bool)',
  'function backstopVault(address oldVault) external',
  'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active))',
];
const wxdaiAbi = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function deposit() external payable',
  'function balanceOf(address) view returns (uint256)',
];

async function main() {
  if (!process.env.BACKSTOP_PRIVATE_KEY) {
    console.error('BACKSTOP_PRIVATE_KEY not set — backstop requires a SECOND funded Base Sepolia key.');
    process.exit(1);
  }
  const provider = cfg.getProvider();
  const newLp = new ethers.Wallet(process.env.BACKSTOP_PRIVATE_KEY, provider);
  const oldVault = process.argv[2] || process.env.VAULT ||
    (process.env.PRIVATE_KEY ? new ethers.Wallet(process.env.PRIVATE_KEY).address : null);
  if (!oldVault) { console.error('No old vault address (set VAULT or PRIVATE_KEY).'); process.exit(1); }

  console.log('Backstop demo');
  console.log('=============');
  console.log('New LP:    ', newLp.address);
  console.log('Old vault: ', oldVault);
  console.log('');

  const hub = new ethers.Contract(cfg.HUB, hubAbi, newLp);
  const wxdai = new ethers.Contract(cfg.WXDAI, wxdaiAbi, newLp);

  if (newLp.address.toLowerCase() === oldVault.toLowerCase()) {
    console.error('Backstopper must differ from the old vault. Use a separate BACKSTOP_PRIVATE_KEY.');
    process.exit(2);
  }
  if (!(await hub.isVaultLiquidatable(oldVault))) {
    console.error('Old vault is NOT underwater (CR >= 120%). Run demoForceLiquidation.js first.');
    process.exit(2);
  }

  // Ensure the new LP has a well-collateralized vault to absorb the position.
  const collateralAmount = ethers.utils.parseEther(BACKSTOP_COLLATERAL_ETH);
  if (!(await hub.hasActiveVault(newLp.address))) {
    console.log('Creating backstopper vault...');
    await (await hub.createVault()).wait();
    await (await hub.setMaxMintBps(10000)).wait();
  }
  const newV = await hub.getVault(newLp.address);
  if (newV.collateralShares.lt(collateralAmount)) {
    await (await wxdai.deposit({ value: collateralAmount })).wait();
    await (await wxdai.approve(cfg.HUB, collateralAmount)).wait();
    await (await hub.depositCollateral(collateralAmount)).wait();
    console.log(`Deposited ${BACKSTOP_COLLATERAL_ETH} wxDAI as backstop collateral`);
  }
  console.log('');

  const tx = await hub.backstopVault(oldVault, { gasLimit: 2_000_000 });
  console.log('backstopVault tx:', tx.hash);
  await tx.wait();

  const oldAfter = await hub.getVault(oldVault);
  const newAfter = await hub.getVault(newLp.address);
  console.log('');
  console.log('Old vault debt after:', oldAfter.normalizedDebt.toString(), '(expect 0)');
  console.log('New vault collateral shares:', newAfter.collateralShares.toString());
  console.log('New vault debt:', newAfter.normalizedDebt.toString());
  console.log('Old vault still liquidatable?', await hub.isVaultLiquidatable(oldVault));
  console.log('Done — position taken over, overcollateralization restored.');
}

main().catch((e) => { console.error(e); process.exit(1); });
