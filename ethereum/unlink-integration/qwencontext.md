# Mission Context: Unlink SDK tWXMR Deposit

## Objective
Make the Unlink SDK deposit flow work by correctly implementing the deterministic identity derivation (EVM signature-based) and executing token approval + deposit on Base Sepolia testnet.

## Key Requirements
1. **Environment Variables** (in `.env`):
   - `PRIVATE_KEY` – EVM wallet private key
   - `BASE_SEPOLIA_RPC_URL` – JSON-RPC endpoint for Base Sepolia
   - `UNLINK_API_KEY` – Unlink platform API key
   - `UNLINK_PROJECT_ID` – Your Unlink project/app ID
   - `TOKEN_ADDRESS` – tWXMR token contract address on Base Sepolia

2. **Core Flow**:
   ```javascript
   // 1. Setup EVM provider & wallet
   const provider = new ethers.JsonRpcProvider(process.env.BASE_SEPOLIA_RPC_URL);
   const evmWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

   // 2. Derive deterministic Unlink identity via signature
   const message = buildDeriveSeedMessage({
     appId: process.env.UNLINK_PROJECT_ID,
     chainId: 84532, // Base Sepolia
   });
   const signature = await evmWallet.signMessage(message);
   const unlinkAccount = account.fromEthereumSignature({
     signature,
     appId: process.env.UNLINK_PROJECT_ID,
     chainId: 84532,
   });

   // 3. Register user via admin (if needed) & get unlink address
   const admin = createUnlinkAdmin({
     apiKey: process.env.UNLINK_API_KEY,
     environment: 'base-sepolia',
   });
   const { account: registeredAccount } = await admin.users.register({
     unlinkAddress: unlinkAccount.unlinkedAddress,
   });
   const unlinkAddress = registeredAccount.address;

   // 4. Initialize client with approval token & EVM provider
   const client = createUnlinkClient({
     environment: 'base-sepolia',
     account: unlinkAccount,
     evm: evm.fromEthers({ signer: evmWallet, provider }),
     register: (payload) => admin.users.register(payload),
     authorizationToken: {
       provider: () => admin.authorizationTokens.issue({ unlinkAddress }),
     },
   });

   // 5. Approve & deposit tWXMR
   const tokenAddress = process.env.TOKEN_ADDRESS;
   await ensureErc20Approval(client, {
     tokenAddress,
     amountToApprove: '1', // or desired amount
   });
   const result = await client.deposit({
     to: unlinkAccount.unlinkedAddress,
     assetId: tokenAddress,
     amount: '0.001', // deposit amount
     metadata: { fromEthereumSignature: signature },
   });
   ```

3. **Critical SDK Imports**:
   ```javascript
   import 'dotenv/config';
   import { ethers } from 'ethers';
   import { account, buildDeriveSeedMessage } from '@unlink-xyz/sdk/crypto';
   import { createUnlinkClient, createUnlinkAdmin, evm } from '@unlink-xyz/sdk/client';
   ```

## Known Issues & Fixes
- **Missing `.env` loading** → Added `import 'dotenv/config';`
- **Wrong SDK imports** → `account` & `buildDeriveSeedMessage` come from `/crypto`, not `/client`
- **Invalid mnemonic derivation** → Use EIP-191 signature flow for deterministic identity
- **Client initialization errors** → Must provide `evm.fromEthers()`, `register`, and `authorizationToken.provider`

## Next Steps
- Run `deposit.js` with populated `.env` variables
- Monitor tx hashes for approval & deposit on Base Sepolia
- Handle SDK version-specific API changes if needed