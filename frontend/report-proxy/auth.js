// Chainlink Data Streams API — HMAC request signing
// Docs: https://docs.chain.link/data-streams/reference/data-streams-api/authentication

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Load CHAINLINK_API_KEY / CHAINLINK_API_SECRET from repo-root .env (zero-dependency) */
export function loadCredentials() {
    let key = process.env.CHAINLINK_API_KEY;
    let secret = process.env.CHAINLINK_API_SECRET;

    if (!key || !secret) {
        const envPath = path.resolve(__dirname, '../../.env');
        if (fs.existsSync(envPath)) {
            for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
                const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
                if (!m) continue;
                if (m[1] === 'CHAINLINK_API_KEY' && !key) key = m[2];
                if (m[1] === 'CHAINLINK_API_SECRET' && !secret) secret = m[2];
            }
        }
    }

    if (!key || !secret) {
        throw new Error('Missing CHAINLINK_API_KEY / CHAINLINK_API_SECRET (set env vars or repo-root .env)');
    }
    return { key, secret };
}

/**
 * Generate the auth headers for a Data Streams API request.
 * @param {string} method - HTTP method, e.g. 'GET'
 * @param {string} pathWithQuery - e.g. '/api/v1/reports/latest?feedID=0x...'
 * @param {{key: string, secret: string}} creds
 * @param {string} body - request body ('' for GET)
 */
export function authHeaders(method, pathWithQuery, creds, body = '') {
    const timestamp = Date.now();
    const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
    const stringToSign = `${method} ${pathWithQuery} ${bodyHash} ${creds.key} ${timestamp}`;
    const signature = crypto
        .createHmac('sha256', Buffer.from(creds.secret, 'utf8'))
        .update(stringToSign)
        .digest('hex');

    return {
        'Authorization': creds.key,
        'X-Authorization-Timestamp': String(timestamp),
        'X-Authorization-Signature-SHA256': signature,
    };
}

export const TESTNET_API = 'https://api.testnet-dataengine.chain.link';
export const MAINNET_API = 'https://api.dataengine.chain.link';

/** Signed GET against the Data Streams API. Returns parsed JSON. */
export async function apiGet(baseUrl, pathWithQuery, creds) {
    const headers = authHeaders('GET', pathWithQuery, creds);
    const res = await fetch(baseUrl + pathWithQuery, { headers });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Data Streams API ${res.status}: ${text}`);
    }
    return JSON.parse(text);
}
