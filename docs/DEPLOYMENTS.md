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

Read the log yourself (no key needed): `cd demo && npm ci && npm run show`.
