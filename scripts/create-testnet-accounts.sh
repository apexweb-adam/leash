#!/usr/bin/env bash
# Create the four Leash demo accounts on NEAR testnet with the public faucet
# (no human, no wallet, no money). Keys are generated locally and written to
# $LEASH_SECRETS_DIR (mode 600). Account ids go to deployments/testnet.json.
#
#   owner     the human. Owns the policy, co-signs big spends.
#   contract  holds the Leash policy contract and the agent's budget.
#   agent     the AI agent. Will only get a function-call key (add-agent-key.sh).
#   merchant  an allowlisted "coffee shop".
#
# Usage: LEASH_SUFFIX=myname scripts/create-testnet-accounts.sh
source "$(dirname "$0")/common.sh"

SUFFIX="${LEASH_SUFFIX:-$(date +%m%d%H%M)}"
mkdir -p "$(dirname "$DEPLOY_FILE")"

declare -A IDS=(
  [owner]="leash-owner-$SUFFIX.testnet"
  [contract]="leash-$SUFFIX.testnet"
  [agent]="leash-agent-$SUFFIX.testnet"
  [merchant]="leash-coffee-$SUFFIX.testnet"
)

for role in owner contract agent merchant; do
  id="${IDS[$role]}"
  kf="$(keyfile "$id")"
  if [ -f "$kf" ] && near account view-account-summary "$id" network-config testnet now >/dev/null 2>&1; then
    echo "exists: $role $id"
    continue
  fi
  [ -f "$kf" ] || node "$REPO_ROOT/scripts/keygen.mjs" "$id" "$kf" >/dev/null
  pk="$(node -e 'process.stdout.write(require(process.argv[1]).public_key)' "$kf")"
  echo "creating: $role $id"
  near account create-account sponsor-by-faucet-service "$id" \
    use-manually-provided-public-key "$pk" network-config testnet create
done

node -e '
const [file, ...kv] = process.argv.slice(1);
const fs = require("fs");
const d = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
d.network = "testnet";
for (const p of kv) { const [k, v] = p.split("="); d[k] = v; }
fs.writeFileSync(file, JSON.stringify(d, null, 2) + "\n");
' "$DEPLOY_FILE" owner="${IDS[owner]}" contract="${IDS[contract]}" agent="${IDS[agent]}" merchant="${IDS[merchant]}"
echo "wrote $DEPLOY_FILE"
