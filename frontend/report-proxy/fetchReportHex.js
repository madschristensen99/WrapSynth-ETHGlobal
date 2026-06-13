// CLI: print the latest signed `fullReport` (hex with 0x prefix) for a single feed.
// Used by Foundry FFI in tests: `vm.ffi(["node", ".../fetchReportHex.js", "0x..."])`.
//
// Reads CHAINLINK_API_KEY / CHAINLINK_API_SECRET from env or repo-root .env.

import { loadCredentials, apiGet, TESTNET_API } from './auth.js';

const feedID = process.argv[2];
if (!feedID || !feedID.startsWith('0x')) {
    process.stderr.write('Usage: node fetchReportHex.js 0x<feedID>\n');
    process.exit(1);
}

try {
    const creds = loadCredentials();
    const r = await apiGet(TESTNET_API, `/api/v1/reports/latest?feedID=${feedID}`, creds);
    const fr = r.report.fullReport;
    process.stdout.write(fr.startsWith('0x') ? fr : `0x${fr}`);
} catch (e) {
    process.stderr.write(`fetchReportHex failed: ${e.message}\n`);
    process.exit(1);
}
