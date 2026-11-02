# Shared settings for the Leash testnet scripts. Sourced, not executed.
# Testnet only. These scripts refuse to run against any other network.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="${NEAR_NETWORK:-testnet}"
if [ "$NETWORK" != "testnet" ]; then
  echo "Leash scripts are testnet only (NEAR_NETWORK=$NETWORK refused)" >&2
  exit 1
fi

# Private keys live OUTSIDE the repository. Override with LEASH_SECRETS_DIR.
SECRETS_DIR="${LEASH_SECRETS_DIR:-$HOME/.leash-secrets/testnet}"
case "$(realpath -m "$SECRETS_DIR")/" in
  "$REPO_ROOT"/*) echo "LEASH_SECRETS_DIR must be outside the repository" >&2; exit 1 ;;
esac
mkdir -p "$SECRETS_DIR" && chmod 700 "$SECRETS_DIR"

DEPLOY_FILE="$REPO_ROOT/deployments/testnet.json"

need() { command -v "$1" >/dev/null || { echo "missing tool: $1 (see README)" >&2; exit 1; }; }
need near
need node

# Public account ids from deployments/testnet.json (no secrets in that file).
acct() { node -e 'const d=require(process.argv[1]);process.stdout.write(d[process.argv[2]]||"")' "$DEPLOY_FILE" "$1"; }
keyfile() { echo "$SECRETS_DIR/$1.json"; }
sign() { echo sign-with-access-key-file "$(keyfile "$1")"; }
