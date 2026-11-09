/**
 * TEE attestation for the Leash policy engine.
 *
 * Two jobs, one report format (the dstack / NEAR AI Cloud format):
 *
 * 1. Verify a report: an Intel TDX quote whose report_data binds
 *    `signing_address || nonce`, plus the event log and app compose that
 *    explain the measurements. Used for
 *      - NEAR AI Cloud (cloud-api.near.ai/v1/attestation/report, no API key),
 *        the private inference the engine can use as an extra judge, and
 *      - the Leash engine itself when it runs in a dstack CVM (NEAR AI Cloud
 *        or Phala Cloud). Then signing_address is the engine's ed25519 key and
 *        the owner registers it with `set_engine` only after this check passes.
 * 2. Produce a report inside the CVM: ask the dstack guest agent
 *    (/var/run/dstack.sock) for a quote over `engine_pk || nonce`, and derive
 *    the engine signing seed from the app's KMS key so it never exists
 *    outside the TEE.
 *
 * Checks (all must pass): request nonce echo, quote report_data binding,
 * RTMR3 replay from the event log (digests recomputed, not trusted),
 * MRCONFIGID = 0x01 || sha256(app_compose) || 0^15, compose-hash event,
 * optional pinned compose hash or image, and Intel DCAP signature chain +
 * TCB status via @phala/dcap-qvl (needs network for collateral).
 */
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";

export interface TeeEvent { imr: number; event_type: number; digest?: string; event: string; event_payload?: string }
export interface TeeReport {
  signing_address: string;
  signing_algo: string;
  intel_quote: string;
  request_nonce?: string;
  report_data?: string;
  event_log?: string | TeeEvent[];
  info?: { tcb_info?: string | { app_compose?: string; event_log?: TeeEvent[]; compose_hash?: string }; app_name?: string; compose_hash?: string };
}

export interface TdxFields { version: number; teeType: number; mrTd: string; mrConfigId: string; rtmr: string[]; reportData: string }

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Parse the TD report body of an Intel TDX v4/v5 quote (header 48 bytes, TD10 body). */
export function parseTdxQuote(quoteHex: string): TdxFields {
  if (!/^[0-9a-fA-F]+$/.test(quoteHex) || quoteHex.length % 2) throw new Error("quote is not hex");
  const q = Buffer.from(quoteHex, "hex");
  if (q.length < 48 + 584) throw new Error("quote too short");
  const version = q.readUInt16LE(0), teeType = q.readUInt32LE(4);
  if (teeType !== 0x81) throw new Error(`not a TDX quote (tee type ${teeType.toString(16)})`);
  let off = 48;
  if (version === 5) off = 48 + 6; // v5: body type (2) + size (4) before the body
  else if (version !== 4) throw new Error(`unsupported quote version ${version}`);
  const at = (o: number, n: number) => hex(q.subarray(off + o, off + o + n));
  return { version, teeType, mrTd: at(136, 48), mrConfigId: at(184, 48), rtmr: [at(328, 48), at(376, 48), at(424, 48), at(472, 48)], reportData: at(520, 64) };
}

/** dstack runtime event digest: sha384(type_le32 || ":" || event || ":" || payload). */
export function eventDigest(e: TeeEvent): string {
  const t = Buffer.alloc(4); t.writeUInt32LE(e.event_type >>> 0);
  return createHash("sha384").update(Buffer.concat([t, Buffer.from(":"), Buffer.from(e.event, "utf8"), Buffer.from(":"), Buffer.from(e.event_payload ?? "", "hex")])).digest("hex");
}

export function replayRtmr3(events: TeeEvent[]): string {
  let r = Buffer.alloc(48);
  for (const e of events) if (e.imr === 3) r = createHash("sha384").update(Buffer.concat([r, Buffer.from(eventDigest(e), "hex")])).digest();
  return r.toString("hex");
}

function parseMaybeJson<T>(v: unknown): T | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") { try { return JSON.parse(v) as T; } catch { return undefined; } }
  return v as T;
}

export function tcbInfo(r: TeeReport): { app_compose?: string; event_log?: TeeEvent[]; compose_hash?: string } {
  return parseMaybeJson(r.info?.tcb_info) ?? {};
}

export interface VerifyOptions {
  nonce: string;
  /** Expected signing key (hex). For the engine: the key you are about to register. */
  expectSigningAddress?: string;
  expectComposeHash?: string;
  /** Substring that must appear in app_compose, e.g. an image digest "sha256:...". */
  expectComposeIncludes?: string[];
  /** Intel DCAP check. Pass `dcapVerify` (network) or false to skip (then the result says so). */
  dcap?: false | ((quote: Buffer) => Promise<{ status: string; advisory_ids?: string[] }>);
  acceptTcb?: string[];
}

export interface Check { name: string; ok: boolean; detail: string }
export interface VerifyResult { ok: boolean; checks: Check[]; signingAddress: string; signingAlgo: string; composeHash?: string; appName?: string }

export async function verifyReport(r: TeeReport, o: VerifyOptions): Promise<VerifyResult> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let f: TdxFields | undefined;
  try { f = parseTdxQuote(r.intel_quote); add("tdx_quote_parse", true, `TDX quote v${f.version}`); }
  catch (e) { add("tdx_quote_parse", false, (e as Error).message); }

  add("nonce_echo", r.request_nonce === o.nonce, r.request_nonce === o.nonce ? "request_nonce matches our fresh nonce" : `got ${r.request_nonce}`);
  const addr = (r.signing_address ?? "").toLowerCase().replace(/^0x/, "");
  if (o.expectSigningAddress) add("signing_key_expected", addr === o.expectSigningAddress.toLowerCase(), `signing_address ${addr.slice(0, 16)}...`);
  if (f) {
    // report_data = signing_address (32 bytes, left aligned) || nonce (32 bytes)
    const want = addr.padEnd(64, "0").slice(0, 64) + o.nonce.toLowerCase();
    add("report_data_binding", f.reportData === want, f.reportData === want ? "quote binds signing key and nonce" : "report_data does not bind key || nonce");
  }
  const ti = tcbInfo(r);
  const events = parseMaybeJson<TeeEvent[]>(r.event_log) ?? ti.event_log ?? [];
  if (f) {
    const rt = replayRtmr3(events);
    add("rtmr3_replay", events.length > 0 && rt === f.rtmr[3], events.length ? (rt === f.rtmr[3] ? `${events.filter((e) => e.imr === 3).length} runtime events replay to the quoted RTMR3` : "event log does not replay to RTMR3") : "no event log");
  }
  const compose = ti.app_compose;
  let composeHash: string | undefined;
  if (compose == null) add("app_compose", false, "no app_compose in tcb_info");
  else {
    composeHash = createHash("sha256").update(compose, "utf8").digest("hex");
    if (f) add("mrconfigid_binding", f.mrConfigId === "01" + composeHash + "00".repeat(15), "MRCONFIGID = 01 || sha256(app_compose) || 0^15");
    const ev = events.find((e) => e.imr === 3 && e.event === "compose-hash");
    add("compose_hash_event", ev?.event_payload?.toLowerCase() === composeHash, "compose-hash runtime event matches app_compose");
    if (o.expectComposeHash) add("compose_hash_pinned", composeHash === o.expectComposeHash.toLowerCase(), `compose ${composeHash.slice(0, 16)}...`);
    for (const s of o.expectComposeIncludes ?? []) add("compose_includes", compose.includes(s), `app_compose ${compose.includes(s) ? "contains" : "lacks"} ${s}`);
  }
  if (o.dcap === false || !o.dcap) add("intel_dcap", false, "skipped (offline): Intel signature chain and TCB not checked");
  else {
    try {
      const v = await o.dcap(Buffer.from(r.intel_quote, "hex"));
      const accept = o.acceptTcb ?? ["UpToDate"];
      add("intel_dcap", accept.includes(v.status), `Intel DCAP: ${v.status}${v.advisory_ids?.length ? " advisories " + v.advisory_ids.join(",") : ""}`);
    } catch (e) { add("intel_dcap", false, `DCAP verification failed: ${(e as Error).message}`); }
  }
  return { ok: checks.every((c) => c.ok), checks, signingAddress: addr, signingAlgo: r.signing_algo, composeHash, appName: r.info?.app_name };
}

/** Intel DCAP via Phala's pure-JS dcap-qvl (fetches collateral from a PCCS). */
export async function dcapVerify(quote: Buffer): Promise<{ status: string; advisory_ids?: string[] }> {
  const m = (await import("@phala/dcap-qvl")) as unknown as { getCollateralAndVerify(q: Buffer): Promise<{ status: string; advisory_ids?: string[] }> };
  return m.getCollateralAndVerify(quote);
}

export const freshNonce = () => randomBytes(32).toString("hex");

export const NEAR_AI_ATTESTATION = "https://cloud-api.near.ai/v1/attestation/report";

/** Fetch the NEAR AI Cloud gateway report (and model reports if `model` is set). No API key. */
export async function fetchNearAiReport(nonce: string, model?: string, fetchImpl: typeof fetch = fetch): Promise<{ gateway_attestation: TeeReport; model_attestations?: TeeReport[] }> {
  const u = new URL(NEAR_AI_ATTESTATION);
  u.searchParams.set("signing_algo", "ed25519"); u.searchParams.set("nonce", nonce);
  if (model) { u.searchParams.set("model", model); u.searchParams.set("provider", "near"); }
  const res = await fetchImpl(u, { headers: { accept: "application/json", "x-no-aliasing": "true" } });
  if (!res.ok) throw new Error(`attestation report HTTP ${res.status}`);
  return (await res.json()) as { gateway_attestation: TeeReport; model_attestations?: TeeReport[] };
}

/* ---------- inside the CVM: dstack guest agent ---------- */

export const DSTACK_SOCKET = "/var/run/dstack.sock";

function dstackCall<T>(path: string, body: unknown, socketPath: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        if ((res.statusCode ?? 500) >= 300) return reject(new Error(`dstack ${path} HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T); } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("dstack timeout")));
    req.end(data);
  });
}

/** Engine seed derived from the app's KMS key: same app identity, same key; never leaves the CVM. */
export async function deriveEngineSeed(socketPath = DSTACK_SOCKET): Promise<string> {
  const r = await dstackCall<{ key: string }>("/GetKey", { path: "leash/engine/ed25519/v1", purpose: "signing" }, socketPath);
  if (!r.key) throw new Error("dstack GetKey returned no key");
  return createHash("sha256").update(Buffer.from(r.key, "hex")).update("leash-engine-seed-v1").digest("hex");
}

/** Quote over engine_pk || nonce, in the same shape NEAR AI Cloud returns. */
export async function engineReport(publicKeyHex: string, nonce: string, socketPath = DSTACK_SOCKET): Promise<TeeReport> {
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error("nonce must be 32 bytes hex");
  const q = await dstackCall<{ quote: string; event_log?: string }>("/GetQuote", { report_data: publicKeyHex + nonce }, socketPath);
  const info = await dstackCall<{ tcb_info?: string; app_name?: string; compose_hash?: string }>("/Info", {}, socketPath).catch(() => ({}));
  return { signing_address: publicKeyHex, signing_algo: "ed25519", intel_quote: q.quote, request_nonce: nonce, report_data: publicKeyHex + nonce, event_log: q.event_log, info };
}
