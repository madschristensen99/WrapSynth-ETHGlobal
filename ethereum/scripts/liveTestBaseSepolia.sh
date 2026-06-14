#!/bin/bash
# ============================================================================
# WrapSynth — Base Sepolia live oracle test (Chainlink Data Streams)
# ============================================================================
# End-to-end test of the deployed protocol on Base Sepolia:
#   1. Preflight  : tooling, key, ETH balance, hub is deployed
#   2. LINK       : ensure the hub holds LINK to pay verification fees
#   3. Reports    : fetch live signed XMR/USD + ETH/USD fullReport blobs
#   4. Push       : call updateOraclePrices([XMR, ETH]) on the hub
#   5. Verify     : read prices back and check they are fresh, non-zero,
#                   and within sane USD ranges
#
# Usage:
#   export PRIVATE_KEY=0x<deployer key for 0x52980847...>
#   ./scripts/liveTestBaseSepolia.sh
#
# All config below can be overridden via environment variables, e.g.:
#   HUB=0x... RPC=https://... ./scripts/liveTestBaseSepolia.sh
# ============================================================================

set -uo pipefail

# ---------------------------------------------------------------------------
# Config (override via env)
# ---------------------------------------------------------------------------
HUB="${HUB:-0x0454983E17b803a2C6ff0d98d5D58676525F4A92}"
LINK="${LINK:-0xE4aB69C077896252FAFBD49EFD26B5D171A32410}"
RPC="${RPC:-https://sepolia.base.org}"
XMR_FEED="${XMR_FEED:-0x0003c70558bd921b1559d37b8e347797f121d1240e7386e68b2bee9b731b0833}"
ETH_FEED="${ETH_FEED:-0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782}"

# report-proxy dir (holds fetchReportHex.js, reads CHAINLINK creds from repo-root .env)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY_DIR="${PROXY_DIR:-$SCRIPT_DIR/../../frontend/report-proxy}"

# LINK handling
LINK_TOPUP_WEI="${LINK_TOPUP_WEI:-5000000000000000000}"   # 5 LINK to send if hub is low
MIN_HUB_LINK_WEI="${MIN_HUB_LINK_WEI:-100000000000000000}" # 0.1 LINK = "enough" threshold
MIN_ETH_WEI="${MIN_ETH_WEI:-2000000000000000}"             # 0.002 ETH minimum to operate

# Sanity ranges for verification (USD)
XMR_MIN_USD="${XMR_MIN_USD:-10}"
XMR_MAX_USD="${XMR_MAX_USD:-100000}"
ETH_MIN_USD="${ETH_MIN_USD:-500}"
ETH_MAX_USD="${ETH_MAX_USD:-20000}"

# ---------------------------------------------------------------------------
# Pretty printing
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
  RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLU=$'\033[34m'; BLD=$'\033[1m'; RST=$'\033[0m'
else
  RED=; GRN=; YEL=; BLU=; BLD=; RST=
fi

FAILURES=0
step()  { printf "\n${BLU}${BLD}==> %s${RST}\n" "$1"; }
ok()    { printf "  ${GRN}PASS${RST} %s\n" "$1"; }
warn()  { printf "  ${YEL}WARN${RST} %s\n" "$1"; }
fail()  { printf "  ${RED}FAIL${RST} %s\n" "$1"; FAILURES=$((FAILURES+1)); }
die()   { printf "\n${RED}${BLD}ABORT:${RST} %s\n" "$1"; exit 1; }

# First whitespace-delimited token (cast prints "123 [1.2e2]" for uints)
firsttok() { awk '{print $1}'; }

# python3 float compare helper: returns 0 (true) if $1 in [$2,$3]
in_range() {
  python3 - "$1" "$2" "$3" <<'PY'
import sys
v=float(sys.argv[1]); lo=float(sys.argv[2]); hi=float(sys.argv[3])
sys.exit(0 if lo <= v <= hi else 1)
PY
}

# wei (18-dec) -> human float string
wei_to_usd() {
  python3 - "$1" <<'PY'
import sys
print(f"{int(sys.argv[1])/1e18:.6f}")
PY
}

# ---------------------------------------------------------------------------
# 1. Preflight
# ---------------------------------------------------------------------------
step "1/5 Preflight checks"

command -v cast >/dev/null 2>&1 || die "'cast' not found. Install Foundry (foundryup) and re-source your shell."
command -v node >/dev/null 2>&1 || die "'node' not found. Install Node.js >= 18."
command -v python3 >/dev/null 2>&1 || die "'python3' not found (used for range checks)."
ok "cast, node, python3 available"

[ -n "${PRIVATE_KEY:-}" ] || die "PRIVATE_KEY not exported. Run: export PRIVATE_KEY=0x<deployer key>"
DEPLOYER="$(cast wallet address "$PRIVATE_KEY" 2>/dev/null)" || die "PRIVATE_KEY is not a valid key."
ok "Deployer: $DEPLOYER"

ETH_WEI="$(cast balance "$DEPLOYER" --rpc-url "$RPC" 2>/dev/null | firsttok)" || die "Cannot reach RPC $RPC"
ETH_HUMAN="$(wei_to_usd "$ETH_WEI")"
if [ "$(python3 -c "print(1 if int('$ETH_WEI') >= int('$MIN_ETH_WEI') else 0)")" = "1" ]; then
  ok "ETH balance: $ETH_HUMAN ETH"
else
  die "ETH balance too low ($ETH_HUMAN ETH). Fund $DEPLOYER on Base Sepolia and retry."
fi

HUB_CODE="$(cast code "$HUB" --rpc-url "$RPC" 2>/dev/null)"
if [ -z "$HUB_CODE" ] || [ "$HUB_CODE" = "0x" ]; then
  die "No contract code at hub $HUB. Check the address / that the deploy succeeded."
fi
ok "Hub contract present at $HUB"

[ -f "$PROXY_DIR/fetchReportHex.js" ] || die "fetchReportHex.js not found in $PROXY_DIR"
ok "Report fetcher found"

# ---------------------------------------------------------------------------
# 2. LINK funding for the hub
# ---------------------------------------------------------------------------
step "2/5 Ensure hub has LINK for verification fees"

HUB_LINK="$(cast call "$LINK" "balanceOf(address)(uint256)" "$HUB" --rpc-url "$RPC" 2>/dev/null | firsttok)"
HUB_LINK="${HUB_LINK:-0}"
printf "  hub LINK balance: %s wei\n" "$HUB_LINK"

if [ "$(python3 -c "print(1 if int('$HUB_LINK') >= int('$MIN_HUB_LINK_WEI') else 0)")" = "1" ]; then
  ok "Hub already funded with LINK"
else
  warn "Hub LINK below threshold — attempting top-up of $LINK_TOPUP_WEI wei"
  WALLET_LINK="$(cast call "$LINK" "balanceOf(address)(uint256)" "$DEPLOYER" --rpc-url "$RPC" 2>/dev/null | firsttok)"
  WALLET_LINK="${WALLET_LINK:-0}"
  if [ "$(python3 -c "print(1 if int('$WALLET_LINK') >= int('$LINK_TOPUP_WEI') else 0)")" = "1" ]; then
    printf "  transferring LINK to hub...\n"
    if cast send "$LINK" "transfer(address,uint256)" "$HUB" "$LINK_TOPUP_WEI" \
         --rpc-url "$RPC" --private-key "$PRIVATE_KEY" >/dev/null 2>&1; then
      HUB_LINK="$(cast call "$LINK" "balanceOf(address)(uint256)" "$HUB" --rpc-url "$RPC" 2>/dev/null | firsttok)"
      ok "Hub LINK after top-up: $HUB_LINK wei"
    else
      fail "LINK transfer failed (check gas / balance)"
    fi
  else
    fail "Wallet has insufficient LINK ($WALLET_LINK wei). Get LINK at https://faucets.chain.link/base-sepolia for $DEPLOYER, then re-run."
    die "Cannot proceed without LINK in the hub."
  fi
fi

# ---------------------------------------------------------------------------
# 3. Fetch live signed reports
# ---------------------------------------------------------------------------
step "3/5 Fetch live signed reports from Data Streams"

XMR_BLOB="$(node "$PROXY_DIR/fetchReportHex.js" "$XMR_FEED" 2>/tmp/ws_xmr_err)" || { cat /tmp/ws_xmr_err; die "Failed to fetch XMR report (check CHAINLINK creds in repo-root .env)"; }
ETH_BLOB="$(node "$PROXY_DIR/fetchReportHex.js" "$ETH_FEED" 2>/tmp/ws_eth_err)" || { cat /tmp/ws_eth_err; die "Failed to fetch ETH report"; }

case "$XMR_BLOB" in 0x*) ok "XMR report fetched (${#XMR_BLOB} hex chars)";; *) die "XMR report is not a 0x hex blob: $XMR_BLOB";; esac
case "$ETH_BLOB" in 0x*) ok "ETH report fetched (${#ETH_BLOB} hex chars)";; *) die "ETH report is not a 0x hex blob: $ETH_BLOB";; esac

# ---------------------------------------------------------------------------
# 4. Push prices on-chain
# ---------------------------------------------------------------------------
step "4/5 Push prices: updateOraclePrices([XMR, ETH])"

SEND_OUT="$(cast send "$HUB" "updateOraclePrices(bytes[])" "[$XMR_BLOB,$ETH_BLOB]" \
  --rpc-url "$RPC" --private-key "$PRIVATE_KEY" --json 2>&1)"
SEND_RC=$?

if [ $SEND_RC -ne 0 ]; then
  printf "%s\n" "$SEND_OUT"
  die "updateOraclePrices transaction failed. Common causes: hub has no LINK, report expired (re-run), or wrong feed order."
fi

TX_HASH="$(printf "%s" "$SEND_OUT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('transactionHash',''))" 2>/dev/null)"
TX_STATUS="$(printf "%s" "$SEND_OUT" | python3 -c "import sys,json;print(json.load(sys.stdin).get('status',''))" 2>/dev/null)"

if [ "$TX_STATUS" = "0x1" ]; then
  ok "updateOraclePrices mined: $TX_HASH"
  printf "  explorer: https://sepolia.basescan.org/tx/%s\n" "$TX_HASH"
else
  fail "Transaction reverted (status=$TX_STATUS) tx=$TX_HASH"
  die "Price update did not succeed."
fi

# ---------------------------------------------------------------------------
# 5. Read prices back and verify
# ---------------------------------------------------------------------------
step "5/5 Verify on-chain prices"

read_price() {
  cast call "$HUB" "$1" --rpc-url "$RPC" 2>/dev/null | firsttok
}

XMR_PRICE="$(read_price "getXmrPrice()(uint256)")"
ETH_PRICE="$(read_price "getCollateralPrice()(uint256)")"
EMA_PRICE="$(read_price "getXmrEmaPrice()(uint256)")"

# XMR/USD
if [ -n "$XMR_PRICE" ] && [ "$XMR_PRICE" != "0" ]; then
  XMR_USD="$(wei_to_usd "$XMR_PRICE")"
  if in_range "$XMR_USD" "$XMR_MIN_USD" "$XMR_MAX_USD"; then
    ok "getXmrPrice() = \$$XMR_USD  (in [$XMR_MIN_USD, $XMR_MAX_USD])"
  else
    fail "getXmrPrice() = \$$XMR_USD  OUTSIDE [$XMR_MIN_USD, $XMR_MAX_USD]"
  fi
else
  fail "getXmrPrice() returned empty/zero (stale or not set)"
fi

# ETH/USD (collateral)
if [ -n "$ETH_PRICE" ] && [ "$ETH_PRICE" != "0" ]; then
  ETH_USD="$(wei_to_usd "$ETH_PRICE")"
  if in_range "$ETH_USD" "$ETH_MIN_USD" "$ETH_MAX_USD"; then
    ok "getCollateralPrice() = \$$ETH_USD  (in [$ETH_MIN_USD, $ETH_MAX_USD])"
  else
    fail "getCollateralPrice() = \$$ETH_USD  OUTSIDE [$ETH_MIN_USD, $ETH_MAX_USD]"
  fi
else
  fail "getCollateralPrice() returned empty/zero (stale or not set)"
fi

# EMA
if [ -n "$EMA_PRICE" ] && [ "$EMA_PRICE" != "0" ]; then
  EMA_USD="$(wei_to_usd "$EMA_PRICE")"
  ok "getXmrEmaPrice() = \$$EMA_USD"
else
  fail "getXmrEmaPrice() returned empty/zero"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf "\n${BLD}============================================================${RST}\n"
if [ "$FAILURES" -eq 0 ]; then
  printf "${GRN}${BLD}  ALL CHECKS PASSED${RST}\n"
  printf "  Chainlink Data Streams -> on-chain verify -> storage works live.\n"
  printf "${BLD}============================================================${RST}\n"
  exit 0
else
  printf "${RED}${BLD}  %d CHECK(S) FAILED${RST}\n" "$FAILURES"
  printf "${BLD}============================================================${RST}\n"
  exit 1
fi
