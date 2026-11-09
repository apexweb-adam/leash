/**
 * Minimal HTTP wrapper around the engine, the unit that runs in the TEE.
 *
 *   LEASH_ENGINE_SEED_HEX=<64 hex>  LEASH_CONTRACT=leash-11020911.testnet \
 *   LEASH_KNOWN_MERCHANTS=leash-coffee-11020911.testnet  node dist/server.js
 *
 * POST /assess  {intent, balance}  ->  {assessment, attestation}
 * GET  /key                        ->  {public_key}
 *
 * Binds to 127.0.0.1 by default. The seed is read from the environment only
 * and is never logged or returned.
 */
import { createServer } from "node:http";
import { assess, type SpendIntent } from "./index.js";
import { keyFromSeedHex, nearPublicKey, signVerdict } from "./sign.js";

const MAX_BODY = 16 * 1024;

export function startServer(env: NodeJS.ProcessEnv = process.env) {
  const seed = env.LEASH_ENGINE_SEED_HEX;
  const contract = env.LEASH_CONTRACT;
  if (!seed || !contract) throw new Error("LEASH_ENGINE_SEED_HEX and LEASH_CONTRACT are required");
  const key = keyFromSeedHex(seed);
  const known = (env.LEASH_KNOWN_MERCHANTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // Nonces must grow across restarts: start from the clock in milliseconds.
  let nonce = Date.now();

  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/key") return send(200, { public_key: nearPublicKey(key), contract });
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
        nonce += 1;
        const attestation = signVerdict(i, assessment, { contract, nonce, nowSec: Math.floor(Date.now() / 1000), key });
        send(200, { assessment, attestation });
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
