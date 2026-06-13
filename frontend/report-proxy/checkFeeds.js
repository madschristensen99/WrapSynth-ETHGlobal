// Check which candidate stream IDs are served by the testnet data engine.
// Usage: node checkFeeds.js 0xfeedid1 0xfeedid2 ...

import { loadCredentials, apiGet, TESTNET_API } from './auth.js';

const creds = loadCredentials();
const candidates = process.argv.slice(2);

const { feeds } = await apiGet(TESTNET_API, '/api/v1/feeds', creds);
const available = new Set(feeds.map((f) => f.feedID.toLowerCase()));

for (const id of candidates) {
    const listed = available.has(id.toLowerCase());
    let report = 'n/a';
    try {
        const r = await apiGet(TESTNET_API, `/api/v1/reports/latest?feedID=${id}`, creds);
        const ts = r.report?.observationsTimestamp;
        report = `OK (obsTs=${ts}, age=${Math.floor(Date.now() / 1000) - ts}s)`;
    } catch (e) {
        report = `FAIL: ${e.message.slice(0, 120)}`;
    }
    console.log(`${id}\n  listed=${listed}  latestReport=${report}`);
}
