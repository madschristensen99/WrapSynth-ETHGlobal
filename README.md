# ⛴️ WrapSynth - ETHGlobal NYC 2026

> **🏗️ ETHGlobal NYC 2026 Project - Base Sepolia Deployment**  
> This is a fork of [madschristensen99/wrapsynth](https://github.com/madschristensen99/wrapsynth) for ETHGlobal NYC 2026. We're taking the existing trustless Monero bridge protocol and integrating it with:
> - **Chainlink Data Streams** - Real-time oracle price feeds for XMR/USD
> - **Unichain Privacy** - Enhanced privacy features for cross-chain swaps
> - **Uniswap API** - Improved liquidity routing and swap optimization
> 
> **Deploying on Base Sepolia testnet** for the hackathon demo.

**A trustless cross-chain ferry for Monero. The original protocol is live on Gnosis Chain, backed by overcollateralized LP vaults and Ed25519 atomic swap commitments.**

🌐 **Original:** [wrapsynth.com](https://wrapsynth.com) · 📊 **[wsXMR/sDAI Pool on Gnosis](https://gnosisscan.io/address/0x3b3f640b137ed13c79d2d51c54329816a6fbd85d)**

WrapSynth brings Monero's anonymity set to DeFi and DeFi liquidity to Monero. Users swap XMR for wsXMR through atomic-swap mechanics enforced on-chain: LPs post sDAI collateral, mint/burn settlement is gated by Ed25519 secret reveals verified on-chain, and timeout-based slashing protects both sides. No custodian, no federation, no trusted intermediary — every swap settles peer-to-peer between a user and an LP vault.

---

## 🚀 Status

### ETHGlobal NYC 2026 - Base Sepolia (This Fork)

- 🔄 **Integrating Chainlink Data Streams** for real-time XMR/USD price feeds
- 🔄 **Adding Unichain Privacy** features for enhanced cross-chain privacy
- 🔄 **Implementing Uniswap API** integration for optimized liquidity routing
- 🔄 **Deploying to Base Sepolia testnet** for hackathon demo

### Original Production Deployment (Gnosis Chain Mainnet)

- ✅ Full hub + facet system deployed and **verified on Gnosisscan**
- ✅ **wsXMR/sDAI Uniswap V3 pool live** (0.3% fee tier)
- ✅ Complete mint → trade → burn cycle executed end-to-end on mainnet
- ✅ Two rounds of security review completed; all critical findings resolved (see [Security](#-security))
- ✅ 633-line solvency invariant test suite + audit regression suite
- 🔄 Solana port in development (`solana/`)

### Base Sepolia Deployment (ChainID 84532)

| Contract | Address |
|---|---|
| wsXMR Token | [`0x500735b66b9968e9fc7d6c6d1ae6ccf19a6a238b`](https://sepolia.basescan.org/address/0x500735b66b9968e9fc7d6c6d1ae6ccf19a6a238b) |
| wsXmrHub | [`0x65d3b7ff17dfa21fd6bb1553d51336b66548a1c3`](https://sepolia.basescan.org/address/0x65d3b7ff17dfa21fd6bb1553d51336b66548a1c3) |
| MockWXDAI | [`0x7450C945A87F24DE0219D27f5d9A6EdeF6008CB3`](https://sepolia.basescan.org/address/0x7450C945A87F24DE0219D27f5d9A6EdeF6008CB3) |
| MockSavingsDAI | [`0x57cA07e0443c7Dc720CAd8AF63D8a6bBeDabD202`](https://sepolia.basescan.org/address/0x57cA07e0443c7Dc720CAd8AF63D8a6bBeDabD202) |
| Ed25519Helper | [`0x8D7DD0A1FD26A2602837B028afB7A1f1b21DA9E7`](https://sepolia.basescan.org/address/0x8D7DD0A1FD26A2602837B028afB7A1f1b21DA9E7) |

<details>
<summary>Facet addresses</summary>

| Facet | Address |
|---|---|
| ChainlinkDataStreamsOracleFacet | [`0xe38af534e73995a0bfac54e40ed82bc2ffddd22d`](https://sepolia.basescan.org/address/0xe38af534e73995a0bfac54e40ed82bc2ffddd22d) |
| VaultFacet | [`0xeb2435f32deda1da7cbbcd95fc3c230b0b9fcd92`](https://sepolia.basescan.org/address/0xeb2435f32deda1da7cbbcd95fc3c230b0b9fcd92) |
| MintFacet | [`0x09109e9f0c9b2affbdef61a541b6a5e3f70069a9`](https://sepolia.basescan.org/address/0x09109e9f0c9b2affbdef61a541b6a5e3f70069a9) |
| BurnFacet | [`0xc957665b81b16934bf2df813c714fabf8a5878ae`](https://sepolia.basescan.org/address/0xc957665b81b16934bf2df813c714fabf8a5878ae) |
| LiquidationFacet | [`0x42d2cc6db9b495d85922e95d90815f2244567c56`](https://sepolia.basescan.org/address/0x42d2cc6db9b495d85922e95d90815f2244567c56) |
| YieldFacet | [`0x2ed9cc036bba0d976847367a378e6d8e0d3ca19a`](https://sepolia.basescan.org/address/0x2ed9cc036bba0d976847367a378e6d8e0d3ca19a) |

**Oracle config:** Chainlink Data Streams testnet — XMR/USD feed `0x0003c70558bd921b1559d37b8e347797f121d1240e7386e68b2bee9b731b0833`, ETH/USD feed `0x000359843a543ee2fe414dc14c7e7920ef10f4372990b79d6361cdc0dd1ba782`

Full deployment manifest: [`deployment.base-sepolia.json`](./deployment.base-sepolia.json)
</details>

### Original Deployed Contracts (Gnosis Chain, ChainID 100)

| Contract | Address |
|---|---|
| wsXMR Token | [`0x30Aeb2A142744430fFD7D698D5C7C41769CE1279`](https://gnosisscan.io/address/0x30Aeb2A142744430fFD7D698D5C7C41769CE1279) |
| wsXmrHub | [`0x1fb8E7593B01bCdAE13e5b63e529f0e30a3ebD50`](https://gnosisscan.io/address/0x1fb8E7593B01bCdAE13e5b63e529f0e30a3ebD50) |
| Liquidity Router | [`0x6893f38e1DeEdCa95ce8995B01550921cEe353a1`](https://gnosisscan.io/address/0x6893f38e1DeEdCa95ce8995B01550921cEe353a1) |
| wsXMR/sDAI UniV3 Pool | [`0x3b3f640b137ed13c79d2d51c54329816a6fbd85d`](https://gnosisscan.io/address/0x3b3f640b137ed13c79d2d51c54329816a6fbd85d) |

<details>
<summary>Facet addresses</summary>

| Facet | Address |
|---|---|
| RedStoneOracleFacet | [`0xa04bB8E8670c95Ae3017b959dcC7FAdA73A003dc`](https://gnosisscan.io/address/0xa04bB8E8670c95Ae3017b959dcC7FAdA73A003dc) |
| VaultFacet | [`0x81Ef0aF3Eb50Df7241eaC44364dD64A0B754E6cB`](https://gnosisscan.io/address/0x81Ef0aF3Eb50Df7241eaC44364dD64A0B754E6cB) |
| MintFacet | [`0x4e53Ad9223CcBd8953b53223fEB2161338B34D7C`](https://gnosisscan.io/address/0x4e53Ad9223CcBd8953b53223fEB2161338B34D7C) |
| BurnFacet | [`0x4F072A55CE4c3d3B5F247C67beF037d4Cc525dD7`](https://gnosisscan.io/address/0x4F072A55CE4c3d3B5F247C67beF037d4Cc525dD7) |
| LiquidationFacet | [`0x6FA84E83694002aBfA6fc198F430A14f96FdaA54`](https://gnosisscan.io/address/0x6FA84E83694002aBfA6fc198F430A14f96FdaA54) |
| YieldFacet | [`0xA676e2dC47F6B2639F54094190783bcbA8080947`](https://gnosisscan.io/address/0xA676e2dC47F6B2639F54094190783bcbA8080947) |

Full deployment manifest (external contracts, pool config, LP defaults): [`deployment.json`](./deployment.json)
</details>

---

## 🏗️ Architecture

### Hub + Facet (Diamond-style)

All protocol state and collateral live in a single contract, **wsXmrHub**, which dispatches calls to stateless logic facets via a selector → facet table:

- The Hub owns all state (`wsXmrStorage`), holds all collateral, and is the only address authorized to mint/burn wsXMR
- Facets contain logic only and access state through the Hub; only registered facets can mutate state
- Delegate-context is tracked with **EIP-1153 transient storage**, preventing facet logic from being invoked outside the hub's dispatch path

```
                      ┌────────────────────────────┐
                      │         wsXmrHub           │
                      │  state · collateral · token │
                      │  selector → facet dispatch  │
                      └──────────┬─────────────────┘
        ┌──────────┬─────────┬──┴──────┬───────────┬──────────┐
   VaultFacet  MintFacet  BurnFacet  Liquidation  YieldFacet  OracleFacet
   (LP vaults) (XMR→wsXMR)(wsXMR→XMR)  Facet     (sDAI yield) (RedStone)
```

### Key components

- **Ed25519 on-chain verification** — atomic swap secrets are Ed25519 scalars; the contract computes `scalarMultBase(secret)` and checks it against the user's commitment, binding settlement to the same key material used on the Monero side
- **sDAI collateral** — LP vaults are denominated in Savings DAI, so idle collateral earns the DSR; **YieldFacet** harvests and accounts for vault yield
- **Co-LP liquidity router** — `wsXMRLiquidityRouter` deploys vault collateral as Uniswap V3 concentrated liquidity paired against user-supplied wsXMR, putting backing capital to work instead of letting it sit idle
- **Oracle facet** — RedStone-style oracle with an off-chain price pusher keeping XMR/USD fresh on-chain
- **LP node** (`ethereum/lp-node/`, Rust) — monitors events, manages Monero RPC, prices quotes, runs arbitrage, and exposes a REST API for the frontend

---

## 📖 How It Works

### Minting (XMR → wsXMR)

1. **`initiateMint`** — user posts a claim commitment (Ed25519 point) and griefing deposit; the LP vault's capacity is reserved
2. User sends XMR to the LP's Monero address
3. **`setMintReady`** — LP confirms XMR receipt on-chain
4. **`finalizeMint`** — user reveals the secret scalar; the contract verifies `scalarMultBase(secret)` matches the commitment, mints wsXMR, and refunds the deposit

### Burning (wsXMR → XMR)

1. **`requestBurn`** — user locks wsXMR and posts a hash commitment with their Monero destination; LP collateral is reserved against the burn and a deadline starts
2. **`confirmMoneroLock`** — LP signals the XMR payment is underway
3. LP sends XMR; **`finalizeBurn`** settles with the secret reveal, burning the wsXMR and releasing the LP's collateral
4. Escape hatches:
   - **`abortBurn`** — clean unwind before settlement, returning wsXMR to the user
   - **`forceSettleBurn`** / **`claimSlashedCollateral`** — if the LP misses the deadline, the user seizes collateral at oracle price; bad outcomes hit the responsible vault, not the system

### For Liquidity Providers

1. Create a vault and deposit sDAI via **VaultFacet** (minimum 150% collateral ratio; 180% target)
2. Optionally deploy collateral into the co-LP Uniswap V3 position via the router
3. Run the LP node to serve mint/burn flow automatically
4. Earn mint/burn fees + sDAI yield + LP fees; keep ratio above the 120% liquidation threshold

---

## 🔐 Security

### Review history

The protocol has been through **two rounds of security review**, with all critical and high-severity findings resolved and locked in by regression tests ([`AuditRegressionTest.t.sol`](./ethereum/test/AuditRegressionTest.t.sol)). Notable findings fixed:

- **Delegate-context reentrancy** in the hub dispatch path — closed using EIP-1153 transient-storage context flags
- **Yield harvesting unit mismatch** between sDAI shares and DAI amounts in vault accounting
- **Inverted bad-debt socialization** logic in liquidation flow
- **Burn flow redesign** — the original single-path burn was replaced with the `requestBurn` / `abortBurn` / `forceSettleBurn` state machine to remove griefing and stuck-funds paths

### Testing

- [`BurnSolvencyInvariantTest.t.sol`](./ethereum/test/BurnSolvencyInvariantTest.t.sol) — 633-line Foundry invariant suite asserting system solvency across randomized mint/burn/liquidation sequences
- Full lifecycle E2E suites (`E2EFullCycle`, `E2EComprehensive`, `E2EAdvancedScenarios`) plus Hardhat unit suites per facet
- Co-LP fork tests against Gnosis mainnet state (`test/coLP/`)
- Ed25519 compatibility tests against reference vectors

### Honest risk disclosure

⚠️ This is early-stage protocol software. Reviews to date do not eliminate risk:

- No formal verification yet
- Oracle liveness depends on the off-chain price pusher
- LP-side Monero payment confirmation is an off-chain step; the protocol's protection is economic (collateral slashing), not cryptographic proof of XMR transfer
- Use amounts you can afford to lose

---

## 🛠️ Development

### Prerequisites

Node.js v18+, Foundry, Rust (for the LP node), Hardhat (via npm).

```bash
# Clone the ETHGlobal NYC 2026 fork
git clone https://github.com/vedantp03/WrapSynth-ETHGlobal.git
cd WrapSynth-ETHGlobal/ethereum
npm install
cp .env.example .env   # add PRIVATE_KEY and GNOSIS_RPC_URL

# Compile + test
npx hardhat compile
npm test               # Hardhat suites
forge test             # Foundry invariant + E2E suites
```

> **Note:** This fork builds on the original [madschristensen99/wrapsynth](https://github.com/madschristensen99/wrapsynth) codebase. For the production deployment and original implementation, see the upstream repository.

### Run the LP node

```bash
cd ethereum/lp-node
cargo build --release
cargo run --release -- --config config.toml
```

### Solana (in development)

```bash
cd solana/anchor-program
anchor build && anchor test
```

---

## 📁 Repo Layout

```
wrapsynth/
├── deployment.json           # Live Gnosis mainnet deployment manifest
├── ethereum/
│   ├── contracts/
│   │   ├── core/             # wsXmrHub, wsXmrStorage
│   │   ├── facets/           # Vault, Mint, Burn, Liquidation, Yield, Oracle
│   │   ├── router/           # wsXMRLiquidityRouter (co-LP UniV3)
│   │   ├── Ed25519.sol       # On-chain Ed25519 scalar mult
│   │   └── wsXMR.sol         # ERC-20 (8 decimals, matching XMR)
│   ├── test/                 # Foundry invariant/E2E + Hardhat suites
│   └── lp-node/              # Rust LP node (events, Monero RPC, quotes, API)
├── solana/anchor-program/    # Solana port (Anchor)
├── frontend/                 # Web app
└── docs/                     # Sequence diagrams, seed storage design
```

---

## 🔮 Roadmap

- ✅ Gnosis mainnet deployment + verified contracts
- ✅ Live wsXMR/sDAI Uniswap V3 pool
- ✅ Co-LP concentrated liquidity router
- 🔄 Solana port (Meteora DLMM liquidity, JitoSOL collateral, Pyth oracle)
- 🔄 Additional LP onboarding + deeper liquidity
- ⏳ Hyperliquid wsXMR/USD market (HIP-3 proposal drafted)
- ⏳ Third-party audit + bug bounty ahead of broader scaling
- ⏳ Multi-chain expansion

---

## 📚 Documentation

- [Sequence diagrams](./docs/sequenceDiagrams.md) — mint/burn/liquidation flows
- [Seed storage design](./docs/SEED_STORAGE_IMPLEMENTATION.md)
- [LP node README](./ethereum/lp-node/)
- [Solana program](./solana/anchor-program/)

---

## ⚠️ Disclaimer

Experimental protocol software provided "as is." It has undergone security review but not formal third-party audit certification or formal verification. The developers assume no liability for losses. Interact at your own risk.

## 📄 License

MIT

---

Built with ❤️ for privacy and decentralization
