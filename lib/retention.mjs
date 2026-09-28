// Message retention (messaging-policy.v0.8.json retention): every message is deleted permanently
// message_days after it was sent, unless it is part of an open report or waiting for review.
// Deletion must also reach backups: encrypt messages with a per-day key and destroy the key when
// the day expires (crypto-shredding). A reported message is copied into its report case,
// encrypted separately, when it is reported, so destroying the day key never affects a case.

const DAY_MS = 86_400_000;

export function messageExpiresAt(policy, message) {
  return new Date(new Date(message.sent_at).getTime() + policy.retention.message_days * DAY_MS);
}

// message: { sent_at, reported_open?: boolean, held_for_review?: boolean }
export function shouldDelete(policy, message, now = new Date()) {
  if (message.reported_open || message.held_for_review) return false;
  return now >= messageExpiresAt(policy, message);
}

// Key for the day a message was sent; destroy it once every message of that day has expired.
export function encryptionKeyDay(message) {
  return new Date(message.sent_at).toISOString().slice(0, 10);
}

export function keyDaysToDestroy(policy, keyDays, now = new Date()) {
  const cutoff = now.getTime() - (policy.retention.message_days + 1) * DAY_MS;
  return keyDays.filter((day) => new Date(`${day}T00:00:00Z`).getTime() < cutoff);
}
