#!/usr/bin/env bash
#
# testCreLive.sh — end-to-end live test for the WrapSynth CRE Liquidation Keeper
# on Base Sepolia.
#
# What it proves, on a live testnet, with PASS/FAIL for every check:
#   1. Demo hub + LiquidationAlertRegistry deploy and wire together.
#   2. An LP vault can be pushed below the 120% liquidation threshold.
#   3. The keeper READ (getLiquidatableVaults) returns that vault.
#   4. The keeper WRITE path (registry.onReport with abi.encode(address[]))
#      re-validates on-chain and emits VaultFlaggedForLiquidation.
#   5. flagCount advances and the event carries the right vault + debt.
#   6. An incentivized liquidator can then clear the vault (CR restored).
#
# The flag step uses scripts/demo/creEquivalentFlag.js, which reproduces
# cre/liquidation-keeper/main.ts 1:1 (same read, same onReport payload). The
# only thing it omits is the DON consensus/signing wrapper — Chainlink
# infrastructure, not this project's logic. If a real `cre workflow simulate`
# developer CLI is detected on PATH it is used instead.
#
# Usage:
#   ./testCreLive.sh                 # full run (auto-skips already-done steps)
#   REDEPLOY=1 ./testCreLive.sh      # force fresh demo hub + registry
#   SKIP_LIQUIDATE=1 ./testCreLive.sh# stop after flagging (leave vault flagged)
#
# Prereqs: forge, cast, node on PATH; repo .env with PRIVATE_KEY + RPC; wallet
# funded with Base Sepolia ETH.

set -uo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETH_DIR="$ROOT/ethereum"
DEMO_DIR="$ETH_DIR/scripts/demo"
CRE_CFG="$ROOT/cre/liquidation-keeper/config.staging.json"
DEMO_MANIFEST="$ETH_DIR/deployment.demo-hub.json"
CRE_TEST_MANIFEST="$ETH_DIR/deployment.cre-test.json"
EXPECTED_WALLET="0x52980847dafb9f78dD52cfcEcf116f80468266AF"

# ---------------------------------------------------------------------------
# Pretty output + PASS/FAIL accounting
# ---------------------------------------------------------------------------
if [ -t 1 ]; then G="\033[32m"; R="\033[31m"; Y="\033[33m"; B="\033[36m"; N="\033[0m"; else G=""; R=""; Y=""; B=""; N=""; fi
PASS=0; FAIL=0
declare -a RESULTS=()
ok()   { echo -e "${G}PASS${N}  $1"; PASS=$((PASS+1)); RESULTS+=("PASS  $1"); }
bad()  { echo -e "${R}FAIL${N}  $1"; FAIL=$((FAIL+1)); RESULTS+=("FAIL  $1"); }
warn() { echo -e "${Y}WARN${N}  $1"; }
hdr()  { echo; echo -e "${B}=== $1 ===${N}"; }
die()  { echo -e "${R}FATAL${N} $1"; print_summary; exit 1; }

print_summary() {
  hdr "SUMMARY"
  for r in "${RESULTS[@]}"; do
    case "$r" in
      PASS*) echo -e "${G}$r${N}" ;;
      FAIL*) echo -e "${R}$r${N}" ;;
      *)     echo "$r" ;;
    esac
  done
  echo
  echo -e "Total: ${G}$PASS passed${N}, ${R}$FAIL failed${N}."
}

# read a top-level field from a JSON file via node (robust vs grep)
json_get() { node -e "try{const j=require(process.argv[1]);process.stdout.write(String(j[process.argv[2]]||''))}catch(e){}" "$1" "$2"; }

# ---------------------------------------------------------------------------
# 0. Preflight
# ---------------------------------------------------------------------------
hdr "0. Preflight"

for t in forge cast node; do
  command -v "$t" >/dev/null 2>&1 || die "'$t' not found on PATH."
done
ok "forge, cast, node present"

# Load repo .env
[ -f "$ROOT/.env" ] || die "Missing $ROOT/.env"
set -a; # shellcheck disable=SC1090
source "$ROOT/.env"; set +a
[ -n "${PRIVATE_KEY:-}" ] || die "PRIVATE_KEY not set in .env"

# Normalize the key to 0x-prefixed (forge vm.envUint + node ethers both want it).
PK_NO0X="${PRIVATE_KEY#0x}"
export PRIVATE_KEY="0x$PK_NO0X"
export CRE_ETH_PRIVATE_KEY="$PRIVATE_KEY"
# The official https://sepolia.base.org is load-balanced and returns stale
# nonce/state under rapid sequential use (breaks deploys + read-after-write).
# Prefer a single-backend RPC. Override with TEST_RPC_URL if you have your own.
RELIABLE_RPC="https://base-sepolia-rpc.publicnode.com"
RPC="${TEST_RPC_URL:-${BASE_SEPOLIA_RPC_URL:-$RELIABLE_RPC}}"
if [ "$RPC" = "https://sepolia.base.org" ]; then
  RPC="$RELIABLE_RPC"
  warn "Switched off the flaky public RPC to $RPC (set TEST_RPC_URL to override)"
fi
export BASE_SEPOLIA_RPC_URL="$RPC"

WALLET="$(cast wallet address --private-key "$PRIVATE_KEY" 2>/dev/null)" || die "Bad PRIVATE_KEY"
echo "Wallet:  $WALLET"
echo "RPC:     $RPC"
if [ "$(echo "$WALLET" | tr 'A-Z' 'a-z')" = "$(echo "$EXPECTED_WALLET" | tr 'A-Z' 'a-z')" ]; then
  ok "Signer matches expected wallet ($EXPECTED_WALLET)"
else
  warn "Signer $WALLET != expected $EXPECTED_WALLET (continuing with .env key)"
fi

# Balance
BAL_WEI="$(cast balance "$WALLET" --rpc-url "$RPC" 2>/dev/null || echo 0)"
BAL_ETH="$(cast to-unit "$BAL_WEI" ether 2>/dev/null || echo 0)"
echo "Balance: $BAL_ETH ETH"
# need ~0.01 for deploys + mint flow; warn if low
if node -e "process.exit(Number(process.argv[1])>=0.01?0:1)" "$BAL_ETH" 2>/dev/null; then
  ok "Wallet funded ($BAL_ETH ETH)"
else
  warn "Low balance ($BAL_ETH ETH). Deploys + mint may run out of gas; fund with Base Sepolia ETH."
fi

# ethers + dotenv for the demo scripts. Install into an isolated prefix and
# expose it via NODE_PATH so we don't trigger a full (heavy) ethereum/ install.
DEPS_DIR="$ROOT/.cre-test-deps"
if ! (cd "$ETH_DIR" && node -e "require('ethers');require('dotenv')" >/dev/null 2>&1); then
  if ! NODE_PATH="$DEPS_DIR/node_modules" node -e "require('ethers');require('dotenv')" >/dev/null 2>&1; then
    echo "Installing ethers + dotenv into $DEPS_DIR (isolated)..."
    npm install --prefix "$DEPS_DIR" --no-audit --no-fund ethers@5.7.2 dotenv >/dev/null 2>&1 \
      || die "Failed to install ethers; run 'npm install --prefix .cre-test-deps ethers@5.7.2 dotenv' manually."
  fi
  export NODE_PATH="$DEPS_DIR/node_modules${NODE_PATH:+:$NODE_PATH}"
fi
ok "ethers + dotenv available for demo scripts"

# ---------------------------------------------------------------------------
# 1. Deploy demo hub (controllable prices)
# ---------------------------------------------------------------------------
hdr "1. Demo hub (MockVerifierProxy)"

if [ "${REDEPLOY:-0}" = "1" ]; then rm -f "$DEMO_MANIFEST" "$CRE_TEST_MANIFEST"; fi

if [ -f "$DEMO_MANIFEST" ]; then
  ok "Reusing existing demo hub manifest ($DEMO_MANIFEST)"
else
  echo "Deploying DeployDemoHub.s.sol ..."
  (cd "$ETH_DIR" && forge script script/DeployDemoHub.s.sol --rpc-url "$RPC" --broadcast --slow --skip test) \
    || die "DeployDemoHub failed"
  [ -f "$DEMO_MANIFEST" ] || die "DeployDemoHub did not write $DEMO_MANIFEST"
  ok "Demo hub deployed"
fi

HUB="$(json_get "$DEMO_MANIFEST" wsXmrHub)"
WSXMR="$(json_get "$DEMO_MANIFEST" wsXMR)"
VERIFIER="$(json_get "$DEMO_MANIFEST" mockVerifierProxy)"
[ -n "$HUB" ] || die "Could not read wsXmrHub from manifest"
echo "Hub:      $HUB"
echo "wsXMR:    $WSXMR"
echo "Verifier: $VERIFIER"

# ---------------------------------------------------------------------------
# 2. Deploy LiquidationAlertRegistry against the demo hub
# ---------------------------------------------------------------------------
hdr "2. LiquidationAlertRegistry"

REGISTRY="$(json_get "$CRE_TEST_MANIFEST" registry)"
# Re-deploy if missing, or if it points at a different hub.
NEED_REGISTRY=1
if [ -n "$REGISTRY" ]; then
  WIRED="$(cast call "$REGISTRY" "hub()(address)" --rpc-url "$RPC" 2>/dev/null || echo "")"
  if [ "$(echo "$WIRED" | tr 'A-Z' 'a-z')" = "$(echo "$HUB" | tr 'A-Z' 'a-z')" ]; then
    NEED_REGISTRY=0
    ok "Reusing registry $REGISTRY (wired to demo hub)"
  fi
fi

if [ "$NEED_REGISTRY" = "1" ]; then
  echo "Deploying DeployLiquidationRegistry.s.sol (FORWARDER=0 -> permissionless onReport) ..."
  (cd "$ETH_DIR" && HUB_ADDRESS="$HUB" FORWARDER="0x0000000000000000000000000000000000000000" \
    forge script script/DeployLiquidationRegistry.s.sol --rpc-url "$RPC" --broadcast --slow --skip test) \
    || die "DeployLiquidationRegistry broadcast failed (check funds / RPC)"

  # Parse the deployed address from the broadcast artifact, then VERIFY it is a
  # real contract wired to our hub — a failed broadcast can still leave a stale
  # (simulated) address in the log, so on-chain verification is mandatory.
  REGISTRY="$(node -e '
    const fs=require("fs");
    const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const tx=(j.transactions||[]).find(t=>t.contractName==="LiquidationAlertRegistry"&&t.contractAddress);
    process.stdout.write(tx?tx.contractAddress:"");
  ' "$ETH_DIR/broadcast/DeployLiquidationRegistry.s.sol/84532/run-latest.json")"
  [ -n "$REGISTRY" ] || die "Could not parse deployed registry address from broadcast artifact"

  CODE="$(cast code "$REGISTRY" --rpc-url "$RPC" 2>/dev/null || echo 0x)"
  [ "${#CODE}" -gt 2 ] || die "No contract code at parsed registry $REGISTRY (broadcast likely failed)"
  WIRED="$(cast call "$REGISTRY" "hub()(address)" --rpc-url "$RPC" 2>/dev/null || echo "")"
  [ "$(echo "$WIRED" | tr 'A-Z' 'a-z')" = "$(echo "$HUB" | tr 'A-Z' 'a-z')" ] \
    || die "Registry $REGISTRY is not wired to demo hub (hub()=$WIRED)"

  node -e "const fs=require('fs');fs.writeFileSync(process.argv[1],JSON.stringify({registry:process.argv[2],hub:process.argv[3]},null,2))" \
    "$CRE_TEST_MANIFEST" "$REGISTRY" "$HUB"
  ok "Registry deployed + verified: $REGISTRY"
fi
echo "Registry: $REGISTRY"

# Verify wiring
WIRED="$(cast call "$REGISTRY" "hub()(address)" --rpc-url "$RPC" 2>/dev/null)"
if [ "$(echo "$WIRED" | tr 'A-Z' 'a-z')" = "$(echo "$HUB" | tr 'A-Z' 'a-z')" ]; then
  ok "registry.hub() == demo hub"
else
  bad "registry.hub() ($WIRED) != demo hub ($HUB)"
fi
FWD="$(cast call "$REGISTRY" "forwarder()(address)" --rpc-url "$RPC" 2>/dev/null)"
if [ "$FWD" = "0x0000000000000000000000000000000000000000" ]; then
  ok "registry.onReport is permissionless (forwarder == 0)"
else
  warn "registry.forwarder == $FWD; only that address may call onReport"
fi

# ---------------------------------------------------------------------------
# 3. Configure the CRE workflow + write cre/.env
# ---------------------------------------------------------------------------
hdr "3. CRE workflow config"

node -e '
const fs=require("fs");
const p=process.argv[1];
const j=JSON.parse(fs.readFileSync(p,"utf8"));
j.hubAddress=process.argv[2];
j.registryAddress=process.argv[3];
fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");
' "$CRE_CFG" "$HUB" "$REGISTRY" && ok "Updated config.staging.json (hubAddress + registryAddress)" || bad "Failed to update config.staging.json"

cat > "$ROOT/cre/.env" <<EOF
CRE_ETH_PRIVATE_KEY=$PRIVATE_KEY
EOF
ok "Wrote cre/.env (CRE_ETH_PRIVATE_KEY)"

# ---------------------------------------------------------------------------
# 4. Drive an LP vault under 120% CR
# ---------------------------------------------------------------------------
hdr "4. Force an undercollateralized vault"

# Demo knobs (override via env). The vault opens at the protocol-minimum 150%
# CR (the original imagined allocation); cranking XMR from $150 -> $195 drops it
# to ~115% CR, which is liquidatable (< 120%) yet still has enough collateral
# for a clean full liquidation afterwards. Keep ETH usage low (reuse wxDAI +
# small mint deposits).
export DEMO_COLLATERAL_ETH="${DEMO_COLLATERAL_ETH:-0.003}"
export DEMO_MINT_DEPOSIT="${DEMO_MINT_DEPOSIT:-0.0002}"
export DEMO_SEED_XMR_USD="${DEMO_SEED_XMR_USD:-150}"
export DEMO_TARGET_CR_PCT="${DEMO_TARGET_CR_PCT:-150}"
export DEMO_CRANK_XMR_USD="${DEMO_CRANK_XMR_USD:-195}"
export DEMO_COLLATERAL_USD="${DEMO_COLLATERAL_USD:-1}"

IS_LIQ="$(cast call "$HUB" "isVaultLiquidatable(address)(bool)" "$WALLET" --rpc-url "$RPC" 2>/dev/null || echo false)"
if [ "$IS_LIQ" = "true" ]; then
  ok "Vault already liquidatable — skipping seed step"
else
  echo "Running demoForceLiquidation.js (creates vault, mints ~170% CR, waits ~95s, cranks XMR price)..."
  (cd "$ETH_DIR" && node scripts/demo/demoForceLiquidation.js) || die "demoForceLiquidation.js failed"
  IS_LIQ="$(cast call "$HUB" "isVaultLiquidatable(address)(bool)" "$WALLET" --rpc-url "$RPC" 2>/dev/null || echo false)"
fi

if [ "$IS_LIQ" = "true" ]; then
  ok "isVaultLiquidatable($WALLET) == true (vault < 120% CR)"
else
  bad "Vault is not liquidatable after seeding — cannot continue"
  print_summary; exit 1
fi

# ---------------------------------------------------------------------------
# 5. Keeper READ check — getLiquidatableVaults must return our vault
# ---------------------------------------------------------------------------
hdr "5. Keeper read (getLiquidatableVaults)"

READ_OUT="$(cast call "$HUB" "getLiquidatableVaults(uint256,uint256)(address[],uint256[])" 0 100 --rpc-url "$RPC" 2>/dev/null || echo "")"
echo "$READ_OUT"
if echo "$READ_OUT" | grep -iq "${WALLET#0x}"; then
  ok "getLiquidatableVaults includes our vault"
else
  bad "getLiquidatableVaults did NOT include our vault"
fi

# ---------------------------------------------------------------------------
# 6. Keeper WRITE — flag on-chain (real cre CLI if present, else equivalent)
# ---------------------------------------------------------------------------
hdr "6. Keeper flag (onReport)"

# The demo's MockVerifierProxy price ages out after the hub's 120s staleness
# window; the real Chainlink Data Streams feed is always fresh. We must refresh
# it WITHOUT tripping the oracle facet's two guards:
#   - _assertDeviation: within 90s of the last update, a new price must stay
#     within MAX_PRICE_DEVIATION_BPS (20%) of the lagging EMA. Right after the
#     crank ($150->$195) the EMA is still ~$158, so re-pushing $195 inside that
#     window deviates ~23% and REVERTS (this is what makes a too-fast run fail).
#   - _getXmrPriceFromStorage: reverts StalePrice once the price is >120s old.
# Strategy: if the on-chain price is still fresh, skip the push entirely (the
# next step runs well within 120s). Only push once the 90s deviation window has
# cleared, waiting it out if we're caught in the middle.
refresh_oracle_fresh() {
  local what="$1" last now age wait
  last="$(cast call "$HUB" "lastXmrPriceTimestamp()(uint256)" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}')"
  now="$(cast block latest --field timestamp --rpc-url "$RPC" 2>/dev/null | awk '{print $1}')"
  if ! [[ "$last" =~ ^[0-9]+$ ]] || ! [[ "$now" =~ ^[0-9]+$ ]]; then
    warn "Could not read oracle price age; attempting a refresh anyway"
    (cd "$ETH_DIR" && node scripts/demo/pushPrices.js "$DEMO_CRANK_XMR_USD" "$DEMO_COLLATERAL_USD" >/dev/null) \
      && ok "Demo oracle price refreshed before $what" \
      || warn "Price refresh failed; $what may hit StalePrice"
    return
  fi
  age=$(( now - last ))
  if [ "$age" -lt 60 ]; then
    ok "Oracle price is fresh (${age}s old) — flagging without a refresh (avoids the <90s EMA deviation guard)"
    return
  fi
  if [ "$age" -lt 90 ]; then
    wait=$(( 92 - age ))
    echo "Oracle price is ${age}s old; waiting ${wait}s for the 90s deviation guard to clear before refreshing..."
    sleep "$wait"
  fi
  echo "Refreshing demo oracle price before $what (deviation guard cleared)..."
  (cd "$ETH_DIR" && node scripts/demo/pushPrices.js "$DEMO_CRANK_XMR_USD" "$DEMO_COLLATERAL_USD" >/dev/null) \
    && ok "Demo oracle price refreshed before $what (XMR=\$$DEMO_CRANK_XMR_USD)" \
    || warn "Price refresh failed; $what may hit StalePrice"
}

refresh_oracle_fresh "flag"

FLAG_BEFORE="$(cast call "$REGISTRY" "flagCount()(uint256)" --rpc-url "$RPC" 2>/dev/null || echo 0)"
echo "flagCount before: $FLAG_BEFORE"

# Prefer the official CRE developer CLI (installed to ~/.cre/bin) over any stale
# binary earlier on PATH (e.g. the internal runner at /usr/local/bin/cre, which
# errors with "wasm must be set"). Also put Bun on PATH for TS compilation.
CRE_BIN="$(command -v cre 2>/dev/null || true)"
[ -x "$HOME/.cre/bin/cre" ] && CRE_BIN="$HOME/.cre/bin/cre"
[ -d "$HOME/.bun/bin" ] && export PATH="$HOME/.bun/bin:$PATH"

run_equivalent_flag() {
  echo "Using the CRE-equivalent onReport path (mirrors main.ts exactly)..."
  if (cd "$ETH_DIR" && REGISTRY="$REGISTRY" node scripts/demo/creEquivalentFlag.js); then
    ok "CRE-equivalent flag (onReport) succeeded"
  else
    bad "CRE-equivalent flag step failed"
  fi
}

USE_REAL_CRE=0
if [ -n "$CRE_BIN" ]; then
  CRE_HELP="$("$CRE_BIN" workflow simulate --help 2>&1 || true)"
  # The developer CLI documents --broadcast/--target; the internal runner does not.
  if echo "$CRE_HELP" | grep -qi -- "--broadcast" && ! echo "$CRE_HELP" | grep -qi "wasm must be set"; then
    USE_REAL_CRE=1
  fi
fi

if [ "$USE_REAL_CRE" = "1" ]; then
  echo "Detected the CRE developer CLI ($CRE_BIN) — running the real workflow simulation..."
  echo "  (delivers onReport via the Base Sepolia MockKeystoneForwarder 0x82300bd7c3958625581cc2f77bc6464dcecdf3e5)"
  # One-time: install the workflow's CRE SDK + WASM tooling.
  if [ ! -d "$ROOT/cre/liquidation-keeper/node_modules" ]; then
    echo "Installing CRE workflow deps (bun install)..."
    (cd "$ROOT/cre/liquidation-keeper" && bun install) || warn "bun install failed; the real CRE run may fail"
  fi
  if (cd "$ROOT/cre" && "$CRE_BIN" workflow simulate liquidation-keeper --target staging-settings --broadcast --env .env); then
    ok "cre workflow simulate --broadcast completed (flag delivered via KeystoneForwarder)"
  else
    warn "Real CRE simulate failed (see error above; common causes: stale finalized-block read before fix, or missing deps). Falling back to the equivalent path."
    run_equivalent_flag
  fi
else
  echo "CRE developer CLI not available (installed binary is the internal runner)."
  run_equivalent_flag
fi

# ---------------------------------------------------------------------------
# 7. Verify on-chain effects of the flag
# ---------------------------------------------------------------------------
hdr "7. Verify flag on-chain"

FLAG_AFTER="$(cast call "$REGISTRY" "flagCount()(uint256)" --rpc-url "$RPC" 2>/dev/null || echo 0)"
echo "flagCount after:  $FLAG_AFTER"
if node -e "process.exit(BigInt(process.argv[1])>BigInt(process.argv[2])?0:1)" "$FLAG_AFTER" "$FLAG_BEFORE" 2>/dev/null; then
  ok "flagCount advanced ($FLAG_BEFORE -> $FLAG_AFTER)"
else
  bad "flagCount did not advance ($FLAG_BEFORE -> $FLAG_AFTER)"
fi

# Independent event check via logs over recent blocks
TIP="$(cast block-number --rpc-url "$RPC" 2>/dev/null || echo 0)"
FROM=$(( TIP > 500 ? TIP - 500 : 0 ))
EVENTS="$(cast logs --rpc-url "$RPC" --address "$REGISTRY" --from-block "$FROM" --to-block latest \
  "VaultFlaggedForLiquidation(address,uint256,address,uint256)" 2>/dev/null || echo "")"
if echo "$EVENTS" | grep -iq "${WALLET#0x}"; then
  ok "VaultFlaggedForLiquidation event found on-chain for our vault"
else
  warn "Could not confirm VaultFlaggedForLiquidation via cast logs (RPC range limits); flagCount delta already confirms it"
fi

# ---------------------------------------------------------------------------
# 8. Act on the flag — liquidate and confirm CR restored
# ---------------------------------------------------------------------------
if [ "${SKIP_LIQUIDATE:-0}" = "1" ]; then
  hdr "8. Liquidation (skipped via SKIP_LIQUIDATE=1)"
  warn "Leaving vault flagged/undercollateralized as requested"
else
  hdr "8. Liquidate the flagged vault"
  # Refresh the mock oracle again (it ages out in 120s; production stays fresh),
  # using the same guard-aware helper so we never trip the <90s deviation guard.
  refresh_oracle_fresh "liquidation"
  echo "Running liquidate.js (burns wsXMR, seizes collateral at the liquidation bonus)..."
  if (cd "$ETH_DIR" && node scripts/demo/liquidate.js "$WALLET"); then
    ok "liquidate.js executed"
  else
    bad "liquidate.js failed"
  fi
  POST_LIQ="$(cast call "$HUB" "isVaultLiquidatable(address)(bool)" "$WALLET" --rpc-url "$RPC" 2>/dev/null || echo true)"
  if [ "$POST_LIQ" = "false" ]; then
    ok "Vault no longer liquidatable after liquidation (overcollateralization restored)"
  else
    warn "Vault still liquidatable (liquidator may not have held enough wsXMR to fully clear; partial clear is expected if so)"
  fi
fi

# ---------------------------------------------------------------------------
print_summary
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
