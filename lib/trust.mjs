// Account trust signals against catfishing, scams and trafficking. Uses account metadata and
// behaviour counters only (verification status, device/IP country, message rates, hashes of
// first messages, reports), never the content of conversations.
import { createHash } from 'node:crypto';
import { normalizeText } from './moderation.mjs';

const LEVELS = ['low', 'medium', 'high'];

// Hash of a normalized first message, for spotting copy-paste openers sent to many people
// without storing the text itself.
export function messageHash(text) {
  return createHash('sha256').update(normalizeText(text)).digest('hex');
}

export function isVerified(account) {
  return account.verification?.identity?.status === 'verified';
}

export function accountRiskSignals(policy, account, activity = {}, now = new Date()) {
  const cfg = policy.account_trust;
  const flags = [];
  const flag = (id, level, actions) => flags.push({ id, level, actions });

  if (!isVerified(account)) {
    flag(
      'unverified',
      'medium',
      cfg.messaging_requires_verification ? ['require_verification'] : []
    );
  }
  if ((activity.accounts_with_same_document ?? 1) > 1) {
    flag('duplicate_identity', 'high', ['block_new_account', 'review']);
  }
  if ((activity.accounts_on_device ?? 1) > cfg.max_accounts_per_device) {
    flag('shared_device', 'medium', ['review']);
  }
  const ipCountries = activity.ip_countries ?? [];
  if (ipCountries.length && !ipCountries.includes(account.location?.country)) {
    // Common in romance scams ("local" profile operated from abroad); VPNs cause false positives,
    // so this asks for re-verification rather than blocking.
    flag('location_mismatch', 'medium', ['require_verification']);
  }

  const ageDays = (now - new Date(account.created_at)) / 86_400_000;
  const limit =
    ageDays < cfg.new_account_days
      ? cfg.new_account_first_messages_per_day
      : cfg.first_messages_per_day;
  if ((activity.first_messages_today ?? 0) > limit) {
    flag('mass_messaging', 'medium', ['limit_messaging']);
  }
  const counts = new Map();
  for (const h of activity.first_message_hashes_last_day ?? [])
    counts.set(h, (counts.get(h) ?? 0) + 1);
  if (Math.max(0, ...counts.values()) >= cfg.identical_first_messages_threshold) {
    flag('copy_paste_openers', 'medium', ['limit_messaging', 'review']);
  }

  const reasons = new Set((activity.open_reports ?? []).map((r) => r.reason));
  const urgent = cfg.escalate_immediately.filter((r) => reasons.has(r));
  if (urgent.length) {
    flag(`reported:${urgent.join(',')}`, 'high', ['suspend_pending_review', 'review_now']);
  } else if (reasons.size >= 2) {
    flag('multiple_reports', 'high', ['review']);
  }
  if ((activity.held_messages_30d ?? 0) >= 2) flag('repeated_held_messages', 'high', ['review']);

  const level = flags.reduce(
    (worst, f) => (LEVELS.indexOf(f.level) > LEVELS.indexOf(worst) ? f.level : worst),
    'low'
  );
  return { level, flags, actions: [...new Set(flags.flatMap((f) => f.actions))] };
}

// Whether this account may start a new conversation right now.
export function canStartConversation(policy, account, activity = {}, now = new Date()) {
  const { actions } = accountRiskSignals(policy, account, activity, now);
  const blocking = [
    'require_verification',
    'limit_messaging',
    'suspend_pending_review',
    'block_new_account'
  ];
  const reasons = actions.filter((a) => blocking.includes(a));
  return { allowed: reasons.length === 0, reasons };
}
