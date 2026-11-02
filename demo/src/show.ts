/** npm run show -> read the on-chain spend log of the deployed testnet contract. No key needed. */
import { yoctoToNear } from "./agent";
import { loadDeployment } from "./config";
import { view } from "./testnet";
import type { LeashStatus } from "./types";

interface Rec { id: number; merchant: string; amount: string; memo: string; status: string; rule: string; reason: string; timestamp_sec: number }

const dep = loadDeployment();
const st = await view<LeashStatus>(dep.contract, "get_status");
const from = Math.max(0, st.log_len - 20);
const log = await view<Rec[]>(dep.contract, "get_spends", { from_index: from, limit: 20 });
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ contract: dep.contract, status: st, spends: log }, null, 2));
} else {
  console.log(`contract ${dep.contract}  owner ${st.owner}  agent ${st.agent}  paused ${st.paused}`);
  console.log(`available ${yoctoToNear(st.available_budget)} NEAR, spent today ${yoctoToNear(st.spent_today)} NEAR, log ${st.log_len}`);
  for (const r of log) {
    const t = new Date(r.timestamp_sec * 1000).toISOString();
    console.log(`#${r.id} ${t} ${r.status.padEnd(13)} ${yoctoToNear(r.amount).padStart(10)} NEAR -> ${r.merchant}  [${r.rule}] ${r.reason}`);
  }
}
