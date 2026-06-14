import {
  CronCapability,
  EVMClient,
  Runner,
  getNetwork,
  encodeCallMsg,
  prepareReportRequest,
  bytesToHex,
  handler,
  LATEST_BLOCK_NUMBER,
  type Runtime,
} from "@chainlink/cre-sdk"
import {
  type Address,
  encodeFunctionData,
  decodeFunctionResult,
  encodeAbiParameters,
  parseAbiParameters,
  zeroAddress,
} from "viem"
import { liquidationFacetAbi, VAULTS_REPORT_PARAMS } from "../contracts/abi"

/**
 * WrapSynth Autonomous Liquidation Keeper (Chainlink CRE).
 *
 * Goal: keep every LP vault overcollateralized. LPs open vaults at ~150% CR;
 * if XMR appreciates and a vault's collateral ratio falls below the 120%
 * liquidation threshold, this workflow detects it with DON consensus and flags
 * it on-chain. Independent actors then either:
 *   - liquidate(vault, debt)  -> burn wsXMR for the LIQUIDATION_BONUS, or
 *   - backstopVault(oldVault) -> take the position over to restore the peg.
 *
 * The keeper never custodies funds and never executes the liquidation itself;
 * it only surfaces the opportunity trustlessly. The registry re-validates each
 * vault against the live hub before emitting an event, so a flag can never be
 * forged for a healthy vault.
 */
type Config = {
  /** Cron expression (5 or 6 fields). 6th optional field = seconds. */
  schedule: string
  /** Chain selector name, e.g. "ethereum-testnet-sepolia-base-1". */
  chainName: string
  /** wsXmrHub address (exposes LiquidationFacet view selectors via the diamond). */
  hubAddress: string
  /** LiquidationAlertRegistry address that receives the DON-signed flag report. */
  registryAddress: string
  /** First index into the hub's vaultList to scan. */
  scanStartIndex: number
  /** How many vaults to scan per run. */
  scanCount: number
  /** Gas limit for the on-chain flag write. */
  gasLimit: string
}

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const cfg = runtime.config
  runtime.log(`[keeper] scanning vault health on ${cfg.chainName} (hub ${cfg.hubAddress})`)

  const network = getNetwork({ chainFamily: "evm", chainSelectorName: cfg.chainName })
  if (!network) {
    throw new Error(`Unsupported chain selector name: ${cfg.chainName}`)
  }
  const evmClient = new EVMClient(network.chainSelector.selector)

  // --- 1. Read undercollateralized vaults from the hub (consensus read) ---
  const callData = encodeFunctionData({
    abi: liquidationFacetAbi,
    functionName: "getLiquidatableVaults",
    args: [BigInt(cfg.scanStartIndex), BigInt(cfg.scanCount)],
  })

  // Use latest, not finalized: on L2 testnets (e.g. Base Sepolia) the finalized
  // tag can lag hundreds of blocks behind head. A freshly deployed demo hub
  // won't exist at the finalized height yet → eth_call returns 0x and viem
  // errors "Cannot decode zero data". Liquidation detection needs current CR
  // anyway; the registry re-validates on-chain before emitting.
  const call = evmClient
    .callContract(runtime, {
      call: encodeCallMsg({
        from: zeroAddress,
        to: cfg.hubAddress as Address,
        data: callData,
      }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result()

  const decoded = decodeFunctionResult({
    abi: liquidationFacetAbi,
    functionName: "getLiquidatableVaults",
    data: bytesToHex(call.data),
  }) as readonly [readonly Address[], readonly bigint[]]

  // getLiquidatableVaults allocates fixed-length arrays and only fills the
  // first N "found" slots, leaving trailing entries as the zero address.
  const vaultsRaw = decoded[0]
  const vaults: Address[] = []
  for (let i = 0; i < vaultsRaw.length; i++) {
    const v = vaultsRaw[i]
    if (v && v !== zeroAddress) {
      vaults.push(v)
    }
  }

  if (vaults.length === 0) {
    runtime.log("[keeper] all scanned vaults are >= 120% CR — nothing to flag")
    return "healthy: 0 vaults flagged"
  }

  runtime.log(`[keeper] ${vaults.length} undercollateralized vault(s): ${vaults.join(", ")}`)

  // --- 2. Flag them on-chain via a DON-signed report ---
  // The report payload is abi.encode(address[]); the registry's onReport()
  // decodes it and re-checks isVaultLiquidatable() for every vault before
  // emitting VaultFlaggedForLiquidation, so this write is trust-minimized.
  const reportPayload = encodeAbiParameters(parseAbiParameters(VAULTS_REPORT_PARAMS), [vaults])
  const report = runtime.report(prepareReportRequest(reportPayload)).result()

  const writeResult = evmClient
    .writeReport(runtime, {
      receiver: cfg.registryAddress as Address,
      report,
      gasConfig: { gasLimit: cfg.gasLimit },
    })
    .result()

  const txHash = bytesToHex(writeResult.txHash || new Uint8Array(32))
  runtime.log(`[keeper] flagged ${vaults.length} vault(s) — tx ${txHash} (${writeResult.txStatus})`)

  return `flagged ${vaults.length} vault(s): tx ${txHash}`
}

const initWorkflow = (config: Config) => {
  const cron = new CronCapability()
  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)]
}

export async function main() {
  const runner = await Runner.newRunner<Config>()
  await runner.run(initWorkflow)
}
