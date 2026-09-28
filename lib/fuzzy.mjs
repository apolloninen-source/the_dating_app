// Fuzzy-logic primitives. Matching works with degrees of membership in [0, 1] instead of crisp
// thresholds, so a rating of 7 is "fairly high" rather than either high or not, and a candidate
// just outside a limit is penalized by degree instead of falling off a cliff.

// Trapezoid membership: 0 below a, rising to 1 at b, 1 until c, falling to 0 at d.
// Shoulders: a === b gives a left shoulder, c === d a right shoulder.
export function trapezoid(x, [a, b, c, d]) {
  if (x < a || x > d) return 0;
  if (x < b) return (x - a) / (b - a);
  if (x <= c) return 1;
  return d === c ? 1 : (d - x) / (d - c);
}

// Linguistic hedges.
export const hedges = {
  very: (mu) => mu * mu,
  somewhat: (mu) => Math.sqrt(mu),
  none: (mu) => mu
};

// Probabilistic sum (algebraic OR): accumulates evidence without exceeding 1.
export const probOr = (degrees) => 1 - degrees.reduce((acc, mu) => acc * (1 - mu), 1);

// Algebraic AND over constraint degrees.
export const probAnd = (degrees) => degrees.reduce((acc, mu) => acc * mu, 1);

// Membership of a 1-10 rating in a named fuzzy set (low | medium | high).
export function ratingIn(fuzzy, set, rating) {
  return Number.isFinite(rating) ? trapezoid(rating, fuzzy.rating_sets[set]) : 0;
}

// Degree to which two ratings `d` points apart count as "close". Differences within
// rating_spread are indistinguishable (self-ratings are imprecise); at the tolerance the degree is
// 0.8, reaching 0 at the largest possible gap.
export function closeness(d, tolerance, span, spread = 0) {
  const eff = Math.max(0, d - spread);
  if (eff <= tolerance) return 1 - (0.2 * eff) / tolerance;
  if (span - spread <= tolerance) return 0.8;
  return 0.8 * Math.max(0, 1 - (eff - tolerance) / (span - spread - tolerance));
}

// Degree to which `value` satisfies "within [lo, hi]", fading linearly to 0 over `margin`.
export function within(value, lo, hi, margin) {
  return trapezoid(value, [lo - margin, lo, hi, hi + margin]);
}

// Linguistic label for a score: the set with the highest membership, plus all memberships.
export function label(fuzzy, score) {
  const memberships = Object.fromEntries(
    Object.entries(fuzzy.match_labels).map(([name, set]) => [name, trapezoid(score, set)])
  );
  const best = Object.entries(memberships).reduce((a, b) => (b[1] > a[1] ? b : a));
  return { label: best[0], memberships };
}
