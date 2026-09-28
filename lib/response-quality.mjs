// Response-quality checks on one person's self ratings, using the catalog's fuzzy rating sets.
// Advisory only: the app can ask the person to revisit answers; matching never uses these flags.
import { hedges, ratingIn } from './fuzzy.mjs';

const STRAIGHT_LINE_MIN_ANSWERS = 20;
const STRAIGHT_LINE_MAX_SD = 0.75;
const FLAG_AT = 0.75;

export function responseQuality(catalog, ratings = {}) {
  const fuzzy = catalog.matching_config.fuzzy;
  const high = (r) => ratingIn(fuzzy, 'high', r);
  const flags = [];
  const byId = new Map(catalog.traits.map((t) => [t.id, t]));

  // "Very high" agreement with an item almost nobody can honestly endorse.
  for (const trait of catalog.traits) {
    if (trait.matching_role !== 'validity') continue;
    const degree = hedges.very(high(ratings[trait.id]));
    if (degree >= FLAG_AT) flags.push({ type: 'social_desirability', traits: [trait.id], degree });
  }

  // Both sides of a contradiction rated high: degree = min(high(a), high(b)).
  const seen = new Set();
  for (const trait of catalog.traits) {
    for (const other of trait.inconsistent_with) {
      const key = [trait.id, other].sort().join('|');
      if (seen.has(key) || !byId.has(other)) continue;
      seen.add(key);
      const degree = Math.min(high(ratings[trait.id]), high(ratings[other]));
      if (degree >= FLAG_AT)
        flags.push({ type: 'inconsistent', traits: [trait.id, other], degree });
    }
  }

  const values = Object.entries(ratings)
    .filter(([id, r]) => byId.has(id) && Number.isFinite(r))
    .map(([, r]) => r);
  if (values.length >= STRAIGHT_LINE_MIN_ANSWERS) {
    const mean = values.reduce((s, x) => s + x, 0) / values.length;
    const sd = Math.sqrt(values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length);
    if (sd < STRAIGHT_LINE_MAX_SD) flags.push({ type: 'straight_lining', sd });
  }

  return { ok: flags.length === 0, flags };
}
