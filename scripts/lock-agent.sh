#!/usr/bin/env bash
# Remove the agent account's own full-access key, so the ONLY keys left on it
# are the Leash function-call keys. Faucet accounts are created with a full
# key; until it is deleted the "agent cannot transfer" claim only holds for
# the key the agent runtime has. After this, it holds for the account.
#
# 1. moves the agent's spare balance to the owner (keeps 1 NEAR for gas),
# 2. checks at least one function-call key on the Leash contract exists,
# 3. deletes the full-access key, then shows the remaining keys.
# Testnet only. Irreversible for this account: to rotate later, create a new
# agent account and call set_agent from the owner.
#
# Usage: scripts/lock-agent.sh
source "$(dirname "$0")/common.sh"

CONTRACT="$(acct contract)"; AGENT="$(acct agent)"; OWNER="$(acct owner)"
FULL="$(keyfile "$AGENT")"
[ -f "$FULL" ] || { echo "no full-access key file for $AGENT (already locked?)" >&2; exit 1; }
PK="$(node -e 'process.stdout.write(require(process.argv[1]).public_key)' "$FULL")"

KEYS="$(near account list-keys "$AGENT" network-config testnet now 2>&1)"
echo "$KEYS" | grep -q "function calls on $CONTRACT" || { echo "no function-call key on $CONTRACT, refusing" >&2; exit 1; }
echo "$KEYS" | grep -q "${PK#ed25519:}" || { echo "full key $PK not on $AGENT (already locked)"; exit 0; }

BAL="$(near account view-account-summary "$AGENT" network-config testnet now 2>&1 | awk '/Native account balance/ {print $4}')"
SPARE="$(node -e 'const b=Number(process.argv[1]); const s=Math.floor((b-1)*1000)/1000; process.stdout.write(s>0?String(s):"0")' "$BAL")"
if [ "$SPARE" != "0" ]; then
  echo "== moving $SPARE NEAR spare balance from $AGENT to owner $OWNER"
  near tokens "$AGENT" send-near "$OWNER" "$SPARE NEAR" network-config testnet $(sign "$AGENT") send
fi

echo "== deleting full-access key $PK from $AGENT"
near account delete-keys "$AGENT" public-keys "$PK" network-config testnet $(sign "$AGENT") send

near account list-keys "$AGENT" network-config testnet now
