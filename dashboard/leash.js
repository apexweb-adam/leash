// Pure helpers shared by the dashboard and its tests. No DOM access here.
// Public RPC endpoints, tried in order (fallback if one is down or rate limited).
export const RPC = {
  testnet: ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"],
  mainnet: ["https://rpc.mainnet.near.org", "https://free.rpc.fastnear.com"],
};
const YOCTO = 10n ** 24n;

export function formatNear(yocto) {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac} NEAR` : `${whole} NEAR`;
}

export function isValidAccountId(id) {
  return typeof id === "string" && id.length >= 2 && id.length <= 64 &&
    /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
const unbytes = (arr) => new TextDecoder().decode(new Uint8Array(arr));

export async function view(network, contract, method, args = {}, fetchImpl = fetch) {
  if (!RPC[network]) throw new Error(`unknown network ${network}`);
  if (!isValidAccountId(contract)) throw new Error(`invalid account id ${contract}`);
  if (!/^[a-z_]{1,64}$/.test(method)) throw new Error(`invalid method ${method}`);
  const body = JSON.stringify({ jsonrpc: "2.0", id: "leash", method: "query",
    params: { request_type: "call_function", finality: "final", account_id: contract,
      method_name: method, args_base64: b64(JSON.stringify(args)) } });
  let lastErr;
  for (const url of RPC[network]) {
    let j;
    try {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body });
      j = await res.json();
    } catch (e) { lastErr = e; continue; } // network or rate limit: try the next endpoint
    if (j.error) throw new Error(j.error.data || j.error.message || "rpc error");
    if (j.result?.error) throw new Error(j.result.error);
    return JSON.parse(unbytes(j.result.result));
  }
  throw new Error(`all RPC endpoints failed: ${lastErr?.message || "unknown"}`);
}

export async function loadAllSpends(network, contract, logLen, fetchImpl = fetch, page = 50) {
  const out = [];
  for (let from = 0; from < logLen; from += page) {
    out.push(...await view(network, contract, "get_spends", { from_index: from, limit: page }, fetchImpl));
  }
  return out;
}

export function summarize(spends) {
  const by = {};
  let blockedYocto = 0n;
  for (const s of spends) {
    by[s.status] = (by[s.status] || 0) + 1;
    if (s.status === "Blocked") blockedYocto += BigInt(s.amount);
  }
  return { byStatus: by, blockedYocto: blockedYocto.toString() };
}
