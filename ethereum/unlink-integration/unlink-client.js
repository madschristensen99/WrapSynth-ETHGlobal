require('dotenv').config();
const { Client, SupportedNetworks } = require('@unlink-xyz/sdk');
const { ethers } = require('ethers');
const tWXMRAddress = process.env.UNLINK_TEST_TOKEN; // Paste your deployed tWXMR address here

// 1. Initialize Unlink Client
// Use 'testnet' for the bounty demo, or 'mainnet' if you have keys
const client = new Client({ 
    network: SupportedNetworks.TESTNET, 
    apiKey: process.env.UNLINK_API_KEY 
});

async function depositUnlink() {
    // Ensure user is registered in the Unlink ecosystem
    await client.ensureRegistered();

    // Get signer from .env (the EVM wallet address)
    const provider = new ethers.JsonRpcProvider("https://rpc.gnosischain.com");
    const signer = new ethers.Wallet(process.env.UNLINK_PRIVATE_KEY, provider);
    
    // Connect the EVM provider to the client so it can sign transactions
    client.setEvmProvider(signer);

    const amount = ethers.parseEther("10"); // 10 tWXMR

    console.log("Depositing...", amount.toString());
    
    // This moves funds from your EVM wallet into the Unlink private state
    const tx = await client.depositWithApproval({
        token: tWXMRAddress,
        amount: amount.toString(),
    });

    const status = await tx.wait();
    console.log("Deposit Status:", status);
}

depositUnlink().catch(console.error);