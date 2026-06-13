// Chainlink Data Streams report proxy
//
// The Data Streams API requires HMAC-signed requests, so the API secret must
// never reach the browser. This tiny server holds the credentials and serves
// signed `fullReport` blobs to the frontend, which passes them on-chain to
// updateOraclePrices for verification.
//
// Usage: node server.js   (reads CHAINLINK_API_KEY / CHAINLINK_API_SECRET from
//        env or the repo-root .env; listens on PORT, default 3002)

import http from 'node:http';
import { loadCredentials, apiGet, TESTNET_API } from './auth.js';

const PORT = process.env.PORT || 3002;
const creds = loadCredentials();

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname !== '/reports') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found. Use GET /reports?feedIDs=0x...,0x...' }));
        return;
    }

    const feedIDs = (url.searchParams.get('feedIDs') || '').split(',').filter(Boolean);
    if (feedIDs.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing feedIDs query parameter' }));
        return;
    }

    try {
        const reports = await Promise.all(
            feedIDs.map(async (id) => {
                const r = await apiGet(TESTNET_API, `/api/v1/reports/latest?feedID=${id}`, creds);
                return {
                    feedID: r.report.feedID,
                    observationsTimestamp: r.report.observationsTimestamp,
                    fullReport: r.report.fullReport,
                };
            })
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reports }));
    } catch (e) {
        console.error('Report fetch failed:', e.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
    }
});

server.listen(PORT, () => {
    console.log(`Data Streams report proxy listening on http://localhost:${PORT}`);
    console.log(`Try: http://localhost:${PORT}/reports?feedIDs=<feedID1>,<feedID2>`);
});
