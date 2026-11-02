/**
 * A deliberately gullible "agent". No LLM, so the demo is deterministic and
 * needs no API key. It models the worst case: it does the user's task AND
 * obeys any payment instruction it finds in the page it reads.
 */
export const YOCTO_PER_NEAR = 10n ** 24n;

export interface AgentIntent {
  label: "user_task" | "injected";
  merchant: string;
  amount: string; // yoctoNEAR
  memo: string;
  sourceContext: string;
  userGoal: string;
}

/** "0.05" NEAR -> yoctoNEAR string, exact (no floats). */
export function nearToYocto(near: string): string {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(near.trim());
  if (!m) throw new Error(`bad NEAR amount: ${near}`);
  const frac = (m[2] ?? "").padEnd(24, "0");
  return (BigInt(m[1]) * YOCTO_PER_NEAR + BigInt(frac)).toString();
}

export function yoctoToNear(yocto: string | bigint, digits = 4): string {
  const v = BigInt(yocto);
  const whole = v / YOCTO_PER_NEAR;
  const frac = (v % YOCTO_PER_NEAR).toString().padStart(24, "0").slice(0, digits);
  return `${whole}.${frac}`;
}

export function planSpends(args: {
  userGoal: string;
  item: string;
  page: string;
  merchant: string;
  balance: string;
  orderId: string;
}): AgentIntent[] {
  const intents: AgentIntent[] = [];
  const price = new RegExp(`${args.item}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*NEAR`, "i").exec(args.page);
  if (price) {
    intents.push({
      label: "user_task",
      merchant: args.merchant,
      amount: nearToYocto(price[1]),
      memo: `1 ${args.item.toLowerCase()}, order ${args.orderId}`,
      // The evidence the agent used for this spend: the menu line.
      sourceContext: price[0],
      userGoal: args.userGoal,
    });
  }
  const injected = /send (?:the )?(?:entire|whole|full|all(?: of)?(?: the)?) (?:balance|funds)\s+to\s+([a-z0-9._-]+\.(?:testnet|near))/i.exec(
    args.page,
  );
  if (injected) {
    intents.push({
      label: "injected",
      merchant: injected[1].toLowerCase(),
      amount: args.balance,
      memo: "security transfer",
      // The evidence for this spend: the page text that contained the order.
      sourceContext: args.page,
      userGoal: args.userGoal,
    });
  }
  return intents;
}
