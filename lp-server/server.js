require('dotenv').config();
const express = require('express');
const ethers = require('ethers');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const burnHandler = require('./burnHandler');

const app = express();
app.use(express.json());

// ─── Config ─────────────────────────────────────────────────────────────────
const RPC_URL = process.env.RPC_URL || 'https://sepolia.base.org';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const PORT = process.env.PORT || 3001;

if (!PRIVATE_KEY) {
  console.error('Error: PRIVATE_KEY env var is required');
  process.exit(1);
}

const deploymentPath = path.join(__dirname, '..', 'deployment.json');
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

const HUB_ADDRESS = deployment.contracts.wsXmrHub;
const CHAIN_ID = deployment.chainId || 84532;

// Minimal ABI for the operations we need
const HUB_ABI = [
  // Mint events
  'event MintInitiated(bytes32 indexed requestId, address indexed initiator, address indexed recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout)',
  'event LPKeyProvided(bytes32 indexed requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey)',
  'event MintReady(bytes32 indexed requestId)',
  // Burn events
  'event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral, bytes32 claimCommitment)',
  'event HashProposed(bytes32 indexed requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey)',
  'event BurnCommitted(bytes32 indexed requestId, uint256 deadline)',
  'event BurnFinalized(bytes32 indexed requestId, bytes32 secret, uint256 rewardPaid)',
  'event BurnCancelled(bytes32 indexed requestId)',
  'event BurnAborted(bytes32 indexed requestId)',
  // Functions
  'function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
  'function setMintReady(bytes32 requestId) external payable',
  'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps))',
  'function proposeHash(bytes32 requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
  'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
  'function claimSlashedCollateral(bytes32 requestId) external',
  'function resolveDeclinedProposal(bytes32 requestId) external',
  'function getBurnRequest(bytes32 requestId) external view returns (tuple(address user, address lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 feeAmount, uint256 collateralLocked, uint256 rewardCollateral, bytes32 claimCommitment, bytes32 secretHash, uint256 timeout, uint256 commitDeadline, uint256 state))',
];

// ─── Ethers Setup ───────────────────────────────────────────────────────────
const provider = new ethers.providers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, wallet);

console.log(`LP Server starting...`);
console.log(`Wallet / LP Vault: ${wallet.address}`);
console.log(`Hub: ${HUB_ADDRESS}`);
console.log(`RPC: ${RPC_URL}`);

// ─── In-memory tracking ─────────────────────────────────────────────────────
const pendingMints = new Map(); // requestId -> { initiatedAt, keyPostedAt }

// ─── Ed25519 Key Generation ─────────────────────────────────────────────────
async function generateEd25519Keys() {
  const ed = await import('@noble/ed25519');
  const crypto = require('crypto');
  
  // Set up SHA-512 sync for @noble/ed25519
  if (!ed.etc.sha512Sync) {
    ed.etc.sha512Sync = (...m) => crypto.createHash('sha512').update(Buffer.concat(m)).digest();
  }
  
  const spendPriv = ed.utils.randomPrivateKey();
  const viewPriv = ed.utils.randomPrivateKey();
  const spendPub = await ed.getPublicKey(spendPriv);
  const viewPub = await ed.getPublicKey(viewPriv);
  return {
    lpPublicSpendKey: '0x' + Buffer.from(spendPub).toString('hex'),
    lpPublicViewKey: '0x' + Buffer.from(viewPub).toString('hex'),
  };
}

// ─── Core Mint Processing ───────────────────────────────────────────────────
async function processMint(reqIdHex, lpPublicSpendKey, lpPublicViewKey) {
  console.log(`[Mint] Auto-processing ${reqIdHex}`);

  // 1. Provide LP key on-chain
  console.log(`[Chain] Calling provideLPKey(${reqIdHex})...`);
  const tx1 = await hub.provideLPKey(reqIdHex, lpPublicSpendKey, lpPublicViewKey);
  console.log(`[Chain] provideLPKey tx: ${tx1.hash}`);
  const receipt1 = await tx1.wait();
  console.log(`[Chain] provideLPKey confirmed in block ${receipt1.blockNumber}`);

  const mint = pendingMints.get(reqIdHex) || {};
  mint.keyPostedAt = Date.now();
  mint.lpPublicSpendKey = lpPublicSpendKey;
  mint.lpPublicViewKey = lpPublicViewKey;
  pendingMints.set(reqIdHex, mint);

  // 2. Wait 20 seconds, then call setMintReady
  console.log(`[Timer] Waiting 20 seconds before calling setMintReady...`);
  await new Promise(r => setTimeout(r, 20000));

  // Fetch required bond from vault config
  const vault = await hub.getVault(wallet.address);
  const requiredBond = vault.mintReadyBond;
  console.log(`[Chain] Vault mintReadyBond: ${ethers.utils.formatEther(requiredBond)} ETH`);

  console.log(`[Chain] Calling setMintReady(${reqIdHex}) with bond ${ethers.utils.formatEther(requiredBond)} ETH...`);
  const tx2 = await hub.setMintReady(reqIdHex, { value: requiredBond });
  console.log(`[Chain] setMintReady tx: ${tx2.hash}`);
  const receipt2 = await tx2.wait();
  console.log(`[Chain] setMintReady confirmed in block ${receipt2.blockNumber}`);
}

// ─── On-chain Event Listener ────────────────────────────────────────────────
async function startEventListener() {
  const fromBlock = await provider.getBlockNumber();
  console.log(`Listening for MintInitiated from block ${fromBlock}`);

  hub.on('MintInitiated', async (requestId, initiator, recipient, lpVault, xmrAmount, wsxmrAmount, feeAmount, claimCommitment, userPublicKey, timeout, event) => {
    const reqIdHex = ethers.utils.hexlify(requestId);
    if (lpVault.toLowerCase() !== wallet.address.toLowerCase()) {
      console.log(`[Event] MintInitiated ${reqIdHex} — not our vault, ignoring`);
      return;
    }
    console.log(`[Event] MintInitiated ${reqIdHex}`);
    console.log(`  Initiator: ${initiator}`);
    console.log(`  Recipient: ${recipient}`);
    console.log(`  xmrAmount: ${xmrAmount.toString()}`);
    console.log(`  Timeout block: ${timeout.toString()}`);
    pendingMints.set(reqIdHex, {
      requestId: reqIdHex,
      initiator,
      recipient,
      xmrAmount: xmrAmount.toString(),
      timeoutBlock: timeout.toNumber(),
      initiatedAt: Date.now(),
    });

    // Auto-process: generate keys, provideLPKey, wait, setMintReady
    try {
      const keys = await generateEd25519Keys();
      console.log(`[Mint] Generated Ed25519 keys for ${reqIdHex}`);
      console.log(`  lpPublicSpendKey: ${keys.lpPublicSpendKey}`);
      console.log(`  lpPublicViewKey: ${keys.lpPublicViewKey}`);
      await processMint(reqIdHex, keys.lpPublicSpendKey, keys.lpPublicViewKey);
    } catch (err) {
      console.error(`[Mint] Auto-process failed for ${reqIdHex}:`, err.message || err);
      const mint = pendingMints.get(reqIdHex) || {};
      mint.autoProcessError = err.message || String(err);
      pendingMints.set(reqIdHex, mint);
    }
  });
}

// ─── HTTP Routes ────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', wallet: wallet.address, hub: HUB_ADDRESS });
});

// Post LP key for a mint request manually (auto-processing is the default)
app.post('/mint/key', async (req, res) => {
  const { requestId, lpPublicSpendKey, lpPublicViewKey } = req.body;

  if (!requestId) {
    return res.status(400).json({ error: 'requestId required' });
  }
  if (!lpPublicSpendKey || !lpPublicViewKey) {
    return res.status(400).json({ error: 'lpPublicSpendKey and lpPublicViewKey required' });
  }

  const reqIdHex = ethers.utils.hexlify(requestId);
  console.log(`[HTTP] Received LP key for ${reqIdHex}`);

  try {
    // Kick off processing without blocking the response
    res.json({
      success: true,
      requestId: reqIdHex,
      message: 'Processing started. provideLPKey then setMintReady will follow.',
    });

    await processMint(reqIdHex, lpPublicSpendKey, lpPublicViewKey);
  } catch (err) {
    console.error(`[Error] Failed processing /mint/key for ${reqIdHex}:`, err.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || String(err), requestId: reqIdHex });
    }
  }
});

// List tracked mints
app.get('/mints', (_req, res) => {
  const list = Array.from(pendingMints.values());
  res.json({ mints: list, count: list.length });
});

// ─── Chainlink Data Streams Report Proxy ────────────────────────────────────
// Serves signed fullReport blobs to the frontend so the API secret never
// reaches the browser. Mirrors frontend/report-proxy/server.js behaviour.

const PROXY_DIR = path.join(__dirname, '..', 'frontend', 'report-proxy');

function fetchReport(feedId) {
  const out = execSync(`node "${path.join(PROXY_DIR, 'fetchReportHex.js')}" ${feedId}`, {
    cwd: PROXY_DIR,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' }
  });
  return out.trim();
}

app.options('/reports', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.get('/reports', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  const feedIDs = (req.query.feedIDs || '').split(',').filter(Boolean);
  if (feedIDs.length === 0) {
    return res.status(400).json({ error: 'Missing feedIDs query parameter' });
  }

  try {
    const reports = await Promise.all(
      feedIDs.map(async (id) => {
        const fullReport = fetchReport(id);
        return { feedID: id, fullReport };
      })
    );
    res.json({ reports });
  } catch (e) {
    console.error('Report fetch failed:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ─── Burn Handler Integration ───────────────────────────────────────────────
burnHandler.registerRoutes(app);

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`HTTP server listening on http://localhost:${PORT}`);
  await startEventListener();
  burnHandler.attachEventListeners(hub, wallet, provider);
});
