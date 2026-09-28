import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deletionPlan, exportAccountData, requestDeadline } from '../lib/account-data.mjs';
import {
  fileComplaint,
  reportDecisionNotice,
  reportingMisuse,
  resolveComplaint,
  statementForMessage,
  statementForPhoto
} from '../lib/decisions.mjs';
import { moderateMessage } from '../lib/moderation.mjs';
import { photoDecision } from '../lib/profile-content.mjs';

const load = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const decisions = load('data/moderation-decisions.v0.8.json');
const messaging = load('data/messaging-policy.v0.8.json');
const profileContent = load('data/profile-content-policy.v0.8.json');
const privacy = load('data/privacy.v0.8.json');
const NOW = new Date('2026-09-28T12:00:00Z');
const daysLater = (d) => new Date(NOW.getTime() + d * 86_400_000);
const late = { messages_exchanged: 50 };

describe('DSA statements of reasons (Art. 17)', () => {
  it('explains a blocked message: restriction, facts, automation, ground and redress', () => {
    const moderation = moderateMessage(messaging, { text: 'you stupid bitch' }, late);
    const sor = statementForMessage(decisions, 'u1', moderation, { content_ref: 'm1', now: NOW });
    expect(sor).toMatchObject({
      subject: 'u1',
      decision_type: 'message_blocked',
      restriction: 'content_not_delivered',
      automated: { detection: true, decision: true },
      transparency_database: { submit: true, personal_data: false }
    });
    expect(sor.grounds.items[0].section).toBe('tos.harassment');
    expect(sor.redress.internal_complaint_until).toBe(daysLater(183).toISOString());
  });

  it('marks held messages as decided by a person later, and issues nothing when delivered', () => {
    const held = moderateMessage(messaging, { text: 'I know where you live' }, late);
    expect(statementForMessage(decisions, 'u1', held, { now: NOW })).toMatchObject({
      decision_type: 'content_held_for_review',
      automated: { detection: true, decision: false }
    });
    const ok = moderateMessage(messaging, { text: 'Hello there' }, late);
    expect(statementForMessage(decisions, 'u1', ok, { now: NOW })).toBeNull();
  });

  it('explains rejected photos, but not purely technical rejections', () => {
    const upload = { type: 'image/jpeg', bytes: 1000, width: 800, height: 800 };
    const screening = { nudity: 0.95, violence: 0, face_count: 1, face_match: 0.9 };
    const rejected = photoDecision(profileContent, upload, screening);
    expect(statementForPhoto(decisions, 'u1', rejected, { now: NOW }).decision_type).toBe(
      'photo_rejected'
    );
    const wrongType = photoDecision(profileContent, { ...upload, type: 'image/gif' }, screening);
    expect(statementForPhoto(decisions, 'u1', wrongType, { now: NOW })).toBeNull();
  });
});

describe('DSA complaints (Art. 20) and notices (Art. 16, 23)', () => {
  const moderation = moderateMessage(messaging, { text: 'kys' }, late);
  const sor = statementForMessage(decisions, 'u1', moderation, { now: NOW });

  it('accepts free complaints for six months and needs a person to decide them', () => {
    const complaint = fileComplaint(decisions, sor, {
      by: 'u1',
      text: 'I was quoting',
      now: daysLater(30)
    });
    expect(complaint).toMatchObject({ status: 'open', requires_human_review: true });
    expect(() =>
      fileComplaint(decisions, sor, { by: 'u1', text: 'too late', now: daysLater(200) })
    ).toThrow();
    expect(() =>
      resolveComplaint(decisions, complaint, {
        reviewer: { type: 'automated' },
        outcome: 'reversed',
        explanation: 'x'
      })
    ).toThrow();
    const resolved = resolveComplaint(decisions, complaint, {
      reviewer: { type: 'human', id: 'r1' },
      outcome: 'reversed',
      explanation: 'Quoted in context, not directed at the person.',
      now: daysLater(35)
    });
    expect(resolved.actions).toEqual(['restore_content_or_access', 'remove_related_strike']);
    expect(resolved.further_redress.out_of_court).toMatch(/Art\. 21/);
  });

  it('tells reporters the decision without revealing the reported person', () => {
    const notice = reportDecisionNotice(
      decisions,
      { id: 'r9', reporter: 'u2', subject: 'u1' },
      { action_taken: true, automated: false, now: NOW }
    );
    expect(notice.decision).toBe('action_taken');
    expect(JSON.stringify(notice)).not.toContain('u1');
  });

  it('warns and then suspends people who keep filing unfounded reports', () => {
    expect(reportingMisuse(decisions, 2).action).toBe('none');
    expect(reportingMisuse(decisions, 5).action).toBe('warn');
    expect(reportingMisuse(decisions, 12)).toEqual({ action: 'suspend_reporting', days: 30 });
  });
});

describe('GDPR export and deletion (Art. 15, 17, 20)', () => {
  const profile = {
    id: 'me',
    birth_month: '1995-05',
    profile_text: 'Hi',
    ratings: { honest_direct: 8 },
    blocked_ids: ['someone']
  };
  const stores = {
    conversations: [
      {
        id: 'c1',
        participants: ['me', 'other'],
        status: 'open',
        created_at: NOW.toISOString(),
        messages: [
          { from: 'me', text: 'Hello', sent_at: NOW.toISOString() },
          { from: 'other', text: 'Hi!', sent_at: NOW.toISOString() }
        ]
      },
      { id: 'c2', participants: ['x', 'y'], status: 'open', messages: [] }
    ],
    reports: [
      { id: 'r1', reporter: 'me', subject: 'badguy', reason: 'harassment', status: 'open' },
      { id: 'r2', reporter: 'me', subject: 'badguy2', reason: 'scam', status: 'closed' }
    ],
    strikes: [{ account: 'me', rule: 'harassment' }],
    banned_photo_hashes: [{ account: 'me', hash: 'abc' }]
  };

  it('exports everything held about the person, and no one else’s identity', () => {
    const data = exportAccountData(privacy, profile, stores, NOW);
    expect(data.profile).toEqual(profile);
    expect(data.conversations).toHaveLength(1);
    expect(data.conversations[0].messages.map((m) => m.from)).toEqual(['you', 'them']);
    expect(data.reports_you_made).toHaveLength(2);
    const text = JSON.stringify(data);
    for (const other of ['"other"', 'badguy']) expect(text).not.toContain(other);
    expect(data.never_collected).toContain('identity_documents');
    expect(requestDeadline(privacy, NOW)).toBe(daysLater(30).toISOString());
  });

  it('deletes everything at once, keeping only open cases and unlinked photo hashes', () => {
    const plan = deletionPlan(privacy, profile, stores);
    expect(plan.delete_now).toContain('conversations_and_messages_for_both_people');
    expect(plan.keep.map((k) => k.store)).toEqual(['report_case', 'banned_photo_hash']);
    expect(plan.keep[0].id).toBe('r1');
  });
});
