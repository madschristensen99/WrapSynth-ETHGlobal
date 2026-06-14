import 'dotenv/config';
import * as ethers from 'ethers';

const RPC_URL = process.env.RPC_URL || 'https://base-sepolia.blockscout.com/api/eth-rpc';
const provider = new ethers.JsonRpcProvider(RPC_URL, 84532);
const HUB_ADDRESS = '0x0454983E17b803a2C6ff0d98d5D58676525F4A92';

const HUB_ABI = [
  'event MintInitiated(bytes32 indexed requestId, address indexed initiator, address indexed recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout)'
];

async function test() {
  const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, provider);
  const currentBlock = await provider.getBlockNumber();
  console.log('Current block:', currentBlock);
  
  const fromBlock = currentBlock - 100;
  console.log('Querying from', fromBlock, 'to', currentBlock);
  
  try {
    const filter = hub.filters.MintInitiated();
    const events = await hub.queryFilter(filter, fromBlock, currentBlock);
    console.log('Events found:', events.length);
    for (const e of events) {
      console.log('Mint:', e.args.requestId, 'to vault:', e.args.lpVault);
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
}
test();
