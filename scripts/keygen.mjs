#!/usr/bin/env node
// Generate an ed25519 NEAR key pair and write a near-cli credential file
// ({account_id, public_key, private_key}) with mode 600.
// Usage: node scripts/keygen.mjs <account_id> <out_file>
// Prints only the PUBLIC key. Never point <out_file> inside the repo.
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  return {
    public_key: "ed25519:" + base58(pub),
    private_key: "ed25519:" + base58(Buffer.concat([seed, pub])),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [accountId, outFile] = process.argv.slice(2);
  if (!accountId || !outFile) {
    console.error("usage: node scripts/keygen.mjs <account_id> <out_file>");
    process.exit(2);
  }
  const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const out = resolve(outFile);
  if (out.startsWith(repo + "/")) {
    console.error("refusing to write a private key inside the repository");
    process.exit(1);
  }
  if (existsSync(out)) {
    console.error(`refusing to overwrite ${out}`);
    process.exit(1);
  }
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
  const kp = newKeyPair();
  writeFileSync(out, JSON.stringify({ account_id: accountId, ...kp }) + "\n", { mode: 0o600 });
  console.log(kp.public_key);
}
