import 'dotenv/config';
import { createUnlinkAdmin } from '@unlink-xyz/sdk/admin';
import { buildDeriveSeedMessage, account } from '@unlink-xyz/sdk/crypto';
import { createUnlinkClient, evm } from '@unlink-xyz/sdk/client';
import { Wallet, JsonRpcProvider } from 'ethers';

async function main() {
  console.log('🚀 Starting Unlink Deposit Process...');

  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
  const TOKEN_ADDRESS = process.env.UNLINK_TEST_TOKEN || process.env.TOKEN_ADDRESS;
  const UNLINK_API_KEY = process.env.UNLINK_API_KEY;

  if (!PRIVATE_KEY) {
    console.error('❌ Missing PRIVATE_KEY in .env');
    process.exit(1);
  }
  if (!BASE_SEPOLIA_RPC_URL) {
    console.error('❌ Missing BASE_SEPOLIA_RPC_URL in .env');
    process.exit(1);
  }
  if (!TOKEN_ADDRESS) {
    console.error('❌ Missing TOKEN_ADDRESS in .env');
    process.exit(1);
  }
  if (!UNLINK_API_KEY) {
    console.error('❌ Missing UNLINK_API_KEY in .env');
    console.error('   Get one from https://app.unlink.xyz/developers/api-keys');
    process.exit(1);
  }

  // 1. Setup EVM Provider (for gas/signing)
  const provider = new JsonRpcProvider(BASE_SEPOLIA_RPC_URL);
  const evmWallet = new Wallet(PRIVATE_KEY, provider);

  console.log(`EVM Address: ${evmWallet.address}`);

  // 2. Create Admin client (server-side only)
  const admin = createUnlinkAdmin({
    environment: 'base-sepolia',
    apiKey: UNLINK_API_KEY,
  });

  // 3. Build the message to sign and derive the Unlink identity
  const message = buildDeriveSeedMessage({
    appId: process.env.UNLINK_PROJECT_ID || '',
    chainId: 84532, // Base Sepolia
  });

  console.log('Signing message to derive Unlink identity...');
  const signature = await evmWallet.signMessage(message);

  // 4. Create the Unlink account from the Ethereum signature
  const unlinkAccount = account.fromEthereumSignature({
    signature,
    appId: process.env.UNLINK_PROJECT_ID || '',
    chainId: 84532,
  });

  const unlinkAddress = await unlinkAccount.getAddress();
  console.log(`Unlink Account Address (ETH format): ${unlinkAddress}`);

  // 5. Create Client with admin-based registration and authorization
  const client = createUnlinkClient({
    environment: 'base-sepolia',
    account: unlinkAccount,
    evm: evm.fromEthers({
      signer: evmWallet,
      provider: new JsonRpcProvider(BASE_SEPOLIA_RPC_URL),
    }),
    register: (payload) => admin.users.register(payload),
    authorizationToken: {
      provider: () => admin.authorizationTokens.issue({ unlinkAddress }),
    },
  });

  try {
    // 6. Register the user
    console.log('📝 Registering user...');
    await client.ensureRegistered();
    console.log('✅ Registered!');

    const tokenAddress = TOKEN_ADDRESS;
    const amount = '100000000000000000'; // 0.1 tokens (18 decimals)

    // Simplified Deposit with auto-approval
    console.log(`💸 Depositing ${amount} of tokens (with auto-approval)...`);

    try {
      // Use depositWithApproval to handle approval and deposit in one flow
      const tx = await client.depositWithApproval({
        token: tokenAddress,
        amount,
      });

      console.log('⏳ Waiting for transaction confirmation...');
      const confirmed = await tx.wait();
      
      console.log(`✅ Deposit Status: ${confirmed.status}`);
      
      if (confirmed.status === 'processed') {
        console.log('🎉 Deposit successful!');
      } else if (confirmed.status === 'failed') {
        throw new Error('Deposit transaction failed on-chain.');
      }

    } catch (depositError) {
      console.error('💥 Deposit failed:', depositError.message);
      throw depositError;
    }

  } catch (error) {
    console.error('💥 Error:', error.message || error);
    if (error.stack) console.error(error.stack);
  }
}

main();