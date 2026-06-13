require('dotenv').config();
const express = require('express');
const { Client, SupportedNetworks } = require('@unlink-xyz/sdk');
const app = express();
app.use(express.json());

const client = new Client({ 
    network: SupportedNetworks.TESTNET, 
    apiKey: process.env.UNLINK_API_KEY 
});

// Primitive 2: Withdraw from Unlink Privacy back to EVM
app.post('/withdraw', async (req, res) => {
    const { amount, destinationAddress } = req.body;

    try {
        // This triggers the reveal and transfer of private state to the public EVM
        const tx = await client.withdraw({
            token: process.env.UNLINK_TEST_TOKEN, // tWXMR address
            amount: ethers.parseEther(amount).toString(),
            destination: destinationAddress,
            provider: new ethers.JsonRpcProvider("https://rpc.gnosischain.com"), // Or your backend wallet
        });

        res.json({ message: "Withdrawal initiated", txHash: await tx.hash() });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(3000, () => console.log('Unlink Privacy Server running on port 3000'));