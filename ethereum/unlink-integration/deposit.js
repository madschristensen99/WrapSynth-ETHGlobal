// ethereum/unlink-integration/deposit.js
const express = require('express');
const { UnlinkSDK } = require('@unlink-xyz/sdk'); // Assuming this is the package name
require('dotenv').config();

const app = express();
app.use(express.json());

// Initialize Unlink SDK with your config (e.g., zk-program path, verifier address)
// Note: You may need to point to a specific zkey/vk file from the Unlink repo
const unlinkSDK = new UnlinkSDK({
  // ... configuration specifics for your setup ...
});

app.post('/deposit', async (req, res) => {
    try {
        const { userAddress, amount, tokenContract } = req.body;
        
        // 1. Prepare the deposit payload
        const depositPayload = await unlinkSDK.prepareDeposit({
            token: tokenContract, // Your tWXMR address
            to: userAddress,
            amount: amount
        });

        // 2. Return the proof/request object to the client
        res.json({ 
            success: true, 
            payload: depositPayload 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Unlink Deposit Service running on port ${PORT}`));