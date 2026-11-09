import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config";
import { buildQuoteRequest, checkInvoice, intentsMemo, quoteDigest, requestDryQuote, toBaseUnits, verifyQuote, type MerchantRoute, type QuoteResponse } from "../src/intents";
import { OfflineLeash } from "../src/simulator";

const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const REC = "0x52908400098527886E0F7030069857D2E4169EE7";
const route: MerchantRoute = { merchant: "coffee.testnet", label: "coffee-on-base", destinationAsset: USDC_BASE, destinationDecimals: 6, recipient: REC };
const fixture = (): QuoteResponse => JSON.parse(readFileSync(resolve(REPO_ROOT, "demo/fixtures/intents-dry-quote.json"), "utf8"));
const NOW = Date.parse("2026-11-09T08:50:00Z");
const req = () => buildQuoteRequest(route, "4.50", "near", NOW);
const resp = () => { const r = fixture(); r.quoteRequest.deadline = req().deadline; return r; };
const N = 10n ** 24n;

describe("intents: invoice vs owner route", () => {
  it("accepts the registered route (address case-insensitive)", () => {
    expect(checkInvoice({ merchant: "coffee.testnet", amount: "4.50", recipient: REC.toLowerCase(), destinationAsset: USDC_BASE, memo: "" }, [route]).ok).toBe(true);
  });
  it("refuses a poisoned invoice that swaps the recipient", () => {
    const c = checkInvoice({ merchant: "coffee.testnet", amount: "4.50", recipient: "0x000000000000000000000000000000000000bEEF", destinationAsset: USDC_BASE, memo: "" }, [route]);
    expect(c.ok).toBe(false); expect(c.findings[0]).toMatch(/not the registered address/);
  });
  it("refuses another asset or an unknown merchant", () => {
    expect(checkInvoice({ merchant: "coffee.testnet", amount: "4.50", recipient: REC, destinationAsset: "nep141:wrap.near", memo: "" }, [route]).ok).toBe(false);
    expect(checkInvoice({ merchant: "evil.testnet", amount: "4.50", recipient: REC, destinationAsset: USDC_BASE, memo: "" }, [route]).ok).toBe(false);
  });
  it("converts amounts exactly and rejects junk", () => {
    expect(toBaseUnits("4.50", 6)).toBe("4500000");
    expect(toBaseUnits("1", 24)).toBe((N).toString());
    for (const bad of ["1e3", "-1", "0", "1.1234567", ""]) expect(() => toBaseUnits(bad, 6), bad).toThrow();
  });
});

describe("intents: dry quote", () => {
  it("builds a dry EXACT_OUTPUT request to the route recipient", () => {
    const r = req();
    expect(r).toMatchObject({ dry: true, swapType: "EXACT_OUTPUT", amount: "4500000", recipient: REC, originAsset: "nep141:wrap.near" });
  });
  it("refuses to send a non-dry request", async () => {
    await expect(requestDryQuote({ ...req(), dry: false } as never, async () => { throw new Error("must not be called"); })).rejects.toThrow(/dry/);
  });
  it("posts to /v0/quote and surfaces API errors", async () => {
    let url = "";
    const ok = await requestDryQuote(req(), async (u) => { url = u; return { ok: true, status: 200, json: async () => resp() }; });
    expect(url).toBe("https://1click.chaindefuser.com/v0/quote"); expect(ok.quote.amountOut).toBe("4500000");
    await expect(requestDryQuote(req(), async () => ({ ok: false, status: 400, json: async () => ({ message: "recipient is not valid" }) }))).rejects.toThrow(/recipient is not valid/);
  });
  it("verifies the recorded real 1Click quote", () => {
    expect(verifyQuote(req(), resp(), NOW)).toEqual({ ok: true, findings: [] });
  });
  it("rejects a tampered quote (recipient, amount, deposit address, fees, deadline)", () => {
    const t1 = resp(); t1.quoteRequest.recipient = "0x000000000000000000000000000000000000bEEF";
    expect(verifyQuote(req(), t1, NOW).findings.join()).toMatch(/recipient/);
    const t2 = resp(); t2.quote.minAmountOut = "4000000";
    expect(verifyQuote(req(), t2, NOW).findings.join()).toMatch(/delivers/);
    const t3 = resp(); t3.quote.depositAddress = "abc";
    expect(verifyQuote(req(), t3, NOW).findings.join()).toMatch(/deposit address/);
    const t4 = resp(); t4.quoteRequest.appFees = [{ recipient: "x", fee: 500 }];
    expect(verifyQuote(req(), t4, NOW).findings.join()).toMatch(/fees/);
    const t5 = resp(); t5.quoteRequest.deadline = new Date(NOW + 86_400_000).toISOString();
    expect(verifyQuote(req(), t5, NOW).findings.join()).toMatch(/deadline/);
  });
});

describe("intents: through Leash policy", () => {
  const policy = { allowlist: ["coffee.testnet"], per_tx_cap: (2n * N).toString(), daily_cap: (5n * N).toString(), cosign_threshold: (3n * N).toString(), velocity_max_tx: 5, velocity_window_sec: 60 };
  it("coffee quote amount is Allowed, 100x invoice is Blocked by PerTxCap", async () => {
    const leash = new OfflineLeash("o.testnet", "a.testnet", policy, 10n * N, () => 1_800_000_000);
    const r = resp(); const d = quoteDigest(req(), r);
    const memo = intentsMemo(route, { merchant: "coffee.testnet", amount: "4.50", recipient: REC, destinationAsset: USDC_BASE, memo: "" }, d);
    expect(Buffer.byteLength(memo)).toBeLessThanOrEqual(256);
    expect((await leash.requestSpend("coffee.testnet", r.quote.amountIn, memo)).result.status).toBe("Allowed");
    const big = (BigInt(r.quote.amountIn) * 100n).toString();
    expect((await leash.requestSpend("coffee.testnet", big, memo)).result.rule).toBe("PerTxCap");
  });
  it("digest changes when the recipient or amount changes", () => {
    const r = resp(); const a = quoteDigest(req(), r);
    expect(quoteDigest({ ...req(), recipient: "0x000000000000000000000000000000000000bEEF" }, r)).not.toBe(a);
    expect(quoteDigest({ ...req(), amount: "4500001" }, r)).not.toBe(a);
  });
});
