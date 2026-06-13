# Data Streams Report Proxy

Tiny zero-dependency Node server that holds the Chainlink Data Streams API
credentials (HMAC key/secret) and serves signed `fullReport` blobs to the
frontend. The browser must never see the API secret, so all Data Streams API
calls go through this proxy.

## Setup

Add credentials to the repo-root `.env` (gitignored):

```
CHAINLINK_API_KEY=<key id>
CHAINLINK_API_SECRET=<secret>
```

## Run

```bash
node server.js          # listens on http://localhost:3002
```

## Endpoints

- `GET /reports?feedIDs=0x...,0x...` — latest signed reports for the given
  stream IDs, each entry contains `{ feedID, observationsTimestamp, fullReport }`.
  `fullReport` is passed unmodified to `updateOraclePrices(bytes[])` on-chain.

## Utilities

- `node discoverFeeds.js [filter]` — list stream IDs available on the testnet
  data engine for these credentials.
- `node checkFeeds.js 0xfeedid ...` — check specific stream IDs (listed +
  latest report availability).

## Stream IDs used (testnet data engine)

| Stream | Feed ID |
|---|---|
| XMR/USD (RefPrice, testnet-production) | `0x0003c70558bd921b1559d37b8e347797f121d1240e7386e68b2bee9b731b0833` |
| DAI/USD (RefPrice, Sepolia Premium) | `0x0003649272a19e143a7f4c2d98905b413e98dce81fb09287dcf4c513cba5cc72` |
