import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adDecision, adRequest, recordImpression } from '../lib/ads.mjs';
import { directionalScore, explainMatch } from '../lib/match.mjs';
import { rankCandidates } from '../lib/rank.mjs';

const load = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const catalog = load('data/traits.v0.8.json');
const dealbreakers = load('data/dealbreakers.v0.8.json');
const features = load('data/features.v0.8.json');
const ads = load('data/ads-policy.v0.8.json');
const NOW = new Date('2026-09-28T12:00:00Z');
const at = (minutes) => new Date(NOW.getTime() + minutes * 60_000);

function person(overrides = {}) {
  return {
    id: 'p',
    birth_date: '1995-05-01',
    gender: { identity: 'woman' },
    seeking: { genders: ['man', 'woman'], age_min: 25, age_max: 45 },
    location: { country: 'FI', timezone: 'Europe/Helsinki', lat: 60.17, lng: 24.94 },
    max_distance_km: 50,
    languages: [{ code: 'en', proficiency: 'fluent' }],
    ui_locale: 'en',
    mode: 'safe',
    matching_status: 'active',
    ratings: {},
    preferences: {},
    dealbreakers: {},
    verification: { identity: { status: 'verified' } },
    ...overrides
  };
}

describe('free features', () => {
  it('has no paid tiers and gives every listed feature for free', () => {
    expect(features.pricing.paid_tiers).toBe(false);
    const ids = features.free.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining(['see_whos_interested', 'incognito_mode', 'travel_mode', 'undo'])
    );
  });

  it('does not sell visibility or scarcity', () => {
    const not = features.not_offered.map((f) => f.id);
    expect(not).toEqual(expect.arrayContaining(['paid_visibility', 'scarcity_currency']));
  });

  it('never optimizes for ad impressions', () => {
    expect(catalog.objective.never_optimize_for).toContain('ad_impressions');
  });
});

describe('incognito mode', () => {
  const ratings = { honest_direct: 8, patient: 8, warm_and_affectionate: 8 };
  const viewer = person({ id: 'v', ratings });
  const visible = person({ id: 'a', ratings });
  const hidden = person({ id: 'h', ratings, incognito: true, expressed_interest_in: [] });
  const open = person({ id: 'o', ratings, incognito: true, expressed_interest_in: ['v'] });

  it('only shows incognito people to those they showed interest in', () => {
    const { candidates } = rankCandidates(catalog, dealbreakers, viewer, [visible, hidden, open], {
      now: NOW
    });
    expect(candidates.map((c) => c.id)).toEqual(['a', 'o']);
  });
});

describe('travel mode', () => {
  const madrid = { country: 'ES', timezone: 'Europe/Madrid', lat: 40.42, lng: -3.7 };
  const candidate = person({ id: 'es', location: madrid });

  it('matches at the destination during the trip only', () => {
    const traveller = (from, to) => person({ travel: { location: madrid, from, to } });
    expect(
      directionalScore(catalog, dealbreakers, traveller('2026-09-20', '2026-10-05'), candidate, {
        now: NOW
      }).excluded
    ).toBe(false);
    expect(
      directionalScore(catalog, dealbreakers, traveller('2026-11-01', '2026-11-10'), candidate, {
        now: NOW
      }).reasons
    ).toContain('dealbreaker:location');
  });
});

describe('match explanations', () => {
  it('names shared strengths and friction points', () => {
    const viewer = person({ ratings: { honest_direct: 9, calm_under_pressure: 9 } });
    const candidate = person({ id: 'c', ratings: { honest_direct: 9, quick_to_anger: 9 } });
    const why = explainMatch(catalog, dealbreakers, viewer, candidate, { now: NOW });
    expect(why.strengths[0]).toMatchObject({
      id: 'sg_honesty',
      i18n_key: 'scale_group.sg_honesty'
    });
    expect(why.friction[0]).toMatchObject({
      mine: 'calm_under_pressure',
      theirs: 'quick_to_anger'
    });
    expect(why.unmet).toEqual([]);
  });
});

describe('ads: two videos and one text ad per day, then nothing', () => {
  const ctx = (placement, extra = {}) => ({
    placement,
    foreground: true,
    connection: 'wifi',
    ...extra
  });

  it('caps per 24 hours across sessions, not per session', () => {
    let state = null;
    const show = (placement, minutes) => {
      const d = adDecision(ads, state, ctx(placement), at(minutes));
      if (d.ad) state = recordImpression(ads, state, d.ad, at(minutes));
      return d;
    };
    expect(show('after_daily_candidates', 0).ad).toBe('video');
    expect(show('after_daily_candidates', 1).reason).toBe('too_soon_after_video');
    expect(show('after_questionnaire_block', 15).ad).toBe('video');
    expect(show('after_daily_candidates', 60).reason).toBe('video_cap_reached');
    expect(show('daily_candidates_footer', 61).ad).toBe('text');
    // A new session later the same day gets nothing.
    expect(show('after_daily_candidates', 5 * 60).reason).toBe('daily_cap_reached');
    expect(show('settings_footer', 23 * 60).reason).toBe('daily_cap_reached');
    // 24 hours after the first ad, a new day starts.
    expect(show('after_daily_candidates', 24 * 60).ad).toBe('video');
  });

  it('only shows video when viable, and never in protected places', () => {
    expect(adDecision(ads, null, ctx('conversation')).reason).toBe('protected_placement');
    expect(adDecision(ads, null, ctx('report_flow')).reason).toBe('protected_placement');
    const cellular = ctx('after_daily_candidates', { connection: 'cellular', data_saver: true });
    expect(adDecision(ads, null, cellular).reason).toBe('video_not_viable:data_saver');
    const calm = ctx('after_daily_candidates', { reduced_motion: true });
    expect(adDecision(ads, null, calm).reason).toBe('video_not_viable:reduced_motion');
    const lowBattery = ctx('after_daily_candidates', { battery_level: 0.05 });
    expect(adDecision(ads, null, lowBattery).reason).toBe('video_not_viable:low_battery');
  });

  it('targets by context only, never by profile answers', () => {
    const profile = person({ ratings: { wants_children: 9 }, dealbreakers: { religion: {} } });
    const req = adRequest(ads, profile, 'daily_candidates_footer');
    expect(Object.keys(req).sort()).toEqual([
      'country',
      'excluded_categories',
      'placement',
      'ui_locale'
    ]);
    expect(req.excluded_categories).toContain('dating_services');
    expect(ads.targeting.uses_profile_data).toBe(false);
  });
});

describe('social expectations of a partner', () => {
  it('pairs every expectation with the willingness items that fulfil it', () => {
    const section = catalog.traits.filter((t) => t.block === 'social_expectations');
    expect(section.length).toBeGreaterThanOrEqual(30);
    for (const t of section) {
      expect(t.fulfilled_by.length + t.fulfills.length).toBeGreaterThan(0);
    }
    const block = catalog.questionnaire.blocks.find((b) => b.id === 'social_expectations');
    expect(block.size).toBe(section.length);
  });

  it('checks the candidate’s willingness against the viewer’s expectation, one-sided', () => {
    const viewer = person({ ratings: { expects_family_participation: 8 } });
    const willing = person({ id: 'w', ratings: { joins_partner_family: 10 } });
    const unwilling = person({ id: 'u', ratings: { joins_partner_family: 2 } });
    const run = (c) => directionalScore(catalog, dealbreakers, viewer, c, { now: NOW });
    expect(run(willing).parts.implicit).toBe(1);
    expect(run(unwilling).parts.implicit).toBeLessThan(0.5);

    const why = explainMatch(catalog, dealbreakers, viewer, unwilling, { now: NOW });
    expect(why.expectations_to_discuss.map((e) => e.id)).toEqual(['expects_family_participation']);
    expect(
      explainMatch(catalog, dealbreakers, viewer, willing, { now: NOW }).expectations_to_discuss
    ).toEqual([]);
  });

  it('matches who-pays answers by compatibility, neither traditional nor progressive by default', () => {
    const viewer = (self, extra = {}) =>
      person({ dealbreakers: { date_payment: { self, ...extra } } });
    const candidate = (self) => person({ id: 'c', dealbreakers: { date_payment: { self } } });
    const satisfaction = (v, c) =>
      directionalScore(catalog, dealbreakers, v, c, { now: NOW }).parts.constraint_satisfaction;

    expect(satisfaction(viewer('split_evenly'), candidate('take_turns'))).toBe(1);
    expect(satisfaction(viewer('traditional_roles'), candidate('traditional_roles'))).toBe(1);
    expect(satisfaction(viewer('flexible'), candidate('traditional_roles'))).toBe(1);
    // An incompatible answer is a soft mismatch unless the viewer makes it strict.
    expect(satisfaction(viewer('split_evenly'), candidate('traditional_roles'))).toBeCloseTo(0.7);
    expect(
      directionalScore(
        catalog,
        dealbreakers,
        viewer('split_evenly', { strict: true }),
        candidate('traditional_roles'),
        { now: NOW }
      ).reasons
    ).toContain('dealbreaker:date_payment');
  });
});
