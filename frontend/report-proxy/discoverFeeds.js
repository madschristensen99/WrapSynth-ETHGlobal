// List available Data Streams feeds on the testnet data engine.
// Usage: node discoverFeeds.js [filter]

import { loadCredentials, apiGet, TESTNET_API } from './auth.js';

const filter = (process.argv[2] || '').toLowerCase();
const creds = loadCredentials();

const data = await apiGet(TESTNET_API, '/api/v1/feeds', creds);
const feeds = data.feeds || data;

console.log(`Total testnet feeds: ${feeds.length}`);
for (const f of feeds) {
    const desc = (f.feedName || f.description || f.name || '').toString();
    const line = `${f.feedID || f.feedId}  ${desc}`;
    if (!filter || line.toLowerCase().includes(filter)) {
        console.log(line);
    }
}
