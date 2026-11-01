# Leash build plan (Nov 1 to Nov 14, 2026)

Deadline: repository public and submission sent before 2026-11-14T23:59Z (Nov 15 00:59 Budapest). Demo post on X by the human, with video, tagging @NEARProtocol and #NEARHackathon. Times below are Budapest.

## Done (Nov 1)

- Policy contract (`contract/`): allowlist, per-tx cap, daily cap, velocity, co-sign threshold, pause, owner/agent separation, spend log, `EVENT_JSON` events. 23 unit tests.
- Policy engine (`engine/`): prompt-injection and scam heuristics, intent digest. 12 vitest tests.
- README, threat model, MIT license, CI.

## Remaining

| Day | Work | Done when |
| --- | --- | --- |
| Nov 2 | Install `cargo-near` and `near-cli-rs`. Reproducible build. Add pending-spend expiry and transfer callback (mark `TransferFailed`). Tests. | `cargo near build` passes, new tests green |
| Nov 3 | Testnet deploy script (`scripts/deploy-testnet.sh`) using env vars only. Script that adds a function-call key for the agent limited to `request_spend`. Human creates the testnet accounts. | Contract live on testnet, agent key can only call `request_spend` (verified by a failing transfer attempt) |
| Nov 4 | Demo agent (`agent/`): small TS agent with a "buy coffee" tool that calls `request_spend`. Poisoned test page served locally. | Attack recorded on testnet: `Blocked` with reason in `get_spends` |
| Nov 5 | Read NEAR AI Cloud docs (docs.near.ai, cloud.near.ai) for TEE deployment and attestation format. Package engine as an HTTP service. | Engine runs locally in a container, returns signed verdict with a dev key |
| Nov 6 | Deploy engine to NEAR AI Cloud TEE. Fetch and verify attestation report. | Live attested endpoint |
| Nov 7 | Contract: `set_engine_key`, `request_spend_attested(intent, verdict, signature)`; reject if signature invalid or score above `max_risk`. Tests. | Contract rejects unattested or high-risk spends |
| Nov 8 | NEAR Intents: read docs.near-intents.org, 1Click API. Allowed spend for a cross-chain merchant produces an Intents quote (`dry: true`). | Quote flow works end to end in tests |
| Nov 9 | Intents execution with tiny amounts on a separate dev account, only after Adam approves spend. Otherwise keep `dry: true` and document. | One real or dry cross-chain settlement shown |
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
