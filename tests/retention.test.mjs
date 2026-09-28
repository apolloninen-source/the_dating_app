import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  encryptionKeyDay,
  keyDaysToDestroy,
  messageExpiresAt,
  shouldDelete
} from '../lib/retention.mjs';

const policy = JSON.parse(
  readFileSync(new URL('../data/messaging-policy.v0.8.json', import.meta.url), 'utf8')
);
const sent = { sent_at: '2026-09-01T10:00:00Z' };
const day = (d) => new Date(`2026-09-${String(d).padStart(2, '0')}T10:00:00Z`);

describe('messages are deleted forever after 15 days', () => {
  it('keeps a message for 15 days, then deletes it', () => {
    expect(policy.retention.message_days).toBe(15);
    expect(messageExpiresAt(policy, sent).toISOString()).toBe('2026-09-16T10:00:00.000Z');
    expect(shouldDelete(policy, sent, day(15))).toBe(false);
    expect(shouldDelete(policy, sent, day(16))).toBe(true);
  });

  it('keeps reported or held messages only until the case is handled', () => {
    expect(shouldDelete(policy, { ...sent, reported_open: true }, day(30))).toBe(false);
    expect(shouldDelete(policy, { ...sent, held_for_review: true }, day(30))).toBe(false);
    expect(shouldDelete(policy, { ...sent, reported_open: false }, day(30))).toBe(true);
  });

  it('destroys each day’s key once all its messages have expired (covers backups)', () => {
    expect(encryptionKeyDay(sent)).toBe('2026-09-01');
    const days = ['2026-09-01', '2026-09-10'];
    expect(keyDaysToDestroy(policy, days, day(16))).toEqual([]);
    expect(keyDaysToDestroy(policy, days, day(18))).toEqual(['2026-09-01']);
  });
});
