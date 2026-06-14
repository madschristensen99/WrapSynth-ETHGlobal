'use strict';
/**
 * Shared config for the CRE Liquidation Keeper demo scripts.
 *
 * Reads the demo-hub manifest written by `forge script DeployDemoHub.s.sol`
 * (ethereum/deployment.demo-hub.json) plus the Base Sepolia manifest for the
 * reusable Ed25519Helper, and the repo-root .env for PRIVATE_KEY / RPC.
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

const demoPath = path.join(__dirname, '../../deployment.demo-hub.json');
if (!fs.existsSync(demoPath)) {
  console.error('Missing ethereum/deployment.demo-hub.json. Deploy the demo hub first:');
  console.error('  cd ethereum && forge script script/DeployDemoHub.s.sol \\');
  console.error('    --rpc-url https://sepolia.base.org --broadcast');
  process.exit(1);
}
const demo = JSON.parse(fs.readFileSync(demoPath, 'utf8'));

// Ed25519Helper is chain-global; reuse the one from the Base Sepolia deployment.
let ed25519Helper = process.env.ED25519_HELPER || null;
const baseSepoliaPath = path.join(__dirname, '../../../deployment.base-sepolia.json');
if (!ed25519Helper && fs.existsSync(baseSepoliaPath)) {
  try {
    ed25519Helper = JSON.parse(fs.readFileSync(baseSepoliaPath, 'utf8'))
      .externalContracts.Ed25519Helper;
  } catch (_) { /* optional */ }
}

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org';

// ethers v5 hardcodes a 1.5 gwei maxPriorityFeePerGas, which is ~100x too high
// for Base Sepolia. Besides overpaying, gasLimit * maxFeePerGas inflates the
// node's balance reserve check and causes bogus "insufficient funds"
// rejections. Patch getFeeData() to use sane Base fees.
function getProvider() {
  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

  // Public Base Sepolia RPCs occasionally drop requests (ETIMEDOUT / 429 / 503).
  // Retry transient failures with backoff. Re-sending the identical signed tx is
  // idempotent (same hash), so this is safe for eth_sendRawTransaction too.
  const send = provider.send.bind(provider);
  provider.send = async (method, params) => {
    let lastErr;
    for (let i = 0; i < 5; i++) {
      try {
        return await send(method, params);
      } catch (e) {
        lastErr = e;
        const msg = `${(e && e.code) || ''} ${(e && e.message) || ''}`;
        if (!/TIMEOUT|ETIMEDOUT|SERVER_ERROR|ECONNRESET|socket hang up|bad response|429|502|503|504/i.test(msg)) {
          throw e;
        }
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
    }
    throw lastErr;
  };

  const orig = provider.getFeeData.bind(provider);
  provider.getFeeData = async () => {
    const fd = await orig();
    const priority = ethers.utils.parseUnits('0.01', 'gwei');
    const base = fd.lastBaseFeePerGas || ethers.utils.parseUnits('0.05', 'gwei');
    const maxFee = base.mul(2).add(priority);
    return {
      gasPrice: maxFee,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priority,
      lastBaseFeePerGas: fd.lastBaseFeePerGas || null,
    };
  };
  return provider;
}

module.exports = {
  RPC_URL,
  getProvider,
  HUB: demo.wsXmrHub,
  WSXMR: demo.wsXMR,
  VERIFIER: demo.mockVerifierProxy,
  COLLATERAL: demo.collateral,
  WXDAI: demo.wxDAI,
  XMR_FEED: demo.xmrFeedId,
  DAI_FEED: demo.daiFeedId,
  ED25519_HELPER: ed25519Helper,
};
