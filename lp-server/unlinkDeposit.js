import 'dotenv/config';
import { createUnlinkAdmin } from '@unlink-xyz/sdk/admin';
import { buildDeriveSeedMessage, account } from '@unlink-xyz/sdk/crypto';
import { createUnlinkClient, evm } from '@unlink-xyz/sdk/client';
import { Wallet, JsonRpcProvider } from 'ethers';

async function executeUnlinkDeposit({ tokenAddress, amount, privateKey, rpcUrl }) {
  console.log('🚀 Starting Unlink Deposit Process...');

  const UNLINK_API_KEY = process.env.UNLINK_API_KEY;
  const UNLINK_PROJECT_ID = process.env.UNLINK_PROJECT_ID;

  if (!UNLINK_API_KEY) {
    throw new Error('Missing UNLINK_API_KEY in .env. Get one from https://app.unlink.xyz/developers/api-keys');
  }

  if (!UNLINK_PROJECT_ID) {
    throw new Error('Missing UNLINK_PROJECT_ID in .env');
  }

  if (!tokenAddress) {
    throw new Error('tokenAddress is required');
  }

  if (!amount) {
    throw new Error('amount is required');
  }

  const provider = new JsonRpcProvider(rpcUrl || process.env.BASE_SEPOLIA_RPC_URL);
  const evmWallet = new Wallet(privateKey || process.env.PRIVATE_KEY, provider);

  console.log(`EVM Address: ${evmWallet.address}`);

  const admin = createUnlinkAdmin({
    environment: 'base-sepolia',
    apiKey: UNLINK_API_KEY,
  });

  const message = buildDeriveSeedMessage({
    appId: UNLINK_PROJECT_ID,
    chainId: 84532,
  });

  console.log('Signing message to derive Unlink identity...');
  const signature = await evmWallet.signMessage(message);

  const unlinkAccount = account.fromEthereumSignature({
    signature,
    appId: UNLINK_PROJECT_ID,
    chainId: 84532,
  });

  const unlinkAddress = await unlinkAccount.getAddress();
  console.log(`Unlink Account Address: ${unlinkAddress}`);

  const client = createUnlinkClient({
    environment: 'base-sepolia',
    account: unlinkAccount,
    evm: evm.fromEthers({
      signer: evmWallet,
      provider: new JsonRpcProvider(rpcUrl || process.env.BASE_SEPOLIA_RPC_URL),
    }),
    register: (payload) => admin.users.register(payload),
    authorizationToken: {
      provider: () => admin.authorizationTokens.issue({ unlinkAddress }),
    },
  });

  console.log('📝 Registering user...');
  await client.ensureRegistered();
  console.log('✅ Registered!');

  console.log(`💸 Depositing ${amount} tokens (with auto-approval)...`);

  let tx;
  try {
    tx = await Promise.race([
      client.depositWithApproval({
        token: tokenAddress,
        amount: amount.toString(),
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Deposit timed out after 60s')), 60000)
      ),
    ]);
  } catch (err) {
    console.error('❌ depositWithApproval failed:', err.message);
    throw err;
  }

  console.log('⏳ Waiting for transaction confirmation...');
  let confirmed;
  try {
    confirmed = await Promise.race([
      tx.wait(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Confirmation timed out after 60s')), 60000)
      ),
    ]);
  } catch (err) {
    console.error('❌ tx.wait() failed:', err.message);
    throw err;
  }

  console.log(`✅ Deposit Status: ${confirmed.status}`);

  if (confirmed.status === 'processed') {
    console.log('🎉 Deposit successful!');
    return {
      success: true,
      status: confirmed.status,
      unlinkAddress,
      evmAddress: evmWallet.address,
      amount: amount.toString(),
      tokenAddress,
    };
  } else if (confirmed.status === 'failed') {
    throw new Error('Deposit transaction failed on-chain.');
  }

  return {
    success: false,
    status: confirmed.status,
    unlinkAddress,
    evmAddress: evmWallet.address,
  };
}

export { executeUnlinkDeposit };
