# Leash build plan (Nov 1 to Nov 14, 2026)

Deadline: repository public and submission sent before 2026-11-14T23:59Z (Nov 15 00:59 Budapest). Demo post on X by the human, with video, tagging @NEARProtocol and #NEARHackathon. Times below are Budapest.

## Done (Nov 1)

- Policy contract (`contract/`): allowlist, per-tx cap, daily cap, velocity, co-sign threshold, pause, owner/agent separation, spend log, `EVENT_JSON` events. 23 unit tests.
- Policy engine (`engine/`): prompt-injection and scam heuristics, intent digest. 12 vitest tests.
- README, threat model, MIT license.

## Done (Nov 2)

- `cargo-near` 0.22 and `near-cli-rs` 0.30 installed. `cargo near build reproducible-wasm` works (pinned `sourcescan/cargo-near:0.22.0-rust-1.99.1` image, toolchain pinned to 1.99.1). Contract reports its source commit via NEP-330 `contract_source_metadata`.
- `scripts/`: faucet-funded testnet accounts (owner, contract, agent, merchant), reproducible deploy with `new(...)`, function-call agent key limited to `request_spend` with two negative checks (plain transfer and `pause()` both rejected by NEAR). Testnet only, keys outside the repo.
- Live on testnet: `leash-11020911.testnet` (see `docs/DEPLOYMENTS.md`).
- `demo/`: gullible agent reads a poisoned coffee shop page, engine scores each intent, every intent goes to the contract anyway. On testnet: latte `Allowed`, drain of 8.36 NEAR to `attacker-vault.testnet` `Blocked`/`MerchantNotAllowlisted`. Offline simulator for keyless runs, `npm run show` reads the on-chain log. 9 vitest tests.
- README "do X, see Y" steps 1 to 9.

## Remaining

| Day | Work | Done when |
| --- | --- | --- |
| ~~Nov 2~~ | ~~cargo-near, near-cli-rs, reproducible build~~ | done Nov 2 |
| ~~Nov 3~~ | ~~Testnet deploy scripts, function-call agent key~~ | done Nov 2 (accounts via faucet, no human needed) |
| ~~Nov 4~~ | ~~Demo agent and poisoned page~~ | done Nov 2 (`demo/`) |
| ~~Nov 3~~ | ~~Contract: pending-spend expiry and transfer callback (mark `TransferFailed`, release budget). Tests. Redeploy to testnet. Record a `PerTxCap` attack and a co-sign on testnet.~~ | done Nov 3: 32 contract tests, in-place upgrade (state kept), txs in `docs/DEPLOYMENTS.md` |
| Nov 4 | Start NEAR AI Cloud research early (docs.near.ai, cloud.near.ai): TEE deployment, attestation format, signing key. Package engine as an HTTP service with a dev signing key. | Engine container returns signed verdict |
| Nov 5 | Read NEAR AI Cloud docs (docs.near.ai, cloud.near.ai) for TEE deployment and attestation format. Package engine as an HTTP service. | Engine runs locally in a container, returns signed verdict with a dev key |
| Nov 6 | Deploy engine to NEAR AI Cloud TEE. Fetch and verify attestation report. | Live attested endpoint |
| Nov 7 | Contract: `set_engine_key`, `request_spend_attested(intent, verdict, signature)`; reject if signature invalid or score above `max_risk`. Tests. | Contract rejects unattested or high-risk spends |
| Nov 8 | NEAR Intents: read docs.near-intents.org, 1Click API. Allowed spend for a cross-chain merchant produces an Intents quote (`dry: true`). | Quote flow works end to end in tests |
| Nov 9 | Intents execution with tiny amounts on a separate dev account, only after Adam approves spend. Otherwise keep `dry: true` and document. | One real or dry cross-chain settlement shown |
| ~~Nov 10~~ | ~~Dashboard read-only slice~~ | done Nov 8: `dashboard/` reads live testnet log, 5 tests. Co-sign and pause buttons via wallet selector still open. |
| Nov 10 | Dashboard (`dashboard/`): reads `get_spends` and events, shows allowed/pending/blocked with reason, co-sign and pause buttons via wallet selector. | Dashboard shows the attack and a co-sign |
| Nov 11 | Host dashboard (Vercel), keep up to Nov 25. README "do X, see Y" for hosted demo. | Public URL works for judges |
| Nov 12 | Hardening: fuzz `evaluate`, more engine cases (multilingual injection, Hungarian included), gas profile. | All tests green |
| Nov 13 | Record 60 to 90 s demo video ("buy coffee, poisoned page, chain says no"). Draft X post for Adam. | Video file and draft ready |
| Nov 14 | Re-read HACKATHON.md. Final README pass. Adam publishes the X post, provides NEAR payout account and confirms the submission payload. Submit once. | 201 from the submission API |

## Rules to remember

- Never commit keys, seed phrases or account credentials. Env vars only.
- No mainnet deploy, transaction signing or token spend without Adam's explicit confirmation.
- The payout NEAR account is created by Adam. Never invent one.
- One submission per project, not editable. Print the payload and wait for a yes.
