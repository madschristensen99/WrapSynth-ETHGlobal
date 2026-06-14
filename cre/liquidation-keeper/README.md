# liquidation-keeper

Cron-triggered CRE workflow. Reads `getLiquidatableVaults` from the WrapSynth hub
with DON consensus and flags sub-120% CR vaults on-chain via a signed report to
`LiquidationAlertRegistry`.

See [`../README.md`](../README.md) for full architecture, setup, and the
end-to-end demo.

## Quick start

```bash
npm install                  # installs cre-sdk + viem (postinstall: bunx cre-setup)

# from the cre/ project root:
cre workflow simulate liquidation-keeper --env .env --broadcast
```

Edit `config.staging.json` first:

- `hubAddress` — wsXmrHub (live or demo hub)
- `registryAddress` — deployed LiquidationAlertRegistry

## Entry point

`main.ts`:

1. `onCronTrigger` reads `getLiquidatableVaults(scanStartIndex, scanCount)`.
2. Filters zero-address padding from the fixed-length return arrays.
3. If any vaults are undercollateralized, builds `abi.encode(address[])`, signs it
   via `runtime.report(...)`, and `writeReport`s it to the registry's `onReport`.
