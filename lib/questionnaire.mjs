// Adaptive questionnaire. 264 items is a lot, so after the fixed, blind initial 60 (matching
// starts as soon as they are done), each next question is the one expected to improve matches
// most: high research prior, many links to other items (complements, conflicts, the
// expectation-willingness pairs, gated dealbreakers), not redundant with an answered scale-group
// item, and completing a half-answered expectation pair.

const answered = (ratings, id) => Number.isFinite(ratings[id]);

function blockOrder(catalog) {
  return catalog.questionnaire.blocks
    .filter((b) => 'size' in b)
    .sort((a, b) => a.order - b.order)
    .map((b) => b.id);
}

export function questionnaireProgress(catalog, ratings = {}) {
  const blocks = {};
  for (const id of blockOrder(catalog)) {
    const items = catalog.traits.filter((t) => t.block === id);
    blocks[id] = {
      answered: items.filter((t) => answered(ratings, t.id)).length,
      total: items.length
    };
  }
  const totals = Object.values(blocks);
  return {
    blocks,
    answered: totals.reduce((s, b) => s + b.answered, 0),
    total: totals.reduce((s, b) => s + b.total, 0),
    can_match: blocks.initial.answered === blocks.initial.total
  };
}

// Expected value of asking `trait` next, given what is already answered.
export function questionValue(trait, ratings, answeredGroups) {
  const links =
    trait.seed_complements.length +
    trait.seed_conflicts.length +
    trait.fulfilled_by.length +
    trait.fulfills.length +
    (trait.constraint?.gates.length ?? 0);
  let value = trait.weights.research_prior * (1 + 0.25 * links);
  if (trait.scale_group && answeredGroups.has(trait.scale_group)) value *= 0.5;
  if ([...trait.fulfilled_by, ...trait.fulfills].some((id) => answered(ratings, id))) value *= 1.5;
  if (trait.matching_role === 'validity') value *= 0.3;
  return value;
}

export function nextQuestions(catalog, ratings = {}, n = 5) {
  // The initial block is blind and fixed: always in catalog order.
  const initial = catalog.traits.filter((t) => t.block === 'initial' && !answered(ratings, t.id));
  if (initial.length) return initial.slice(0, n).map((t) => t.id);

  const answeredGroups = new Set(
    catalog.traits.filter((t) => t.scale_group && answered(ratings, t.id)).map((t) => t.scale_group)
  );
  return catalog.traits
    .filter((t) => !answered(ratings, t.id))
    .map((t) => ({ id: t.id, value: questionValue(t, ratings, answeredGroups) }))
    .sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
    .slice(0, n)
    .map((q) => q.id);
}
