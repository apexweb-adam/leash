/**
 * Signed engine verdicts.
 *
 * The engine signs its risk score for one exact spend so the Leash contract
 * can check it on chain (`request_spend_attested`). The message layout is
 * pinned by a test on both sides (here and in contract/src/tests.rs).
 *
 * The signing key comes from the environment only. In production it is
 * generated inside the NEAR AI Cloud TEE and never leaves it; the contract
 * owner registers its public key with `set_engine`.
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from "node:crypto";
import type { Assessment, SpendIntent } from "./index.js";

export const MSG_PREFIX = "leash-verdict-v1";

export interface Attestation {
  score: number;
  issued_at_sec: number;
  nonce: number;
  /** base64 ed25519 signature, 64 bytes. */
  signature: string;
}

export function verdictMessage(p: {
  contract: string;
  merchant: string;
  amount: string;
  memo: string;
  score: number;
  issuedAtSec: number;
  nonce: number;
}): string {
  if (!/^\d+$/.test(p.amount)) throw new Error("amount must be a yoctoNEAR integer string");
  if (!Number.isInteger(p.score) || p.score < 0 || p.score > 100) throw new Error("score must be 0..100");
  if (!Number.isSafeInteger(p.nonce) || p.nonce < 1) throw new Error("nonce must be a positive integer");
  for (const [k, v] of [["contract", p.contract], ["merchant", p.merchant]] as const) {
    if (/\s/.test(v) || v.length === 0) throw new Error(`${k} must be a non-empty account id`);
  }
  // Rust hashes memo bytes as UTF-8, same as Node.
  const memoHash = createHash("sha256").update(p.memo, "utf8").digest("hex");
  // Match Rust u128 formatting: no leading zeros.
  const amount = BigInt(p.amount).toString();
  return [MSG_PREFIX, p.contract, p.merchant, amount, memoHash, p.score, p.issuedAtSec, p.nonce].join("\n");
}

/** Build an ed25519 private key from a 32-byte seed (hex). */
export function keyFromSeedHex(seedHex: string): KeyObject {
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error("seed must be 32 bytes hex");
  // PKCS#8 DER prefix for an ed25519 private key, followed by the seed.
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seedHex, "hex")]);
  return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Uint8Array): string {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

/** NEAR formatted public key (`ed25519:<base58>`) for `set_engine`. */
export function nearPublicKey(key: KeyObject): string {
  const spki = createPublicKey(key).export({ format: "der", type: "spki" });
  return "ed25519:" + base58(spki.subarray(spki.length - 32));
}

export function signVerdict(
  intent: SpendIntent,
  assessment: Assessment,
  opts: { contract: string; nonce: number; nowSec: number; key: KeyObject },
): Attestation {
  const msg = verdictMessage({
    contract: opts.contract,
    merchant: intent.merchant,
    amount: intent.amount,
    memo: intent.memo,
    score: assessment.score,
    issuedAtSec: opts.nowSec,
    nonce: opts.nonce,
  });
  const sig = edSign(null, Buffer.from(msg, "utf8"), opts.key);
  return { score: assessment.score, issued_at_sec: opts.nowSec, nonce: opts.nonce, signature: sig.toString("base64") };
}
