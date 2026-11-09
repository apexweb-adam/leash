# TEE attestation in Leash

Leash uses a Trusted Execution Environment (Intel TDX, dstack) in two places. Both use one verifier, `engine/src/tee.ts`, and one report format (the NEAR AI Cloud / dstack format).

## 1. NEAR AI Cloud private inference (works today, no account)

The engine can ask a model running in a NEAR AI Cloud TEE for a second opinion on a spend (`engine/src/nearai-judge.ts`). The page the agent read can hold private data, so the engine sends it only after it has verified the model's TEE, and it accepts the answer only when the model's TEE signature covers the exact request and response bytes.

Verification needs no API key. Do:

```bash
cd engine && npm ci
npm run tee -- nearai                                  # gateway TEE
npm run tee -- nearai --model Qwen/Qwen3.6-35B-A3B-FP8 # gateway + model TEE (GPU CVM)
npm run tee -- nearai --offline                        # recorded report, no network
```

See (live run, Nov 9):

```
NEAR AI Cloud gateway TEE: VERIFIED  (dstack-0.5.12, ed25519 key 40599fb284f43953...)
  PASS  tdx_quote_parse        TDX quote v4
  PASS  nonce_echo             request_nonce matches our fresh nonce
  PASS  report_data_binding    quote binds signing key and nonce
  PASS  rtmr3_replay           10 runtime events replay to the quoted RTMR3
  PASS  mrconfigid_binding     MRCONFIGID = 01 || sha256(app_compose) || 0^15
  PASS  compose_hash_event     compose-hash runtime event matches app_compose
  PASS  intel_dcap             Intel DCAP: UpToDate

model attestation #0: VERIFIED  (dstack-nvidia-0.5.12, ed25519 key 89fb781a9530473a...)
  ... same 7 checks, all PASS
```

What each check means:

| Check | Why it matters |
| --- | --- |
| `nonce_echo`, `report_data_binding` | The quote's 64-byte report data is `signing_key || our fresh nonce`. A replayed or borrowed report fails. |
| `rtmr3_replay` | Runtime events (app id, compose hash, KMS, OS image) are re-hashed by us, not trusted, and must replay to RTMR3 in the quote. |
| `mrconfigid_binding`, `compose_hash_event` | The exact docker compose that runs is measured. Changing one byte of it changes the quote. |
| `intel_dcap` | Intel signature chain, QE identity and TCB status, via `@phala/dcap-qvl` with collateral from a PCCS. |

Not checked yet: NVIDIA GPU evidence (`nvidia_payload`) of the model CVM, and the TLS-connection binding of the gateway (`include_tls_fingerprint`).

The judge flow (all steps are unit tested with a synthetic TEE in `engine/test/tee.test.ts`):

1. Preflight: model report with a fresh nonce, every candidate must pass all checks.
2. `POST /v1/chat/completions` with `x-no-aliasing: true`, exact bytes kept.
3. `GET /v1/signature/<id>?signing_algo=ed25519`: `signature_kind` must be `provider_tee`, `text` must equal `<model>:<sha256 request>:<sha256 response>`, the ed25519 signature must verify, and the signer must match exactly one verified report.
4. A verified "injection" answer can only raise the engine's score (`combineScore`). Anything unverified is ignored and the heuristic score stands.

Running the judge for real needs a NEAR AI Cloud API key (`NEAR_AI_API_KEY`, environment only). See "What needs an account" below.

## 2. The Leash engine itself inside a TEE

Today the engine signs verdicts with a dev key from the environment, and the contract checks that signature (`request_spend_attested`, see README step 10). The TEE step removes the dev key:

- `engine/Dockerfile` and `deploy/dstack/docker-compose.yml` run the engine in a dstack CVM with `LEASH_TEE=dstack`.
- With `LEASH_TEE=dstack` the engine refuses an environment seed. It derives its ed25519 seed from the app's KMS key through the dstack guest agent (`/var/run/dstack.sock`, `GetKey`), so no human ever holds it. Without the socket it fails closed.
- `GET /attestation?nonce=<64 hex>` returns a TDX quote over `engine_public_key || nonce` (`GetQuote`), in the same shape as NEAR AI Cloud.
- The owner verifies it before registering the key:

```bash
cd engine && npm run tee -- engine --url https://<engine-host> --image sha256:<pushed image digest>
```

It prints `VERIFIED` and the exact `set_engine` command with `required: true` only when every check passes, the attested key equals the key the engine serves, and the measured compose pins the expected image digest. Otherwise it prints `Do NOT register this key.`

Tested offline against a fake dstack socket (`engine/test/tee.test.ts`): stable seed derivation, report binding, verifier accept and reject, server refusing a dev seed in TEE mode, `/attestation` returning 501 outside a TEE.

## What needs an account

| Step | Needs | Status |
| --- | --- | --- |
| Verify NEAR AI Cloud gateway and model TEEs | nothing | done, live |
| Attested model judge (`NEAR_AI_API_KEY`) | NEAR AI Cloud account at https://cloud.near.ai, credits (HACKATHON.md Q-000: $10 by joining NEAR Builders at https://nearbuilders.org/join, or buy), then create an API key in the dashboard | waiting for account |
| Engine in a dstack CVM | a TEE host that runs a docker compose: Phala Cloud (https://cloud.phala.network, dstack) or NEAR AI Cloud if it offers custom CVMs to the account. Plus a public image registry for the engine image (GHCR on the repo owner works) | waiting for account and image push |

No key, seed or API key is ever committed. `NEAR_AI_API_KEY` goes in as an encrypted dstack secret, never in the compose file.
