// burnHandler.js — LP-side burn operations for WrapSynth
// Handles: listen for BurnRequested → proposeHash → finalizeBurn

const crypto = require('crypto');
const ethers = require('ethers');

// ─── Config ─────────────────────────────────────────────────────────────────
const AUTO_PROCESS_BURNS = (process.env.AUTO_PROCESS_BURNS || 'false').toLowerCase() === 'true';
const BURN_PROPOSE_DELAY_MS = parseInt(process.env.BURN_PROPOSE_DELAY_MS || '5000', 10);
const BURN_FINALIZE_DELAY_MS = parseInt(process.env.BURN_FINALIZE_DELAY_MS || '30000', 10);
const MONERO_WALLET_RPC_URL = process.env.MONERO_WALLET_RPC_URL || null;

// Default LP Ed25519 public keys (hex, 32 bytes, 0x prefix optional)
// If not set, keys must be supplied per-request via HTTP endpoints.
const DEFAULT_LP_PUBLIC_SPEND_KEY = process.env.BURN_LP_PUBLIC_SPEND_KEY || null;
const DEFAULT_LP_PUBLIC_VIEW_KEY = process.env.BURN_LP_PUBLIC_VIEW_KEY || null;

// ─── State ──────────────────────────────────────────────────────────────────
const pendingBurns = new Map(); // requestId -> burn state object
let hubContract = null;
let wallet = null;
let provider = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hexToBytes(hex) {
  hex = hex.replace(/^0x/, '');
  if (hex.length % 2 !== 0) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

function bytesToHex(bytes) {
  return '0x' + Buffer.from(bytes).toString('hex');
}

function normalizeHex32(val) {
  if (!val) return null;
  let h = val.toString().replace(/^0x/, '');
  if (h.length !== 64) return null;
  return '0x' + h;
}

/**
 * Compute secretHash from a secret scalar.
 * Matches WrapSynth on-chain verifier:
 *   secretHash = keccak256(abi.encodePacked(px, py))
 * where (px, py) = G * secret on Ed25519.
 */
async function computeSecretHash(secretBytes) {
  const ed = await import('@noble/ed25519');
  const secretBigInt = BigInt('0x' + Buffer.from(secretBytes).toString('hex'));
  // Ed25519 group order
  const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const secretReduced = secretBigInt % ED25519_L;
  const reducedBytes = Buffer.alloc(32);
  let tmp = secretReduced;
  for (let i = 0; i < 32; i++) {
    reducedBytes[31 - i] = Number(tmp & 0xffn);
    tmp = tmp >> 8n;
  }

  const publicKeyPoint = ed.Point.BASE.multiply(secretReduced);
  const publicKeyBytes = publicKeyPoint.toRawBytes();
  const publicKeyHex = bytesToHex(publicKeyBytes);

  const px = publicKeyHex.slice(0, 66);
  const py = '0x' + publicKeyHex.slice(66);

  const encoded = ethers.utils.solidityPack(['bytes32', 'bytes32'], [px, py]);
  const hash = ethers.utils.keccak256(encoded);
  return { secretHash: hash, px, py };
}

/**
 * Send XMR via monero-wallet-rpc (optional).
 * Returns a placeholder tx hash if wallet RPC is not configured.
 */
async function sendXmr(destination, amountAtomic) {
  if (!MONERO_WALLET_RPC_URL) {
    console.log('[Burn] Monero wallet RPC not configured — XMR send skipped (placeholder)');
    return { txHash: 'placeholder_tx_hash', sent: false };
  }

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: '0',
    method: 'transfer',
    params: {
      destinations: [{ amount: amountAtomic.toString(), address: destination }],
      priority: 1,
      get_tx_key: true,
    },
  });

  const res = await fetch(MONERO_WALLET_RPC_URL + '/json_rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`Wallet RPC error: ${JSON.stringify(data.error)}`);
  }

  return { txHash: data.result.tx_hash || 'unknown', sent: true };
}

// ─── Burn State Machine ─────────────────────────────────────────────────────

class BurnState {
  constructor(requestId, user, lpVault, wsxmrAmount, xmrAmount, claimCommitment) {
    this.requestId = requestId;
    this.user = user;
    this.lpVault = lpVault;
    this.wsxmrAmount = wsxmrAmount.toString();
    this.xmrAmount = xmrAmount.toString();
    this.claimCommitment = claimCommitment;
    this.createdAt = Date.now();
    this.state = 'requested'; // requested | proposed | committed | finalized | slashed | cancelled
    this.secret = null;
    this.secretHash = null;
    this.lpPublicSpendKey = null;
    this.lpPublicViewKey = null;
    this.proposeTxHash = null;
    this.finalizeTxHash = null;
    this.moneroTxHash = null;
    this.error = null;
  }
}

// ─── Core Operations ──────────────────────────────────────────────────────────

/**
 * Handle a BurnRequested event.
 * Generates secret, optionally sends XMR, calls proposeHash on-chain.
 */
async function handleBurnRequest(requestId, user, lpVault, wsxmrAmount, xmrAmount, claimCommitment) {
  const reqIdHex = ethers.utils.hexlify(requestId);

  if (lpVault.toLowerCase() !== wallet.address.toLowerCase()) {
    console.log(`[Burn] BurnRequested ${reqIdHex} — not our vault, ignoring`);
    return;
  }

  console.log(`[Burn] BurnRequested ${reqIdHex}`);
  console.log(`  User: ${user}`);
  console.log(`  wsxmrAmount: ${wsxmrAmount.toString()}`);
  console.log(`  xmrAmount: ${xmrAmount.toString()}`);

  if (pendingBurns.has(reqIdHex)) {
    console.log(`[Burn] Already tracking ${reqIdHex}`);
    return;
  }

  const burn = new BurnState(reqIdHex, user, lpVault, wsxmrAmount, xmrAmount, claimCommitment);
  pendingBurns.set(reqIdHex, burn);

  if (!AUTO_PROCESS_BURNS) {
    console.log(`[Burn] AUTO_PROCESS_BURNS is off — waiting for manual POST /burn/propose`);
    return;
  }

  try {
    await processPropose(reqIdHex);
  } catch (err) {
    console.error(`[Burn] Auto-propose failed for ${reqIdHex}:`, err.message);
    burn.error = err.message;
  }
}

/**
 * Execute proposeHash for a tracked burn request.
 */
async function processPropose(reqIdHex, customKeys = {}) {
  const burn = pendingBurns.get(reqIdHex);
  if (!burn) throw new Error(`Unknown burn request: ${reqIdHex}`);
  if (burn.state !== 'requested') throw new Error(`Burn ${reqIdHex} is not in 'requested' state`);

  const lpPublicSpendKey = normalizeHex32(customKeys.lpPublicSpendKey || DEFAULT_LP_PUBLIC_SPEND_KEY);
  const lpPublicViewKey = normalizeHex32(customKeys.lpPublicViewKey || DEFAULT_LP_PUBLIC_VIEW_KEY);

  if (!lpPublicSpendKey || !lpPublicViewKey) {
    throw new Error('LP public spend key and view key are required. Set BURN_LP_PUBLIC_SPEND_KEY / BURN_LP_PUBLIC_VIEW_KEY env vars or pass them in the request body.');
  }

  // Generate secret
  const secret = crypto.randomBytes(32);
  const { secretHash } = await computeSecretHash(secret);

  console.log(`[Burn] Generated secret for ${reqIdHex}`);
  console.log(`[Burn] secretHash: ${secretHash}`);

  burn.secret = bytesToHex(secret);
  burn.secretHash = secretHash;
  burn.lpPublicSpendKey = lpPublicSpendKey;
  burn.lpPublicViewKey = lpPublicViewKey;

  // Optionally send XMR (placeholder if wallet RPC unavailable)
  // In production the destination would come from the burn request details on-chain.
  // For now we rely on the LP to send XMR out-of-band or integrate wallet RPC.
  try {
    const xmrAmountAtomic = BigInt(burn.xmrAmount);
    // We don't have the user's destination address from the event alone;
    // the frontend / user provides it during requestBurn.  It is not emitted.
    // In production the LP node should query the hub for getBurnRequest(requestId)
    // which may contain the destination address if stored on-chain.
    const burnReq = await hubContract.getBurnRequest(reqIdHex);
    const destination = burnReq.destination || null;
    if (destination && MONERO_WALLET_RPC_URL) {
      const result = await sendXmr(destination, xmrAmountAtomic);
      burn.moneroTxHash = result.txHash;
      console.log(`[Burn] XMR send result: ${result.txHash}`);
    } else {
      console.log(`[Burn] Skipping XMR send — destination=${destination}, walletRPC=${!!MONERO_WALLET_RPC_URL}`);
    }
  } catch (xmrErr) {
    console.warn(`[Burn] XMR send failed (non-critical):`, xmrErr.message);
  }

  // Delay slightly to allow any off-chain XMR tx to settle before on-chain propose
  if (BURN_PROPOSE_DELAY_MS > 0) {
    console.log(`[Burn] Waiting ${BURN_PROPOSE_DELAY_MS}ms before proposeHash...`);
    await new Promise(r => setTimeout(r, BURN_PROPOSE_DELAY_MS));
  }

  // Call proposeHash on-chain
  console.log(`[Burn] Calling proposeHash(${reqIdHex}, ${secretHash}, ...)`);
  const tx = await hubContract.proposeHash(reqIdHex, secretHash, lpPublicSpendKey, lpPublicViewKey);
  console.log(`[Burn] proposeHash tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[Burn] proposeHash confirmed in block ${receipt.blockNumber}`);

  burn.state = 'proposed';
  burn.proposeTxHash = tx.hash;
}

/**
 * Handle BurnCommitted event (user called confirmMoneroLock).
 * Auto-finalize if enabled.
 */
async function handleBurnCommitted(requestId) {
  const reqIdHex = ethers.utils.hexlify(requestId);
  console.log(`[Burn] BurnCommitted ${reqIdHex}`);

  const burn = pendingBurns.get(reqIdHex);
  if (!burn) {
    console.log(`[Burn] No tracked burn for ${reqIdHex} (may have missed BurnRequested event)`);
    return;
  }

  burn.state = 'committed';

  if (!AUTO_PROCESS_BURNS) {
    console.log(`[Burn] AUTO_PROCESS_BURNS is off — waiting for manual POST /burn/finalize`);
    return;
  }

  try {
    await processFinalize(reqIdHex);
  } catch (err) {
    console.error(`[Burn] Auto-finalize failed for ${reqIdHex}:`, err.message);
    burn.error = err.message;
  }
}

/**
 * Execute finalizeBurn for a tracked burn.
 */
async function processFinalize(reqIdHex) {
  const burn = pendingBurns.get(reqIdHex);
  if (!burn) throw new Error(`Unknown burn request: ${reqIdHex}`);
  if (burn.state !== 'proposed' && burn.state !== 'committed') {
    throw new Error(`Burn ${reqIdHex} must be in 'proposed' or 'committed' state`);
  }
  if (!burn.secret) throw new Error(`Secret not available for ${reqIdHex}`);

  // Wait a grace period so the user has time to claim XMR on-chain
  if (BURN_FINALIZE_DELAY_MS > 0) {
    console.log(`[Burn] Waiting ${BURN_FINALIZE_DELAY_MS}ms before finalizeBurn...`);
    await new Promise(r => setTimeout(r, BURN_FINALIZE_DELAY_MS));
  }

  console.log(`[Burn] Calling finalizeBurn(${reqIdHex}, ...) secret: ${burn.secret.slice(0, 10)}...`);
  const tx = await hubContract.finalizeBurn(reqIdHex, burn.secret);
  console.log(`[Burn] finalizeBurn tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`[Burn] finalizeBurn confirmed in block ${receipt.blockNumber}`);

  burn.state = 'finalized';
  burn.finalizeTxHash = tx.hash;
}

/**
 * Handle BurnFinalized event.
 */
async function handleBurnFinalized(requestId, secret, rewardPaid) {
  const reqIdHex = ethers.utils.hexlify(requestId);
  console.log(`[Burn] BurnFinalized ${reqIdHex}`);
  console.log(`  Secret: ${secret.slice(0, 10)}...`);
  console.log(`  Reward: ${ethers.utils.formatEther(rewardPaid)} ETH`);

  const burn = pendingBurns.get(reqIdHex);
  if (burn) {
    burn.state = 'finalized';
    burn.finalizeTxHash = 'event'; // we saw it via event
  }
}

/**
 * Handle BurnCancelled or BurnAborted event.
 */
async function handleBurnCancelled(requestId) {
  const reqIdHex = ethers.utils.hexlify(requestId);
  console.log(`[Burn] BurnCancelled/Aborted ${reqIdHex}`);
  const burn = pendingBurns.get(reqIdHex);
  if (burn) burn.state = 'cancelled';
}

// ─── Event Listener Setup ───────────────────────────────────────────────────

function attachEventListeners(hub, _wallet, _provider) {
  hubContract = hub;
  wallet = _wallet;
  provider = _provider;

  // Extra ABI fragments the main server may not have included.
  // We create a new contract instance with the merged ABI so burn events decode properly.
  const burnAbi = [
    'event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral, bytes32 claimCommitment)',
    'event HashProposed(bytes32 indexed requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey)',
    'event BurnCommitted(bytes32 indexed requestId, uint256 deadline)',
    'event BurnFinalized(bytes32 indexed requestId, bytes32 secret, uint256 rewardPaid)',
    'event BurnCancelled(bytes32 indexed requestId)',
    'event BurnAborted(bytes32 indexed requestId)',
    'function proposeHash(bytes32 requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
    'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
    'function claimSlashedCollateral(bytes32 requestId) external',
    'function resolveDeclinedProposal(bytes32 requestId) external',
    'function getBurnRequest(bytes32 requestId) external view returns (tuple(address user, address lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 feeAmount, uint256 collateralLocked, uint256 rewardCollateral, bytes32 claimCommitment, bytes32 secretHash, uint256 timeout, uint256 commitDeadline, uint256 state))',
  ];

  const existingAbi = hub.interface.fragments.map(f => f.format(ethers.utils.FormatTypes.full));
  const mergedAbi = Array.from(new Set([...existingAbi, ...burnAbi]));
  hubContract = new ethers.Contract(hub.address, mergedAbi, wallet);

  hubContract.on('BurnRequested', (requestId, user, lpVault, wsxmrAmount, xmrAmount, rewardCollateral, claimCommitment, event) => {
    handleBurnRequest(requestId, user, lpVault, wsxmrAmount, xmrAmount, claimCommitment);
  });

  hubContract.on('BurnCommitted', (requestId, deadline, event) => {
    handleBurnCommitted(requestId);
  });

  hubContract.on('BurnFinalized', (requestId, secret, rewardPaid, event) => {
    handleBurnFinalized(requestId, secret, rewardPaid);
  });

  hubContract.on('BurnCancelled', (requestId, event) => {
    handleBurnCancelled(requestId);
  });

  hubContract.on('BurnAborted', (requestId, event) => {
    handleBurnCancelled(requestId);
  });

  console.log('[Burn] Event listeners attached for burn operations');
}

// ─── HTTP Routes ────────────────────────────────────────────────────────────

function registerRoutes(app) {
  // List tracked burns
  app.get('/burns', (_req, res) => {
    const list = Array.from(pendingBurns.values());
    res.json({ burns: list, count: list.length });
  });

  // Get single burn
  app.get('/burns/:requestId', (req, res) => {
    const burn = pendingBurns.get(req.params.requestId);
    if (!burn) return res.status(404).json({ error: 'Burn not found' });
    res.json(burn);
  });

  // Manually propose hash for a burn request
  app.post('/burn/propose', async (req, res) => {
    const { requestId, lpPublicSpendKey, lpPublicViewKey } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId required' });

    const reqIdHex = ethers.utils.hexlify(requestId);

    try {
      await processPropose(reqIdHex, { lpPublicSpendKey, lpPublicViewKey });
      res.json({
        success: true,
        requestId: reqIdHex,
        state: pendingBurns.get(reqIdHex).state,
        proposeTxHash: pendingBurns.get(reqIdHex).proposeTxHash,
      });
    } catch (err) {
      console.error(`[Burn] POST /burn/propose error:`, err);
      res.status(500).json({ error: err.message, requestId: reqIdHex });
    }
  });

  // Manually finalize a burn
  app.post('/burn/finalize', async (req, res) => {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId required' });

    const reqIdHex = ethers.utils.hexlify(requestId);

    try {
      await processFinalize(reqIdHex);
      res.json({
        success: true,
        requestId: reqIdHex,
        state: pendingBurns.get(reqIdHex).state,
        finalizeTxHash: pendingBurns.get(reqIdHex).finalizeTxHash,
      });
    } catch (err) {
      console.error(`[Burn] POST /burn/finalize error:`, err);
      res.status(500).json({ error: err.message, requestId: reqIdHex });
    }
  });

  // Claim slashed collateral (permissionless, if LP failed to reveal)
  app.post('/burn/slash', async (req, res) => {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId required' });

    const reqIdHex = ethers.utils.hexlify(requestId);

    try {
      console.log(`[Burn] Calling claimSlashedCollateral(${reqIdHex})`);
      const tx = await hubContract.claimSlashedCollateral(reqIdHex);
      console.log(`[Burn] claimSlashedCollateral tx: ${tx.hash}`);
      const receipt = await tx.wait();

      const burn = pendingBurns.get(reqIdHex);
      if (burn) burn.state = 'slashed';

      res.json({
        success: true,
        requestId: reqIdHex,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
      });
    } catch (err) {
      console.error(`[Burn] POST /burn/slash error:`, err);
      res.status(500).json({ error: err.message, requestId: reqIdHex });
    }
  });

  // Resolve a declined proposal (permissionless)
  app.post('/burn/resolve-declined', async (req, res) => {
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: 'requestId required' });

    const reqIdHex = ethers.utils.hexlify(requestId);

    try {
      console.log(`[Burn] Calling resolveDeclinedProposal(${reqIdHex})`);
      const tx = await hubContract.resolveDeclinedProposal(reqIdHex);
      console.log(`[Burn] resolveDeclinedProposal tx: ${tx.hash}`);
      const receipt = await tx.wait();

      res.json({
        success: true,
        requestId: reqIdHex,
        txHash: tx.hash,
        blockNumber: receipt.blockNumber,
      });
    } catch (err) {
      console.error(`[Burn] POST /burn/resolve-declined error:`, err);
      res.status(500).json({ error: err.message, requestId: reqIdHex });
    }
  });
}

// ─── Module Export ──────────────────────────────────────────────────────────

module.exports = {
  attachEventListeners,
  registerRoutes,
  pendingBurns,
};
