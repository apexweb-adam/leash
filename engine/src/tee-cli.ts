/**
 * npm run tee -- nearai [--model <id>] [--offline]
 *   Fetch NEAR AI Cloud attestation with a fresh nonce and verify it (no API key).
 * npm run tee -- engine --url https://<engine-host> [--compose-hash <hex>] [--image <sha256:...>]
 *   Verify a Leash engine running in a dstack CVM and print the NEAR key to
 *   register with set_engine. Prints the exact near-cli command; signs nothing.
 */
import { readFileSync } from "node:fs";
import { dcapVerify, fetchNearAiReport, freshNonce, verifyReport, type TeeReport, type VerifyResult } from "./tee.js";
import { nearPublicKeyFromHex } from "./sign.js";

const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k: string) => argv.includes(k);

function print(label: string, v: VerifyResult) {
  console.log(`\n${label}: ${v.ok ? "VERIFIED" : "NOT VERIFIED"}  (${v.appName ?? "?"}, ${v.signingAlgo} key ${v.signingAddress.slice(0, 16)}...)`);
  for (const c of v.checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(22)} ${c.detail}`);
}

async function main() {
  const mode = argv[0];
  if (mode === "nearai") {
    let nonce: string, rep: { gateway_attestation: TeeReport; model_attestations?: TeeReport[] };
    if (has("--offline")) {
      const fx = JSON.parse(readFileSync(new URL("../test/fixtures/nearai-gateway-report.json", import.meta.url), "utf8"));
      nonce = fx.nonce; rep = fx;
      console.log(`offline: recorded report (${fx.fetched_at}), Intel DCAP skipped`);
    } else {
      nonce = freshNonce();
      console.log(`nonce ${nonce}`);
      rep = await fetchNearAiReport(nonce, flag("--model"));
    }
    const dcap = has("--offline") ? false : dcapVerify;
    const g = await verifyReport(rep.gateway_attestation, { nonce, dcap });
    print("NEAR AI Cloud gateway TEE", g);
    let ok = g.ok;
    for (const [i, m] of (rep.model_attestations ?? []).entries()) {
      const v = await verifyReport({ ...m, request_nonce: m.request_nonce ?? nonce }, { nonce, dcap });
      print(`model attestation #${i}`, v); ok &&= v.ok;
    }
    if (flag("--model") && !(rep.model_attestations ?? []).length) { console.log("no model attestation returned: treat the model as unverified"); ok = false; }
    process.exitCode = ok || has("--offline") ? 0 : 1;
    return;
  }
  if (mode === "engine") {
    const url = flag("--url");
    if (!url || !/^https:\/\//.test(url)) throw new Error("--url https://... required");
    const nonce = freshNonce();
    const res = await fetch(`${url.replace(/\/$/, "")}/attestation?nonce=${nonce}`);
    if (!res.ok) throw new Error(`engine /attestation HTTP ${res.status}`);
    const rep = (await res.json()) as TeeReport;
    const keyRes = await fetch(`${url.replace(/\/$/, "")}/key`);
    const key = (await keyRes.json()) as { public_key: string; public_key_hex: string };
    const v = await verifyReport(rep, {
      nonce, dcap: dcapVerify, expectSigningAddress: key.public_key_hex,
      expectComposeHash: flag("--compose-hash"), expectComposeIncludes: flag("--image") ? [flag("--image")!] : [],
    });
    print("Leash engine TEE", v);
    if (!v.ok) { process.exitCode = 1; console.log("\nDo NOT register this key."); return; }
    const pk = nearPublicKeyFromHex(v.signingAddress);
    if (pk !== key.public_key) throw new Error("key endpoint and attested key differ");
    console.log(`\nAttested engine key: ${pk}\nRegister it (owner key, testnet):\n  near contract call-function as-transaction <contract> set_engine json-args '{"engine_pk":"${pk}","max_risk":30,"max_age_sec":300,"required":true}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <owner> network-config testnet sign-with-keychain send`);
    return;
  }
  console.log("usage: tee nearai [--model id] [--offline] | tee engine --url https://... [--compose-hash hex] [--image sha256:...]");
  process.exitCode = 2;
}
main().catch((e) => { console.error(e.message); process.exit(1); });
