// swapFlow.js — Omni-token on-chain Uniswap V3 swaps on Base Sepolia.
//
// Trades any registered token ↔ any other, routing through WETH as the hub:
//   • WETH ↔ token  → single-hop (the token's own WETH-pool fee tier)
//   • token ↔ token → multi-hop via WETH (exactInput with an encoded path)
// Direct on-chain only (QuoterV2 + SwapRouter02) — the Uniswap Trading API can't route
// custom Base Sepolia pools. No proxy, no API key, no Permit2; just an ERC20 approve of
// the input token. Reads use a dedicated Base Sepolia client; every tx is hard-pinned to
// Base Sepolia (_assertOnBaseSepolia) so nothing leaks onto Gnosis.

import { UNISWAP_CONFIG } from './config.js?v=20260617';
import { saveToHistory } from './storage.js?v=20260617';

// ─── viem (dynamic import) ──────────────────────────────────────────────────────
let _viemPromise = null;
function viem() { if (!_viemPromise) _viemPromise = import('https://esm.sh/viem@2.7.0'); return _viemPromise; }

let _publicClient = null;
async function readClient() {
    if (_publicClient) return _publicClient;
    const { createPublicClient, http } = await viem();
    _publicClient = createPublicClient({
        transport: http(UNISWAP_CONFIG.rpcUrl, { retryCount: 3, retryDelay: 1500, timeout: 15000 })
    });
    return _publicClient;
}

// ─── ABIs ───────────────────────────────────────────────────────────────────────
const QUOTER_SINGLE_ABI = [{
    type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
    inputs: [{ name: 'params', type: 'tuple', components: [
        { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
        { name: 'amountIn', type: 'uint256' }, { name: 'fee', type: 'uint24' },
        { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ] }],
    outputs: [
        { name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96After', type: 'uint160' },
        { name: 'initializedTicksCrossed', type: 'uint32' }, { name: 'gasEstimate', type: 'uint256' },
    ],
}];

const QUOTER_PATH_ABI = [{
    type: 'function', name: 'quoteExactInput', stateMutability: 'nonpayable',
    inputs: [{ name: 'path', type: 'bytes' }, { name: 'amountIn', type: 'uint256' }],
    outputs: [
        { name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96AfterList', type: 'uint160[]' },
        { name: 'initializedTicksCrossedList', type: 'uint32[]' }, { name: 'gasEstimate', type: 'uint256' },
    ],
}];

const SWAP_ROUTER_ABI = [
    {
        type: 'function', name: 'exactInputSingle', stateMutability: 'payable',
        inputs: [{ name: 'params', type: 'tuple', components: [
            { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
            { name: 'fee', type: 'uint24' }, { name: 'recipient', type: 'address' },
            { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
            { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ] }],
        outputs: [{ name: 'amountOut', type: 'uint256' }],
    },
    {
        type: 'function', name: 'exactInput', stateMutability: 'payable',
        inputs: [{ name: 'params', type: 'tuple', components: [
            { name: 'path', type: 'bytes' }, { name: 'recipient', type: 'address' },
            { name: 'amountIn', type: 'uint256' }, { name: 'amountOutMinimum', type: 'uint256' },
        ] }],
        outputs: [{ name: 'amountOut', type: 'uint256' }],
    },
];

const ERC20_ABI = [
    { type: 'function', name: 'allowance', stateMutability: 'view',
      inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ type: 'uint256' }] },
    { type: 'function', name: 'approve', stateMutability: 'nonpayable',
      inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
    { type: 'function', name: 'balanceOf', stateMutability: 'view',
      inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const MAX_UINT256 = (1n << 256n) - 1n;

// ─── Formatting helpers ───────────────────────────────────────────────────────
function formatUnits(raw, decimals) {
    if (raw === null || raw === undefined) return '—';
    const n = BigInt(raw);
    const divisor = 10n ** BigInt(decimals);
    const whole = n / divisor;
    const frac = n % divisor;
    const show = Math.min(decimals, 8);
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, show).replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

function parseUnits(value, decimals) {
    if (value === undefined || value === null || value === '' || isNaN(Number(value))) return 0n;
    const [whole, frac = ''] = String(value).split('.');
    const fracPadded = frac.slice(0, decimals).padEnd(decimals, '0');
    return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

function toHex(n) { return '0x' + BigInt(n).toString(16); }
function feePct(fee) { return `${(fee / 10000).toFixed(2)}%`; }

// ─── SwapFlow ─────────────────────────────────────────────────────────────────
class SwapFlow {
    constructor() {
        this._initialized = false;
        this.fromKey = 'tWSXMR';
        this.toKey = 'USDC';
        this.quoteOut = null;       // bigint output amount (toToken decimals)
        this.currentRoute = null;
        this.fromBalance = 0n;
        this._debounceTimer = null;
        this.slippageMode = 'auto'; // 'auto' | bps number (e.g. 50 = 0.5%)
        this.lastImpactBps = 0;     // most recent on-chain price impact, in bps
    }

    // Effective slippage in bps. 'auto' = on-chain price impact + 0.5% buffer, clamped to
    // [0.5%, 5%]; otherwise the manually selected bps. (The Trading API's autoSlippage can't
    // run on Base Sepolia, so we derive slippage from QuoterV2's price impact instead.)
    _effectiveSlippageBps() {
        if (this.slippageMode === 'auto') return Math.min(500, Math.max(50, Math.round(this.lastImpactBps) + 50));
        return this.slippageMode;
    }

    _renderSlippage() {
        const bps = this._effectiveSlippageBps();
        const valEl = document.getElementById('swap-slippage-value');
        if (valEl) valEl.textContent = this.slippageMode === 'auto' ? `Auto · ${(bps / 100).toFixed(2)}%` : `${(bps / 100).toFixed(2)}%`;
        document.getElementById('swap-panel')?.querySelectorAll('.slip-btn').forEach(b => {
            const active = String(this.slippageMode) === b.dataset.slip;
            b.style.background = active ? 'var(--primary, #f97316)' : 'rgba(255,255,255,0.6)';
            b.style.color = active ? '#fff' : '';
            b.style.borderColor = active ? 'var(--primary, #f97316)' : 'rgba(0,0,0,0.12)';
        });
    }

    // ── Token helpers ───────────────────────────────────────────────────────────
    get _weth() { return UNISWAP_CONFIG.weth; }
    _token(key) { return UNISWAP_CONFIG.tokens[key]; }
    _fromToken() { return this._token(this.fromKey); }
    _toToken() { return this._token(this.toKey); }
    _isWeth(t) { return !!t.isWeth || t.address.toLowerCase() === this._weth.toLowerCase(); }
    _otherKey(key) { return Object.keys(UNISWAP_CONFIG.tokens).find(k => k !== key); }

    // Route: single-hop when one side is WETH, else multi-hop via WETH.
    async _buildRoute(from, to) {
        if (this._isWeth(from) || this._isWeth(to)) {
            const fee = this._isWeth(from) ? to.wethPoolFee : from.wethPoolFee;
            return { type: 'single', fee, tokenIn: from.address, tokenOut: to.address, hops: [from.symbol, to.symbol] };
        }
        const { encodePacked } = await viem();
        const path = encodePacked(
            ['address', 'uint24', 'address', 'uint24', 'address'],
            [from.address, from.wethPoolFee, this._weth, to.wethPoolFee, to.address],
        );
        return { type: 'multi', path, fees: [from.wethPoolFee, to.wethPoolFee], hops: [from.symbol, 'WETH', to.symbol] };
    }

    async _quoteRoute(route, amountIn) {
        const { encodeFunctionData, decodeFunctionResult } = await viem();
        const pc = await readClient();
        if (route.type === 'single') {
            const data = encodeFunctionData({ abi: QUOTER_SINGLE_ABI, functionName: 'quoteExactInputSingle',
                args: [{ tokenIn: route.tokenIn, tokenOut: route.tokenOut, amountIn, fee: route.fee, sqrtPriceLimitX96: 0n }] });
            const res = await pc.call({ to: UNISWAP_CONFIG.quoterV2, data });
            return decodeFunctionResult({ abi: QUOTER_SINGLE_ABI, functionName: 'quoteExactInputSingle', data: res.data })[0];
        }
        const data = encodeFunctionData({ abi: QUOTER_PATH_ABI, functionName: 'quoteExactInput', args: [route.path, amountIn] });
        const res = await pc.call({ to: UNISWAP_CONFIG.quoterV2, data });
        return decodeFunctionResult({ abi: QUOTER_PATH_ABI, functionName: 'quoteExactInput', data: res.data })[0];
    }

    async _swapCalldata(route, user, amountIn, minOut) {
        const { encodeFunctionData } = await viem();
        if (route.type === 'single') {
            return encodeFunctionData({ abi: SWAP_ROUTER_ABI, functionName: 'exactInputSingle',
                args: [{ tokenIn: route.tokenIn, tokenOut: route.tokenOut, fee: route.fee, recipient: user,
                         amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
        }
        return encodeFunctionData({ abi: SWAP_ROUTER_ABI, functionName: 'exactInput',
            args: [{ path: route.path, recipient: user, amountIn, amountOutMinimum: minOut }] });
    }

    // ── Network helpers ─────────────────────────────────────────────────────────
    async _walletChainId() {
        try { return parseInt(await window.ethereum.request({ method: 'eth_chainId' }), 16); }
        catch { return null; }
    }

    async switchToBaseSepolia() {
        try {
            await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: UNISWAP_CONFIG.chainIdHex }] });
        } catch (err) {
            if (err.code === 4902) {
                await window.ethereum.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: UNISWAP_CONFIG.chainIdHex, chainName: UNISWAP_CONFIG.chainName,
                        rpcUrls: [UNISWAP_CONFIG.rpcUrl], blockExplorerUrls: [UNISWAP_CONFIG.blockExplorer],
                        nativeCurrency: UNISWAP_CONFIG.nativeCurrency,
                    }],
                });
            } else { throw err; }
        }
    }

    async _account() {
        const accts = await window.ethereum.request({ method: 'eth_accounts' }).catch(() => []);
        return accts[0] || null;
    }

    // Switch the wallet to Base Sepolia AND verify it actually landed there before sending
    // any tx. Without the verify, a tx can go out on the app's default chain (Gnosis) — the
    // wallet then asks for xDai gas and the router's transferFrom reverts with "STF".
    async _assertOnBaseSepolia() {
        if (await this._walletChainId() !== UNISWAP_CONFIG.chainId) await this.switchToBaseSepolia();
        const start = Date.now();
        while (Date.now() - start < 8000) {
            if (await this._walletChainId() === UNISWAP_CONFIG.chainId) return;
            await new Promise(r => setTimeout(r, 250));
        }
        throw new Error(`Wallet must be on ${UNISWAP_CONFIG.chainName} (84532). Switch networks in your wallet and retry.`);
    }

    // ── Status display ────────────────────────────────────────────────────────────
    _setStatus(msg, isError = false) {
        const el = document.getElementById('swap-status');
        if (!el) return;
        el.innerHTML = msg;
        el.classList.remove('hidden');
        el.style.color = isError ? 'var(--error-color, #e53e3e)' : 'var(--text-secondary-light)';
    }
    _clearStatus() { document.getElementById('swap-status')?.classList.add('hidden'); }

    // ── Selectors / route / balance ───────────────────────────────────────────────
    _populateSelects() {
        for (const id of ['swap-from-select', 'swap-to-select']) {
            const sel = document.getElementById(id);
            if (!sel) continue;
            sel.innerHTML = '';
            for (const [key, t] of Object.entries(UNISWAP_CONFIG.tokens)) {
                sel.appendChild(Object.assign(document.createElement('option'), { value: key, textContent: t.symbol }));
            }
        }
        this._syncSelectValues();
    }
    _syncSelectValues() {
        const fs = document.getElementById('swap-from-select'); if (fs) fs.value = this.fromKey;
        const ts = document.getElementById('swap-to-select');   if (ts) ts.value = this.toKey;
    }

    // Show the routing path + fee(s); always visible, independent of the quote.
    _renderRoute() {
        const from = this._fromToken(), to = this._toToken();
        const single = this._isWeth(from) || this._isWeth(to);
        const hops = single ? [from.symbol, to.symbol] : [from.symbol, 'WETH', to.symbol];
        const routeEl = document.getElementById('swap-route');
        if (routeEl) routeEl.textContent = hops.join(' → ');
        const feeEl = document.getElementById('swap-pool-fee');
        if (feeEl) {
            feeEl.textContent = single
                ? feePct(this._isWeth(from) ? to.wethPoolFee : from.wethPoolFee)
                : `${feePct(from.wethPoolFee)} + ${feePct(to.wethPoolFee)}`;
        }
    }

    async fetchFromBalance() {
        const user = await this._account();
        const from = this._fromToken();
        const balEl = document.getElementById('swap-from-balance');
        if (!user) { this.fromBalance = 0n; if (balEl) balEl.textContent = ''; return; }
        try {
            const pc = await readClient();
            this.fromBalance = await pc.readContract({ address: from.address, abi: ERC20_ABI, functionName: 'balanceOf', args: [user] });
        } catch { this.fromBalance = 0n; }
        if (balEl) balEl.textContent = `Balance: ${formatUnits(this.fromBalance, from.decimals)} ${from.symbol}`;
    }

    // ── Quote ───────────────────────────────────────────────────────────────────
    _resetQuoteUI() {
        this.quoteOut = null;
        document.getElementById('swap-quote-box')?.classList.add('hidden');
        const outEl = document.getElementById('swap-to-amount');
        if (outEl) outEl.textContent = '—';
        const btn = document.getElementById('swap-execute');
        if (btn) { btn.disabled = true; btn.querySelector('.btn-text').textContent = 'Enter an amount'; }
    }

    async getQuote() {
        const from = this._fromToken(), to = this._toToken();
        const amountInput = document.getElementById('swap-from-amount')?.value?.trim();
        const btn = document.getElementById('swap-execute');

        if (!amountInput || Number(amountInput) <= 0) { this._resetQuoteUI(); this._clearStatus(); return; }
        const amountIn = parseUnits(amountInput, from.decimals);
        if (amountIn <= 0n) { this._resetQuoteUI(); return; }

        if (btn) { btn.disabled = true; btn.querySelector('.btn-text').textContent = 'Getting quote…'; }
        this._setStatus('Fetching on-chain quote…');

        try {
            const route = await this._buildRoute(from, to);
            this.currentRoute = route;
            const amountOut = await this._quoteRoute(route, amountIn);
            if (!amountOut || amountOut === 0n) throw new Error('zero output');
            this.quoteOut = amountOut;

            const outEl = document.getElementById('swap-to-amount');
            if (outEl) outEl.textContent = `${formatUnits(amountOut, to.decimals)} ${to.symbol}`;

            const inF = Number(amountInput), outF = Number(formatUnits(amountOut, to.decimals));
            const rateEl = document.getElementById('swap-rate');
            if (rateEl) rateEl.textContent = inF > 0 ? `1 ${from.symbol} ≈ ${(outF / inF).toFixed(6)} ${to.symbol}` : '—';

            // Price impact (on-chain, via a tiny QuoterV2 reference quote) → feeds auto-slippage.
            const impact = await this._estimatePriceImpact(route, from, amountIn, amountOut).catch(() => null);
            this.lastImpactBps = impact != null ? impact * 100 : 0;
            const impactEl = document.getElementById('swap-price-impact');
            if (impactEl) {
                if (impact == null) { impactEl.textContent = '—'; impactEl.style.color = ''; }
                else {
                    impactEl.textContent = `${impact.toFixed(2)}%`;
                    impactEl.style.color = impact > 5 ? 'var(--error-color, #e53e3e)' : impact > 2 ? '#d69e2e' : '';
                }
            }

            // Min received using the effective (auto/manual) slippage tolerance.
            const minOut = (amountOut * BigInt(10000 - this._effectiveSlippageBps())) / 10000n;
            const minEl = document.getElementById('swap-min-received');
            if (minEl) minEl.textContent = `${formatUnits(minOut, to.decimals)} ${to.symbol}`;
            this._renderSlippage();

            document.getElementById('swap-quote-box')?.classList.remove('hidden');
            this._clearStatus();

            if (btn) {
                btn.disabled = false;
                const needApprove = await this._needsApproval(amountIn).catch(() => false);
                btn.querySelector('.btn-text').textContent = needApprove ? 'Approve & Swap' : 'Swap';
            }
        } catch (err) {
            this._resetQuoteUI();
            this._setStatus('No quote — amount likely exceeds pool liquidity. Try a smaller amount.', true);
            if (btn) { btn.disabled = true; btn.querySelector('.btn-text').textContent = 'Enter an amount'; }
        }
    }

    // Coarse price impact: quote a tiny reference amount (1 fromToken) vs the actual quote.
    async _estimatePriceImpact(route, from, amountIn, amountOut) {
        const refIn = 10n ** BigInt(from.decimals);
        if (refIn >= amountIn) return null;
        const refOut = await this._quoteRoute(route, refIn).catch(() => null);
        if (!refOut || refOut === 0n) return null;
        const spotOut = (refOut * amountIn) / refIn;
        if (spotOut === 0n) return null;
        const impact = Number((spotOut - amountOut) * 10000n / spotOut) / 100;
        return impact > 0 ? impact : 0;
    }

    // ── Approval ──────────────────────────────────────────────────────────────────
    async _needsApproval(amountIn) {
        const user = await this._account();
        if (!user) return false;
        const from = this._fromToken();
        const pc = await readClient();
        const allowance = await pc.readContract({
            address: from.address, abi: ERC20_ABI, functionName: 'allowance', args: [user, UNISWAP_CONFIG.swapRouter02],
        });
        return allowance < amountIn;
    }

    async _estimateGasHex({ from, to, data, value }) {
        const pc = await readClient();
        const g = await pc.estimateGas({ account: from, to, data, value: value && value !== '0x0' ? BigInt(value) : 0n });
        return toHex((g * 125n) / 100n);
    }

    async _sendApproval(user) {
        await this._assertOnBaseSepolia(); // never approve on the wrong chain
        const { encodeFunctionData } = await viem();
        const token = this._fromToken().address;
        const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [UNISWAP_CONFIG.swapRouter02, MAX_UINT256] });
        let gas;
        try { gas = await this._estimateGasHex({ from: user, to: token, data, value: '0x0' }); } catch { gas = toHex(100000n); }
        const txHash = await window.ethereum.request({
            method: 'eth_sendTransaction', params: [{ from: user, to: token, data, value: '0x0', gas }],
        });
        this._setStatus(`Approval sent: ${txHash.slice(0, 10)}… — waiting…`);
        const pc = await readClient();
        await pc.waitForTransactionReceipt({ hash: txHash });
        this._setStatus('Approval confirmed.');
    }

    // ── Execute swap ──────────────────────────────────────────────────────────────
    async executeSwap() {
        const btn = document.getElementById('swap-execute');
        const from = this._fromToken(), to = this._toToken();
        const amountInput = document.getElementById('swap-from-amount')?.value?.trim();
        if (!amountInput || Number(amountInput) <= 0 || !this.quoteOut) { return this.getQuote(); }

        const setText = t => btn && (btn.querySelector('.btn-text').textContent = t);
        const amountIn = parseUnits(amountInput, from.decimals);
        const minOut = (this.quoteOut * BigInt(10000 - this._effectiveSlippageBps())) / 10000n;

        try {
            if (btn) btn.disabled = true;

            setText('Switching to Base Sepolia…');
            await this._assertOnBaseSepolia();

            const user = await this._account();
            if (!user) throw new Error('Wallet not connected');

            // 1. Approval of the input token to the router (both directions are ERC-20s).
            if (await this._needsApproval(amountIn)) {
                setText('Approving…');
                this._setStatus(`Approve ${from.symbol} in your wallet…`);
                await this._sendApproval(user);
            }

            // 2. Build calldata for the route (single-hop exactInputSingle / multi-hop exactInput).
            const route = this.currentRoute || await this._buildRoute(from, to);
            const data = await this._swapCalldata(route, user, amountIn, minOut);
            const value = '0x0';
            const to_ = UNISWAP_CONFIG.swapRouter02;

            // 3. Pre-estimate gas on our own RPC and send an explicit limit. A revert here means
            //    the swap would fail on-chain — surface the real reason.
            setText('Estimating gas…');
            let gas;
            try { gas = await this._estimateGasHex({ from: user, to: to_, data, value }); }
            catch (e) { throw new Error(`Swap would fail: ${e?.shortMessage || e?.message || 'transaction would revert'}`); }

            // 4. Broadcast — re-verify the chain (it can drift while the approval confirms).
            await this._assertOnBaseSepolia();
            setText('Confirm in wallet…');
            this._setStatus('Confirm the swap in your wallet…');
            const txHash = await window.ethereum.request({
                method: 'eth_sendTransaction', params: [{ from: user, to: to_, data, value, gas }],
            });

            setText('Swapping…');
            this._setStatus(`Tx sent: ${txHash.slice(0, 10)}… — waiting for confirmation…`);
            const pc = await readClient();
            const receipt = await pc.waitForTransactionReceipt({ hash: txHash });
            if (receipt.status === 'reverted') throw new Error('Transaction reverted on-chain');

            // 5. History + success
            try {
                saveToHistory({
                    type: 'swap', txHash, tokenIn: from.symbol, tokenOut: to.symbol,
                    amountIn: amountInput, amountOut: formatUnits(this.quoteOut, to.decimals),
                    chainId: UNISWAP_CONFIG.chainId, chainName: UNISWAP_CONFIG.chainName, timestamp: Date.now(),
                });
            } catch { /* best effort */ }

            this._setStatus(
                `Swap confirmed! <a href="${UNISWAP_CONFIG.blockExplorer}/tx/${txHash}" target="_blank" rel="noopener" style="color:var(--primary-color,#f97316);text-decoration:underline;">View on BaseScan</a>`
            );
            document.getElementById('swap-status').style.color = 'var(--success-color, #38a169)';

            this._resetQuoteUI();
            const inEl = document.getElementById('swap-from-amount');
            if (inEl) inEl.value = '';
            await this.fetchFromBalance();
        } catch (err) {
            console.error('[swapFlow] executeSwap error:', err);
            this._setStatus(`Error: ${err?.shortMessage || err?.message || 'Swap failed'}`, true);
            if (btn) { btn.disabled = false; btn.querySelector('.btn-text').textContent = 'Retry Swap'; }
            return;
        }
        if (btn) { btn.disabled = true; btn.querySelector('.btn-text').textContent = 'Enter an amount'; }
    }

    // ── Selection changes ─────────────────────────────────────────────────────────
    async _onSelect(side, value) {
        if (side === 'from') { this.fromKey = value; if (this.toKey === value) this.toKey = this._otherKey(value); }
        else { this.toKey = value; if (this.fromKey === value) this.fromKey = this._otherKey(value); }
        this._syncSelectValues();
        this._renderRoute();
        this._resetQuoteUI();
        this._clearStatus();
        await this.fetchFromBalance();
        const v = document.getElementById('swap-from-amount')?.value;
        if (v && Number(v) > 0) this.getQuote();
    }

    async flip() {
        [this.fromKey, this.toKey] = [this.toKey, this.fromKey];
        this._syncSelectValues();
        this._renderRoute();
        const inEl = document.getElementById('swap-from-amount');
        if (inEl) inEl.value = '';
        this._resetQuoteUI();
        this._clearStatus();
        await this.fetchFromBalance();
    }

    // ── Network notice ────────────────────────────────────────────────────────────
    async _refreshNetworkNotice() {
        const onChain = await this._walletChainId() === UNISWAP_CONFIG.chainId;
        document.getElementById('swap-network-notice')?.classList.toggle('hidden', onChain);
    }

    async _ensureBaseSepolia() {
        if (!window.ethereum) return;
        if (await this._walletChainId() === UNISWAP_CONFIG.chainId) return;
        try { await this.switchToBaseSepolia(); } catch { /* declined — notice stays visible */ }
    }

    // ── init ──────────────────────────────────────────────────────────────────────
    async init() {
        this._populateSelects();
        this._renderRoute();
        this._renderSlippage();
        await this._ensureBaseSepolia();
        await this._refreshNetworkNotice();
        await this.fetchFromBalance();
        this._resetQuoteUI();

        if (this._initialized) return;
        this._initialized = true;

        document.getElementById('swap-from-amount')?.addEventListener('input', () => {
            clearTimeout(this._debounceTimer);
            this._debounceTimer = setTimeout(() => this.getQuote(), 400);
        });

        document.getElementById('swap-from-select')?.addEventListener('change', e => this._onSelect('from', e.target.value));
        document.getElementById('swap-to-select')?.addEventListener('change', e => this._onSelect('to', e.target.value));
        document.getElementById('swap-flip')?.addEventListener('click', () => this.flip());

        document.getElementById('swap-panel')?.querySelectorAll('.percentage-btn[data-pct]').forEach(b => {
            b.addEventListener('click', () => {
                const pct = Number(b.dataset.pct);
                if (this.fromBalance === 0n) return;
                const from = this._fromToken();
                const amount = (this.fromBalance * BigInt(pct)) / 100n;
                const inputEl = document.getElementById('swap-from-amount');
                if (inputEl) {
                    inputEl.value = formatUnits(amount, from.decimals);
                    clearTimeout(this._debounceTimer);
                    this._debounceTimer = setTimeout(() => this.getQuote(), 100);
                }
            });
        });

        document.getElementById('swap-switch-network')?.addEventListener('click', async () => {
            try {
                await this.switchToBaseSepolia();
                await this._refreshNetworkNotice();
                await this.fetchFromBalance();
            } catch (err) { this._setStatus(`Network switch failed: ${err.message}`, true); }
        });

        // Slippage controls (Auto / 0.1% / 0.5% / 1%)
        document.getElementById('swap-panel')?.querySelectorAll('.slip-btn').forEach(b => {
            b.addEventListener('click', () => {
                this.slippageMode = b.dataset.slip === 'auto' ? 'auto' : Number(b.dataset.slip);
                this._renderSlippage();
                const v = document.getElementById('swap-from-amount')?.value;
                if (v && Number(v) > 0) this.getQuote();
            });
        });

        document.getElementById('swap-execute')?.addEventListener('click', () => this.executeSwap());

        if (window.ethereum?.on) {
            window.ethereum.on('chainChanged', () => { this._refreshNetworkNotice(); this.fetchFromBalance(); });
            window.ethereum.on('accountsChanged', () => this.fetchFromBalance());
        }
    }
}

// ─── Singleton ────────────────────────────────────────────────────────────────
let _instance = null;
export function getSwapFlow() {
    if (!_instance) _instance = new SwapFlow();
    return _instance;
}
