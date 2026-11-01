/**
 * Leash policy engine.
 *
 * Scores a spend intent from an AI agent for prompt-injection and scam
 * signals before it reaches the on-chain policy contract. The contract is
 * the hard wall (caps, allowlist, co-sign). This engine is the early
 * warning layer that catches manipulation the caps alone cannot explain.
 *
 * Deterministic, dependency-free, no network calls. Planned to run inside a
 * TEE on NEAR AI Cloud so its verdict can be attested (see docs/PLAN.md).
 */
import { createHash } from "node:crypto";

export interface SpendIntent {
  /** NEAR account the agent wants to pay. */
  merchant: string;
  /** Amount in yoctoNEAR, as a decimal string (u128 does not fit in a JS number). */
  amount: string;
  /** Memo the agent attaches to the spend. */
  memo: string;
  /** Untrusted text the agent was reading when it decided to pay (web page, email, tool output). */
  sourceContext?: string;
  /** The task the human actually gave the agent. Trusted. */
  userGoal?: string;
}

export interface EngineConfig {
  /** Merchants the human approved. Mirrors the contract allowlist. */
  knownMerchants: string[];
  /** Current agent budget in yoctoNEAR, decimal string. */
  balance: string;
  /** Score at or above which the verdict is "block". Default 60. */
  blockAt?: number;
  /** Score at or above which the verdict is "review". Default 30. */
  reviewAt?: number;
}

export type FindingId =
  | "injection_phrase"
  | "drain_language"
  | "urgency_pressure"
  | "authority_impersonation"
  | "secret_request"
  | "unknown_merchant"
  | "lookalike_merchant"
  | "merchant_from_untrusted_context"
  | "high_balance_ratio"
  | "hidden_characters"
  | "non_ascii_merchant"
  | "encoded_payload";

export interface Finding {
  id: FindingId;
  weight: number;
  where: "memo" | "sourceContext" | "merchant" | "amount";
  detail: string;
}

export type EngineVerdict = "allow" | "review" | "block";

export interface Assessment {
  score: number;
  verdict: EngineVerdict;
  findings: Finding[];
  /** sha256 of the canonical intent, for binding an attestation to it. */
  intentDigest: string;
}

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/;

const PATTERNS: { id: FindingId; weight: number; re: RegExp; label: string }[] = [
  {
    id: "injection_phrase",
    weight: 45,
    re: /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|all|earlier)\b.{0,20}\b(instructions?|rules?|prompts?|messages?)\b|\byou are now\b|\bnew instructions?\b|^\s*system\s*:|\[\s*system\s*\]|\bdeveloper mode\b|\bdo not (tell|inform|alert) the (user|owner|human)\b|\boverride (the )?(policy|limits?|rules?)\b/im,
    label: "prompt-injection phrasing",
  },
  {
    id: "drain_language",
    weight: 35,
    re: /\b(entire|whole|full|all( of)?( your| the)?)\s+(balance|funds|wallet|money|tokens|near)\b|\bsend (it )?all\b|\bmax(imum)? amount\b|\bempty (the|your) (wallet|account)\b/i,
    label: "asks to move the whole balance",
  },
  {
    id: "urgency_pressure",
    weight: 15,
    re: /\b(urgent(ly)?|immediately|right now|final notice|within \d+ (minutes?|hours?)|will be (suspended|locked|frozen|deleted)|act now)\b/i,
    label: "urgency or threat",
  },
  {
    id: "authority_impersonation",
    weight: 20,
    re: /\b(near (foundation|support|team)|security team|support team|wallet support|admin(istrator)?|compliance department|verify your (wallet|account))\b/i,
    label: "claims authority",
  },
  {
    id: "secret_request",
    weight: 50,
    re: /\b(seed phrase|recovery phrase|mnemonic|private key|secret key|full[- ]access key)\b/i,
    label: "mentions wallet secrets",
  },
  {
    id: "encoded_payload",
    weight: 10,
    re: /[A-Za-z0-9+/]{60,}={0,2}/,
    label: "long encoded blob",
  },
];

/** Levenshtein distance, small inputs only. */
export function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function normalize(s: string): string {
  return s.normalize("NFKC").replace(new RegExp(ZERO_WIDTH.source, "g"), "");
}

export function intentDigest(intent: SpendIntent): string {
  const canonical = JSON.stringify({
    merchant: intent.merchant,
    amount: intent.amount,
    memo: intent.memo,
    sourceContext: intent.sourceContext ?? "",
    userGoal: intent.userGoal ?? "",
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function parseYocto(s: string): bigint {
  if (!/^\d+$/.test(s)) throw new Error(`amount must be a non-negative integer string, got "${s}"`);
  return BigInt(s);
}

export function assess(intent: SpendIntent, cfg: EngineConfig): Assessment {
  const findings: Finding[] = [];
  const blockAt = cfg.blockAt ?? 60;
  const reviewAt = cfg.reviewAt ?? 30;

  const fields: { where: "memo" | "sourceContext"; raw: string }[] = [
    { where: "memo", raw: intent.memo ?? "" },
    { where: "sourceContext", raw: intent.sourceContext ?? "" },
  ];

  for (const { where, raw } of fields) {
    if (ZERO_WIDTH.test(raw)) {
      findings.push({ id: "hidden_characters", weight: 20, where, detail: "zero-width or bidi control characters" });
    }
    const text = normalize(raw);
    for (const p of PATTERNS) {
      const m = text.match(p.re);
      // One finding per pattern id across fields keeps scores bounded.
      if (m && !findings.some((f) => f.id === p.id)) {
        findings.push({ id: p.id, weight: p.weight, where, detail: `${p.label}: "${m[0].trim().slice(0, 80)}"` });
      }
    }
  }

  const merchant = intent.merchant.trim();
  const known = cfg.knownMerchants.map((m) => m.toLowerCase());
  const mLower = merchant.toLowerCase();

  if (/[^\x00-\x7F]/.test(merchant)) {
    findings.push({ id: "non_ascii_merchant", weight: 40, where: "merchant", detail: "merchant id has non-ASCII (homoglyph) characters" });
  }

  if (!known.includes(mLower)) {
    const look = known.find((k) => editDistance(k, normalize(mLower)) <= 2);
    if (look) {
      findings.push({ id: "lookalike_merchant", weight: 45, where: "merchant", detail: `"${merchant}" looks like known merchant "${look}"` });
    } else {
      findings.push({ id: "unknown_merchant", weight: 25, where: "merchant", detail: `"${merchant}" is not a known merchant` });
    }
    const ctx = normalize(intent.sourceContext ?? "").toLowerCase();
    const goal = normalize(intent.userGoal ?? "").toLowerCase();
    if (ctx.includes(mLower) && !goal.includes(mLower)) {
      findings.push({
        id: "merchant_from_untrusted_context",
        weight: 25,
        where: "merchant",
        detail: "merchant was introduced by untrusted content, not by the user's goal",
      });
    }
  }

  const amount = parseYocto(intent.amount);
  const balance = parseYocto(cfg.balance);
  if (balance > 0n) {
    const bps = Number((amount * 10_000n) / balance);
    if (bps >= 9_000) {
      findings.push({ id: "high_balance_ratio", weight: 35, where: "amount", detail: `amount is ${(bps / 100).toFixed(1)}% of balance` });
    } else if (bps >= 5_000) {
      findings.push({ id: "high_balance_ratio", weight: 20, where: "amount", detail: `amount is ${(bps / 100).toFixed(1)}% of balance` });
    }
  }

  const score = Math.min(100, findings.reduce((s, f) => s + f.weight, 0));
  const verdict: EngineVerdict = score >= blockAt ? "block" : score >= reviewAt ? "review" : "allow";
  return { score, verdict, findings, intentDigest: intentDigest(intent) };
}
