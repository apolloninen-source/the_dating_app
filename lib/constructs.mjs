// Shared catalog helpers. A "construct" is what matching compares: a scale group (its members
// averaged, reverse-keyed members flipped) or a single ungrouped trait.

const mean = (xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length;

export function indexCatalog(catalog) {
  const byId = new Map(catalog.traits.map((t) => [t.id, t]));
  const constructs = new Map();

  for (const group of catalog.scale_groups) {
    const members = group.members.map((id) => byId.get(id));
    constructs.set(group.id, {
      id: group.id,
      members,
      domain: members[0].domain_internal,
      partner_effect: group.partner_effect,
      tolerance: Math.round(mean(members.map((t) => t.divergence.default_tolerance))),
      research_prior: mean(members.map((t) => t.weights.research_prior)),
      similarity_weight: mean(members.map((t) => t.weights.similarity_weight))
    });
  }
  for (const t of catalog.traits) {
    if (t.scale_group || t.matching_role !== 'score') continue;
    constructs.set(t.id, {
      id: t.id,
      members: [t],
      domain: t.domain_internal,
      partner_effect: t.partner_effect,
      tolerance: t.divergence.default_tolerance,
      research_prior: t.weights.research_prior,
      similarity_weight: t.weights.similarity_weight
    });
  }

  return {
    catalog,
    byId,
    constructs,
    config: catalog.matching_config,
    scale: catalog.rating_scale,
    constructOf: (traitId) => byId.get(traitId)?.scale_group ?? traitId
  };
}

// Rating on the construct's forward direction.
export function keyed(index, trait, rating) {
  const { min, max } = index.scale;
  return trait.keying === 'reverse' ? min + max - rating : rating;
}

export function constructScores(index, ratings = {}) {
  const scores = new Map();
  for (const construct of index.constructs.values()) {
    const answered = construct.members
      .filter((t) => Number.isFinite(ratings[t.id]))
      .map((t) => keyed(index, t, ratings[t.id]));
    if (answered.length > 0) scores.set(construct.id, mean(answered));
  }
  return scores;
}
