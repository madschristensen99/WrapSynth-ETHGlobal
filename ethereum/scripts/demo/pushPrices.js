'use strict';
/**
 * Demo price control: set the MockVerifierProxy price for the XMR and collateral
 * feeds, then push them on-chain through the demo hub's
 * ChainlinkDataStreamsOracleFacet.updateOraclePrices().
 *
 * Because the demo hub uses a mock verifier (s_feeManager == address(0)), no
 * LINK is required and the price is exactly whatever we set here.
 *
 * Library:  const { pushPrices } = require('./pushPrices');
 *           await pushPrices(wallet, parseUnits('150',18), parseUnits('1',18));
 * CLI:      node pushPrices.js <xmrUsd> <collateralUsd>
 *           node pushPrices.js 150 1
 */
const { ethers } = require('ethers');
const cfg = require('./demoConfig');

const verifierAbi = [
  'function setPrice(bytes32 feedId, int192 price) external',
  'function buildPayload(bytes32 feedId) external view returns (bytes)',
];
const hubAbi = [
  'function updateOraclePrices(bytes[] calldata updateData) external payable',
  'function getXmrPrice() external view returns (uint256)',
  'function getCollateralPrice() external view returns (uint256)',
];

/**
 * @param {ethers.Wallet} wallet
 * @param {ethers.BigNumber} xmrPrice18      XMR/USD with 18 decimals
 * @param {ethers.BigNumber} collateralPrice18 collateral/USD with 18 decimals
 */
async function pushPrices(wallet, xmrPrice18, collateralPrice18) {
  const verifier = new ethers.Contract(cfg.VERIFIER, verifierAbi, wallet);
  const hub = new ethers.Contract(cfg.HUB, hubAbi, wallet);

  await (await verifier.setPrice(cfg.XMR_FEED, xmrPrice18)).wait();
  await (await verifier.setPrice(cfg.DAI_FEED, collateralPrice18)).wait();

  const xmrBlob = await verifier.buildPayload(cfg.XMR_FEED);
  const daiBlob = await verifier.buildPayload(cfg.DAI_FEED);

  const tx = await hub.updateOraclePrices([xmrBlob, daiBlob], { gasLimit: 600000 });
  await tx.wait();
  return tx.hash;
}

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error('PRIVATE_KEY not set');
    process.exit(1);
  }
  const xmrUsd = process.argv[2] || '150';
  const collateralUsd = process.argv[3] || '1';

  const provider = cfg.getProvider();
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

  console.log(`Pushing demo prices  XMR/USD=$${xmrUsd}  collateral/USD=$${collateralUsd}`);
  const hash = await pushPrices(
    wallet,
    ethers.utils.parseUnits(xmrUsd, 18),
    ethers.utils.parseUnits(collateralUsd, 18)
  );
  console.log('updateOraclePrices tx:', hash);

  const hub = new ethers.Contract(cfg.HUB, hubAbi, provider);
  console.log('  on-chain XMR/USD:        $' + ethers.utils.formatUnits(await hub.getXmrPrice(), 18));
  console.log('  on-chain collateral/USD: $' + ethers.utils.formatUnits(await hub.getCollateralPrice(), 18));
}

module.exports = { pushPrices };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
