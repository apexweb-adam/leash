/**
 * NEAR Intents settlement adapter (1Click API), dry quotes only.
 *
 * A merchant on the Leash allowlist can be paid on another chain. The owner
 * registers a fixed route per merchant (destination asset and recipient
 * address). When the agent wants to pay an invoice:
 *
 *   1. checkInvoice: the invoice must match the registered route. A poisoned
 *      invoice that swaps in another recipient or asset is refused before any
 *      quote is asked for.
 *   2. requestDryQuote: EXACT_OUTPUT quote from 1Click with dry: true, so no
 *      deposit address is issued and nothing can be sent.
 *   3. verifyQuote: the quote echo must match what we asked for (asset,
 *      recipient, amount, dry), fees and slippage stay within limits.
 *   4. The NEAR amount the quote needs (amountIn) goes through the normal
 *      Leash policy (request_spend), with a memo bound to the quote digest.
 *
 * NEAR Intents has no testnet (HACKATHON.md Q-007), so live execution needs a
 * mainnet dev account and the owner's approval. This module refuses dry: false.
 */
import { createHash } from "node:crypto";

export const ONE_CLICK_BASE = "https://1click.chaindefuser.com";
export const WNEAR = "nep141:wrap.near";

export interface MerchantRoute {
  /** Leash allowlist entry this route belongs to. */
  merchant: string;
  label: string;
  /** 1Click asset id on the destination chain, e.g. USDC on Base. */
  destinationAsset: string;
  destinationDecimals: number;
  /** Merchant address on the destination chain, fixed by the owner. */
  recipient: string;
}

export interface Invoice {
  merchant: string;
  /** Human amount in the destination asset, e.g. "4.50". */
  amount: string;
  /** Where the agent was told to pay. Comes from untrusted context. */
  recipient: string;
  destinationAsset: string;
  memo: string;
}

export interface QuoteLimits {
  /** Max total app fees in basis points. 1Click charges 20 bps without a JWT (Q-006). */
  maxFeeBps: number;
  /** Max slippage tolerance in basis points. */
  maxSlippageBps: number;
  /** Max quote lifetime in seconds. */
  maxDeadlineSec: number;
}

export const DEFAULT_LIMITS: QuoteLimits = { maxFeeBps: 30, maxSlippageBps: 100, maxDeadlineSec: 900 };

export interface QuoteRequest {
  dry: true;
  swapType: "EXACT_OUTPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
}

export interface QuoteResponse {
  quote: {
    amountIn: string;
    amountInFormatted?: string;
    minAmountIn?: string;
    amountOut: string;
    minAmountOut: string;
    timeEstimate?: number;
    depositAddress?: string;
    amountInUsd?: string;
  };
  quoteRequest: Record<string, unknown> & { appFees?: { recipient: string; fee: number }[] };
  signature?: string;
  timestamp?: string;
  correlationId?: string;
}

export interface Check {
  ok: boolean;
  findings: string[];
}

/** Decimal string to base units, exact, no floats. */
export function toBaseUnits(amount: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`bad amount ${amount}`);
  const [w, f = ""] = amount.split(".");
  if (f.length > decimals) throw new Error(`too many decimals in ${amount}`);
  const v = BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (v === 0n) throw new Error("amount must be > 0");
  return v.toString();
}

const normAddr = (a: string) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a);

/** Step 1: the invoice must match the owner's route. Runs before any network call. */
export function checkInvoice(inv: Invoice, routes: MerchantRoute[]): Check & { route?: MerchantRoute } {
  const findings: string[] = [];
  const route = routes.find((r) => r.merchant === inv.merchant);
  if (!route) return { ok: false, findings: [`no cross-chain route registered for ${inv.merchant}`] };
  if (normAddr(inv.recipient) !== normAddr(route.recipient))
    findings.push(`recipient ${inv.recipient} is not the registered address for ${route.label}`);
  if (inv.destinationAsset !== route.destinationAsset)
    findings.push(`asset ${inv.destinationAsset} is not the registered asset for ${route.label}`);
  try { toBaseUnits(inv.amount, route.destinationDecimals); } catch (e) { findings.push((e as Error).message); }
  return { ok: findings.length === 0, findings, route };
}

export function buildQuoteRequest(route: MerchantRoute, amount: string, refundTo: string, nowMs: number, limits = DEFAULT_LIMITS): QuoteRequest {
  return {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: limits.maxSlippageBps,
    originAsset: WNEAR,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: route.destinationAsset,
    amount: toBaseUnits(amount, route.destinationDecimals),
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: route.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(nowMs + 10 * 60_000).toISOString(),
  };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Step 2: dry quote. No API key needed. Refuses anything that is not dry. */
export async function requestDryQuote(req: QuoteRequest, fetchImpl: FetchLike = fetch as unknown as FetchLike, base = ONE_CLICK_BASE): Promise<QuoteResponse> {
  if (req.dry !== true) throw new Error("Leash only requests dry quotes; live Intents execution needs owner approval on mainnet");
  const res = await fetchImpl(`${base}/v0/quote`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) });
  const body = (await res.json()) as QuoteResponse & { message?: string };
  if (!res.ok || !body?.quote) throw new Error(`1Click quote failed (${res.status}): ${body?.message ?? "no quote"}`);
  return body;
}

/** Step 3: never trust the quote service blindly. */
export function verifyQuote(req: QuoteRequest, resp: QuoteResponse, nowMs: number, limits = DEFAULT_LIMITS): Check {
  const f: string[] = [];
  const echo = resp.quoteRequest ?? {};
  for (const k of ["destinationAsset", "originAsset", "swapType", "amount"] as const)
    if (echo[k] !== req[k]) f.push(`quote ${k} ${String(echo[k])} does not match request ${req[k]}`);
  if (normAddr(String(echo.recipient)) !== normAddr(req.recipient)) f.push(`quote recipient ${String(echo.recipient)} does not match request ${req.recipient}`);
  if (echo.dry !== true) f.push("quote is not dry");
  if (resp.quote.depositAddress) f.push("dry quote unexpectedly carries a deposit address");
  const out = BigInt(resp.quote.amountOut || "0"), minOut = BigInt(resp.quote.minAmountOut || "0"), want = BigInt(req.amount);
  if (out < want || minOut < want) f.push(`quote delivers ${minOut} (min) / ${out}, invoice needs ${want}`);
  if (!/^\d+$/.test(resp.quote.amountIn) || BigInt(resp.quote.amountIn) === 0n) f.push("quote amountIn missing");
  const fees = (echo.appFees ?? []).reduce((s, x) => s + (Number(x.fee) || 0), 0);
  if (fees > limits.maxFeeBps) f.push(`fees ${fees} bps above limit ${limits.maxFeeBps}`);
  if (Number(echo.slippageTolerance) > limits.maxSlippageBps) f.push(`slippage ${String(echo.slippageTolerance)} bps above limit`);
  const dl = Date.parse(String(echo.deadline));
  if (!Number.isFinite(dl) || dl - nowMs > limits.maxDeadlineSec * 1000 || dl < nowMs) f.push("quote deadline outside allowed window");
  return { ok: f.length === 0, findings: f };
}

/** Canonical digest of what we would pay, for the spend memo. */
export function quoteDigest(req: QuoteRequest, resp: QuoteResponse): string {
  const canon = JSON.stringify([req.originAsset, req.destinationAsset, normAddr(req.recipient), req.amount, resp.quote.amountIn, req.deadline]);
  return createHash("sha256").update(canon).digest("hex");
}

/** Memo the agent sends with request_spend. Fits the contract's 256 byte limit. */
export function intentsMemo(route: MerchantRoute, inv: Invoice, digest: string): string {
  return `intents:${route.label}:${inv.amount}:${digest.slice(0, 32)}`.slice(0, 256);
}
