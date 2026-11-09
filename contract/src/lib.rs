//! Leash policy contract: a spending firewall for AI agents on NEAR.
//!
//! The agent account only holds a function-call access key scoped to this
//! contract and the `request_spend` method. It can ask to spend, it cannot
//! move funds itself. Every request is evaluated by `policy::evaluate` and
//! written to an append-only spend log with a machine-readable reason.

pub mod attest;
pub mod policy;

use near_sdk::json_types::U128;
use near_sdk::store::Vector;
use near_sdk::{env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError};
use attest::{Attestation, EngineConfig};
use policy::{evaluate, Decision, PolicyConfig, Rule, Usage, Verdict};

const SECS_PER_DAY: u64 = 86_400;
/// Cap on stored velocity timestamps, so state cannot grow without bound.
const MAX_RECENT: usize = 64;
/// A spend waiting for a human co-sign expires after this many seconds.
/// After that anyone may call `expire_pending` to release the reserved budget,
/// and the owner can no longer co-sign it.
pub const PENDING_TTL_SEC: u64 = 86_400;
/// Gas reserved for the transfer callback.
const CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum SpendStatus {
    Allowed,
    PendingCosign,
    Blocked,
    Approved,
    Rejected,
    /// Pending co-sign was not answered within `PENDING_TTL_SEC`.
    Expired,
    /// Policy allowed the spend but the NEAR transfer failed (for example the
    /// merchant account does not exist). The budget is released again.
    TransferFailed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SpendRecord {
    pub id: u64,
    pub merchant: AccountId,
    pub amount: U128,
    pub memo: String,
    pub status: SpendStatus,
    pub rule: Rule,
    pub reason: String,
    pub timestamp_sec: u64,
    pub day: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct SpendResult {
    pub id: u64,
    pub status: SpendStatus,
    pub rule: Rule,
    pub reason: String,
}

#[near(serializers = [json])]
pub struct Status {
    pub owner: AccountId,
    pub agent: AccountId,
    pub paused: bool,
    pub spent_today: U128,
    pub reserved_pending: U128,
    pub available_budget: U128,
    pub log_len: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Leash {
    owner: AccountId,
    agent: AccountId,
    config: PolicyConfig,
    paused: bool,
    day_index: u64,
    spent_today: u128,
    reserved_pending: u128,
    recent: Vec<u64>,
    log: Vector<SpendRecord>,
}

#[near]
impl Leash {
    #[init]
    pub fn new(owner: AccountId, agent: AccountId, config: PolicyConfig) -> Self {
        require!(owner != agent, "owner and agent must be different accounts");
        Self {
            owner,
            agent,
            config,
            paused: false,
            day_index: 0,
            spent_today: 0,
            reserved_pending: 0,
            recent: Vec::new(),
            log: Vector::new(b"l"),
        }
    }

    // ---------- agent ----------

    /// Called by the agent through its function-call access key.
    /// Never panics on a policy violation: the attempt is logged as Blocked
    /// so the owner can see what the agent tried to do and why it failed.
    pub fn request_spend(&mut self, merchant: AccountId, amount: U128, memo: String) -> SpendResult {
        require!(env::predecessor_account_id() == self.agent, "only the agent can request spends");
        let pre = match attest::load() {
            Some(c) if c.required && !self.paused => Some(Decision {
                verdict: Verdict::Blocked,
                rule: Rule::AttestationRequired,
                reason: "owner requires a signed engine verdict, use request_spend_attested".into(),
            }),
            _ => None,
        };
        self.spend(merchant, amount, memo, pre)
    }

    /// Same as `request_spend`, plus a verdict signed by the policy engine.
    /// The signature binds this contract, merchant, amount, memo hash, score,
    /// time and nonce, so a verdict for a latte cannot be reused for a drain.
    pub fn request_spend_attested(&mut self, merchant: AccountId, amount: U128, memo: String, attestation: Attestation) -> SpendResult {
        require!(env::predecessor_account_id() == self.agent, "only the agent can request spends");
        let pre = if self.paused {
            None
        } else {
            match attest::load() {
                None => Some(Decision { verdict: Verdict::Blocked, rule: Rule::NoEngineKey, reason: "no engine key registered".into() }),
                Some(mut c) => {
                    let me = env::current_account_id();
                    match attest::check(&c, me.as_str(), merchant.as_str(), amount.0, &memo, &attestation, now_sec()) {
                        Ok(()) => {
                            c.last_nonce = attestation.nonce;
                            attest::save(&c);
                            None
                        }
                        Err((rule, reason)) => Some(Decision { verdict: Verdict::Blocked, rule, reason }),
                    }
                }
            }
        };
        self.spend(merchant, amount, memo, pre)
    }

    // ---------- owner: engine ----------

    /// Register the policy engine key. `max_risk` is the highest engine score
    /// that may still spend; `required` makes every spend need a verdict.
    pub fn set_engine(&mut self, engine_pk: near_sdk::PublicKey, max_risk: u32, max_age_sec: u64, required: bool) {
        self.assert_owner();
        require!(attest::ed25519_bytes(&engine_pk).is_some(), "engine key must be ed25519");
        require!(max_risk <= 100, "max_risk is 0..=100");
        require!(max_age_sec >= 30 && max_age_sec <= 3_600, "max_age_sec is 30..=3600");
        let last_nonce = attest::load().map(|c| c.last_nonce).unwrap_or(0);
        attest::save(&EngineConfig { engine_pk, max_risk, max_age_sec, required, last_nonce });
    }

    pub fn clear_engine(&mut self) {
        self.assert_owner();
        attest::clear();
    }

    pub fn get_engine(&self) -> Option<EngineConfig> {
        attest::load()
    }

    fn spend(&mut self, merchant: AccountId, amount: U128, memo: String, pre: Option<Decision>) -> SpendResult {
        let now = now_sec();
        self.roll_day(now);
        self.prune_recent(now);

        let usage = Usage {
            paused: self.paused,
            spent_today: self.spent_today,
            recent_spend_secs: self.recent.clone(),
            available_budget: self.available_budget(),
        };
        let d = pre.unwrap_or_else(|| evaluate(&self.config, &usage, merchant.as_str(), amount.0, &memo, now));
        let id = self.log.len() as u64;

        let status = match d.verdict {
            Verdict::Allowed => {
                self.spent_today += amount.0;
                self.push_recent(now);
                self.pay(id, merchant.clone(), amount.0);
                SpendStatus::Allowed
            }
            Verdict::PendingCosign => {
                self.spent_today += amount.0;
                self.reserved_pending += amount.0;
                self.push_recent(now);
                SpendStatus::PendingCosign
            }
            Verdict::Blocked => SpendStatus::Blocked,
        };
        // Truncate stored memo for blocked requests too; never store unbounded input.
        let memo: String = memo.chars().take(policy::MAX_MEMO_LEN).collect();
        let rec = SpendRecord {
            id,
            merchant,
            amount,
            memo,
            status: status.clone(),
            rule: d.rule,
            reason: d.reason.clone(),
            timestamp_sec: now,
            day: self.day_index,
        };
        emit("spend", &rec);
        self.log.push(rec);
        SpendResult { id, status, rule: d.rule, reason: d.reason }
    }

    // ---------- owner ----------

    /// Human co-sign for a pending spend. Executes the transfer.
    pub fn cosign(&mut self, id: u64) -> SpendResult {
        self.assert_owner();
        let now = now_sec();
        let rec = self.log.get_mut(id as u32).unwrap_or_else(|| env::panic_str("unknown spend id"));
        require!(rec.status == SpendStatus::PendingCosign, "spend is not pending");
        require!(now < rec.timestamp_sec + PENDING_TTL_SEC, "spend expired, ask the agent to request it again");
        rec.status = SpendStatus::Approved;
        rec.reason = "co-signed by owner".into();
        let (merchant, amount) = (rec.merchant.clone(), rec.amount.0);
        let out = SpendResult { id, status: SpendStatus::Approved, rule: rec.rule, reason: rec.reason.clone() };
        let snapshot = rec.clone();
        self.reserved_pending -= amount;
        emit("cosign", &snapshot);
        self.pay(id, merchant, amount);
        out
    }

    /// Owner refuses a pending spend. Releases the reservation.
    pub fn reject(&mut self, id: u64) -> SpendResult {
        self.assert_owner();
        let day_now = now_sec() / SECS_PER_DAY;
        let rec = self.log.get_mut(id as u32).unwrap_or_else(|| env::panic_str("unknown spend id"));
        require!(rec.status == SpendStatus::PendingCosign, "spend is not pending");
        rec.status = SpendStatus::Rejected;
        rec.reason = "rejected by owner".into();
        let (amount, day) = (rec.amount.0, rec.day);
        let out = SpendResult { id, status: SpendStatus::Rejected, rule: rec.rule, reason: rec.reason.clone() };
        let snapshot = rec.clone();
        self.reserved_pending -= amount;
        self.release_daily(amount, day, day_now);
        emit("reject", &snapshot);
        out
    }

    // ---------- anyone ----------

    /// Release the budget held by a pending spend nobody co-signed in time.
    /// Callable by anyone (a keeper, the dashboard, the agent) once the TTL
    /// has passed, so a forgotten request cannot block the budget forever.
    pub fn expire_pending(&mut self, id: u64) -> SpendResult {
        let now = now_sec();
        let day_now = now / SECS_PER_DAY;
        let rec = self.log.get_mut(id as u32).unwrap_or_else(|| env::panic_str("unknown spend id"));
        require!(rec.status == SpendStatus::PendingCosign, "spend is not pending");
        require!(now >= rec.timestamp_sec + PENDING_TTL_SEC, "spend has not expired yet");
        rec.status = SpendStatus::Expired;
        rec.reason = format!("no co-sign within {PENDING_TTL_SEC} s");
        let (amount, day) = (rec.amount.0, rec.day);
        let out = SpendResult { id, status: SpendStatus::Expired, rule: rec.rule, reason: rec.reason.clone() };
        let snapshot = rec.clone();
        self.reserved_pending -= amount;
        self.release_daily(amount, day, day_now);
        emit("expire", &snapshot);
        out
    }

    // ---------- callbacks ----------

    /// Result of the NEAR transfer started by `request_spend` or `cosign`.
    /// On failure the record becomes `TransferFailed` and the daily budget is
    /// released, so the log never claims money moved when it did not.
    #[private]
    pub fn on_transfer(&mut self, id: u64, #[callback_result] result: Result<(), PromiseError>) -> bool {
        if result.is_ok() {
            return true;
        }
        let day_now = now_sec() / SECS_PER_DAY;
        let Some(rec) = self.log.get_mut(id as u32) else { return false };
        rec.status = SpendStatus::TransferFailed;
        rec.reason = "transfer to merchant failed, funds stayed in the contract".into();
        let (amount, day) = (rec.amount.0, rec.day);
        let snapshot = rec.clone();
        self.release_daily(amount, day, day_now);
        emit("transfer_failed", &snapshot);
        false
    }

    pub fn set_policy(&mut self, config: PolicyConfig) {
        self.assert_owner();
        self.config = config;
    }

    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        require!(agent != self.owner, "owner and agent must be different accounts");
        self.agent = agent;
    }

    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
    }

    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
    }

    /// Owner tops up the agent budget. Plain transfers to the contract also work.
    #[payable]
    pub fn fund(&mut self) {}

    // ---------- views ----------

    pub fn get_policy(&self) -> PolicyConfig {
        self.config.clone()
    }

    pub fn get_spend(&self, id: u64) -> Option<SpendRecord> {
        self.log.get(id as u32).cloned()
    }

    /// Spend log, oldest first. Used by the dashboard.
    pub fn get_spends(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<SpendRecord> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50).min(200) as usize;
        self.log.iter().skip(from).take(limit).cloned().collect()
    }

    pub fn get_status(&self) -> Status {
        Status {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            paused: self.paused,
            spent_today: U128(self.spent_today),
            reserved_pending: U128(self.reserved_pending),
            available_budget: U128(self.available_budget()),
            log_len: self.log.len() as u64,
        }
    }

    // ---------- internal ----------

    /// Transfer to the merchant and check the outcome in `on_transfer`.
    fn pay(&self, id: u64, merchant: AccountId, amount: u128) {
        let _ = Promise::new(merchant)
            .transfer(NearToken::from_yoctonear(amount))
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_transfer(id));
    }

    /// Give back daily budget for a spend that never went out, but only if it
    /// was counted in the current day (yesterday's counter is already reset).
    fn release_daily(&mut self, amount: u128, day: u64, day_now: u64) {
        if day == day_now && self.day_index == day_now {
            self.spent_today = self.spent_today.saturating_sub(amount);
        }
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    fn roll_day(&mut self, now: u64) {
        let day = now / SECS_PER_DAY;
        if day != self.day_index {
            self.day_index = day;
            self.spent_today = 0;
        }
    }

    fn prune_recent(&mut self, now: u64) {
        let start = now.saturating_sub(self.config.velocity_window_sec);
        self.recent.retain(|t| *t > start);
    }

    fn push_recent(&mut self, now: u64) {
        self.recent.push(now);
        if self.recent.len() > MAX_RECENT {
            self.recent.remove(0);
        }
    }

    /// Balance the contract can pay out: balance minus storage cost minus
    /// amounts reserved for pending co-signs.
    fn available_budget(&self) -> u128 {
        let storage = env::storage_byte_cost().as_yoctonear() * env::storage_usage() as u128;
        env::account_balance()
            .as_yoctonear()
            .saturating_sub(storage)
            .saturating_sub(self.reserved_pending)
    }
}

fn now_sec() -> u64 {
    env::block_timestamp() / 1_000_000_000
}

/// NEP-297 style event so an indexer or dashboard can follow every decision.
fn emit(event: &str, rec: &SpendRecord) {
    let data = near_sdk::serde_json::json!({
        "standard": "leash",
        "version": "1.0.0",
        "event": event,
        "data": [rec],
    });
    env::log_str(&format!("EVENT_JSON:{data}"));
}

#[cfg(test)]
mod tests;
