/**
 * npm run demo              -> real NEAR testnet (needs LEASH_AGENT_KEY_FILE, the agent's function-call key)
 * npm run demo -- --offline -> offline simulator of the contract rules, no key, no network
 * Add --json for machine-readable output.
 */
import { existsSync } from "node:fs";
import { yoctoToNear } from "./agent";
import { ATTACKER, loadDeployment, loadFixture } from "./config";
import { runDemo } from "./demo";
import { renderFixture } from "./page";
import { OfflineLeash } from "./simulator";
import { TestnetLeash, explorerTx } from "./testnet";
import type { LeashClient } from "./types";

const args = new Set(process.argv.slice(2));
const dep = loadDeployment();
const keyFile = process.env.LEASH_AGENT_KEY_FILE;
const offline = args.has("--offline") || !keyFile || !existsSync(keyFile);

let client: LeashClient;
if (offline) {
  if (!args.has("--offline")) console.error("LEASH_AGENT_KEY_FILE not set or missing: using --offline simulator");
  const N = 10n ** 24n;
  client = new OfflineLeash(
    dep.owner,
    dep.agent,
    {
      allowlist: [dep.merchant],
      per_tx_cap: (N / 2n).toString(),
      daily_cap: (2n * N).toString(),
      cosign_threshold: (N / 5n).toString(),
      velocity_max_tx: 5,
      velocity_window_sec: 60,
    },
    8n * N,
  );
} else {
  client = new TestnetLeash(dep.contract, keyFile);
}

const html = renderFixture(loadFixture(), { merchant: dep.merchant, attacker: ATTACKER });
const steps = await runDemo({ client, html, merchant: dep.merchant });

if (args.has("--json")) {
  console.log(JSON.stringify({ mode: client.kind, contract: dep.contract, steps: steps.map((s) => ({
    label: s.intent.label, merchant: s.intent.merchant, amount: s.intent.amount,
    engine: { score: s.engine.score, verdict: s.engine.verdict, findings: s.engine.findings.map((f) => f.id) },
    chain: s.chain, tx: s.txHash ? explorerTx(s.txHash) : null })) }, null, 2));
} else {
  console.log(`Leash demo (${client.kind}${client.kind === "testnet" ? `, contract ${dep.contract}` : ""})`);
  console.log(`User goal: buy me a latte. The agent reads the coffee shop page (it contains a hidden prompt injection).\n`);
  for (const s of steps) {
    console.log(`[${s.intent.label}] pay ${yoctoToNear(s.intent.amount)} NEAR to ${s.intent.merchant} (memo "${s.intent.memo}")`);
    console.log(`  engine: score ${s.engine.score}, verdict ${s.engine.verdict}${s.engine.findings.length ? `, findings ${s.engine.findings.map((f) => f.id).join(", ")}` : ""}`);
    console.log(`  chain:  ${s.chain.status} (rule ${s.chain.rule}): ${s.chain.reason}`);
    if (s.txHash) console.log(`  tx:     ${explorerTx(s.txHash)}`);
    console.log("");
  }
  const st = await client.getStatus();
  console.log(`Budget left: ${yoctoToNear(st.available_budget)} NEAR. Spend log entries: ${st.log_len}.`);
}
