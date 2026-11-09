/**
 * Minimal HTTP wrapper around the engine, the unit that runs in the TEE.
 *
 *   LEASH_ENGINE_SEED_HEX=<64 hex>  LEASH_CONTRACT=leash-11020911.testnet \
 *   LEASH_KNOWN_MERCHANTS=leash-coffee-11020911.testnet  node dist/server.js
 *
 * POST /assess  {intent, balance}  ->  {assessment, attestation, judge?}
 * GET  /key                        ->  {public_key, public_key_hex, contract, tee}
 * GET  /attestation?nonce=<64 hex> ->  TDX quote over public_key || nonce (TEE only)
 *
 * In a dstack CVM (NEAR AI Cloud or Phala Cloud) set LEASH_TEE=dstack and no
 * seed: the signing seed is derived from the app's KMS key inside the TEE, so
 * no human ever sees it. Outside a TEE, LEASH_ENGINE_SEED_HEX is a dev key.
 * NEAR_AI_API_KEY + LEASH_JUDGE_MODEL turn on the attested model judge.
 *
 * Binds to 127.0.0.1 by default. Secrets come from the environment only and
 * are never logged or returned.
 */
import { createServer } from "node:http";
import { assess, type SpendIntent } from "./index.js";
import { keyFromSeedHex, nearPublicKey, publicKeyHex, signVerdict } from "./sign.js";
import { DSTACK_SOCKET, deriveEngineSeed, engineReport } from "./tee.js";
import { combineScore, judge, type JudgeResult } from "./nearai-judge.js";

const MAX_BODY = 16 * 1024;

export async function startServer(env: NodeJS.ProcessEnv = process.env) {
  const tee = env.LEASH_TEE === "dstack";
  const socket = env.DSTACK_SOCKET ?? DSTACK_SOCKET;
  const contract = env.LEASH_CONTRACT;
  if (!contract) throw new Error("LEASH_CONTRACT is required");
  if (tee && env.LEASH_ENGINE_SEED_HEX) throw new Error("in TEE mode the seed must come from the TEE, unset LEASH_ENGINE_SEED_HEX");
  const seed = tee ? await deriveEngineSeed(socket) : env.LEASH_ENGINE_SEED_HEX;
  if (!seed) throw new Error("LEASH_ENGINE_SEED_HEX is required outside a TEE (or set LEASH_TEE=dstack)");
  const key = keyFromSeedHex(seed);
  const pkHex = publicKeyHex(key);
  const judgeKey = env.NEAR_AI_API_KEY ?? "", judgeModel = env.LEASH_JUDGE_MODEL ?? "";
  const known = (env.LEASH_KNOWN_MERCHANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // Nonces must grow across restarts: start from the clock in milliseconds.
  let nonce = Date.now();

  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/key") return send(200, { public_key: nearPublicKey(key), public_key_hex: pkHex, contract, tee: tee ? "dstack" : "none" });
    if (req.method === "GET" && req.url?.startsWith("/attestation")) {
      const n = new URL(req.url, "http://x").searchParams.get("nonce") ?? "";
      if (!/^[0-9a-f]{64}$/.test(n)) return send(400, { error: "nonce must be 32 bytes lowercase hex" });
      if (!tee) return send(501, { error: "not running in a TEE (dev key): nothing to attest" });
      engineReport(pkHex, n, socket).then((r) => send(200, r), () => send(502, { error: "TEE quote unavailable" }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/assess") return send(404, { error: "not found" });
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        send(413, { error: "body too large" });
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (res.writableEnded) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { intent?: SpendIntent; balance?: string };
        const i = body.intent;
        if (!i || typeof i.merchant !== "string" || typeof i.amount !== "string" || typeof i.memo !== "string") {
          return send(400, { error: "intent {merchant, amount, memo} required" });
        }
        const assessment = assess(i, { knownMerchants: known, balance: body.balance ?? "0" });
        const finish = (j?: JudgeResult) => {
          if (j) {
            assessment.score = combineScore(assessment.score, j);
            assessment.verdict = assessment.score >= 60 ? "block" : assessment.score >= 30 ? "review" : assessment.verdict;
          }
          nonce += 1;
          const attestation = signVerdict(i, assessment, { contract, nonce, nowSec: Math.floor(Date.now() / 1000), key });
          send(200, { assessment, attestation, ...(j ? { judge: j } : {}) });
        };
        if (judgeKey && judgeModel) judge(i, { apiKey: judgeKey, model: judgeModel }).then(finish, () => finish({ verified: false, reason: "judge error" }));
        else finish();
      } catch (e) {
        send(400, { error: e instanceof Error ? e.message : "bad request" });
      }
    });
  });
  const port = Number(env.PORT ?? 8787);
  const host = env.HOST ?? "127.0.0.1";
  return new Promise<typeof server>((resolve) => server.listen(port, host, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then((s) => console.log(`leash engine listening on ${JSON.stringify(s.address())}`));
}
