// Account trust signals against catfishing, scams and trafficking, without identity data. Uses
// only what abuse prevention needs: the live photo check result, rate counters, short-lived
// hashes of first messages, a sign-in country flag computed and discarded on the spot, reports,
// and perceptual hashes of banned photos. Never names, ID documents, phone numbers, device
// fingerprints or the content of conversations.
import { createHash } from 'node:crypto';
import { normalizeText } from './moderation.mjs';

const LEVELS = ['low', 'medium', 'high'];

// Hash of a normalized first message, for spotting copy-paste openers sent to many people
// without storing the text itself.
export function messageHash(text) {
  return createHash('sha256').update(normalizeText(text)).digest('hex');
}

export function isPhotoChecked(account) {
  return account.photo_check?.status === 'passed';
}

// activity (all optional, all short-lived counters or flags):
//   signin_country_mismatch        boolean, computed at sign-in; the country itself is not kept
//   first_messages_today           number
//   first_message_hashes_last_day  string[]
//   banned_photo_match             boolean, profile photo matches a banned photo's perceptual hash
//   open_reports                   [{ reason }]
//   held_messages_30d              number
export function accountRiskSignals(policy, account, activity = {}, now = new Date()) {
  const cfg = policy.account_trust;
  const flags = [];
  const flag = (id, level, actions) => flags.push({ id, level, actions });

  if (!isPhotoChecked(account)) {
    const actions = cfg.messaging_requires_photo_check ? ['require_photo_check'] : [];
    flag('not_photo_checked', 'medium', actions);
  }
  if (activity.banned_photo_match) {
    flag('banned_photo_reused', 'high', ['block_new_account', 'review']);
  }
  if (activity.signin_country_mismatch) {
    // Common in romance scams ("local" profile operated from abroad); VPNs cause false positives,
    // so this asks for a fresh photo check rather than blocking.
    flag('location_mismatch', 'medium', ['require_photo_check']);
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
  for (const h of activity.first_message_hashes_last_day ?? []) {
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
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
    'require_photo_check',
    'limit_messaging',
    'suspend_pending_review',
    'block_new_account'
  ];
  const reasons = actions.filter((a) => blocking.includes(a));
  return { allowed: reasons.length === 0, reasons };
}
