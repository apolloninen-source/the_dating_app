import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { indexCatalog, constructScores } from '../lib/constructs.mjs';
import { closeness, label, probOr, ratingIn, trapezoid } from '../lib/fuzzy.mjs';
import { directionalScore, mutualMatch } from '../lib/match.mjs';
import { moderateMessage, normalizeText } from '../lib/moderation.mjs';
import { rankCandidates } from '../lib/rank.mjs';
import { responseQuality } from '../lib/response-quality.mjs';
import { accountRiskSignals, canStartConversation, messageHash } from '../lib/trust.mjs';
import { validateCatalog, validateDealbreakers, validateProfile } from '../lib/validate.mjs';
import { buildSourceCatalog } from '../scripts/extract-i18n.mjs';

const load = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const catalog = load('data/traits.v0.8.json');
const dealbreakers = load('data/dealbreakers.v0.8.json');
const policy = load('data/messaging-policy.v0.8.json');
const regionPolicy = load('data/region-policy.example.json');
const fuzzy = catalog.matching_config.fuzzy;
const NOW = new Date('2026-09-28T12:00:00Z');

function person(overrides = {}) {
  return {
    id: 'p',
    schema_version: '0.8.0',
    birth_month: '1995-05',
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
    photo_check: { status: 'passed' },
    ...overrides
  };
}

// Plausible answers for the initial block: desirable traits at `level`, straining traits
// mirrored, style/preference items around the middle.
const profileRatings = (level) =>
  Object.fromEntries(
    catalog.traits
      .filter((t) => t.block === 'initial')
      .map((t, i) => {
        if (t.valence === 'positive') return [t.id, level];
        if (t.valence === 'challenging') return [t.id, 11 - level];
        return [t.id, 5 + (i % 3) - 1];
      })
  );

const score = (viewer, candidate, options = {}) =>
  directionalScore(catalog, dealbreakers, viewer, candidate, { now: NOW, ...options });

describe('v0.8 catalog', () => {
  it('passes catalog and dealbreaker validation', () => {
    expect(validateCatalog(catalog, dealbreakers)).toEqual([]);
    expect(validateDealbreakers(dealbreakers)).toEqual([]);
  });

  it('keeps a 60-item initial block balanced across the 11 personality domains', () => {
    const initial = catalog.traits.filter((t) => t.block === 'initial');
    expect(initial).toHaveLength(60);
    expect(new Set(initial.map((t) => t.domain_internal)).size).toBe(11);
  });

  it('declares every domain that traits use', () => {
    const declared = new Set(catalog.domains_internal);
    for (const t of catalog.traits) expect(declared.has(t.domain_internal)).toBe(true);
  });

  it('turns hard constraints into gates on real dealbreaker questions', () => {
    const gates = catalog.traits.filter((t) => t.matching_role === 'gate');
    expect(gates.map((t) => t.id)).toContain('children_non_negotiable');
    for (const t of gates) expect(t.domain_internal).toBe('hard_constraints');
  });

  it('keeps i18n/en.json in sync with the data files', () => {
    expect(load('i18n/en.json')).toEqual(buildSourceCatalog(catalog, dealbreakers));
  });
});

describe('fuzzy primitives', () => {
  it('rates membership by degree, not by cut-off', () => {
    expect(ratingIn(fuzzy, 'high', 10)).toBe(1);
    expect(ratingIn(fuzzy, 'high', 7)).toBeCloseTo(0.6);
    expect(ratingIn(fuzzy, 'high', 5)).toBe(0);
    expect(ratingIn(fuzzy, 'medium', 5.5)).toBe(1);
    expect(trapezoid(0.5, [0, 1, 2, 3])).toBe(0.5);
  });

  it('treats differences within the rating spread as identical', () => {
    expect(closeness(0, 3, 9, 1)).toBe(1);
    expect(closeness(1, 3, 9, 1)).toBe(1);
    expect(closeness(4, 3, 9, 1)).toBeCloseTo(0.8);
    expect(closeness(9, 3, 9, 1)).toBe(0);
  });

  it('accumulates evidence with probabilistic OR and labels scores linguistically', () => {
    expect(probOr([0.5, 0.5])).toBe(0.75);
    expect(label(fuzzy, 0.95).label).toBe('excellent');
    expect(label(fuzzy, 0.2).label).toBe('poor');
  });
});

describe('matching', () => {
  it('averages scale groups and flips reverse-keyed items', () => {
    const index = indexCatalog(catalog);
    const scores = constructScores(index, { honest_direct: 8, bends_truth_for_harmony: 4 });
    expect(scores.get('sg_honesty')).toBe(7.5);
  });

  it('scores similar people above dissimilar ones, with a label', () => {
    const a = person({ ratings: profileRatings(8) });
    const similar = person({ id: 'b', gender: { identity: 'man' }, ratings: profileRatings(8) });
    const different = person({ id: 'c', gender: { identity: 'man' }, ratings: profileRatings(2) });
    const close = mutualMatch(catalog, dealbreakers, a, similar, { now: NOW });
    const far = mutualMatch(catalog, dealbreakers, a, different, { now: NOW });
    expect(close.excluded).toBe(false);
    expect(close.score).toBeGreaterThan(far.score);
    expect(['good', 'excellent']).toContain(close.label);
    expect(close.forward.parts.friction).toBeLessThan(far.forward.parts.friction);
  });

  it('grades dealbreaker strictness by the gate rating', () => {
    const viewer = person({ dealbreakers: { smoking: { self: 'never', accept: ['never'] } } });
    const smoker = person({ id: 's', dealbreakers: { smoking: { self: 'regularly' } } });

    const preference = score(viewer, smoker);
    expect(preference.excluded).toBe(false);
    expect(preference.parts.constraint_satisfaction).toBeCloseTo(1 - fuzzy.baseline_strictness);

    viewer.ratings = { lifestyle_non_negotiable: 7 };
    const fairlyStrict = score(viewer, smoker);
    expect(fairlyStrict.excluded).toBe(false);
    expect(fairlyStrict.parts.constraint_satisfaction).toBeCloseTo(0.4);

    viewer.ratings = { lifestyle_non_negotiable: 9 };
    expect(score(viewer, smoker).reasons).toContain('dealbreaker:smoking');
  });

  it('excludes when many soft mismatches add up', () => {
    const accept = (self) => ({ self, accept: [self] });
    const viewer = person({
      dealbreakers: {
        smoking: accept('never'),
        alcohol: accept('never'),
        cannabis: accept('never'),
        diet: accept('vegan'),
        pets_have: accept('none')
      }
    });
    const candidate = person({
      id: 'x',
      dealbreakers: {
        smoking: { self: 'regularly' },
        alcohol: { self: 'frequently' },
        cannabis: { self: 'regularly' },
        diet: { self: ['no_restrictions'] },
        pets_have: { self: ['dog'] }
      }
    });
    expect(score(viewer, candidate).reasons).toEqual(['combined_constraints']);
  });

  it('treats prefer_not_to_say as unknown under a strict filter', () => {
    const viewer = person({
      dealbreakers: { religion: { self: 'jewish', accept: ['jewish'], strict: true } }
    });
    const candidate = person({
      id: 'x',
      dealbreakers: { religion: { self: 'prefer_not_to_say' } }
    });
    expect(score(viewer, candidate).reasons).toContain('dealbreaker:religion');
  });

  it('skips questions disabled in either person’s region', () => {
    const viewer = person({
      open_to_long_distance: true,
      dealbreakers: { cannabis: { self: 'never', accept: ['never'], strict: true } }
    });
    const candidate = person({ id: 'x', location: { country: 'XA', timezone: 'UTC' } });
    expect(score(viewer, candidate, { regionPolicy }).reasons).not.toContain(
      'dealbreaker:cannabis'
    );
  });

  it('fades mandatory preferences out past tolerance instead of cutting off', () => {
    const viewer = person({
      preferences: {
        calm_under_pressure: { importance: 3, desired: 8, mandatory: true, tolerance: 2 }
      }
    });
    const rate = (r) => score(viewer, person({ id: 'c', ratings: { calm_under_pressure: r } }));
    expect(rate(9).excluded).toBe(false);
    const nearMiss = rate(5);
    expect(nearMiss.excluded).toBe(false);
    expect(nearMiss.parts.constraint_satisfaction).toBeCloseTo(0.5);
    expect(rate(3).reasons).toContain('mandatory:calm_under_pressure');
  });

  it('only penalizes the worse side of partner-effect traits', () => {
    const viewer = person({ ratings: { patient: 5 } });
    expect(score(viewer, person({ id: 'm', ratings: { patient: 10 } })).parts.implicit).toBe(1);
    expect(score(viewer, person({ id: 'l', ratings: { patient: 1 } })).parts.implicit).toBeLessThan(
      1
    );
  });

  it('softens age and distance edges but keeps gender, 18+ and photo check crisp', () => {
    const viewer = person({ seeking: { genders: ['woman'], age_min: 32, age_max: 40 } });
    const oneYearYounger = score(viewer, person({ id: 'y' }));
    expect(oneYearYounger.excluded).toBe(false);
    expect(oneYearYounger.parts.constraint_satisfaction).toBeCloseTo(0.5);

    const far = person({
      id: 'x',
      gender: { identity: 'man' },
      birth_month: '2004-01',
      location: { country: 'FI', timezone: 'UTC', lat: 65, lng: 25.5 }
    });
    expect(score(viewer, far).reasons).toEqual(
      expect.arrayContaining(['gender_not_sought', 'age_range', 'dealbreaker:location'])
    );

    const checkedOnly = person({ only_photo_checked_matches: true });
    const unchecked = person({ id: 'u', photo_check: { status: 'pending' } });
    expect(score(checkedOnly, unchecked).reasons).toContain('candidate_not_photo_checked');
  });
});

describe('ranking for lasting relationships', () => {
  const viewer = person({ id: 'v', ratings: profileRatings(8) });
  const pool = [
    person({ id: 'strong', gender: { identity: 'man' }, ratings: profileRatings(8) }),
    person({ id: 'weak', gender: { identity: 'man' }, ratings: profileRatings(2) }),
    person({
      id: 'taken',
      gender: { identity: 'man' },
      ratings: profileRatings(8),
      matching_status: 'in_relationship'
    })
  ];

  it('declares lasting relationships as the objective, never engagement', () => {
    expect(catalog.objective.optimize_for).toBe('lasting_relationships');
    expect(catalog.objective.never_optimize_for).toContain('time_in_app');
  });

  it('shows the best matches first and nobody below the quality threshold', () => {
    const { candidates } = rankCandidates(catalog, dealbreakers, viewer, pool, { now: NOW });
    expect(candidates.map((c) => c.id)).toEqual(['strong']);
  });

  it('shows no new people while enough conversations are open', () => {
    const r = rankCandidates(catalog, dealbreakers, viewer, pool, {
      now: NOW,
      activeConversations: catalog.ranking.max_active_conversations
    });
    expect(r).toEqual({ candidates: [], reason: 'focus_on_current_conversations' });
  });

  it('hides people in a relationship, including the viewer', () => {
    const together = { ...viewer, matching_status: 'in_relationship' };
    expect(rankCandidates(catalog, dealbreakers, together, pool, { now: NOW }).reason).toBe(
      'viewer_not_active'
    );
  });
});

describe('profile validation', () => {
  it('requires consent for special-category answers', () => {
    const p = person({ ratings: { religious_practice_important: 7 } });
    expect(validateProfile(p, catalog, dealbreakers, { now: NOW })).toContain(
      'special-category data (religion) without consent'
    );
    p.consents = { religion: { granted_at: '2026-01-01T00:00:00Z', policy_version: '1' } };
    expect(validateProfile(p, catalog, dealbreakers, { now: NOW })).toEqual([]);
  });

  it('enforces the mandatory limit and regional minimum age', () => {
    const prefs = Object.fromEntries(
      catalog.traits
        .filter((t) => t.block === 'initial')
        .slice(0, 11)
        .map((t) => [t.id, { importance: 2, mandatory: true }])
    );
    const p = person({
      birth_month: '2007-06',
      location: { country: 'XB', timezone: 'UTC' },
      seeking: { genders: ['man'], age_min: 20, age_max: 30 },
      preferences: prefs
    });
    const errors = validateProfile(p, catalog, dealbreakers, { regionPolicy, now: NOW });
    expect(errors).toContain('must be at least 20');
    expect(errors).toContain('at most 10 mandatory preferences');
  });
});

describe('response quality', () => {
  it('flags contradictions, social desirability and straight-lining by degree', () => {
    const flags = responseQuality(catalog, {
      wants_children: 9,
      does_not_want_children: 9,
      validity_never_lied: 10
    }).flags.map((f) => f.type);
    expect(flags).toEqual(expect.arrayContaining(['inconsistent', 'social_desirability']));
    const flat = Object.fromEntries(catalog.traits.slice(0, 30).map((t) => [t.id, 7]));
    expect(responseQuality(catalog, flat).flags.map((f) => f.type)).toEqual(['straight_lining']);
  });
});

describe('message moderation', () => {
  const late = { messages_exchanged: 50 };
  const check = (text, ctx = late, attachments) =>
    moderateMessage(policy, { text, attachments }, ctx);

  it('allows ordinary messages, including words that contain filtered ones', () => {
    expect(check('Hi! I saw you like hiking. Cocktails in Essex sometime?').action).toBe('allow');
  });

  it('blocks all images: attachments, image links, embedded images', () => {
    expect(check('hey', late, [{ type: 'image/jpeg' }]).action).toBe('block');
    expect(check('look https://i.imgur.com/abc').reasons[0].rule).toBe('image_link');
    expect(check('see example.com/me.JPG').reasons.map((r) => r.rule)).toContain('image_link');
    expect(check('![x](http://a.b/c)').action).toBe('block');
  });

  it('blocks picture requests and evasive spellings with a strike', () => {
    const r = check('s e n d  n u d e s');
    expect(r.action).toBe('block');
    expect(r.strike).toBe(true);
    expect(normalizeText('d.i.c.k p1c')).toBe('dick pic');
    expect(check('want a d.i.c.k p1c?').action).toBe('block');
  });

  it('allows explicit talk only after both opt in, without a strike', () => {
    expect(check("I'm so horny").action).toBe('block');
    expect(check("I'm so horny", { ...late, explicit_consent: true }).action).toBe('allow');
    const pics = check('send nudes', { ...late, explicit_consent: true });
    expect(pics.action).toBe('block');
    expect(pics.strike).toBe(false);
  });

  it('holds threats, scams and exploitation for review', () => {
    expect(check('I know where you live').action).toBe('hold_for_review');
    expect(check('can you send me money for a gift card').action).toBe('hold_for_review');
    expect(check('200 roses per hour, incall only').action).toBe('hold_for_review');
    expect(check('I will pay for your ticket and visa, modelling job abroad').action).toBe(
      'hold_for_review'
    );
  });

  it('blocks links and contact details early in a conversation', () => {
    const early = { messages_exchanged: 2 };
    expect(check('add me on whatsapp', early).reasons[0].rule).toBe('contact_too_early');
    expect(check('mail me a@b.co', early).action).toBe('block');
    expect(check('read this www.example.org', early).reasons[0].rule).toBe('link_too_early');
    expect(check('add me on whatsapp', late).action).toBe('allow');
  });

  it('blocks everything from a suspended sender', () => {
    expect(check('hello', { ...late, sender_strikes: 3 }).reasons[0].rule).toBe('sender_suspended');
  });
});

describe('account trust', () => {
  const account = {
    id: 'a',
    created_at: '2026-09-27T00:00:00Z',
    location: { country: 'FI' },
    photo_check: { status: 'passed' }
  };

  it('lets a photo-checked, well-behaved account message', () => {
    expect(canStartConversation(policy, account, {}, NOW).allowed).toBe(true);
  });

  it('requires a photo check from unchecked or location-mismatched accounts', () => {
    const unchecked = { ...account, photo_check: { status: 'pending' } };
    expect(canStartConversation(policy, unchecked, {}, NOW).reasons).toContain(
      'require_photo_check'
    );
    const r = accountRiskSignals(policy, account, { signin_country_mismatch: true }, NOW);
    expect(r.flags.map((f) => f.id)).toContain('location_mismatch');
  });

  it('limits mass and copy-paste messaging', () => {
    const h = messageHash('Hey beautiful, how are you?');
    expect(messageHash('hey   BEAUTIFUL how are you')).toBe(h);
    const r = accountRiskSignals(
      policy,
      account,
      { first_messages_today: 6, first_message_hashes_last_day: [h, h, h, h, h] },
      NOW
    );
    expect(r.flags.map((f) => f.id)).toEqual(
      expect.arrayContaining(['mass_messaging', 'copy_paste_openers'])
    );
  });

  it('suspends immediately on trafficking or underage reports, and on reused banned photos', () => {
    const r = accountRiskSignals(
      policy,
      account,
      { open_reports: [{ reason: 'trafficking_or_exploitation' }], banned_photo_match: true },
      NOW
    );
    expect(r.level).toBe('high');
    expect(r.actions).toEqual(
      expect.arrayContaining(['suspend_pending_review', 'block_new_account'])
    );
  });
});
