#!/usr/bin/env node
'use strict';
/**
 * Liquidator path: burn wsXMR to clear an undercollateralized vault's debt and
 * seize its collateral at a 10% bonus (LIQUIDATION_BONUS = 110).
 *
 * This is what an incentivized third party does AFTER the CRE keeper emits
 * VaultFlaggedForLiquidation. The liquidator must hold wsXMR (>= the debt being
 * cleared); burn() is hub-gated so no token approval is needed.
 *
 * Usage:
 *   node scripts/demo/liquidate.js [vaultAddress]
 *
 * Env:
 *   PRIVATE_KEY            signer + default liquidator (holds the minted wsXMR)
 *   LIQUIDATOR_PRIVATE_KEY optional separate liquidator key (must hold wsXMR)
 *   VAULT                  vault to liquidate (defaults to the LP = PRIVATE_KEY)
 */
const { ethers } = require('ethers');
const cfg = require('./demoConfig');

const hubAbi = [
  'function isVaultLiquidatable(address lpVault) external view returns (bool)',
  'function calculateLiquidation(address lpVault, uint256 debtToClear) external view returns (uint256 collateralSeized, uint256 actualDebtCleared)',
  'function liquidate(address lpVault, uint256 debtToClear) external',
  'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active))',
];
const wsxmrAbi = ['function balanceOf(address) view returns (uint256)'];
const wxdaiAbi = ['function balanceOf(address) view returns (uint256)'];

async function main() {
  if (!process.env.PRIVATE_KEY) { console.error('PRIVATE_KEY not set'); process.exit(1); }
  const provider = cfg.getProvider();
  const lpAddress = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  const liquidator = new ethers.Wallet(process.env.LIQUIDATOR_PRIVATE_KEY || process.env.PRIVATE_KEY, provider);

  const vaultAddr = process.argv[2] || process.env.VAULT || lpAddress;

  console.log('Liquidator demo');
  console.log('===============');
  console.log('Liquidator:', liquidator.address);
  console.log('Vault:     ', vaultAddr);
  console.log('');

  const hub = new ethers.Contract(cfg.HUB, hubAbi, liquidator);
  const wsxmr = new ethers.Contract(cfg.WSXMR, wsxmrAbi, provider);
  const wxdai = new ethers.Contract(cfg.WXDAI, wxdaiAbi, provider);

  if (!(await hub.isVaultLiquidatable(vaultAddr))) {
    console.error('Vault is NOT liquidatable (CR >= 120%). Run demoForceLiquidation.js first.');
    process.exit(2);
  }

  const [, fullDebt] = await hub.calculateLiquidation(vaultAddr, ethers.constants.MaxUint256);
  const balance = await wsxmr.balanceOf(liquidator.address);
  const debtToClear = balance.lt(fullDebt) ? balance : fullDebt;

  console.log('Full debt:        ', ethers.utils.formatUnits(fullDebt, 8), 'wsXMR');
  console.log('Liquidator wsXMR: ', ethers.utils.formatUnits(balance, 8));
  console.log('Clearing:         ', ethers.utils.formatUnits(debtToClear, 8), 'wsXMR');
  if (debtToClear.eq(0)) {
    console.error('Liquidator holds 0 wsXMR — acquire wsXMR (e.g. mint via the demo) before liquidating.');
    process.exit(2);
  }

  const wxdaiBefore = await wxdai.balanceOf(liquidator.address);
  const tx = await hub.liquidate(vaultAddr, debtToClear, { gasLimit: 2_000_000 });
  console.log('liquidate tx:', tx.hash);
  await tx.wait();

  const wxdaiAfter = await wxdai.balanceOf(liquidator.address);
  console.log('Collateral seized (wxDAI shares):', ethers.utils.formatEther(wxdaiAfter.sub(wxdaiBefore)));
  console.log('Vault still liquidatable?', await hub.isVaultLiquidatable(vaultAddr));
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
