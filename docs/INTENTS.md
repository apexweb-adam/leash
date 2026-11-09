# NEAR Intents settlement (1Click, dry quotes)

A merchant can want to be paid in USDC on Base while the agent's budget is NEAR on NEAR. Leash keeps the same rule: the agent never chooses where money goes.

Flow (`demo/src/intents.ts`):

1. **Route check, before any network call.** The owner registers one route per allowlisted merchant: destination asset and recipient address. The invoice the agent found must match it. A poisoned invoice that swaps in another recipient or asset is refused here.
2. **Dry quote.** `POST https://1click.chaindefuser.com/v0/quote` with `dry: true`, `swapType: EXACT_OUTPUT`, origin `nep141:wrap.near`. Dry means no deposit address is issued, so nothing can be sent. The module refuses `dry: false`.
3. **Quote verification.** The echoed request must match what we asked for (asset, recipient, amount, swap type, dry), the merchant must get at least the invoice amount (`minAmountOut`), fees (20 bps without a 1Click JWT, Q-006) and slippage within limits, deadline within 15 minutes, no deposit address on a dry quote.
4. **Leash policy.** The NEAR amount the quote needs (`amountIn`) goes through the normal Leash rules (`request_spend`: allowlist, per-tx cap, daily cap, velocity, co-sign). The memo is `intents:<route>:<amount>:<quote digest>`, so the spend log shows exactly which quote it paid for.

Do:

```bash
cd demo && npm ci
npm run intents              # live dry quotes from 1Click (no key, no funds)
npm run intents -- --offline # recorded quote in demo/fixtures/intents-dry-quote.json
```

See (live, Nov 9):

```
[user_task] 4.50 USDC on Base: 1Click dry quote needs 1.2867 wNEAR (merchant gets >= 4.5 USDC, ~24s). Leash: Allowed (rule WithinPolicy).
[inflated] 450 USDC on Base: 1Click dry quote needs 128.4627 wNEAR (merchant gets >= 450 USDC, ~22s). Leash: Blocked (rule PerTxCap).
[injected] 450 USDC to 0x000000000000000000000000000000000000bEEF: REFUSED before quote: recipient ... is not the registered address for coffee-on-base
```

Tests: `demo/test/intents.test.ts` (11 tests: route check, exact amounts, dry-only, API errors, the recorded real quote verifies, five kinds of tampered quote rejected, policy on the quoted amount, digest binding).

Why dry only: NEAR Intents has no testnet (HACKATHON.md Q-007). A live settlement needs a mainnet dev account with a tiny balance and the owner's approval, and a forwarder the contract can allowlist (the 1Click deposit address changes per quote). That forwarder is the next step after the hackathon; the demo recipient `0x5290...9EE7` is an EIP-55 test vector, never send funds to it.
