import "dotenv/config";
import { createUnlinkAdmin } from "@unlink-xyz/sdk/admin";
import { createUnlinkClient } from "@unlink-xyz/sdk/client";
import { account, buildDeriveSeedMessage } from "@unlink-xyz/sdk/crypto";
import { ethers } from "ethers";

// 1. Setup EVM provider and signer using ethers (already installed in package.json)
const provider = new ethers.JsonRpcProvider(
  process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org"
);
const walletClient = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const evmAddress = await walletClient.getAddress();

console.log("EVM Address:", evmAddress);

// 2. Build the message for deriving the unlink seed
const message = buildDeriveSeedMessage({
  appId: process.env.UNLINK_PROJECT_ID,
  chainId: 84532,
});

console.log("Message to sign:", message);

// 3. Sign the message with your EVM wallet
const signature = await walletClient.signMessage(message);
console.log("Signature:", signature);

// 4. Initialize Unlink Admin SDK
const admin = createUnlinkAdmin({
  environment: "base-sepolia",
  apiKey: process.env.UNLINK_API_KEY,
});

// 5. Create the Unlink account from the Ethereum signature
const unlinkAccount = account.fromEthereumSignature({
  signature,
  appId: process.env.UNLINK_PROJECT_ID,
  chainId: 84532,
});

const unlinkAddress = await unlinkAccount.getAddress();
console.log("Unlink Address:", unlinkAddress);

// 6. Initialize Unlink Client with registration and auth token logic
const client = createUnlinkClient({
  environment: "base-sepolia",
  account: unlinkAccount,
  register: (payload) => admin.users.register(payload),
  authorizationToken: {
    provider: () => admin.authorizationTokens.issue({ unlinkAddress }),
  },
});

// 7. Ensure the user is registered in the Unlink ecosystem
await client.ensureRegistered();
console.log("✅ User is now registered with Unlink!");