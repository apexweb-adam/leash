/**
 * Offline stand-in for the Leash contract, for running the demo without a
 * testnet key. It is a line-by-line port of `evaluate` in
 * contract/src/policy.rs (same rule order, same reason strings). The real
 * enforcement is the deployed contract: run without --offline to use it.
 */
import type { LeashClient, LeashStatus, PolicyConfig, SpendResult, SpendStatus } from "./types";

const MAX_MEMO_LEN = 256;
const SECS_PER_DAY = 86_400;

export class OfflineLeash implements LeashClient {
  readonly kind = "offline" as const;
  private spentToday = 0n;
  private reserved = 0n;
  private recent: number[] = [];
  private day = 0;
  private logLen = 0;
  paused = false;

  constructor(
    private readonly owner: string,
    private readonly agent: string,
    private readonly config: PolicyConfig,
    private balance: bigint,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async getPolicy(): Promise<PolicyConfig> {
    return structuredClone(this.config);
  }

  async getStatus(): Promise<LeashStatus> {
    return {
      owner: this.owner,
      agent: this.agent,
      paused: this.paused,
      spent_today: this.spentToday.toString(),
      reserved_pending: this.reserved.toString(),
      available_budget: (this.balance - this.reserved).toString(),
      log_len: this.logLen,
    };
  }

  async requestSpend(merchant: string, amountStr: string, memo: string): Promise<{ result: SpendResult }> {
    const now = this.now();
    const day = Math.floor(now / SECS_PER_DAY);
    if (day !== this.day) {
      this.day = day;
      this.spentToday = 0n;
    }
    const c = this.config;
    this.recent = this.recent.filter((t) => t > now - c.velocity_window_sec);
    const amount = BigInt(amountStr);
    const available = this.balance - this.reserved;
    const block = (rule: SpendResult["rule"], reason: string) => this.log("Blocked", rule, reason);

    if (this.paused) return block("Paused", "policy is paused by owner");
    if (amount === 0n) return block("ZeroAmount", "amount must be > 0");
    if (Buffer.byteLength(memo) > MAX_MEMO_LEN) return block("MemoTooLong", `memo longer than ${MAX_MEMO_LEN} bytes`);
    if (!c.allowlist.includes(merchant)) return block("MerchantNotAllowlisted", `merchant ${merchant} is not on the allowlist`);
    if (amount > BigInt(c.per_tx_cap)) return block("PerTxCap", `amount ${amount} exceeds per-tx cap ${c.per_tx_cap}`);
    if (this.spentToday + amount > BigInt(c.daily_cap))
      return block("DailyCap", `daily cap ${c.daily_cap} would be exceeded (already ${this.spentToday}, request ${amount})`);
    if (this.recent.length >= c.velocity_max_tx)
      return block("Velocity", `velocity limit: ${this.recent.length} spends in last ${c.velocity_window_sec}s (max ${c.velocity_max_tx})`);
    if (amount > available) return block("InsufficientBudget", `amount ${amount} exceeds available budget ${available}`);

    this.spentToday += amount;
    this.recent.push(now);
    if (amount >= BigInt(c.cosign_threshold)) {
      this.reserved += amount;
      return this.log("PendingCosign", "CosignThreshold", `amount ${amount} >= co-sign threshold ${c.cosign_threshold}; waiting for owner`);
    }
    this.balance -= amount; // transfer to merchant
    return this.log("Allowed", "WithinPolicy", "within policy");
  }

  private log(status: SpendStatus, rule: SpendResult["rule"], reason: string) {
    return { result: { id: this.logLen++, status, rule, reason } };
  }
}
