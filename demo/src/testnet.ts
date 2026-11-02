/**
 * Testnet client. Signs `request_spend` with the agent's FUNCTION-CALL key
 * (the only key the agent has). Views go through public RPC, no key needed.
 */
import { readFileSync } from "node:fs";
import { Account, JsonRpcProvider, actions, teraToGas, type KeyPairString } from "near-api-js";
import type { LeashClient, LeashStatus, PolicyConfig, SpendResult } from "./types";

export const TESTNET_RPC = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";

export function explorerTx(hash: string): string {
  return `https://testnet.nearblocks.io/txns/${hash}`;
}

export function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const provider = new JsonRpcProvider({ url: TESTNET_RPC });
  return provider.callFunction({ contractId, method, args }) as Promise<T>;
}

export class TestnetLeash implements LeashClient {
  readonly kind = "testnet" as const;
  private readonly account?: Account;

  /** keyFile: near-cli credential JSON {account_id, public_key, private_key}. Omit for read-only. */
  constructor(readonly contractId: string, keyFile?: string) {
    if (!contractId.endsWith(".testnet")) throw new Error("testnet only");
    if (keyFile) {
      const k = JSON.parse(readFileSync(keyFile, "utf8")) as { account_id: string; private_key: string };
      const provider = new JsonRpcProvider({ url: TESTNET_RPC });
      this.account = new Account(k.account_id, provider, k.private_key as KeyPairString);
    }
  }

  getStatus(): Promise<LeashStatus> {
    return view(this.contractId, "get_status");
  }

  getPolicy(): Promise<PolicyConfig> {
    return view(this.contractId, "get_policy");
  }

  async requestSpend(merchant: string, amount: string, memo: string): Promise<{ result: SpendResult; txHash: string }> {
    if (!this.account) throw new Error("no agent key loaded (set LEASH_AGENT_KEY_FILE)");
    // deposit 0: function-call keys cannot attach deposits anyway.
    const res = (await this.account.signAndSendTransaction({
      receiverId: this.contractId,
      actions: [actions.functionCall("request_spend", { merchant, amount, memo }, teraToGas("30"), 0n)],
      waitUntil: "FINAL",
    })) as unknown as { transaction: { hash: string }; status: { SuccessValue?: string; Failure?: unknown } };
    const ok = res.status.SuccessValue;
    if (ok === undefined) throw new Error(`request_spend failed: ${JSON.stringify(res.status.Failure)}`);
    const result = JSON.parse(Buffer.from(ok, "base64").toString("utf8")) as SpendResult;
    return { result, txHash: res.transaction.hash };
  }
}
