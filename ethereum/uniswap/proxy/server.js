import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3002;
const UNISWAP_BASE = 'https://trade-api.gateway.uniswap.org/v1';

if (!process.env.UNISWAP_API_KEY) {
    console.warn('[warn] UNISWAP_API_KEY is not set — API calls will be rejected by upstream');
}

app.use(cors({ origin: '*', allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json());

// Headers injected on every upstream call.
// x-universal-router-version: 2.0 is required by the Uniswap Trading API.
function upstreamHeaders() {
    return {
        'Content-Type': 'application/json',
        'x-api-key': process.env.UNISWAP_API_KEY || '',
        'x-universal-router-version': '2.0',
        'Origin': 'https://app.uniswap.org',
    };
}

// ─── POST /uniswap/check-approval ────────────────────────────────────────────
// Body: { token, amount, walletAddress, chainId }
// Returns: { approval: null | { to, data, value, from, chainId } }
app.post('/uniswap/check-approval', async (req, res) => {
    try {
        console.log(`[POST] /uniswap/check-approval → upstream`);

        const upstream = await fetch(`${UNISWAP_BASE}/check_approval`, {
            method: 'POST',
            headers: upstreamHeaders(),
            body: JSON.stringify(req.body),
        });

        const body = await upstream.json();
        console.log(`  ↳ ${upstream.status}`);

        return res.status(upstream.ok ? 200 : upstream.status).json(body);
    } catch (err) {
        console.error('[check-approval] network error:', err.message);
        return res.status(502).json({ error: 'Upstream unreachable', detail: err.message });
    }
});

// ─── POST /uniswap/quote ──────────────────────────────────────────────────────
// Body: { type, amount, tokenIn, tokenOut, tokenInChainId, tokenOutChainId,
//         swapper, slippageTolerance?, protocols?, routingPreference? }
// Enforces classic AMM routing (protocols V4/V3/V2, routingPreference BEST_PRICE).
// Returns the full Uniswap quote response (routing, quote, permitData, ...).
app.post('/uniswap/quote', async (req, res) => {
    try {
        console.log(`[POST] /uniswap/quote → upstream`);

        const body = { ...req.body };

        // Force classic AMM — UniswapX is not available on testnets.
        // routingPreference must be BEST_PRICE when protocols is set (API constraint).
        if (!body.protocols || body.protocols.length === 0) {
            body.protocols = ['V4', 'V3', 'V2'];
        }
        // 'CLASSIC' is not a valid routingPreference value — only BEST_PRICE or FASTEST.
        if (!body.routingPreference || body.routingPreference === 'CLASSIC') {
            body.routingPreference = 'BEST_PRICE';
        }
        if (!body.slippageTolerance) {
            body.slippageTolerance = 0.5;
        }

        const upstream = await fetch(`${UNISWAP_BASE}/quote`, {
            method: 'POST',
            headers: upstreamHeaders(),
            body: JSON.stringify(body),
        });

        const upstreamBody = await upstream.json();
        console.log(`  ↳ ${upstream.status} routing=${upstreamBody.routing ?? '?'}`);

        return res.status(upstream.ok ? 200 : upstream.status).json(upstreamBody);
    } catch (err) {
        console.error('[quote] network error:', err.message);
        return res.status(502).json({ error: 'Upstream unreachable', detail: err.message });
    }
});

// ─── POST /uniswap/swap ───────────────────────────────────────────────────────
// Body: the full quote response SPREAD into the body (not wrapped in {quote: ...}),
//       plus optional signature and permitData (both required together for CLASSIC).
// Returns: { swap: { to, data, value, from, chainId, gasLimit } }
app.post('/uniswap/swap', async (req, res) => {
    try {
        console.log(`[POST] /uniswap/swap → upstream`);

        const body = req.body;

        // Basic guard: the spread quote must contain at minimum a routing field.
        if (!body || !body.routing) {
            return res.status(400).json({
                error: 'Request body must be the full /quote response spread into the body (not {quote: ...}).'
            });
        }

        const upstream = await fetch(`${UNISWAP_BASE}/swap`, {
            method: 'POST',
            headers: upstreamHeaders(),
            body: JSON.stringify(body),
        });

        const upstreamBody = await upstream.json();
        console.log(`  ↳ ${upstream.status}`);

        if (!upstream.ok) {
            return res.status(upstream.status).json(upstreamBody);
        }

        // Validate calldata is non-empty before returning to client.
        if (!upstreamBody.swap?.data || upstreamBody.swap.data === '0x' || upstreamBody.swap.data === '') {
            console.error('[swap] upstream returned empty calldata');
            return res.status(502).json({ error: 'Upstream returned empty calldata — quote may have expired' });
        }

        return res.json(upstreamBody);
    } catch (err) {
        console.error('[swap] network error:', err.message);
        return res.status(502).json({ error: 'Upstream unreachable', detail: err.message });
    }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'wrapsynth-uniswap-proxy', port: PORT });
});

app.listen(PORT, () => {
    console.log(`WrapSynth Uniswap proxy listening on http://localhost:${PORT}`);
    console.log(`  API key configured: ${process.env.UNISWAP_API_KEY ? 'yes' : 'NO — set UNISWAP_API_KEY in .env'}`);
});
