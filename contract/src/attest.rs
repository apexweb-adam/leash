//! Signed engine verdicts ("attestations").
//!
//! The off-chain policy engine (`engine/`) scores every spend intent for
//! prompt-injection and scam signals and signs its score with an ed25519 key.
//! The plan is to run that engine in a TEE on NEAR AI Cloud, so the key only
//! exists inside attested hardware. The contract stores the engine public key
//! and accepts `request_spend_attested` only when:
//!
//! 1. the signature over the exact (contract, merchant, amount, memo, score,
//!    time, nonce) message is valid for the registered engine key,
//! 2. the verdict is fresh (`max_age_sec`),
//! 3. the nonce is strictly greater than the last accepted one (no replay),
//! 4. the score is at or below `max_risk`.
//!
//! A failed check is never a panic: the attempt is logged as `Blocked` with
//! a rule id, the same way policy violations are.

use near_sdk::json_types::Base64VecU8;
use near_sdk::{env, near};

use crate::policy::Rule;

pub const MSG_PREFIX: &str = "leash-verdict-v1";
/// Storage key for the engine config. Kept outside the main state struct so
/// adding attestations does not need a state migration of the live contract.
pub const STORAGE_KEY: &[u8] = b"att";

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct EngineConfig {
    /// ed25519 public key of the policy engine, `ed25519:<base58>`.
    pub engine_pk: near_sdk::PublicKey,
    /// Highest engine score (0..=100) that may still spend.
    pub max_risk: u32,
    /// Verdicts older than this are rejected.
    pub max_age_sec: u64,
    /// When true, plain `request_spend` is blocked and every spend needs a verdict.
    pub required: bool,
    /// Last accepted nonce. Verdicts must use a strictly larger one.
    pub last_nonce: u64,
}

/// What the engine returns next to its score.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Attestation {
    pub score: u32,
    pub issued_at_sec: u64,
    pub nonce: u64,
    /// 64-byte ed25519 signature over `message(...)`, base64.
    pub signature: Base64VecU8,
}

/// Canonical message the engine signs. Newline separated ASCII, the memo is
/// hashed so arbitrary memo bytes cannot change the field layout.
pub fn message(contract: &str, merchant: &str, amount: u128, memo_sha256_hex: &str, a_score: u32, issued_at_sec: u64, nonce: u64) -> String {
    format!("{MSG_PREFIX}\n{contract}\n{merchant}\n{amount}\n{memo_sha256_hex}\n{a_score}\n{issued_at_sec}\n{nonce}")
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn load() -> Option<EngineConfig> {
    env::storage_read(STORAGE_KEY).map(|v| near_sdk::borsh::from_slice(&v).unwrap_or_else(|_| env::panic_str("bad engine config")))
}

pub fn save(cfg: &EngineConfig) {
    env::storage_write(STORAGE_KEY, &near_sdk::borsh::to_vec(cfg).unwrap());
}

pub fn clear() {
    env::storage_remove(STORAGE_KEY);
}

/// Returns the 32 raw key bytes, or None if the key is not ed25519.
pub fn ed25519_bytes(pk: &near_sdk::PublicKey) -> Option<[u8; 32]> {
    let raw = pk.as_bytes();
    if raw.len() != 33 || raw[0] != 0 {
        return None;
    }
    raw[1..].try_into().ok()
}

/// Check a verdict. Ok(()) means the spend may go on to the policy rules.
pub fn check(
    cfg: &EngineConfig,
    contract: &str,
    merchant: &str,
    amount: u128,
    memo: &str,
    a: &Attestation,
    now_sec: u64,
) -> Result<(), (Rule, String)> {
    let pk = ed25519_bytes(&cfg.engine_pk).ok_or((Rule::BadAttestation, "engine key is not ed25519".into()))?;
    let sig: [u8; 64] = a
        .signature
        .0
        .as_slice()
        .try_into()
        .map_err(|_| (Rule::BadAttestation, "signature must be 64 bytes".to_string()))?;
    let memo_hash = hex(&env::sha256(memo.as_bytes()));
    let msg = message(contract, merchant, amount, &memo_hash, a.score, a.issued_at_sec, a.nonce);
    if !env::ed25519_verify(&sig, msg.as_bytes(), &pk) {
        return Err((Rule::BadAttestation, "engine signature does not match this spend".into()));
    }
    if a.issued_at_sec > now_sec + 60 {
        return Err((Rule::BadAttestation, "verdict is dated in the future".into()));
    }
    if now_sec.saturating_sub(a.issued_at_sec) > cfg.max_age_sec {
        return Err((Rule::BadAttestation, format!("verdict older than {} s", cfg.max_age_sec)));
    }
    if a.nonce <= cfg.last_nonce {
        return Err((Rule::BadAttestation, format!("nonce {} already used (last {})", a.nonce, cfg.last_nonce)));
    }
    if a.score > cfg.max_risk {
        return Err((Rule::EngineRisk, format!("engine risk score {} above max {}", a.score, cfg.max_risk)));
    }
    Ok(())
}
