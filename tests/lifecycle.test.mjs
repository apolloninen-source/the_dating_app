import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyCheckin, departureRecord } from '../lib/calibration.mjs';
import {
  areaStatus,
  constraintImpact,
  prefilterBlocker,
  prefilterSpec
} from '../lib/candidates.mjs';
import {
  closeConversation,
  conversationState,
  openConversationCount
} from '../lib/conversations.mjs';
import { mutualMatch } from '../lib/match.mjs';
import { nextQuestions, questionValue, questionnaireProgress } from '../lib/questionnaire.mjs';
import { rankCandidates, visibilityBlocker } from '../lib/rank.mjs';
import { afterDateOutcome, confirmTogether } from '../lib/relationship.mjs';

const load = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const catalog = load('data/traits.v0.8.json');
const dealbreakers = load('data/dealbreakers.v0.8.json');
const lifecycle = load('data/lifecycle-policy.v0.8.json');
const NOW = new Date('2026-09-28T12:00:00Z');
const daysLater = (d) => new Date(NOW.getTime() + d * 86_400_000);

function person(overrides = {}) {
  return {
    id: 'p',
    birth_month: '1995-05',
    gender: { identity: 'woman' },
    seeking: { genders: ['man', 'woman'], age_min: 25, age_max: 45 },
    location: { country: 'FI', timezone: 'Europe/Helsinki', lat: 60.17, lng: 24.94 },
    max_distance_km: 50,
    languages: [{ code: 'en', proficiency: 'fluent' }],
    ui_locale: 'en',
    mode: 'safe',
    matching_status: 'active',
    ratings: { honest_direct: 8, patient: 8, warm_and_affectionate: 8 },
    preferences: {},
    dealbreakers: {},
    photo_check: { status: 'passed' },
    ...overrides
  };
}

describe('conversations close kindly or automatically', () => {
  const conv = {
    id: 'c',
    participants: ['a', 'b'],
    status: 'open',
    created_at: NOW.toISOString(),
    last_message_at: NOW.toISOString(),
    last_message_by: 'a'
  };

  it('reminds the person whose turn it is once, then closes after inactivity', () => {
    expect(conversationState(lifecycle, conv, daysLater(1)).state).toBe('open');
    expect(conversationState(lifecycle, conv, daysLater(4))).toEqual({
      state: 'remind',
      remind: 'b'
    });
    const reminded = { ...conv, reminders_sent: 1 };
    expect(conversationState(lifecycle, reminded, daysLater(5)).state).toBe('open');
    expect(conversationState(lifecycle, reminded, daysLater(10)).state).toBe('auto_close');
  });

  it('lets a participant close kindly with a template', () => {
    const closed = closeConversation(lifecycle, conv, {
      by: 'b',
      template: 'not_a_match',
      now: NOW
    });
    expect(closed).toMatchObject({
      status: 'closed',
      closed_by: 'b',
      closing_template: 'not_a_match'
    });
    expect(() => closeConversation(lifecycle, conv, { by: 'x', now: NOW })).toThrow();
    expect(() =>
      closeConversation(lifecycle, conv, { by: 'a', template: 'rude', now: NOW })
    ).toThrow();
  });

  it('frees conversation slots when chats close', () => {
    const closed = { ...conv, id: 'd', status: 'closed' };
    const stale = { ...conv, id: 'e', last_message_at: daysLater(-11).toISOString() };
    expect(openConversationCount(lifecycle, [conv, closed, stale], 'a', NOW)).toBe(1);
  });
});

describe('blocking and fair exposure', () => {
  const viewer = person({ id: 'v', blocked_ids: ['x'] });

  it('never shows blocked pairs, in either direction', () => {
    expect(visibilityBlocker(catalog, viewer, person({ id: 'x' }))).toBe('blocked');
    expect(visibilityBlocker(catalog, viewer, person({ id: 'y', blocked_ids: ['v'] }))).toBe(
      'blocked'
    );
  });

  it('stops showing people who are already seen or asked by many', () => {
    const exposure = {
      busy: { shown_today: catalog.ranking.max_daily_exposure },
      popular: { pending_incoming_interest: catalog.ranking.max_pending_incoming_interest }
    };
    const pool = ['busy', 'popular', 'free'].map((id) => person({ id }));
    const { candidates } = rankCandidates(catalog, dealbreakers, viewer, pool, {
      now: NOW,
      exposure
    });
    expect(candidates.map((c) => c.id)).toEqual(['free']);
  });
});

describe('relationship lifecycle', () => {
  const a = person({ id: 'a', calibration_opt_in: true });
  const b = person({ id: 'b', calibration_opt_in: true });

  it('confirms "together" only when both confirm within the window', () => {
    const pair = { a: 'a', b: 'b' };
    const first = confirmTogether(lifecycle, pair, 'a', NOW);
    expect(first.status).toBe('waiting_for_partner');
    const both = confirmTogether(lifecycle, first.pair, 'b', daysLater(3));
    expect(both.status).toBe('together');
    expect(both.actions).toContain('hide_both_from_matching');
    expect(both.delete_after).toBe(daysLater(33).toISOString());
    const late = confirmTogether(lifecycle, first.pair, 'b', daysLater(20));
    expect(late.status).toBe('waiting_for_partner');
  });

  it('turns a private after-date check-in into actions, never shared answers', () => {
    const pair = { a: 'a', b: 'b' };
    const yes = { met: true, see_again: 'yes', felt_safe: true };
    expect(afterDateOutcome(pair, { a: yes, b: yes }).outcome_signal).toBe(
      'conversation_led_to_meeting'
    );
    const mixed = afterDateOutcome(pair, {
      a: yes,
      b: { met: true, see_again: 'no', felt_safe: false }
    });
    expect(mixed.outcome_signal).toBe('did_not_want_to_meet_again');
    expect(mixed.actions).toEqual(
      expect.arrayContaining([
        { user: 'b', action: 'offer_support_and_report' },
        { user: 'b', action: 'suggest_closing_kindly' }
      ])
    );
    expect(JSON.stringify(mixed)).not.toContain('see_again');
  });

  it('collects later outcomes through an anonymous check-in link, not an account', () => {
    expect(
      departureRecord(catalog, dealbreakers, a, { ...b, calibration_opt_in: false }, NOW)
    ).toBeNull();
    const { token, record } = departureRecord(catalog, dealbreakers, a, b, NOW);
    expect(JSON.stringify(record)).not.toContain(token);
    expect(JSON.stringify(record)).not.toMatch(/"a"|"b"/);
    const later = applyCheckin(
      catalog,
      record,
      token,
      'both_confirm_together_at_3_months',
      daysLater(92)
    );
    expect(later.outcomes.map((o) => o.outcome)).toEqual([
      'both_left_app_together',
      'both_confirm_together_at_3_months'
    ]);
    expect(applyCheckin(catalog, later, token, 'both_confirm_together_at_3_months')).toBe(later);
    expect(() => applyCheckin(catalog, record, 'wrong', 'separated')).toThrow();
  });
});

describe('candidate prefilter is sound', () => {
  // A synthetic population varying every attribute the prefilter looks at.
  const pool = [];
  const cities = [
    { country: 'FI', timezone: 'UTC', lat: 60.17, lng: 24.94 },
    { country: 'FI', timezone: 'UTC', lat: 60.45, lng: 22.27 },
    { country: 'FI', timezone: 'UTC', lat: 65.01, lng: 25.47 },
    { country: 'SE', timezone: 'UTC', lat: 59.33, lng: 18.07 },
    { country: 'EE', timezone: 'UTC' }
  ];
  let n = 0;
  for (const identity of ['woman', 'man', 'non_binary']) {
    for (const birth of ['2010-01', '2003-06', '1996-02', '1990-11', '1978-03']) {
      for (const where of cities) {
        for (const smoking of ['never', 'regularly', undefined]) {
          n += 1;
          pool.push(
            person({
              id: `c${n}`,
              gender: { identity },
              birth_month: birth,
              location: where,
              seeking: {
                genders: n % 4 ? ['woman', 'man'] : ['man'],
                age_min: 20 + (n % 15),
                age_max: 50
              },
              dealbreakers: smoking ? { smoking: { self: smoking } } : {},
              photo_check: { status: n % 7 ? 'passed' : 'pending' },
              blocked_ids: n % 11 ? [] : ['v']
            })
          );
        }
      }
    }
  }
  const viewer = person({
    id: 'v',
    seeking: { genders: ['woman', 'man'], age_min: 25, age_max: 40 },
    countries_open: ['SE'],
    only_photo_checked_matches: true,
    ratings: { honest_direct: 8, patient: 8, lifestyle_non_negotiable: 9 },
    dealbreakers: { smoking: { self: 'never', accept: ['never'] } }
  });

  it('only drops people the matcher would exclude anyway', () => {
    const spec = prefilterSpec(catalog, dealbreakers, viewer, NOW);
    let dropped = 0;
    let kept = 0;
    for (const c of pool) {
      const reason = prefilterBlocker(spec, c, NOW);
      if (reason === null) {
        kept += 1;
        continue;
      }
      dropped += 1;
      const excluded =
        visibilityBlocker(catalog, viewer, c) !== null ||
        mutualMatch(catalog, dealbreakers, viewer, c, { now: NOW }).excluded;
      expect({ id: c.id, reason, excluded }).toEqual({ id: c.id, reason, excluded: true });
    }
    expect(dropped).toBeGreaterThan(100);
    expect(kept).toBeGreaterThan(0);
  });

  it('explains "why am I seeing nobody?" without singling anyone out', () => {
    const impact = constraintImpact(catalog, dealbreakers, lifecycle, viewer, pool, { now: NOW });
    expect(impact.pool).toBe(pool.length);
    const top = impact.excluded_by_your_settings[0];
    expect(typeof top.count === 'number' ? top.count : 0).toBeGreaterThanOrEqual(5);
    const tiny = constraintImpact(catalog, dealbreakers, lifecycle, viewer, pool.slice(0, 3), {
      now: NOW
    });
    for (const row of tiny.excluded_by_your_settings) {
      expect(row.count === '<5' || row.count >= 5).toBe(true);
    }
  });

  it('puts thin areas on a waitlist', () => {
    expect(areaStatus(lifecycle, 40)).toBe('waitlist');
    expect(areaStatus(lifecycle, 400)).toBe('open');
  });
});

describe('adaptive questionnaire', () => {
  it('starts with the fixed initial block and allows matching once it is done', () => {
    expect(questionnaireProgress(catalog, {}).can_match).toBe(false);
    const first = catalog.traits.filter((t) => t.block === 'initial').slice(0, 3);
    expect(nextQuestions(catalog, {}, 3)).toEqual(first.map((t) => t.id));
    const initialDone = Object.fromEntries(
      catalog.traits.filter((t) => t.block === 'initial').map((t) => [t.id, 5])
    );
    const progress = questionnaireProgress(catalog, initialDone);
    expect(progress.can_match).toBe(true);
    expect(progress.answered).toBe(60);
    const next = nextQuestions(catalog, initialDone, 10);
    expect(next).toHaveLength(10);
    expect(next.some((id) => id in initialDone)).toBe(false);
  });

  it('values completing an expectation pair and skips redundant scale-group items', () => {
    const joins = catalog.traits.find((t) => t.id === 'joins_partner_family');
    const base = questionValue(joins, {}, new Set());
    expect(questionValue(joins, { expects_family_participation: 9 }, new Set())).toBeCloseTo(
      base * 1.5
    );
    const laughs = catalog.traits.find((t) => t.id === 'laughs_easily');
    expect(questionValue(laughs, {}, new Set(['sg_humor']))).toBeCloseTo(
      questionValue(laughs, {}, new Set()) / 2
    );
  });
});
