// Reference matcher for the v0.8 catalog, built on fuzzy logic (lib/fuzzy.mjs).
//
// Viewer -> candidate (directional); a match is scored in both directions:
//   1. crisp gates that are legal or identity facts: gender sought, 18+, verified-only
//   2. fuzzy constraints, each a satisfaction degree in [0, 1]: age range and distance with soft
//      margins, dealbreakers (strictness = degree the viewer's hard-constraint rating is "high"),
//      mandatory preferences (fading out past tolerance). Degrees combine with algebraic AND;
//      below the alpha-cut the candidate is excluded
//   3. compatibility: explicit preferences and implicit similarity as weighted means of
//      "closeness" degrees; complements weighted by how "high" the viewer is on the trait
//   4. friction: each conflict fires to degree min(high(a), high(b)); conflicts accumulate by
//      probabilistic OR; the viewer's mode applies a hedge (safe = somewhat, curious = very)
//   5. score = compatibility x (1 - friction) x constraints; mutual = geometric mean, with a
//      linguistic label (poor | fair | good | excellent)
import { constructScores, indexCatalog, keyed } from './constructs.mjs';
import { closeness, hedges, label, probAnd, probOr, ratingIn, within } from './fuzzy.mjs';

const UNKNOWN = 'prefer_not_to_say';
const SPOKEN = new Set(['native', 'fluent', 'conversational']);

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function ageOn(birthDate, now) {
  const born = new Date(`${birthDate}T00:00:00Z`);
  const age = now.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < born.getUTCMonth() ||
    (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate());
  return beforeBirthday ? age - 1 : age;
}

export function distanceKm(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Partner-effect constructs only count the gap on the worse side of the target.
function gap(candidate, target, partnerEffect) {
  if (partnerEffect === 'higher_better') return Math.max(0, target - candidate);
  if (partnerEffect === 'lower_better') return Math.max(0, candidate - target);
  return Math.abs(candidate - target);
}

function regionRules(regionPolicy, profile) {
  if (!regionPolicy) return { disabled_questions: [] };
  const rules = regionPolicy.regions?.[profile.location?.country] ?? {};
  return { ...regionPolicy.default, ...rules };
}

function crispGates(viewer, candidate, now) {
  const reasons = [];
  if (!viewer.seeking.genders.includes(candidate.gender.identity))
    reasons.push('gender_not_sought');
  if (ageOn(candidate.birth_date, now) < 18) reasons.push('candidate_under_18');
  if (viewer.only_verified_matches && candidate.verification?.identity?.status !== 'verified') {
    reasons.push('candidate_unverified');
  }
  return reasons;
}

// Strictness of a dealbreaker: explicit choice wins; otherwise the degree to which the viewer's
// linked hard-constraint rating is "high", never below the baseline for a stated preference.
function strictness(index, viewer, questionId, explicit, fallback) {
  if (explicit === true) return 1;
  const { fuzzy } = index.config;
  if (explicit === false) return fuzzy.baseline_strictness;
  let gate = 0;
  for (const trait of index.catalog.traits) {
    if (trait.constraint?.gates.includes(questionId)) {
      gate = Math.max(gate, ratingIn(fuzzy, 'high', viewer.ratings?.[trait.id]));
    }
  }
  return Math.max(fallback, gate);
}

function sharesLanguage(a, b) {
  const primary = (code) => code.split('-')[0].toLowerCase();
  const spoken = (p) =>
    new Set(p.languages.filter((l) => SPOKEN.has(l.proficiency)).map((l) => primary(l.code)));
  const mine = spoken(a);
  return [...spoken(b)].some((code) => mine.has(code));
}

// Degree to which the candidate's location is acceptable: 1 within max distance, fading to 0
// over the distance margin; other countries count only when listed in countries_open.
function locationDegree(index, viewer, candidate) {
  if (viewer.open_to_long_distance) return 1;
  const country = candidate.location.country;
  if (country !== viewer.location.country) {
    return (viewer.countries_open ?? []).includes(country) ? 1 : 0;
  }
  const coords = [viewer.location, candidate.location].every(
    (l) => Number.isFinite(l.lat) && Number.isFinite(l.lng)
  );
  if (!coords) return 1;
  const max = viewer.max_distance_km;
  const km = distanceKm(viewer.location, candidate.location);
  return within(km, 0, max, max * index.config.fuzzy.distance_margin_ratio);
}

// Returns [{ id, degree }] for every constraint that is not fully satisfied.
function constraintDegrees(index, dealbreakers, viewer, candidate, now, regionPolicy) {
  const { fuzzy } = index.config;
  const out = [];
  const push = (id, degree) => degree < 1 && out.push({ id, degree });

  const age = ageOn(candidate.birth_date, now);
  push(
    'age_range',
    within(age, viewer.seeking.age_min, viewer.seeking.age_max, fuzzy.age_margin_years)
  );

  const disabled = new Set([
    ...regionRules(regionPolicy, viewer).disabled_questions,
    ...regionRules(regionPolicy, candidate).disabled_questions
  ]);
  for (const q of dealbreakers.questions) {
    if (disabled.has(q.id)) continue;
    const mine = viewer.dealbreakers?.[q.id];
    if (q.type === 'location') {
      if (mine?.enabled === false || !Number.isFinite(viewer.max_distance_km)) continue;
      const s = strictness(index, viewer, q.id, mine?.strict, 1);
      push(`dealbreaker:${q.id}`, 1 - s * (1 - locationDegree(index, viewer, candidate)));
    } else if (q.type === 'language_overlap') {
      if (mine?.enabled !== true) continue;
      const s = strictness(index, viewer, q.id, mine.strict, 1);
      push(`dealbreaker:${q.id}`, sharesLanguage(viewer, candidate) ? 1 : 1 - s);
    } else {
      if (!Array.isArray(mine?.accept) || mine.accept.length === 0) continue;
      const theirs = candidate.dealbreakers?.[q.id]?.self;
      const options = [theirs].flat().filter((o) => o !== undefined && o !== UNKNOWN);
      let mismatch = 0;
      if (options.length === 0) mismatch = fuzzy.unknown_mismatch;
      else if (!options.some((o) => mine.accept.includes(o))) mismatch = 1;
      const s = strictness(index, viewer, q.id, mine.strict, fuzzy.baseline_strictness);
      push(`dealbreaker:${q.id}`, 1 - s * mismatch);
    }
  }
  return out;
}

// Weight multiplier per domain: 1 + degree the viewer's hard-constraint rating is "high".
function domainAmplifiers(index, viewer) {
  const amp = new Map();
  for (const trait of index.catalog.traits) {
    if (!trait.constraint) continue;
    const factor = 1 + ratingIn(index.config.fuzzy, 'high', viewer.ratings?.[trait.id]);
    for (const domain of trait.constraint.amplifies_domains) {
      amp.set(domain, Math.max(amp.get(domain) ?? 1, factor));
    }
  }
  return amp;
}

function explicitScore(index, viewer, candidateScores, viewerScores) {
  const { min, max } = index.scale;
  const { fuzzy } = index.config;
  const span = max - min;
  const [tolLo, tolHi] = index.config.allowed_divergence_range;

  // Merge preferences that land on the same construct (e.g. two items of one scale group).
  const merged = new Map();
  for (const [traitId, pref] of Object.entries(viewer.preferences ?? {})) {
    const trait = index.byId.get(traitId);
    if (!trait || trait.matching_role !== 'score') continue;
    if (pref.importance === 0 && !pref.mandatory) continue;
    const cid = index.constructOf(traitId);
    const desired = Number.isFinite(pref.desired) ? keyed(index, trait, pref.desired) : undefined;
    const prev = merged.get(cid);
    merged.set(cid, {
      importance: Math.max(prev?.importance ?? 0, pref.importance),
      mandatory: Boolean(prev?.mandatory || pref.mandatory),
      desired: prev?.desired ?? desired,
      tolerance: prev?.tolerance ?? pref.tolerance
    });
  }

  const constraints = [];
  let weighted = 0;
  let total = 0;
  for (const [cid, pref] of merged) {
    const construct = index.constructs.get(cid);
    const target = pref.desired ?? viewerScores.get(cid);
    if (target === undefined) continue;
    const tolerance = clamp(pref.tolerance ?? construct.tolerance, tolLo, tolHi);
    const b = candidateScores.get(cid);
    let fit;
    if (b === undefined) {
      fit = 0.5;
      if (pref.mandatory)
        constraints.push({ id: `mandatory:${cid}`, degree: 1 - fuzzy.unknown_mismatch });
    } else {
      const d = gap(b, target, construct.partner_effect);
      fit = closeness(d, tolerance, span, fuzzy.rating_spread);
      if (pref.mandatory) {
        const degree = within(d, 0, tolerance, fuzzy.mandatory_margin);
        if (degree < 1) constraints.push({ id: `mandatory:${cid}`, degree });
      }
    }
    const w = Math.max(pref.importance, pref.mandatory ? 1 : 0) * construct.research_prior;
    weighted += w * fit;
    total += w;
  }
  return { constraints, score: total > 0 ? weighted / total : null };
}

function implicitScore(index, viewer, candidate, candidateScores, viewerScores) {
  const { min, max } = index.scale;
  const span = max - min;
  const { fuzzy, modes } = index.config;
  const mode = modes[viewer.mode ?? 'safe'];
  const amp = domainAmplifiers(index, viewer);

  let weighted = 0;
  let total = 0;
  for (const [cid, a] of viewerScores) {
    const b = candidateScores.get(cid);
    if (b === undefined) continue;
    const construct = index.constructs.get(cid);
    const fit = closeness(
      gap(b, a, construct.partner_effect),
      construct.tolerance,
      span,
      fuzzy.rating_spread
    );
    const w =
      construct.research_prior *
      construct.similarity_weight *
      mode.similarity_boost *
      (amp.get(construct.domain) ?? 1);
    weighted += w * fit;
    total += w;
  }

  const conflicts = [];
  const mine = viewer.ratings ?? {};
  const theirs = candidate.ratings ?? {};
  for (const trait of index.catalog.traits) {
    const a = mine[trait.id];
    if (trait.matching_role !== 'score' || !Number.isFinite(a)) continue;
    const high = ratingIn(fuzzy, 'high', a);
    if (high === 0) continue;
    for (const other of trait.seed_complements) {
      const b = theirs[other];
      if (!Number.isFinite(b)) continue;
      const w =
        high *
        trait.weights.research_prior *
        trait.weights.complementarity_weight *
        mode.complementarity_boost;
      const fit = closeness(
        Math.max(0, a - b),
        trait.divergence.default_tolerance,
        span,
        fuzzy.rating_spread
      );
      weighted += w * fit;
      total += w;
    }
    for (const other of trait.seed_conflicts) {
      const degree = Math.min(high, ratingIn(fuzzy, 'high', theirs[other]));
      if (degree > 0) conflicts.push(fuzzy.conflict_weight * degree);
    }
  }
  const friction = hedges[mode.conflict_hedge](probOr(conflicts));
  return { score: total > 0 ? weighted / total : null, friction };
}

export function directionalScore(
  catalogOrIndex,
  dealbreakers,
  viewer,
  candidate,
  { now = new Date(), regionPolicy } = {}
) {
  const index = catalogOrIndex.constructs ? catalogOrIndex : indexCatalog(catalogOrIndex);
  const { fuzzy } = index.config;
  const reasons = crispGates(viewer, candidate, now);

  const viewerScores = constructScores(index, viewer.ratings);
  const candidateScores = constructScores(index, candidate.ratings);
  const explicit = explicitScore(index, viewer, candidateScores, viewerScores);
  const implicit = implicitScore(index, viewer, candidate, candidateScores, viewerScores);

  const constraints = [
    ...constraintDegrees(index, dealbreakers, viewer, candidate, now, regionPolicy),
    ...explicit.constraints
  ];
  const satisfaction = probAnd(constraints.map((c) => c.degree));
  const cut = fuzzy.exclusion_alpha_cut;
  for (const c of constraints) if (c.degree < cut) reasons.push(c.id);
  if (satisfaction < cut && !constraints.some((c) => c.degree < cut)) {
    reasons.push('combined_constraints');
  }

  const iw = index.config.implicit_weight;
  let compatibility;
  if (explicit.score !== null && implicit.score !== null) {
    compatibility = (1 - iw) * explicit.score + iw * implicit.score;
  } else {
    compatibility = explicit.score ?? implicit.score ?? 0.5;
  }
  const score = clamp(compatibility * (1 - implicit.friction) * satisfaction, 0, 1);

  return {
    excluded: reasons.length > 0,
    reasons,
    score,
    parts: {
      explicit: explicit.score,
      implicit: implicit.score,
      friction: implicit.friction,
      constraint_satisfaction: satisfaction,
      unmet_constraints: constraints
    }
  };
}

export function mutualMatch(catalogOrIndex, dealbreakers, a, b, options = {}) {
  const index = catalogOrIndex.constructs ? catalogOrIndex : indexCatalog(catalogOrIndex);
  const forward = directionalScore(index, dealbreakers, a, b, options);
  const backward = directionalScore(index, dealbreakers, b, a, options);
  const excluded = forward.excluded || backward.excluded;
  const score = excluded ? 0 : Math.sqrt(forward.score * backward.score);
  return { excluded, score, ...label(index.config.fuzzy, score), forward, backward };
}
