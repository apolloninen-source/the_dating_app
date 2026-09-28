import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { moderateProfileText, photoDecision, photoVisible } from '../lib/profile-content.mjs';

const load = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const policy = load('data/profile-content-policy.v0.8.json');
const messaging = load('data/messaging-policy.v0.8.json');
const schema = load('data/profile.schema.json');

const upload = { type: 'image/jpeg', bytes: 800_000, width: 1200, height: 1600 };
const clean = {
  nudity: 0.01,
  violence: 0,
  face_count: 1,
  face_match: 0.95,
  estimated_age: 30,
  contains_text: false
};
const decide = (screening = {}, file = {}) =>
  photoDecision(policy, { ...upload, ...file }, { ...clean, ...screening });

describe('one profile photo', () => {
  it('allows exactly one photo per profile', () => {
    expect(policy.photo.max_count).toBe(1);
    expect(schema.properties.photo.type).toBe('object');
    expect(policy.photo.strip_metadata).toBe(true);
  });

  it('approves a clean photo of the verified person', () => {
    expect(decide()).toEqual({ decision: 'approve', reasons: [], strike: false, escalate: false });
  });

  it('rejects nudity with a strike and holds borderline images for review', () => {
    expect(decide({ nudity: 0.95 })).toMatchObject({ decision: 'reject', strike: true });
    expect(decide({ nudity: 0.5 })).toMatchObject({
      decision: 'hold_for_review',
      reasons: ['possible_nudity']
    });
  });

  it('needs exactly one face, and it must be the verified person (catfishing)', () => {
    expect(decide({ face_count: 0 }).reasons).toContain('needs_exactly_one_face');
    expect(decide({ face_count: 2 }).decision).toBe('reject');
    expect(decide({ face_match: 0.3 })).toMatchObject({
      decision: 'reject',
      reasons: ['does_not_match_verified_face']
    });
    expect(decide({ face_match: 0.75 }).decision).toBe('hold_for_review');
    expect(decide({ face_match: null }).decision).toBe('pending_verification');
  });

  it('never publishes a possible minor and escalates it', () => {
    expect(decide({ estimated_age: 15 })).toMatchObject({
      decision: 'hold_for_review',
      escalate: true
    });
  });

  it('holds images with text (contact details, ads) for review', () => {
    expect(decide({ contains_text: true }).decision).toBe('hold_for_review');
  });

  it('rejects unsupported or oversized files before screening', () => {
    expect(decide({}, { type: 'image/gif' }).reasons).toEqual(['unsupported_type']);
    expect(decide({}, { bytes: 20_000_000 }).reasons).toEqual(['too_large']);
    expect(decide({}, { width: 200 }).reasons).toEqual(['too_small']);
  });

  it('shows the photo only after mutual interest by default', () => {
    const owner = { id: 'o', photo: { status: 'approved' } };
    expect(photoVisible(policy, owner, 'v')).toBe(false);
    expect(photoVisible(policy, owner, 'v', { mutualInterest: true })).toBe(true);
    expect(photoVisible(policy, owner, 'o')).toBe(true);
    const pending = { id: 'o', photo: { status: 'hold_for_review' } };
    expect(photoVisible(policy, pending, 'v', { mutualInterest: true })).toBe(false);
    const onCards = { ...policy, photo: { ...policy.photo, visibility: 'with_daily_candidates' } };
    expect(photoVisible(onCards, owner, 'v')).toBe(true);
  });
});

describe('one profile text', () => {
  const check = (text) => moderateProfileText(policy, messaging, text);

  it('allows an ordinary text', () => {
    expect(check('Teacher, amateur baker, happiest on long walks by the sea.').action).toBe(
      'allow'
    );
  });

  it('never allows explicit content, links or contact details', () => {
    expect(check('Looking for someone horny').action).toBe('block');
    expect(check('Find me on instagram').reasons[0].rule).toBe('contact_too_early');
    expect(check('see www.example.org').action).toBe('block');
  });

  it('enforces the length limit', () => {
    expect(schema.properties.profile_text.maxLength).toBe(policy.text.max_length);
    expect(check('a'.repeat(501)).reasons[0].rule).toBe('too_long');
  });
});
