import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface Deployment {
  network: "testnet";
  owner: string;
  contract: string;
  agent: string;
  merchant: string;
  wasm_sha256?: string;
}

export function loadDeployment(file = resolve(REPO_ROOT, "deployments/testnet.json")): Deployment {
  const d = JSON.parse(readFileSync(file, "utf8")) as Deployment;
  if (d.network !== "testnet") throw new Error("testnet only");
  return d;
}

export function loadFixture(): string {
  return readFileSync(resolve(REPO_ROOT, "demo/fixtures/coffee-shop.html"), "utf8");
}

/** Attacker account named in the poisoned page. Never allowlisted. */
export const ATTACKER = "attacker-vault.testnet";
