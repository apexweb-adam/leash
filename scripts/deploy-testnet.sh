#!/usr/bin/env bash
# Build the contract reproducibly and deploy it to the contract account with
# new(owner, agent, config). The contract account balance is the agent budget.
#
# Demo policy (yoctoNEAR strings in the call):
#   allowlist         [merchant]
#   per_tx_cap        0.5 NEAR
#   daily_cap         2 NEAR
#   cosign_threshold  0.2 NEAR   (spends >= 0.2 NEAR wait for the owner)
#   velocity          5 spends per 60 s
#
# Usage: scripts/deploy-testnet.sh            (reproducible build if Docker + clean tree)
#        LEASH_WASM=path.wasm scripts/deploy-testnet.sh   (use a prebuilt wasm)
#        LEASH_UPGRADE=1 scripts/deploy-testnet.sh        (redeploy code, keep state and spend log;
#                                                          only valid when the state layout is unchanged)
source "$(dirname "$0")/common.sh"

OWNER="$(acct owner)"; CONTRACT="$(acct contract)"; AGENT="$(acct agent)"; MERCHANT="$(acct merchant)"
[ -n "$CONTRACT" ] || { echo "run scripts/create-testnet-accounts.sh first" >&2; exit 1; }

WASM="${LEASH_WASM:-}"
if [ -z "$WASM" ]; then
  need cargo
  if [ -z "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ] && command -v docker >/dev/null; then
    (cd "$REPO_ROOT/contract" && cargo near build reproducible-wasm)
  else
    # reproducible-wasm needs Docker and a clean git tree (it embeds the commit).
    echo "note: dirty git tree or no Docker, using cargo near build non-reproducible-wasm" >&2
    (cd "$REPO_ROOT/contract" && cargo near build non-reproducible-wasm)
  fi
  WASM="$REPO_ROOT/contract/target/near/leash_policy.wasm"
fi
sha="$(sha256sum "$WASM" | cut -d' ' -f1)"
echo "deploying $WASM (sha256 $sha) to $CONTRACT"

ARGS=$(node -e '
const [owner, agent, merchant] = process.argv.slice(1);
const N = 10n ** 24n;
const near = (x) => (BigInt(Math.round(x * 1000)) * N / 1000n).toString();
console.log(JSON.stringify({ owner, agent, config: {
  allowlist: [merchant], per_tx_cap: near(0.5), daily_cap: near(2),
  cosign_threshold: near(0.2), velocity_max_tx: 5, velocity_window_sec: 60 } }));
' "$OWNER" "$AGENT" "$MERCHANT")

if [ -n "${LEASH_UPGRADE:-}" ]; then
  near contract deploy "$CONTRACT" use-file "$WASM" without-init-call \
    network-config testnet $(sign "$CONTRACT") send
else
  near contract deploy "$CONTRACT" use-file "$WASM" \
    with-init-call new json-args "$ARGS" prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
    network-config testnet $(sign "$CONTRACT") send
fi

node -e '
const fs=require("fs");const [f,sha]=process.argv.slice(1);
const d=JSON.parse(fs.readFileSync(f,"utf8"));d.wasm_sha256=sha;d.deployed_at=new Date().toISOString();
fs.writeFileSync(f,JSON.stringify(d,null,2)+"\n");' "$DEPLOY_FILE" "$sha"

near contract call-function as-read-only "$CONTRACT" get_status json-args '{}' network-config testnet now
