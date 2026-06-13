# WrapSynth LP Server

A simple JS server that acts as the LP for the WrapSynth protocol.

## What it does

### Mint flow
1. **Listens** to the `wsXmrHub` contract for `MintInitiated` events targeting this LP's vault.
2. **Accepts** LP Ed25519 public keys via `POST /mint/key`.
3. **Calls** `provideLPKey()` on-chain immediately.
4. **Waits** 30 seconds.
5. **Calls** `setMintReady()` on-chain (with the vault's configured bond).

### Burn flow
1. **Listens** to the `wsXmrHub` contract for `BurnRequested` events targeting this LP's vault.
2. **Generates** a secret and its on-chain hash.
3. **Calls** `proposeHash()` on-chain with the secret hash and LP Ed25519 public keys.
4. **Listens** for `BurnCommitted` (user confirmed Monero lock).
5. **Calls** `finalizeBurn()` on-chain, revealing the secret to reclaim collateral.

## Setup

```bash
cd lp-server
npm install
```

Create `.env`:

```env
PRIVATE_KEY=0x...
RPC_URL=https://sepolia.base.org
PORT=3001

# Optional: auto-process burns without manual HTTP calls
AUTO_PROCESS_BURNS=false

# Optional: default LP Ed25519 keys for burns (hex, 32 bytes)
BURN_LP_PUBLIC_SPEND_KEY=0x...
BURN_LP_PUBLIC_VIEW_KEY=0x...

# Optional: Monero wallet RPC for automatic XMR sends
MONERO_WALLET_RPC_URL=http://localhost:18082/json_rpc
```

## Run

```bash
npm start
```

## API

### Mint

- `GET /health` — Server status and wallet address.
- `GET /mints` — List tracked mint requests.
- `POST /mint/key` — Provide LP keys for a mint.
  ```json
  {
    "requestId": "0x...",
    "lpPublicSpendKey": "0x...",
    "lpPublicViewKey": "0x..."
  }
  ```

### Burn

- `GET /burns` — List tracked burn requests.
- `GET /burns/:requestId` — Get a single burn request.
- `POST /burn/propose` — Manually trigger `proposeHash` for a burn.
  ```json
  {
    "requestId": "0x...",
    "lpPublicSpendKey": "0x...",
    "lpPublicViewKey": "0x..."
  }
  ```
- `POST /burn/finalize` — Manually trigger `finalizeBurn` for a burn.
  ```json
  {
    "requestId": "0x..."
  }
  ```
- `POST /burn/slash` — Claim slashed collateral if LP failed to finalize.
  ```json
  {
    "requestId": "0x..."
  }
  ```
- `POST /burn/resolve-declined` — Resolve a declined proposal (permissionless).
  ```json
  {
    "requestId": "0x..."
  }
  ```
