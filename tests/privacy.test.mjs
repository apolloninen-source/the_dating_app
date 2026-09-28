import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calibrationRecord } from '../lib/calibration.mjs';
import { ageOn } from '../lib/match.mjs';

const load = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const catalog = load('data/traits.v0.8.json');
const dealbreakers = load('data/dealbreakers.v0.8.json');
const schema = load('data/profile.schema.json');
const privacy = load('data/privacy.v0.8.json');
const messaging = load('data/messaging-policy.v0.8.json');
const NOW = new Date('2026-09-28T12:00:00Z');

describe('data minimization', () => {
  it('declares a purpose for every profile field, and only those fields', () => {
    const fields = Object.keys(schema.properties).sort();
    expect(Object.keys(privacy.profile_fields).sort()).toEqual(fields);
    const purposes = Object.keys(privacy.purposes);
    for (const purpose of Object.values(privacy.profile_fields)) {
      expect(purposes).toContain(purpose);
    }
  });

  it('collects no identity data', () => {
    const fields = Object.keys(schema.properties).join(' ');
    expect(fields).not.toMatch(/name|phone|email|address|document|passport|verification/);
    expect(privacy.never_collected).toEqual(
      expect.arrayContaining([
        'real_name',
        'identity_documents',
        'phone_number',
        'exact_birth_date',
        'face_templates_or_check_selfies',
        'device_fingerprints'
      ])
    );
    expect(JSON.stringify(messaging.account_trust)).not.toMatch(/government|document_hash/);
  });

  it('stores birth month only and never overestimates age', () => {
    expect(schema.properties.birth_month.pattern).toBe('^[0-9]{4}-(0[1-9]|1[0-2])$');
    expect(ageOn('2008-09', NOW)).toBe(17);
    expect(ageOn('2008-08', NOW)).toBe(18);
  });
});

describe('calibration records', () => {
  const person = (id, optIn) => ({
    id,
    birth_month: '1990-01',
    location: { country: 'FI', lat: 60.17, lng: 24.94 },
    profile_text: 'hello',
    calibration_opt_in: optIn,
    ratings: { honest_direct: 8, religious_practice_important: 9, wants_children: 7 },
    dealbreakers: {
      smoking: { self: 'never', accept: ['never'] },
      religion: { self: 'jewish' },
      cannabis: { self: 'never' }
    }
  });

  it('only exists when both people opted in', () => {
    const a = person('alice-123', true);
    expect(
      calibrationRecord(
        catalog,
        dealbreakers,
        a,
        person('bob-456', false),
        'both_left_app_together'
      )
    ).toBeNull();
  });

  it('keeps answers and the outcome, and nothing that identifies anyone', () => {
    const record = calibrationRecord(
      catalog,
      dealbreakers,
      person('alice-123', true),
      person('bob-456', true),
      'both_confirm_together_at_12_months',
      NOW
    );
    const text = JSON.stringify(record);
    for (const leak of ['alice-123', 'bob-456', '1990', '60.17', 'hello', 'FI']) {
      expect(text).not.toContain(leak);
    }
    expect(record.recorded_month).toBe('2026-09');
    const [first] = record.people;
    expect(first.ratings).toEqual({ honest_direct: 8, wants_children: 7 });
    expect(first.choices).toEqual({ smoking: 'never' });
  });
});
