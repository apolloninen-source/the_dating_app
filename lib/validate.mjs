// Semantic validation for the trait catalog, dealbreaker questions and profiles. Each function
// returns a list of error strings; an empty list means valid.
import { ageOn } from './match.mjs';

const SPECIAL_CATEGORIES = new Set(['religion', 'sex_life', 'political', 'ethnic', 'health']);
const PARTNER_EFFECTS = new Set(['higher_better', 'lower_better']);
const FLIP = { higher_better: 'lower_better', lower_better: 'higher_better' };
const UNKNOWN = 'prefer_not_to_say';

const isPositive = (x) => typeof x === 'number' && Number.isFinite(x) && x > 0;

export function validateCatalog(catalog, dealbreakers) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  const { min, max } = catalog.rating_scale;
  const [divLo, divHi] = catalog.matching_config.allowed_divergence_range;
  if (!(min < max)) err('rating_scale.min must be below max');
  if (divLo < 1 || divHi > max - min) {
    err(`allowed_divergence_range must lie within 1..${max - min} for a ${min}-${max} scale`);
  }

  if (catalog.objective?.optimize_for !== 'lasting_relationships') {
    err('objective.optimize_for must be lasting_relationships');
  }
  const fuzzy = catalog.matching_config.fuzzy;
  const ordered = ([a, b, c, d]) => a <= b && b <= c && c <= d;
  for (const [name, set] of Object.entries(fuzzy.rating_sets)) {
    if (!ordered(set) || set[0] < min || set[3] > max) err(`fuzzy.rating_sets.${name} invalid`);
  }
  for (const [name, set] of Object.entries(fuzzy.match_labels)) {
    if (!ordered(set) || set[0] < 0 || set[3] > 1) err(`fuzzy.match_labels.${name} invalid`);
  }
  for (let i = 0; i <= 100; i += 1) {
    const x = i / 100;
    const covered = Object.values(fuzzy.match_labels).some(([a, , , d]) => a <= x && x <= d);
    if (!covered) {
      err(`fuzzy.match_labels leave ${x.toFixed(2)} uncovered`);
      break;
    }
  }
  if (!(fuzzy.exclusion_alpha_cut > 0 && fuzzy.exclusion_alpha_cut < 1)) {
    err('fuzzy.exclusion_alpha_cut must be in (0, 1)');
  }
  for (const [name, mode] of Object.entries(catalog.matching_config.modes)) {
    if (!['very', 'somewhat', 'none'].includes(mode.conflict_hedge)) {
      err(`modes.${name}.conflict_hedge must be very | somewhat | none`);
    }
  }

  const ranking = catalog.ranking ?? {};
  if (!(ranking.min_label in fuzzy.match_labels)) err('ranking.min_label must be a match label');
  if (!(ranking.label_alpha > 0 && ranking.label_alpha <= 1)) {
    err('ranking.label_alpha must be in (0, 1]');
  }
  if (ranking.best_first !== true) err('ranking.best_first must be true');
  for (const key of ['daily_candidates', 'max_active_conversations']) {
    if (!Number.isInteger(ranking[key]) || ranking[key] < 1) err(`ranking.${key} must be >= 1`);
  }

  const domains = new Map(catalog.domains.map((d) => [d.id, d]));
  if (domains.size !== catalog.domains.length) err('duplicate domain ids');
  if (JSON.stringify(catalog.domains_internal) !== JSON.stringify([...domains.keys()])) {
    err('domains_internal must list exactly the ids in domains, in order');
  }

  const blocks = new Set(catalog.questionnaire.blocks.filter((b) => 'size' in b).map((b) => b.id));
  const valences = new Set(Object.keys(catalog.valence_definitions));
  const roles = new Set(Object.keys(catalog.matching_role_definitions));
  const groups = new Map(catalog.scale_groups.map((g) => [g.id, g]));
  const questions = dealbreakers ? new Set(dealbreakers.questions.map((q) => q.id)) : null;

  const byId = new Map();
  for (const t of catalog.traits) {
    if (byId.has(t.id)) err(`duplicate trait id ${t.id}`);
    byId.set(t.id, t);
  }

  for (const t of catalog.traits) {
    const at = `trait ${t.id}`;
    if (typeof t.definition !== 'string' || t.definition.length < 10) err(`${at}: definition`);
    if (t.i18n_key !== `trait.${t.id}`) err(`${at}: i18n_key must be trait.${t.id}`);
    if (!domains.has(t.domain_internal)) err(`${at}: undeclared domain ${t.domain_internal}`);
    if (!blocks.has(t.block)) err(`${at}: undeclared block ${t.block}`);
    if (!valences.has(t.valence)) err(`${at}: undefined valence ${t.valence}`);
    if (!roles.has(t.matching_role)) err(`${at}: undefined matching_role ${t.matching_role}`);
    if (t.keying !== 'forward' && t.keying !== 'reverse') err(`${at}: keying`);
    if (t.keying === 'reverse' && !t.scale_group) err(`${at}: reverse keying needs a scale_group`);
    if (t.partner_effect !== null && !PARTNER_EFFECTS.has(t.partner_effect)) {
      err(`${at}: partner_effect ${t.partner_effect}`);
    }
    if (t.special_category !== null && !SPECIAL_CATEGORIES.has(t.special_category)) {
      err(`${at}: special_category ${t.special_category}`);
    }
    for (const key of ['research_prior', 'similarity_weight', 'complementarity_weight']) {
      if (!isPositive(t.weights?.[key])) err(`${at}: weights.${key} must be a positive number`);
    }
    const { default_tolerance: tol, suggested_range: range } = t.divergence;
    if (!(range[0] <= tol && tol <= range[1]))
      err(`${at}: default_tolerance outside suggested_range`);
    if (range[0] < divLo || range[1] > divHi) err(`${at}: suggested_range outside allowed range`);

    for (const field of ['seed_complements', 'seed_conflicts', 'inconsistent_with']) {
      for (const other of t[field]) {
        const o = byId.get(other);
        if (!o) {
          err(`${at}: ${field} references unknown ${other}`);
          continue;
        }
        if (!o[field].includes(t.id)) err(`${at}: ${field} -> ${other} is not symmetric`);
      }
    }
    if (t.seed_complements.includes(t.id)) err(`${at}: cannot complement itself`);
    if (t.inconsistent_with.includes(t.id)) err(`${at}: cannot be inconsistent with itself`);
    for (const other of t.seed_complements) {
      if (t.seed_conflicts.includes(other)) err(`${at}: ${other} is both complement and conflict`);
    }

    if (t.matching_role === 'validity') {
      if (t.domain_internal !== 'response_validity')
        err(`${at}: validity items belong in response_validity`);
      if (t.seed_complements.length || t.seed_conflicts.length || t.scale_group) {
        err(`${at}: validity items take no links or scale group`);
      }
    }
    if ((t.matching_role === 'gate') !== Boolean(t.constraint)) {
      err(`${at}: constraint is required exactly for gate items`);
    }
    if (t.constraint) {
      for (const d of t.constraint.amplifies_domains) {
        if (!domains.has(d)) err(`${at}: amplifies undeclared domain ${d}`);
      }
      if (questions) {
        for (const q of t.constraint.gates) {
          if (!questions.has(q)) err(`${at}: gates unknown dealbreaker ${q}`);
        }
      }
    }
    if (t.scale_group) {
      const g = groups.get(t.scale_group);
      if (!g) err(`${at}: unknown scale_group ${t.scale_group}`);
      else if (!g.members.includes(t.id)) err(`${at}: not listed in ${t.scale_group}.members`);
      if (t.matching_role !== 'score') err(`${at}: only scored items can be grouped`);
    }
  }

  for (const g of catalog.scale_groups) {
    const members = g.members.map((id) => byId.get(id));
    if (members.length < 2) err(`scale group ${g.id}: needs at least 2 members`);
    if (members.some((m) => !m)) {
      err(`scale group ${g.id}: unknown member`);
      continue;
    }
    if (!members.some((m) => m.keying === 'forward')) err(`scale group ${g.id}: no forward member`);
    for (const m of members) {
      if (m.scale_group !== g.id) err(`scale group ${g.id}: ${m.id} points to ${m.scale_group}`);
      const expected =
        g.partner_effect && (m.keying === 'forward' ? g.partner_effect : FLIP[g.partner_effect]);
      if ((m.partner_effect ?? null) !== (expected || null)) {
        err(`scale group ${g.id}: ${m.id} partner_effect disagrees with the group`);
      }
    }
    if (new Set(members.map((m) => m.special_category)).size > 1) {
      err(`scale group ${g.id}: members differ in special_category`);
    }
  }

  const counts = { total: catalog.traits.length };
  for (const block of blocks)
    counts[block] = catalog.traits.filter((t) => t.block === block).length;
  if (JSON.stringify(counts) !== JSON.stringify(catalog.counts)) {
    err(`counts ${JSON.stringify(catalog.counts)} do not match actual ${JSON.stringify(counts)}`);
  }
  if (catalog.questionnaire.initial_block_size !== counts.initial) {
    err('questionnaire.initial_block_size does not match the initial block');
  }
  for (const b of catalog.questionnaire.blocks) {
    if ('size' in b && b.size !== counts[b.id])
      err(`block ${b.id}: size ${b.size} != ${counts[b.id]}`);
  }

  // The blind first block must be personality-only and balanced across its domains.
  const initialByDomain = new Map();
  for (const t of catalog.traits.filter((x) => x.block === 'initial')) {
    if (domains.get(t.domain_internal)?.kind !== 'personality') {
      err(`initial block item ${t.id} is not a personality item`);
    }
    initialByDomain.set(t.domain_internal, (initialByDomain.get(t.domain_internal) ?? 0) + 1);
  }
  const perDomain = [...initialByDomain.values()];
  if (perDomain.length && Math.max(...perDomain) - Math.min(...perDomain) > 1) {
    err(
      `initial block is unbalanced across domains: ${JSON.stringify(Object.fromEntries(initialByDomain))}`
    );
  }
  const initialGroups = catalog.traits
    .filter((t) => t.block === 'initial' && t.scale_group && t.keying === 'forward')
    .map((t) => t.scale_group);
  const dupGroups = initialGroups.filter((g, i) => initialGroups.indexOf(g) !== i);
  if (dupGroups.length) err(`initial block asks the same construct twice: ${dupGroups.join(', ')}`);

  return errors;
}

export function validateDealbreakers(dealbreakers) {
  const errors = [];
  const types = new Set(Object.keys(dealbreakers.question_types));
  const visibilities = new Set(Object.keys(dealbreakers.visibility_levels));
  const seen = new Set();
  for (const q of dealbreakers.questions) {
    const at = `dealbreaker ${q.id}`;
    if (seen.has(q.id)) errors.push(`duplicate dealbreaker id ${q.id}`);
    seen.add(q.id);
    if (q.i18n_key !== `dealbreaker.${q.id}`) errors.push(`${at}: i18n_key`);
    if (!types.has(q.type)) errors.push(`${at}: unknown type ${q.type}`);
    if (!visibilities.has(q.visibility_default)) errors.push(`${at}: visibility_default`);
    if (q.special_category !== null && !SPECIAL_CATEGORIES.has(q.special_category)) {
      errors.push(`${at}: special_category ${q.special_category}`);
    }
    const ids = q.options.map((o) => o.id);
    const choice = q.type === 'single_choice' || q.type === 'multi_choice';
    if (choice && ids.length < 2) errors.push(`${at}: choice questions need at least 2 options`);
    if (!choice && ids.length) errors.push(`${at}: ${q.type} questions take no options`);
    if (new Set(ids).size !== ids.length) errors.push(`${at}: duplicate option ids`);
    if (ids.includes(UNKNOWN))
      errors.push(`${at}: use allow_prefer_not_to_say instead of an option`);
    for (const o of q.options) {
      if (typeof o.label !== 'string' || !o.label)
        errors.push(`${at}: option ${o.id} has no label`);
    }
  }
  return errors;
}

function consentActive(profile, category) {
  const c = profile.consents?.[category];
  return Boolean(c && c.granted_at && !c.withdrawn_at);
}

export function validateProfile(
  profile,
  catalog,
  dealbreakers,
  { regionPolicy, now = new Date() } = {}
) {
  const errors = [];
  const err = (msg) => errors.push(msg);
  const { min, max } = catalog.rating_scale;
  const cfg = catalog.matching_config;
  const byId = new Map(catalog.traits.map((t) => [t.id, t]));
  const questions = new Map(dealbreakers.questions.map((q) => [q.id, q]));
  const region = {
    ...(regionPolicy?.default ?? { min_age: 18, disabled_questions: [] }),
    ...(regionPolicy?.regions?.[profile.location?.country] ?? {})
  };
  const needsConsent = new Set();

  const minAge = Math.max(18, region.min_age ?? 18);
  if (ageOn(profile.birth_date, now) < minAge) err(`must be at least ${minAge}`);
  if (profile.seeking.age_min > profile.seeking.age_max) err('seeking.age_min above age_max');
  if (profile.seeking.age_min < minAge) err(`seeking.age_min below ${minAge}`);
  if (!profile.languages?.length) err('at least one language is required');
  if (profile.sexual_orientation && profile.sexual_orientation !== UNKNOWN)
    needsConsent.add('sex_life');

  for (const [id, r] of Object.entries(profile.ratings ?? {})) {
    const t = byId.get(id);
    if (!t) {
      err(`rating for unknown trait ${id}`);
      continue;
    }
    if (!Number.isInteger(r) || r < min || r > max)
      err(`rating ${id} must be an integer ${min}-${max}`);
    if (t.special_category) needsConsent.add(t.special_category);
  }

  const prefs = Object.entries(profile.preferences ?? {});
  if (prefs.length > catalog.questionnaire.mate_preference_max_items) {
    err(`at most ${catalog.questionnaire.mate_preference_max_items} mate preferences`);
  }
  const mandatory = prefs.filter(([, p]) => p.mandatory).length;
  if (mandatory > cfg.max_mandatory) err(`at most ${cfg.max_mandatory} mandatory preferences`);
  const [divLo, divHi] = cfg.allowed_divergence_range;
  for (const [id, p] of prefs) {
    const t = byId.get(id);
    if (!t) err(`preference for unknown trait ${id}`);
    else if (t.matching_role !== 'score')
      err(`preference ${id}: ${t.matching_role} items cannot be preferences`);
    if (!catalog.questionnaire.mate_preference_importance_levels.includes(p.importance)) {
      err(`preference ${id}: importance`);
    }
    if (p.desired !== undefined && (p.desired < min || p.desired > max))
      err(`preference ${id}: desired`);
    if (p.tolerance !== undefined && (p.tolerance < divLo || p.tolerance > divHi)) {
      err(`preference ${id}: tolerance must be within ${divLo}-${divHi}`);
    }
  }

  for (const [qid, answer] of Object.entries(profile.dealbreakers ?? {})) {
    const q = questions.get(qid);
    if (!q) {
      err(`answer for unknown dealbreaker ${qid}`);
      continue;
    }
    if ((region.disabled_questions ?? []).includes(qid))
      err(`dealbreaker ${qid} is disabled in this region`);
    const valid = new Set(q.options.map((o) => o.id));
    if (q.allow_prefer_not_to_say) valid.add(UNKNOWN);
    if (answer.self !== undefined) {
      if (q.type === 'single_choice' && typeof answer.self !== 'string') {
        err(`dealbreaker ${qid}: single_choice takes one answer`);
      }
      const selves = [answer.self].flat();
      for (const s of selves) if (!valid.has(s)) err(`dealbreaker ${qid}: invalid option ${s}`);
      if (q.special_category && selves.some((s) => s !== UNKNOWN))
        needsConsent.add(q.special_category);
    }
    for (const a of answer.accept ?? []) {
      if (!valid.has(a) || a === UNKNOWN) err(`dealbreaker ${qid}: invalid accept option ${a}`);
    }
  }

  for (const category of needsConsent) {
    if (!consentActive(profile, category))
      err(`special-category data (${category}) without consent`);
  }
  return errors;
}
