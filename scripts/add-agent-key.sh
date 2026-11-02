#!/usr/bin/env bash
# Give the agent its leash: a NEAR function-call access key that can ONLY call
# request_spend on the Leash contract, with a 0.25 NEAR gas allowance and no
# ability to attach deposits. The private key goes to
# $LEASH_SECRETS_DIR/<agent>.fc.json. Then prove the key is restricted:
# a direct transfer and an owner-only method must both be rejected by NEAR.
#
# Usage: scripts/add-agent-key.sh
source "$(dirname "$0")/common.sh"

CONTRACT="$(acct contract)"; AGENT="$(acct agent)"; OWNER="$(acct owner)"
FC="$SECRETS_DIR/$AGENT.fc.json"

if [ ! -f "$FC" ]; then
  node "$REPO_ROOT/scripts/keygen.mjs" "$AGENT" "$FC" >/dev/null
fi
PK="$(node -e 'process.stdout.write(require(process.argv[1]).public_key)' "$FC")"

if near account list-keys "$AGENT" network-config testnet now 2>/dev/null | grep -q "${PK#ed25519:}"; then
  echo "function-call key already on $AGENT"
else
  near account add-key "$AGENT" grant-function-call-access \
    --allowance '0.25 NEAR' --contract-account-id "$CONTRACT" --function-names request_spend \
    use-manually-provided-public-key "$PK" network-config testnet $(sign "$AGENT") send
fi

near account list-keys "$AGENT" network-config testnet now

LOG="$(mktemp)"
echo "== check 1: function-call key tries a direct 0.01 NEAR transfer to owner (must FAIL)"
near tokens "$AGENT" send-near "$OWNER" '0.01 NEAR' network-config testnet \
  sign-with-access-key-file "$FC" send >"$LOG" 2>&1 || true
if grep -q "requires a full permission access key" "$LOG"; then
  echo "OK: NEAR rejected it: Transaction requires a full permission access key."
else cat "$LOG"; echo "UNEXPECTED: transfer not rejected" >&2; exit 1; fi

echo "== check 2: function-call key tries owner method pause() (must FAIL)"
near contract call-function as-transaction "$CONTRACT" pause json-args '{}' prepaid-gas '30.0 Tgas' \
  attached-deposit '0 NEAR' sign-as "$AGENT" network-config testnet \
  sign-with-access-key-file "$FC" send >"$LOG" 2>&1 || true
if grep -q "isn't allowed by the access key" "$LOG"; then
  echo "OK: NEAR rejected it: Transaction method name <pause> isn't allowed by the access key."
else cat "$LOG"; echo "UNEXPECTED: pause not rejected" >&2; exit 1; fi
rm -f "$LOG"
