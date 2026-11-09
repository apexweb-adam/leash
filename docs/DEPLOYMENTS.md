# Deployments

Testnet only. There is no mainnet deployment. Private keys are never in this repository; the scripts write them to `$LEASH_SECRETS_DIR` outside the repo (mode 600).

Machine-readable record: [`deployments/testnet.json`](../deployments/testnet.json).

## NEAR testnet, 2026-11-02

| Role | Account | Keys |
| --- | --- | --- |
| Policy contract (holds the agent budget) | [`leash-11020911.testnet`](https://testnet.nearblocks.io/address/leash-11020911.testnet) | full access (deployer) |
| Owner (the human) | [`leash-owner-11020911.testnet`](https://testnet.nearblocks.io/address/leash-owner-11020911.testnet) | full access |
| Agent | [`leash-agent-11020911.testnet`](https://testnet.nearblocks.io/address/leash-agent-11020911.testnet) | the demo agent uses ONLY a function-call key: `request_spend` on the contract, 0.25 NEAR gas allowance |
| Merchant ("Bean There Coffee") | [`leash-coffee-11020911.testnet`](https://testnet.nearblocks.io/address/leash-coffee-11020911.testnet) | full access |

All four accounts were created with the public testnet faucet (`near account create-account sponsor-by-faucet-service`), no human or money involved.

### Contract build

- Built with `cargo near build reproducible-wasm` (image `sourcescan/cargo-near:0.22.0-rust-1.99.1`, digest pinned in `contract/Cargo.toml`).
- Source snapshot embedded in the contract (NEP-330): commit [`4477303`](https://github.com/apexweb-adam/leash/tree/44773032abad46c79c7231bc33089f4b67e67cdf). Check it: `near contract call-function as-read-only leash-11020911.testnet contract_source_metadata json-args {} network-config testnet now`
- Deployed wasm sha256: `b0acc90e236e32beec65c3ba78ef590ea23b6e07d3b34ab5f66e1000468a0d0a`

### Policy at deploy

`allowlist = [leash-coffee-11020911.testnet]`, `per_tx_cap = 0.5 NEAR`, `daily_cap = 2 NEAR`, `cosign_threshold = 0.2 NEAR`, `velocity = 5 spends / 60 s`.

### Transactions

| What | Result | Tx |
| --- | --- | --- |
| Create owner account (faucet) | ok | [3Yxisq2W...](https://testnet.nearblocks.io/txns/3Yxisq2WC7uoufLQVAZChmkNVTuZN4xBXVYGUQWNct3B) |
| Deploy contract + `new(owner, agent, config)` | ok | [DzrWQ8yq...](https://testnet.nearblocks.io/txns/DzrWQ8yqfwFw9QXz2tgtxhH379GyxJvanRyXobK1m39G) |
| Add agent function-call key (`request_spend` only) | ok | [CC9bay9v...](https://testnet.nearblocks.io/txns/CC9bay9v5XsfgtJcTXULeEJFVdiRKfiD7rNA12BWEviH) |
| Agent key tries a plain 0.01 NEAR transfer | rejected, never included on chain: `Transaction requires a full permission access key.` | none (never accepted) |
| Agent key tries owner method `pause()` | rejected, never included on chain: `Transaction method name <pause> isn't allowed by the access key.` | none (never accepted) |
| Demo: agent buys a 0.05 NEAR latte | `Allowed` / `WithinPolicy`, 0.05 NEAR sent to the merchant | [7CJrjBU1...](https://testnet.nearblocks.io/txns/7CJrjBU1VdjWFo5rRMzmCpUsB44fzy6PMds6EXNNbzxS) |
| Demo: poisoned page makes the agent send the whole budget (8.3579 NEAR) to `attacker-vault.testnet` | `Blocked` / `MerchantNotAllowlisted`, nothing moved, attempt stored in the spend log | [C31sZXh5...](https://testnet.nearblocks.io/txns/C31sZXh5TdsmgbXP4TutP6KrsPedtbZWLGhgGrBeMGPq) |

| Upgrade (2026-11-03): redeploy code without re-init, state and spend log kept (layout unchanged, two enum variants appended) | ok | [HyNqcBEt...](https://testnet.nearblocks.io/txns/HyNqcBEtxN8bdP8CUzBXNmNUvVf73KXddVC9B8vPJik8) |
| Attack: poisoned receipt names the REAL merchant but inflates the total to 0.6 NEAR | `Blocked` / `PerTxCap`, nothing moved, attempt stored in the spend log (id 2) | [6NJ68Rih...](https://testnet.nearblocks.io/txns/6NJ68RihUd9NM1CVeeS8B77JVHgwNijrwPs1RtVrxim6) |
| Agent asks for 0.3 NEAR of coffee beans (over the 0.2 NEAR co-sign threshold) | `PendingCosign` / `CosignThreshold`, budget reserved, nothing moved yet (id 3) | [Hh3vkBBY...](https://testnet.nearblocks.io/txns/Hh3vkBBYTPzSqMWqLSoDWV4rGZp3ApHYHJuhjHW2BYup) |
| Owner co-signs id 3 | `Approved`, 0.3 NEAR sent to the merchant, `on_transfer` callback confirmed it | [CCkg7j9X...](https://testnet.nearblocks.io/txns/CCkg7j9X6FLQKpf3LHEMZh2xMHaE3sHKJ4BbEUENUr4y) |

### Upgrade, 2026-11-03

- Adds a 24 h TTL on pending co-sign requests (`expire_pending(id)`, callable by anyone after the TTL, releases the reservation) and a transfer callback (`on_transfer`, private) that marks a failed payout `TransferFailed` and gives the daily budget back.
- Reproducible build, same pinned image. Source snapshot (NEP-330): commit [`08db527`](https://github.com/apexweb-adam/leash/tree/08db5277c0c0492d22c21da33b5b2d34e0a4b350).
- Deployed wasm sha256: `91114f1a397fb83735e041667a5bad707e51d4eef693441116a48f56a2dd9146` (the 2026-11-02 build above is superseded).

Read the log yourself (no key needed): `cd demo && npm ci && npm run show`.

## Nov 9, 2026: signed engine verdicts live on testnet

Commit `49f5cdc` built with `cargo near build reproducible-wasm` and deployed IN PLACE to `leash-11020911.testnet` (no re-init, state and spend log kept; the engine config lives under its own storage key, so no migration was needed). wasm sha256 `f0dece8904429f79bf70cf360d2e3d2e19a1e53bcf408126a9a16faa2a2dbbd8`.

Run with `scripts/attested-demo.sh`:

| Step | Tx | Result |
| --- | --- | --- |
| Owner registers engine key `ed25519:5av2VPczshKNPuE2SGy7FdkgenVEN1M74gZTHbiXAtqr` (max_risk 30, max_age 300 s) | [8fpfssbT...](https://testnet.nearblocks.io/txns/8fpfssbT41YEYs2h1ijRpkc8YHvtedtTuyJXNdoKWxEC) | ok |
| Agent gets a second function-call key, methods `request_spend`, `request_spend_attested` only | [CSqGDJL3...](https://testnet.nearblocks.io/txns/CSqGDJL32x4qQ9VBwhNPCReY2fQGSXysmVe1j4AA1Pne) | ok |
| #4 latte 0.05 NEAR, engine score 0, signed | [2p2LXkLq...](https://testnet.nearblocks.io/txns/2p2LXkLqHfgzXLwkRtTuZVngcPLzQN45Gk2tDcXDgtVr) | `Allowed` / `WithinPolicy`, paid |
| #5 0.1 NEAR to the allowlisted merchant with an injected memo, engine score 60, signed | [H49iuuQc...](https://testnet.nearblocks.io/txns/H49iuuQcLWJCNKRQowpJXZg1BS7fb2JeG27RYVLfg9rT) | `Blocked` / `EngineRisk` (allowlist and caps alone would have paid it) |
| #6 the latte verdict replayed | [8s1rqY6R...](https://testnet.nearblocks.io/txns/8s1rqY6RcKhhnHQqphxs5QPCXRcZHFMn7CsuRfwmEPnA) | `Blocked` / `BadAttestation` (nonce already used) |

The engine ran locally with a dev seed kept outside the repo. Next: run the same service in a NEAR AI Cloud TEE so the seed is generated inside attested hardware.

## Nov 9, 2026: hosted dashboard, Intents and TEE checks

- Dashboard: https://leash-near.apexweb-adam.workers.dev/ (Cloudflare Worker `leash-near`, static files only, built by `dashboard/deploy/build-worker.mjs`). Reads the live log above over public RPC. Keep online until at least Nov 25.
- NEAR Intents 1Click dry quote, mainnet API, no funds: 4.50 USDC on Base (`nep141:base-0x8335...2913.omft.near`) quoted at about 1.29 wNEAR, 20 bps 1Click fee, ~24 s. Recorded in `demo/fixtures/intents-dry-quote.json`.
- NEAR AI Cloud TEE evidence verified live (no key): gateway `dstack-0.5.12` and model `Qwen/Qwen3.6-35B-A3B-FP8` on `dstack-nvidia-0.5.12`, all 7 checks PASS including Intel DCAP `UpToDate`. Recorded gateway report in `engine/test/fixtures/nearai-gateway-report.json`.
- Not yet: engine in a hosted CVM (needs a TEE host account), so the registered testnet engine key is still the dev key.
- Agent account locked: spare balance moved to the owner, then the faucet-created full-access key `ed25519:B7Grg...BGkpG` deleted with `scripts/lock-agent.sh` ([tx](https://testnet.nearblocks.io/txns/3yeaCtRYp14VD1bMYCcrZrBM8RvXrHFxyaDXo9nobko6)). `leash-agent-11020911.testnet` now has only the two Leash function-call keys.
