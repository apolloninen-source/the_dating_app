// Candidate generation at scale, "why am I seeing nobody?", and launch density.
//
// Scoring every pair does not scale, so a database query first narrows the pool with a prefilter
// spec, and only the shortlist is fuzzy-scored. The prefilter is SOUND: it only drops people the
// fuzzy matcher would certainly exclude (a constraint degree below the alpha-cut), so it can never
// hide a real match.
import { indexCatalog } from './constructs.mjs';
import { trapezoid } from './fuzzy.mjs';
import { ageOn, directionalScore, effectiveLocation, distanceKm, strictness } from './match.mjs';
import { goodEnough, visibilityBlocker } from './rank.mjs';

const disabledIn = (regionPolicy, profile) => {
  if (!regionPolicy) return [];
  const rules = regionPolicy.regions?.[profile.location?.country] ?? {};
  return rules.disabled_questions ?? regionPolicy.default?.disabled_questions ?? [];
};

// A serializable description of who can possibly match `viewer`, for a database query.
export function prefilterSpec(catalog, dealbreakers, viewer, now = new Date(), regionPolicy) {
  const index = indexCatalog(catalog);
  const { fuzzy } = catalog.matching_config;
  const cut = fuzzy.exclusion_alpha_cut;
  const margin = fuzzy.age_margin_years;
  const disabled = new Set(disabledIn(regionPolicy, viewer));

  // Location: only a certain exclusion when the location filter is fully strict.
  let location = null;
  const locAnswer = viewer.dealbreakers?.location;
  if (
    !disabled.has('location') &&
    !viewer.open_to_long_distance &&
    locAnswer?.enabled !== false &&
    Number.isFinite(viewer.max_distance_km) &&
    1 - strictness(index, viewer, 'location', locAnswer?.strict, 1) < cut
  ) {
    const home = effectiveLocation(viewer, now);
    location = {
      home_country: home.country,
      other_countries: [...(viewer.countries_open ?? [])],
      center: Number.isFinite(home.lat) ? { lat: home.lat, lng: home.lng } : null,
      radius_km: viewer.max_distance_km * (1 + fuzzy.distance_margin_ratio)
    };
  }

  // Choice questions strict enough that a mismatch (and maybe unknown) is a certain exclusion.
  const requiredAnswers = [];
  for (const q of dealbreakers.questions) {
    if (disabled.has(q.id) || !q.options.length) continue;
    const mine = viewer.dealbreakers?.[q.id];
    let accept = mine?.accept;
    if (!accept?.length && q.compatibility && typeof mine?.self === 'string') {
      accept = q.compatibility[mine.self];
    }
    if (!accept?.length) continue;
    const s = strictness(index, viewer, q.id, mine.strict, fuzzy.baseline_strictness);
    if (1 - s >= cut) continue;
    requiredAnswers.push({
      question: q.id,
      any_of: [...accept],
      unknown_allowed: 1 - s * fuzzy.unknown_mismatch >= cut
    });
  }

  let sharedLanguage = false;
  const lang = viewer.dealbreakers?.shared_language;
  if (
    !disabled.has('shared_language') &&
    lang?.enabled === true &&
    1 - strictness(index, viewer, 'shared_language', lang.strict, 1) < cut
  ) {
    sharedLanguage = true;
  }

  return {
    viewer_id: viewer.id,
    viewer_gender: viewer.gender.identity,
    viewer_age: ageOn(viewer.birth_month, now),
    viewer_photo_checked: viewer.photo_check?.status === 'passed',
    genders: [...viewer.seeking.genders],
    age_range: [Math.max(18, viewer.seeking.age_min - margin), viewer.seeking.age_max + margin],
    exclude_status: [...catalog.ranking.hide_when_status],
    exclude_ids: [viewer.id, ...(viewer.blocked_ids ?? [])],
    photo_checked_only: Boolean(viewer.only_photo_checked_matches),
    location,
    required_answers: requiredAnswers,
    shared_language_with: sharedLanguage ? viewer.languages.map((l) => l.code) : null,
    reciprocal_age_margin: margin
  };
}

// The same spec evaluated in memory (and the reference for the database query). Returns null if
// the candidate passes, otherwise the first reason.
export function prefilterBlocker(spec, candidate, now = new Date(), regionPolicy) {
  if (spec.exclude_ids.includes(candidate.id)) return 'excluded_id';
  if ((candidate.blocked_ids ?? []).includes(spec.viewer_id)) return 'blocked_viewer';
  if (spec.exclude_status.includes(candidate.matching_status)) return 'not_active';
  if (!spec.genders.includes(candidate.gender.identity)) return 'gender';
  if (!candidate.seeking.genders.includes(spec.viewer_gender)) return 'their_gender';
  const age = ageOn(candidate.birth_month, now);
  if (age < 18 || age < spec.age_range[0] || age > spec.age_range[1]) return 'age';
  const m = spec.reciprocal_age_margin;
  if (
    spec.viewer_age < candidate.seeking.age_min - m ||
    spec.viewer_age > candidate.seeking.age_max + m
  ) {
    return 'their_age';
  }
  if (spec.photo_checked_only && candidate.photo_check?.status !== 'passed') return 'photo_check';
  if (candidate.only_photo_checked_matches && !spec.viewer_photo_checked)
    return 'their_photo_check';

  const disabled = new Set(disabledIn(regionPolicy, candidate));
  if (spec.location && !disabled.has('location')) {
    const where = effectiveLocation(candidate, now);
    if (where.country !== spec.location.home_country) {
      if (!spec.location.other_countries.includes(where.country)) return 'location';
    } else if (spec.location.center && Number.isFinite(where.lat) && Number.isFinite(where.lng)) {
      if (distanceKm(spec.location.center, where) >= spec.location.radius_km) return 'location';
    }
  }

  for (const req of spec.required_answers) {
    if (disabled.has(req.question)) continue;
    const self = candidate.dealbreakers?.[req.question]?.self;
    const answers = [self].flat().filter((o) => o !== undefined && o !== 'prefer_not_to_say');
    if (!answers.length) {
      if (!req.unknown_allowed) return `answer:${req.question}`;
    } else if (!answers.some((a) => req.any_of.includes(a))) {
      return `answer:${req.question}`;
    }
  }

  if (spec.shared_language_with && !disabled.has('shared_language')) {
    const spoken = ['native', 'fluent', 'conversational'];
    const mine = new Set(spec.shared_language_with.map((c) => c.split('-')[0].toLowerCase()));
    const shares = candidate.languages.some(
      (l) => spoken.includes(l.proficiency) && mine.has(l.code.split('-')[0].toLowerCase())
    );
    if (!shares) return 'language';
  }
  return null;
}

// "Why am I seeing nobody?" Aggregated over a pool: which of the viewer's own settings exclude
// the most people. Other people's settings are only ever reported as one total, and small counts
// are shown as "<k" so no individual can be singled out.
export function constraintImpact(catalog, dealbreakers, lifecycle, viewer, pool, options = {}) {
  const { now = new Date(), regionPolicy, exposure = {} } = options;
  const k = lifecycle.launch.min_report_count;
  const index = indexCatalog(catalog);
  const counts = new Map();
  let theirs = 0;
  let belowQuality = 0;
  let wouldShow = 0;
  let unavailable = 0;
  for (const candidate of pool) {
    if (visibilityBlocker(catalog, viewer, candidate, exposure)) {
      unavailable += 1;
      continue;
    }
    const opts = { now, regionPolicy };
    const forward = directionalScore(index, dealbreakers, viewer, candidate, opts);
    if (forward.excluded) {
      for (const reason of forward.reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
      continue;
    }
    const backward = directionalScore(index, dealbreakers, candidate, viewer, opts);
    if (backward.excluded) {
      theirs += 1;
      continue;
    }
    const score = Math.sqrt(forward.score * backward.score);
    const memberships = Object.fromEntries(
      Object.entries(catalog.matching_config.fuzzy.match_labels).map(([name, set]) => [
        name,
        trapezoid(score, set)
      ])
    );
    if (goodEnough(catalog, memberships)) wouldShow += 1;
    else belowQuality += 1;
  }
  const safe = (n) => (n > 0 && n < k ? `<${k}` : n);
  return {
    pool: pool.length,
    would_show: safe(wouldShow),
    excluded_by_your_settings: [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => ({ reason, count: safe(count) })),
    excluded_by_their_settings: safe(theirs),
    below_quality: safe(belowQuality),
    unavailable: safe(unavailable)
  };
}

// Launch density: below the minimum pool within reach, join the area's waitlist.
export function areaStatus(lifecycle, activeWithinReach) {
  return activeWithinReach >= lifecycle.launch.min_area_pool ? 'open' : 'waitlist';
}
