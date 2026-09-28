// De-identified outcome records for improving the matcher. The only data kept "for updating the
// trait match": when both people in a couple opted in, their questionnaire answers and the
// relationship outcome, with no account ids, names, age, location, photos, texts or messages.
// Special-category answers and legally risky questions are always left out.
import { randomUUID } from 'node:crypto';

function answers(catalog, dealbreakers, profile) {
  const scored = new Set(
    catalog.traits
      .filter((t) => t.matching_role === 'score' && t.special_category === null)
      .map((t) => t.id)
  );
  const ratings = Object.fromEntries(
    Object.entries(profile.ratings ?? {}).filter(([id]) => scored.has(id))
  );
  const allowed = new Set(
    dealbreakers.questions
      .filter((q) => q.special_category === null && !q.legal_risk && q.options.length > 0)
      .map((q) => q.id)
  );
  const choices = Object.fromEntries(
    Object.entries(profile.dealbreakers ?? {})
      .filter(([id, a]) => allowed.has(id) && a.self !== undefined)
      .map(([id, a]) => [id, a.self])
  );
  return { ratings, choices, mode: profile.mode ?? 'safe' };
}

// Returns a record to store, or null when either person has not opted in.
export function calibrationRecord(catalog, dealbreakers, a, b, outcome, now = new Date()) {
  if (!a.calibration_opt_in || !b.calibration_opt_in) return null;
  if (!catalog.objective.outcome_signals.includes(outcome)) {
    throw new Error(`unknown outcome ${outcome}`);
  }
  const people = [answers(catalog, dealbreakers, a), answers(catalog, dealbreakers, b)];
  // Random order, so the record doesn't reveal who initiated.
  if (Math.random() < 0.5) people.reverse();
  return {
    record_id: randomUUID(),
    recorded_month: now.toISOString().slice(0, 7),
    catalog_version: catalog.version,
    outcome,
    people
  };
}
