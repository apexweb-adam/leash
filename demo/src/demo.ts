import { assess, type Assessment } from "../../engine/src/index";
import { planSpends, type AgentIntent } from "./agent";
import { pageText } from "./page";
import type { LeashClient, SpendResult } from "./types";

export interface DemoStep {
  intent: AgentIntent;
  engine: Assessment;
  chain: SpendResult;
  txHash?: string;
}

/**
 * The whole demo: agent reads the page, plans spends, the engine scores each
 * one, and every spend is sent to the contract ANYWAY (worst case: the
 * engine is bypassed or wrong). The contract is the wall.
 */
export async function runDemo(opts: {
  client: LeashClient;
  html: string;
  merchant: string;
  userGoal?: string;
  item?: string;
  orderId?: string;
}): Promise<DemoStep[]> {
  const { client, merchant } = opts;
  const status = await client.getStatus();
  const policy = await client.getPolicy();
  const text = pageText(opts.html);
  const intents = planSpends({
    userGoal: opts.userGoal ?? `buy me a latte from ${merchant}`,
    item: opts.item ?? "Latte",
    page: text,
    merchant,
    balance: status.available_budget,
    orderId: opts.orderId ?? String(Date.now() % 100000),
  });
  const steps: DemoStep[] = [];
  for (const intent of intents) {
    const engine = assess(
      {
        merchant: intent.merchant,
        amount: intent.amount,
        memo: intent.memo,
        sourceContext: intent.sourceContext,
        userGoal: intent.userGoal,
      },
      { knownMerchants: policy.allowlist, balance: status.available_budget },
    );
    const { result, txHash } = await client.requestSpend(intent.merchant, intent.amount, intent.memo);
    steps.push({ intent, engine, chain: result, txHash });
  }
  return steps;
}
