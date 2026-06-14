# WrapSynth Autonomous Liquidation Keeper (Chainlink CRE)

A [Chainlink Runtime Environment (CRE)](https://docs.chain.link/cre) workflow that
keeps every WrapSynth LP vault **overcollateralized**, with no custodial keeper
and no trusted bot.

LPs open vaults at ~150% collateral ratio (CR). If XMR appreciates and a vault's
CR falls below the **120% liquidation threshold**, this workflow detects it with
**DON consensus** and flags it on-chain. Independent actors then either:

- **`liquidate(vault, debt)`** — burn wsXMR to clear the debt and seize collateral
  at a 10% bonus (`LIQUIDATION_BONUS = 110`), or
- **`backstopVault(oldVault)`** — a different LP assumes the vault's debt +
  collateral in one shot to restore the peg.

The keeper never custodies funds and never executes the liquidation itself; it
only surfaces the opportunity trustlessly.

```
            ┌──────────── Chainlink DON (consensus) ────────────┐
 cron  ───► │ read getLiquidatableVaults(hub)  ─► encode addr[] │ ─► signed report
            │            (EVM read capability)                  │
            └───────────────────────────────────────────────────┘
                                   │ writeReport (EVM write)
                                   ▼
                    LiquidationAlertRegistry.onReport()
                    └─ re-checks isVaultLiquidatable() on-chain
                       emits VaultFlaggedForLiquidation(vault, debt, …)
                                   │
                 ┌─────────────────┴─────────────────┐
                 ▼                                     ▼
       liquidator: hub.liquidate()        new LP: hub.backstopVault()
```

## Why this is trust-minimized

The registry **re-validates every vault against the live hub** (`isVaultLiquidatable`)
inside `onReport`/`flagVault` before emitting an event. A flag can therefore never
be forged for a healthy vault — regardless of which DON, forwarder, or EOA submitted
it. That's why the `onReport` forwarder lock is optional for correctness.

## Layout

```
cre/
├── project.yaml                    # RPC endpoints per target (Base Sepolia)
├── secrets.yaml                    # none required (read + write only)
├── .env.example                    # CRE_ETH_PRIVATE_KEY for local simulation
├── contracts/abi/                  # viem ABIs (hub view surface + report params)
│   ├── LiquidationFacet.ts
│   └── index.ts
└── liquidation-keeper/
    ├── main.ts                     # cron → read liquidatable vaults → flag on-chain
    ├── config.staging.json         # hub + registry addresses, schedule, scan range
    ├── config.production.json
    ├── workflow.yaml
    ├── package.json
    └── tsconfig.json
```

The on-chain sink is `ethereum/contracts/keeper/LiquidationAlertRegistry.sol`,
deployed via `ethereum/script/DeployLiquidationRegistry.s.sol`.

## Prerequisites

- [Chainlink CRE CLI](https://docs.chain.link/cre/getting-started/cli-installation)
- [Bun](https://bun.com/docs/installation) (CRE post-install / WASM build)
- Node.js 18+
- A funded Base Sepolia key (for `--broadcast` during simulation; in production the
  DON signs writes)

## Setup

```bash
cd cre/liquidation-keeper
npm install            # runs `bunx cre-setup` via postinstall
cp ../.env.example ../.env   # set CRE_ETH_PRIVATE_KEY
```

1. Deploy the registry and copy its address into both `config.*.json`:

   ```bash
   cd ../../ethereum
   export PRIVATE_KEY=0x...
   forge script script/DeployLiquidationRegistry.s.sol \
     --rpc-url https://sepolia.base.org --broadcast
   ```

   Set `registryAddress` (and, for the demo, point `hubAddress` at the demo hub —
   see below).

## Run (local simulation)

From the `cre/` project root:

```bash
cre workflow simulate liquidation-keeper --env .env --broadcast
```

Select the **Cron trigger**. The workflow will:

1. Read `getLiquidatableVaults(startIndex, count)` from the hub (consensus read).
2. Drop zero-address padding and, if any vaults are undercollateralized, generate a
   DON-signed report `abi.encode(address[] vaults)`.
3. Submit it to `LiquidationAlertRegistry.onReport()`, which emits
   `VaultFlaggedForLiquidation` for each vault it re-confirms is liquidatable.

Omit `--broadcast` to dry-run without sending the on-chain write.

## End-to-end demo (controllable prices)

The live hub uses real Chainlink Data Streams prices, so we can't force a vault
underwater. Use the **demo hub** (`MockVerifierProxy`) instead:

```bash
cd ethereum
export PRIVATE_KEY=0x...

# 1. Deploy a demo hub with controllable prices (writes deployment.demo-hub.json)
forge script script/DeployDemoHub.s.sol --rpc-url https://sepolia.base.org --broadcast

# 2. Open a vault, mint ~170% CR, then crank XMR 2x to push CR < 120%
node scripts/demo/demoForceLiquidation.js
```

Point `cre/liquidation-keeper/config.staging.json` → `hubAddress` at the demo hub
(printed by the deploy / stored in `ethereum/deployment.demo-hub.json`), then run
the keeper simulation above to flag the vault. Finally:

```bash
# liquidate (burn wsXMR for the bonus)        — or —   backstop (new LP takes over)
node scripts/demo/liquidate.js
BACKSTOP_PRIVATE_KEY=0x... node scripts/demo/backstopVault.js
```

## Config reference (`config.*.json`)

| Field | Meaning |
|---|---|
| `schedule` | Cron expression (6th field = seconds). Staging: every 30s. |
| `chainName` | `ethereum-testnet-sepolia-base-1` (Base Sepolia chain selector). |
| `hubAddress` | wsXmrHub exposing the LiquidationFacet view selectors. |
| `registryAddress` | Deployed `LiquidationAlertRegistry`. |
| `scanStartIndex` / `scanCount` | Window into the hub's `vaultList` to scan per run. |
| `gasLimit` | Gas limit for the on-chain flag write. |

## Notes

- **No secrets required.** The keeper only reads + writes on-chain. The EVM write is
  signed by the DON in production; `CRE_ETH_PRIVATE_KEY` is used only for local
  `--broadcast` simulation.
- To lock the registry's `onReport` to the real forwarder after deploying the
  workflow, call `registry.setForwarder(<forwarder>)`
  ([Base Sepolia forwarder directory](https://docs.chain.link/cre/guides/workflow/using-evm-client/supported-networks-ts)).
