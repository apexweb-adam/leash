/** Mirrors the contract's JSON types (contract/src/lib.rs, policy.rs). */
export type SpendStatus = "Allowed" | "PendingCosign" | "Blocked" | "Approved" | "Rejected";
export type Rule =
  | "Paused"
  | "ZeroAmount"
  | "MemoTooLong"
  | "MerchantNotAllowlisted"
  | "PerTxCap"
  | "DailyCap"
  | "Velocity"
  | "InsufficientBudget"
  | "CosignThreshold"
  | "WithinPolicy";

export interface SpendResult {
  id: number;
  status: SpendStatus;
  rule: Rule;
  reason: string;
}

export interface PolicyConfig {
  allowlist: string[];
  per_tx_cap: string;
  daily_cap: string;
  velocity_max_tx: number;
  velocity_window_sec: number;
  cosign_threshold: string;
}

export interface LeashStatus {
  owner: string;
  agent: string;
  paused: boolean;
  spent_today: string;
  reserved_pending: string;
  available_budget: string;
  log_len: number;
}

/** What the demo needs from "the chain". Testnet and the offline simulator both implement it. */
export interface LeashClient {
  readonly kind: "testnet" | "offline";
  getStatus(): Promise<LeashStatus>;
  getPolicy(): Promise<PolicyConfig>;
  requestSpend(merchant: string, amount: string, memo: string): Promise<{ result: SpendResult; txHash?: string }>;
}
