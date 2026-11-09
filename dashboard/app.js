import { view, loadAllSpends, formatNear, summarize, isValidAccountId } from "./leash.js";
const $ = (id) => document.getElementById(id);
let spends = [], filter = "all";

// Build DOM with textContent only: contract data (memo, merchant) is untrusted.
function el(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; }
function card(label, value) { const c = el("div", null, "card"); c.append(el("b", value), el("span", label)); return c; }

function renderLog() {
  const body = $("log"); body.replaceChildren();
  const rows = spends.filter((s) => filter === "all" || s.status === filter).slice().reverse();
  for (const s of rows) {
    const tr = document.createElement("tr");
    const st = el("td"); st.append(el("span", s.status, `pill ${s.status}`));
    tr.append(el("td", String(s.id)), el("td", new Date(s.timestamp_sec * 1000).toLocaleString()),
      el("td", s.merchant), el("td", formatNear(s.amount)), st, el("td", s.rule),
      el("td", s.reason, "reason"), el("td", s.memo, "memo"));
    body.append(tr);
  }
  $("count").textContent = `(${rows.length} of ${spends.length})`;
}

function renderFilters(by) {
  const f = $("filters"); f.replaceChildren();
  for (const k of ["all", ...Object.keys(by)]) {
    const b = el("button", k === "all" ? "All" : `${k} (${by[k]})`); b.type = "button";
    if (k === filter) b.classList.add("on");
    b.onclick = () => { filter = k; renderFilters(by); renderLog(); };
    f.append(b);
  }
}

async function load() {
  $("err").textContent = "";
  const network = $("network").value, contract = $("contract").value.trim();
  if (!isValidAccountId(contract)) { $("err").textContent = "Not a valid NEAR account id."; return; }
  try {
    const [status, policy] = await Promise.all([view(network, contract, "get_status"), view(network, contract, "get_policy")]);
    spends = await loadAllSpends(network, contract, status.log_len);
    const sum = summarize(spends);
    $("status").replaceChildren(
      card("contract state", status.paused ? "PAUSED" : "active"), card("owner", status.owner), card("agent (function-call key only)", status.agent),
      card("spent today", formatNear(status.spent_today)), card("pending co-sign", formatNear(status.reserved_pending)),
      card("budget left today", formatNear(status.available_budget)), card("attempts blocked", String(sum.byStatus.Blocked || 0)),
      card("value blocked", formatNear(sum.blockedYocto)));
    $("policy").replaceChildren(
      card("allowlist", policy.allowlist.join(", ") || "(empty)"), card("per-tx cap", formatNear(policy.per_tx_cap)),
      card("daily cap", formatNear(policy.daily_cap)), card("co-sign at or above", formatNear(policy.cosign_threshold)),
      card("velocity", `${policy.velocity_max_tx} tx / ${policy.velocity_window_sec}s`));
    renderFilters(sum.byStatus); renderLog();
    let eng = null; try { eng = await view(network, contract, "get_engine"); } catch { /* older contract without engine */ }
    $("engine").replaceChildren(...(eng ? [
      card("engine key (verdicts signed with ed25519)", eng.engine_pk), card("max risk score", String(eng.max_risk)),
      card("max verdict age", `${eng.max_age_sec}s`), card("signed verdict required", eng.required ? "yes" : "no (opt-in per spend)"),
      card("last accepted nonce", String(eng.last_nonce))] : [card("engine", "not registered")]));
    const u = new URL(location); u.searchParams.set("network", network); u.searchParams.set("contract", contract); history.replaceState(null, "", u);
  } catch (e) { $("err").textContent = `Could not load: ${e.message}`; }
}

const q = new URLSearchParams(location.search);
if (q.get("network")) $("network").value = q.get("network");
if (q.get("contract")) $("contract").value = q.get("contract");
$("cfg").onsubmit = (e) => { e.preventDefault(); load(); };
load();
