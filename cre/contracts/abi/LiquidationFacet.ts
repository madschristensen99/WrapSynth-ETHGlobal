import { parseAbi } from "viem"

/**
 * Minimal ABI for the wsXmrHub LiquidationFacet view surface the keeper reads,
 * plus the registry sink it writes to. The hub exposes the LiquidationFacet
 * selectors through its diamond fallback.
 */
export const liquidationFacetAbi = parseAbi([
  "function getLiquidatableVaults(uint256 startIndex, uint256 count) view returns (address[] vaults, uint256[] debts)",
  "function isVaultLiquidatable(address lpVault) view returns (bool)",
])

/**
 * The CRE report payload delivered to LiquidationAlertRegistry.onReport():
 * a single dynamic array of vault addresses. The registry re-validates each
 * one on-chain before emitting VaultFlaggedForLiquidation.
 */
export const VAULTS_REPORT_PARAMS = "address[] vaults" as const
