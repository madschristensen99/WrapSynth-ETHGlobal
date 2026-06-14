#!/usr/bin/env node
'use strict';
/**
 * CRE-equivalent flag step.
 *
 * Reproduces, on live Base Sepolia, the exact on-chain behavior that the
 * Chainlink CRE "Liquidation Keeper" workflow (cre/liquidation-keeper/main.ts)
 * produces — without the DON consensus/signing wrapper, which is Chainlink
 * infrastructure rather than this project's logic.
 *
 * It mirrors main.ts 1:1:
 *   1. read  getLiquidatableVaults(scanStartIndex, scanCount) on the hub,
 *   2. strip the trailing zero-address slots,
 *   3. abi.encode(address[] vaults)  (== VAULTS_REPORT_PARAMS payload),
 *   4. call registry.onReport("0x", payload)  (the KeystoneForwarder entrypoint),
 *   5. assert VaultFlaggedForLiquidation fired and flagCount advanced.
 *
 * The registry re-validates every vault against the live hub before emitting,
 * so this is the same trust-minimized path the real DON write hits.
 *
 * Env:
 *   PRIVATE_KEY  signer (also the flagger)
 *   REGISTRY     LiquidationAlertRegistry address (else read from
 *                ethereum/deployment.cre-test.json)
 *   SCAN_START / SCAN_COUNT  override the config.staging.json scan window
 *
 * Exit codes: 0 = flagged >=1 vault, 3 = nothing liquidatable, 1 = error.
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const cfg = require('./demoConfig');

function resolveRegistry() {
  if (process.env.REGISTRY && process.env.REGISTRY !== ethers.constants.AddressZero) {
    return process.env.REGISTRY;
  }
  const p = path.join(__dirname, '../../deployment.cre-test.json');
  if (fs.existsSync(p)) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j.registry) return j.registry;
  }
  return null;
}

function resolveScanWindow() {
  let start = 0;
  let count = 100;
  const p = path.join(__dirname, '../../../cre/liquidation-keeper/config.staging.json');
  if (fs.existsSync(p)) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Number.isInteger(j.scanStartIndex)) start = j.scanStartIndex;
      if (Number.isInteger(j.scanCount)) count = j.scanCount;
    } catch (_) { /* use defaults */ }
  }
  if (process.env.SCAN_START) start = parseInt(process.env.SCAN_START, 10);
  if (process.env.SCAN_COUNT) count = parseInt(process.env.SCAN_COUNT, 10);
  return { start, count };
}

const hubAbi = [
  'function getLiquidatableVaults(uint256 startIndex, uint256 count) external view returns (address[] vaults, uint256[] debts)',
];
const registryAbi = [
  'function onReport(bytes metadata, bytes report) external',
  'function flagCount() external view returns (uint256)',
  'function hub() external view returns (address)',
  'function forwarder() external view returns (address)',
  'event VaultFlaggedForLiquidation(address indexed vault, uint256 debt, address indexed flagger, uint256 timestamp)',
  'event VaultFlagRejected(address indexed vault, address indexed flagger)',
];

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error('PRIVATE_KEY not set in repo .env');
    process.exit(1);
  }
  const registryAddr = resolveRegistry();
  if (!registryAddr) {
    console.error('REGISTRY not set and ethereum/deployment.cre-test.json missing.');
    process.exit(1);
  }
  const { start, count } = resolveScanWindow();

  const provider = cfg.getProvider();
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log('CRE-equivalent flag step (mirrors main.ts onReport path)');
  console.log('=========================================================');
  console.log('Hub:      ', cfg.HUB);
  console.log('Registry: ', registryAddr);
  console.log('Flagger:  ', wallet.address);
  console.log(`Scan:      getLiquidatableVaults(${start}, ${count})`);
  console.log('');

  const hub = new ethers.Contract(cfg.HUB, hubAbi, provider);
  const registry = new ethers.Contract(registryAddr, registryAbi, wallet);

  // Guard: registry must point at this hub or the re-validation will reject all.
  const wiredHub = await registry.hub();
  if (wiredHub.toLowerCase() !== cfg.HUB.toLowerCase()) {
    console.error(`Registry.hub() = ${wiredHub} but demo hub = ${cfg.HUB}. Redeploy the registry against the demo hub.`);
    process.exit(1);
  }
  const fwd = await registry.forwarder();
  if (fwd !== ethers.constants.AddressZero && fwd.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(`Registry.onReport is locked to forwarder ${fwd}; this signer cannot call it. Use FORWARDER=0 at deploy.`);
    process.exit(1);
  }

  // --- 1. read undercollateralized vaults (mirrors main.ts step 1) ---
  const [vaultsRaw] = await hub.getLiquidatableVaults(start, count);
  const vaults = vaultsRaw.filter((v) => v && v !== ethers.constants.AddressZero);

  if (vaults.length === 0) {
    console.log('[keeper] all scanned vaults are >= 120% CR — nothing to flag');
    process.exit(3);
  }
  console.log(`[keeper] ${vaults.length} undercollateralized vault(s): ${vaults.join(', ')}`);

  // --- 2. build the DON report payload: abi.encode(address[]) ---
  const report = ethers.utils.defaultAbiCoder.encode(['address[]'], [vaults]);

  // --- 3. deliver via onReport (the KeystoneForwarder entrypoint) ---
  const flagCountBefore = await registry.flagCount();
  const tx = await registry.onReport('0x', report, { gasLimit: 1_500_000 });
  console.log('onReport tx:', tx.hash);
  const rcpt = await tx.wait();

  // --- 4. verify the emitted events ---
  const flagged = [];
  const rejected = [];
  for (const log of rcpt.logs) {
    try {
      const parsed = registry.interface.parseLog(log);
      if (parsed.name === 'VaultFlaggedForLiquidation') {
        flagged.push({ vault: parsed.args.vault, debt: parsed.args.debt.toString() });
      } else if (parsed.name === 'VaultFlagRejected') {
        rejected.push(parsed.args.vault);
      }
    } catch (_) { /* not a registry event */ }
  }
  const flagCountAfter = await registry.flagCount();

  console.log('');
  console.log('Result');
  console.log('------');
  console.log('block:           ', rcpt.blockNumber);
  console.log('flagCount:        %s -> %s', flagCountBefore.toString(), flagCountAfter.toString());
  console.log('VaultFlaggedForLiquidation events:', flagged.length);
  for (const f of flagged) {
    console.log(`  - vault=${f.vault} debt=${ethers.utils.formatUnits(f.debt, 8)} wsXMR`);
  }
  if (rejected.length) {
    console.log('VaultFlagRejected (healthy at re-check):', rejected.join(', '));
  }

  if (flagged.length === 0) {
    console.error('No VaultFlaggedForLiquidation emitted — registry rejected every vault.');
    process.exit(4);
  }
  console.log('');
  console.log(`OK: flagged ${flagged.length} vault(s) on-chain via onReport.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
