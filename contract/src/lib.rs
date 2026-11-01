//! Leash policy contract: a spending firewall for AI agents on NEAR.
//!
//! The agent account only holds a function-call access key scoped to this
//! contract and the `request_spend` method. It can ask to spend, it cannot
//! move funds itself. Every request is evaluated by `policy::evaluate` and
//! written to an append-only spend log with a machine-readable reason.

pub mod policy;

use near_sdk::json_types::U128;
use near_sdk::store::Vector;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise};
use policy::{evaluate, PolicyConfig, Rule, Usage, Verdict};

const SECS_PER_DAY: u64 = 86_400;
/// Cap on stored velocity timestamps, so state cannot grow without bound.
const MAX_RECENT: usize = 64;

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum SpendStatus {
    Allowed,
    PendingCosign,
    Blocked,
    Approved,
    Rejected,
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
        let now = now_sec();
        self.roll_day(now);
        self.prune_recent(now);

        let usage = Usage {
            paused: self.paused,
            spent_today: self.spent_today,
            recent_spend_secs: self.recent.clone(),
            available_budget: self.available_budget(),
        };
        let d = evaluate(&self.config, &usage, merchant.as_str(), amount.0, &memo, now);

        let status = match d.verdict {
            Verdict::Allowed => {
                self.spent_today += amount.0;
                self.push_recent(now);
                let _ = Promise::new(merchant.clone()).transfer(NearToken::from_yoctonear(amount.0));
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
        let id = self.log.len() as u64;
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
        let rec = self.log.get_mut(id as u32).unwrap_or_else(|| env::panic_str("unknown spend id"));
        require!(rec.status == SpendStatus::PendingCosign, "spend is not pending");
        rec.status = SpendStatus::Approved;
        rec.reason = "co-signed by owner".into();
        let (merchant, amount) = (rec.merchant.clone(), rec.amount.0);
        let out = SpendResult { id, status: SpendStatus::Approved, rule: rec.rule, reason: rec.reason.clone() };
        let snapshot = rec.clone();
        self.reserved_pending -= amount;
        emit("cosign", &snapshot);
        let _ = Promise::new(merchant).transfer(NearToken::from_yoctonear(amount));
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
        if day == day_now && self.day_index == day_now {
            self.spent_today = self.spent_today.saturating_sub(amount);
        }
        emit("reject", &snapshot);
        out
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
