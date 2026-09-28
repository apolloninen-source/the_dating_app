// De-identified outcome records for improving the matcher. The only data kept "for updating the
// trait match": when both people in a couple opted in, their questionnaire answers and the
// relationship outcome, with no account ids, names, age, location, photos, texts or messages.
// Special-category answers and legally risky questions are always left out.
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const month = (now) => now.toISOString().slice(0, 7);

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

function knownOutcome(catalog, outcome) {
  const known = [
    ...catalog.objective.outcome_signals,
    ...catalog.objective.negative_outcome_signals
  ];
  if (!known.includes(outcome)) throw new Error(`unknown outcome ${outcome}`);
}

// Returns a record to store, or null when either person has not opted in.
export function calibrationRecord(catalog, dealbreakers, a, b, outcome, now = new Date()) {
  if (!a.calibration_opt_in || !b.calibration_opt_in) return null;
  knownOutcome(catalog, outcome);
  const people = [answers(catalog, dealbreakers, a), answers(catalog, dealbreakers, b)];
  // Random order, so the record doesn't reveal who initiated.
  if (Math.random() < 0.5) people.reverse();
  return {
    record_id: randomUUID(),
    recorded_month: month(now),
    catalog_version: catalog.version,
    outcome,
    people
  };
}

// When a couple leaves together. Their accounts are deleted, so the later outcomes (still together
// at 3 and 12 months) can only arrive through an anonymous check-in link: the couple keeps the
// token, the record keeps only its hash. Returns null unless both opted in.
export function departureRecord(catalog, dealbreakers, a, b, now = new Date()) {
  const record = calibrationRecord(catalog, dealbreakers, a, b, 'both_left_app_together', now);
  if (!record) return null;
  const token = randomBytes(24).toString('base64url');
  const { outcome, ...rest } = record;
  return {
    token,
    record: {
      ...rest,
      outcomes: [{ outcome, month: record.recorded_month }],
      checkin_token_hash: sha256(token)
    }
  };
}

// A later check-in through the anonymous link. Each outcome is recorded once.
export function applyCheckin(catalog, record, token, outcome, now = new Date()) {
  if (sha256(token) !== record.checkin_token_hash) throw new Error('invalid check-in link');
  knownOutcome(catalog, outcome);
  if (record.outcomes.some((o) => o.outcome === outcome)) return record;
  return { ...record, outcomes: [...record.outcomes, { outcome, month: month(now) }] };
}
