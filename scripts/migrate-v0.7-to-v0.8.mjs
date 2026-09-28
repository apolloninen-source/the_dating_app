#!/usr/bin/env node
// One-shot migration of the v0.7 trait catalog to v0.8, kept for provenance: every change
// listed in CHANGELOG.md is applied here. Re-running it (then `prettier --write`) reproduces
// data/traits.v0.8.json from source/core_traits_v0.7.json.
//
//   node scripts/migrate-v0.7-to-v0.8.mjs [input] [output]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2] ?? join(root, 'source/core_traits_v0.7.json');
const output = process.argv[3] ?? join(root, 'data/traits.v0.8.json');

// ---------------------------------------------------------------------------------------------
// Domains: v0.7 declared 11 but traits used 22. All are declared now, plus 6 new ones.
// kind: personality | relationship | lifestyle | values | constraint | validity
// special_category: GDPR Art. 9-style data class; answering needs explicit consent.
const DOMAINS = [
  ['emotional_regulation', 'Emotional regulation', 'personality'],
  ['structure_reliability', 'Structure & reliability', 'personality'],
  ['social_energy', 'Social energy', 'personality'],
  ['openness_curiosity', 'Openness & curiosity', 'personality'],
  ['warmth_empathy', 'Warmth & empathy', 'personality'],
  ['assertiveness_boundaries', 'Assertiveness & boundaries', 'personality'],
  ['values_integrity', 'Values & integrity', 'personality'],
  ['playfulness_lightness', 'Playfulness & lightness', 'personality'],
  ['conflict_communication', 'Conflict & communication', 'personality'],
  ['independence_interdependence', 'Independence & interdependence', 'personality'],
  ['existentialism', 'Existential orientation', 'personality'],
  ['attachment_security', 'Attachment & security', 'personality'],
  ['relationship_objective', 'Relationship goals', 'relationship'],
  ['family_children', 'Family & children', 'relationship'],
  ['sexual_romantic_compatibility', 'Sexual & romantic compatibility', 'relationship', 'sex_life'],
  ['love_languages', 'Love languages', 'relationship'],
  ['attraction', 'Attraction', 'relationship'],
  ['relationship_scenarios', 'Relationship scenarios', 'relationship'],
  ['social_expectations', 'Social expectations of a partner', 'relationship'],
  ['lifestyle', 'Lifestyle', 'lifestyle'],
  ['habits_health', 'Habits & home', 'lifestyle'],
  ['financial_life', 'Financial life', 'lifestyle'],
  ['geography_mobility', 'Geography & mobility', 'lifestyle'],
  ['social_family_ecosystem', 'Social & family ecosystem', 'lifestyle'],
  ['worldview_religion', 'Worldview & religion', 'values', 'religion'],
  ['social_political_values', 'Social & political values', 'values'],
  ['culture_language', 'Culture & language', 'values'],
  ['hard_constraints', 'Dealbreaker strictness', 'constraint'],
  ['response_validity', 'Response validity', 'validity']
].map(([id, label, kind, special]) => ({
  id,
  label,
  kind,
  i18n_key: `domain.${id}`,
  ...(special ? { special_category: special } : {})
}));

// Traits whose special-category class differs from (or is absent on) their domain.
const SPECIAL_CATEGORY_OVERRIDES = {
  spiritually_oriented: 'religion',
  secular_practical: 'religion',
  meaning_seeking: null,
  politically_engaged: 'political',
  traditional_values: 'political',
  progressive_values: 'political',
  shared_politics_important: 'political',
  cultural_heritage_important: 'ethnic',
  religion_non_negotiable: 'religion',
  monogamy_non_negotiable: 'sex_life',
  sexual_compatibility_non_negotiable: 'sex_life',
  open_relationship_receptive: 'sex_life',
  exclusivity_important: 'sex_life',
  // Affection and romance are not sex-life data.
  physical_affection_high: null,
  romance_high: null
};

// ---------------------------------------------------------------------------------------------
// Initial block de-duplication. The first 60 asked the same thing twice in several domains
// (needs_solitude/recharges_alone, playful/teases, humorous/laughs_easily,
// reliable_follow_through/keeps_promises, intellectually_curious/loves_learning). Each pair
// swaps with a refining item from the same domain, so the 60 stay balanced across domains.
const INITIAL_SWAPS = [
  ['recharges_alone', 'initiates_plans'],
  ['laughs_easily', 'brings_levity'],
  ['teases_affectionately', 'dry_humor'],
  ['keeps_promises', 'transparent'],
  ['loves_learning', 'open_to_feedback'],
  ['enjoys_solo_time', 'maintains_separate_worlds']
];

// ---------------------------------------------------------------------------------------------
// Wording changes (global audience / clarity).
const DEFINITION_UPDATES = {
  relationship_intent_marriage:
    'Marriage, or an equivalent lifelong commitment, is an important possible endpoint for my relationship.',
  highly_reactive:
    'I feel emotions strongly and quickly; small events can produce large emotional responses.',
  geographic_rootedness: 'I have strong reasons to remain in my current city, region, or country.',
  international_life_open:
    'I am open to building my life in another country than the one I live in now.'
};

// v0.7 marked one side of many preference pairs "positive" and the other "neutral"
// (wants_children vs does_not_want_children, exclusivity vs non-monogamy, ...). Preferences are
// not virtues: every item in these domains is neutral unless it describes a prosocial behaviour.
const NEUTRAL_PREFERENCE_DOMAINS = new Set([
  'relationship_objective',
  'family_children',
  'sexual_romantic_compatibility',
  'lifestyle',
  'financial_life',
  'geography_mobility',
  'social_family_ecosystem',
  'attraction',
  'worldview_religion'
]);
const PROSOCIAL_EXCEPTIONS = new Set(['sexual_openness', 'worldview_tolerance']);

// v0.7 used "context_sensitive" once, never defined; "mixed" is the defined equivalent.
const VALENCE_RENAMES = { context_sensitive: 'mixed' };

// ---------------------------------------------------------------------------------------------
// Research priors / tolerances for the 73 expanded items (all were 1.0 / 4 placeholders).
// [research_prior, default_tolerance]; suggested_range is derived as tolerance ± 2 within 1..9.
const EXPANDED_PARAMS = {
  relationship_intent_long_term: [1.4, 2],
  relationship_intent_marriage: [1.2, 3],
  relationship_intent_casual: [1.3, 2],
  exclusivity_important: [1.4, 2],
  open_relationship_receptive: [1.4, 2],
  slow_relationship_pace: [1.0, 4],
  fast_relationship_pace: [1.0, 4],
  wants_children: [1.5, 2],
  does_not_want_children: [1.5, 2],
  open_to_adoption: [0.9, 4],
  open_to_partner_children: [1.2, 3],
  large_family: [1.0, 4],
  parenthood_high_priority: [1.3, 3],
  extended_family_involved: [1.0, 4],
  sex_high_importance: [1.2, 3],
  physical_affection_high: [1.2, 3],
  romance_high: [1.0, 4],
  high_sexual_frequency: [1.3, 3],
  sexual_openness: [1.2, 3],
  monogamy_sexual_expectation: [1.4, 2],
  sexual_chemistry_essential: [1.1, 4],
  early_riser: [0.9, 4],
  night_owl: [0.9, 4],
  homebody: [1.0, 4],
  social_lifestyle: [1.0, 4],
  travel_oriented: [0.9, 4],
  rooted_lifestyle: [1.0, 4],
  urban_lifestyle: [1.0, 4],
  rural_lifestyle: [1.0, 4],
  spontaneous_lifestyle: [0.9, 4],
  structured_lifestyle: [0.9, 4],
  active_lifestyle: [1.0, 4],
  financial_security_priority: [1.1, 4],
  saver: [1.2, 3],
  spender: [1.2, 3],
  career_priority: [1.0, 4],
  work_life_balance: [1.0, 4],
  financial_independence: [1.1, 4],
  shared_finances: [1.1, 4],
  financial_risk_tolerance: [1.0, 4],
  religious_practice_important: [1.4, 2],
  shared_worldview_important: [1.3, 3],
  shared_religious_practice: [1.3, 2],
  metaphysical_openness: [0.9, 5],
  worldview_tolerance: [1.1, 4],
  willing_to_relocate: [1.1, 4],
  geographic_rootedness: [1.1, 4],
  long_distance_tolerant: [1.0, 4],
  international_life_open: [1.0, 4],
  family_proximity_important: [1.0, 4],
  friendship_central: [0.9, 5],
  partner_social_integration: [0.9, 5],
  private_couple: [0.9, 5],
  host_frequently: [0.8, 5],
  family_obligations_high: [1.1, 4],
  physical_attraction_essential: [1.1, 4],
  intellectual_attraction: [1.0, 4],
  emotional_attraction: [1.1, 4],
  voice_mannerisms_attraction: [0.8, 5],
  children_non_negotiable: [1.0, 4],
  monogamy_non_negotiable: [1.0, 4],
  religion_non_negotiable: [1.0, 4],
  location_non_negotiable: [1.0, 4],
  lifestyle_non_negotiable: [1.0, 4],
  sexual_compatibility_non_negotiable: [1.0, 4],
  shared_household_fairness: [1.2, 3],
  caregiving_reciprocity: [1.2, 3],
  career_tradeoffs: [1.0, 4],
  financial_crisis_teamwork: [1.1, 3],
  partner_change_tolerance: [1.1, 4],
  aging_family_support: [1.0, 4],
  sacrifice_for_relationship: [1.0, 4],
  repair_after_conflict: [1.3, 3]
};

// ---------------------------------------------------------------------------------------------
// Hard constraints. v0.7 scored "X is non-negotiable" on a 1-10 scale with tolerance 4, which
// says how strict but never which answer is required. Now: the rating sets the strictness of the
// linked categorical dealbreaker filters (dealbreakers.v0.8.json) and amplifies the weight of
// the related domains. matching_role "gate" = never scored for similarity.
const CONSTRAINT_GATES = {
  children_non_negotiable: {
    gates: ['children_want', 'children_have'],
    amplifies_domains: ['family_children']
  },
  monogamy_non_negotiable: {
    gates: ['relationship_structure'],
    amplifies_domains: ['relationship_objective']
  },
  religion_non_negotiable: {
    gates: ['religion', 'religious_practice_level'],
    amplifies_domains: ['worldview_religion']
  },
  location_non_negotiable: { gates: ['location'], amplifies_domains: ['geography_mobility'] },
  lifestyle_non_negotiable: {
    gates: ['smoking', 'alcohol', 'cannabis', 'recreational_drugs', 'diet', 'pets_have'],
    amplifies_domains: ['lifestyle', 'habits_health']
  },
  sexual_compatibility_non_negotiable: {
    gates: [],
    amplifies_domains: ['sexual_romantic_compatibility']
  }
};

// ---------------------------------------------------------------------------------------------
// New traits. [id, definition, domain, block, valence, research_prior, tolerance, extra]
const NEW_TRAITS = [
  // Attachment (v0.7 measured avoidance only)
  [
    'needs_reassurance',
    'In close relationships I often need reassurance that my partner still cares about me.',
    'attachment_security',
    'refining',
    'mixed',
    1.3,
    3
  ],
  [
    'fears_abandonment',
    'I sometimes worry that people I love will lose interest in me or leave.',
    'attachment_security',
    'refining',
    'mixed',
    1.3,
    3
  ],
  [
    'secure_in_partner',
    'When a partner is busy or away, I can usually trust that our relationship is still fine.',
    'attachment_security',
    'refining',
    'positive',
    1.3,
    3
  ],
  [
    'jealous_possessive',
    'I feel jealous or uneasy when my partner spends close time with people I do not know well.',
    'attachment_security',
    'refining',
    'challenging',
    1.4,
    3
  ],
  [
    'comfortable_depending',
    'I find it easy to depend on a partner and to let a partner depend on me.',
    'attachment_security',
    'refining',
    'positive',
    1.2,
    3
  ],
  // Gottman: criticism and contempt (defensiveness and stonewalling were already covered)
  [
    'critical_of_partner',
    'When something bothers me, I tend to point out what is wrong with the other person rather than the situation.',
    'conflict_communication',
    'refining',
    'challenging',
    1.4,
    3
  ],
  [
    'sarcastic_when_upset',
    'When I am frustrated I can become sarcastic, dismissive, or mocking.',
    'conflict_communication',
    'refining',
    'challenging',
    1.5,
    3
  ],
  [
    'compromise_oriented',
    'In disagreements I look for a middle ground that works for both of us.',
    'conflict_communication',
    'refining',
    'positive',
    1.3,
    3
  ],
  [
    'stubborn',
    'Once I have taken a position it is hard for me to change it, even when given good reasons.',
    'conflict_communication',
    'refining',
    'challenging',
    1.1,
    3
  ],
  [
    'holds_grudges',
    'When someone hurts me, I find it hard to let it go, even after they apologize.',
    'conflict_communication',
    'refining',
    'challenging',
    1.2,
    3
  ],
  // Warmth / generosity / expressiveness
  [
    'expresses_appreciation',
    'I regularly tell the people close to me what I appreciate about them.',
    'warmth_empathy',
    'refining',
    'positive',
    1.3,
    3
  ],
  [
    'generous',
    'I readily share my time, money, and attention with people I care about.',
    'warmth_empathy',
    'refining',
    'positive',
    1.2,
    3
  ],
  [
    'thoughtful_gestures',
    'I notice and remember small things that matter to others and act on them.',
    'warmth_empathy',
    'refining',
    'positive',
    1.2,
    3
  ],
  [
    'shows_vulnerability',
    'I am willing to show my fears and weaknesses to a partner.',
    'warmth_empathy',
    'refining',
    'positive',
    1.2,
    3
  ],
  [
    'keeps_things_to_self',
    'I usually keep worries or problems to myself rather than sharing them.',
    'warmth_empathy',
    'refining',
    'mixed',
    1.1,
    3
  ],
  // Humility / status
  [
    'humble',
    'I do not see myself as more important or more deserving than other people.',
    'values_integrity',
    'refining',
    'positive',
    1.1,
    4
  ],
  [
    'enjoys_status',
    'Being admired, or having status and impressive things, matters a lot to me.',
    'values_integrity',
    'refining',
    'mixed',
    1.0,
    4
  ],
  [
    'bends_truth_for_harmony',
    'I sometimes tell small untruths to avoid hurting feelings or awkward moments.',
    'values_integrity',
    'refining',
    'mixed',
    1.2,
    3
  ],
  // Self-esteem / anxiety
  [
    'self_confident',
    'I generally feel confident and comfortable with who I am.',
    'emotional_regulation',
    'refining',
    'positive',
    1.0,
    4
  ],
  [
    'self_conscious',
    'I am often self-conscious about how other people see me.',
    'emotional_regulation',
    'refining',
    'mixed',
    1.0,
    4
  ],
  [
    'anxious_worrier',
    'I worry a lot about things that could go wrong.',
    'emotional_regulation',
    'refining',
    'mixed',
    1.2,
    4
  ],
  [
    'hard_to_calm_down',
    'Once I am upset, it takes me a long time to calm down.',
    'emotional_regulation',
    'refining',
    'challenging',
    1.2,
    3
  ],
  // Self-control / everyday reliability
  [
    'impulsive',
    'I often act on impulses, such as buying things or making decisions, without thinking them through.',
    'structure_reliability',
    'refining',
    'mixed',
    1.1,
    4
  ],
  [
    'decisive',
    'I make decisions fairly quickly and stick with them.',
    'structure_reliability',
    'refining',
    'positive',
    0.9,
    4
  ],
  [
    'punctual',
    'Being on time matters to me, and I expect the same from others.',
    'structure_reliability',
    'refining',
    'neutral',
    0.9,
    4
  ],
  [
    'promises_slip',
    'I sometimes agree to do things and then do not get around to doing them.',
    'structure_reliability',
    'refining',
    'challenging',
    1.3,
    3
  ],
  [
    'competitive',
    'I am strongly competitive, even in casual games or everyday situations.',
    'assertiveness_boundaries',
    'refining',
    'neutral',
    0.9,
    5
  ],
  // Openness
  [
    'creative',
    'I regularly make or express things creatively, for example art, music, writing, cooking, or design.',
    'openness_curiosity',
    'refining',
    'positive',
    0.9,
    5
  ],
  [
    'unconventional',
    'I am comfortable living differently from the social norms and expectations around me.',
    'openness_curiosity',
    'refining',
    'neutral',
    1.0,
    4
  ],
  // Social-desirability checks (never scored; used only by response-quality checks)
  [
    'validity_never_irritated',
    'I have never felt irritated with someone close to me.',
    'response_validity',
    'refining',
    'neutral',
    1.0,
    4,
    { matching_role: 'validity' }
  ],
  [
    'validity_never_lied',
    'I have never told even a small lie.',
    'response_validity',
    'refining',
    'neutral',
    1.0,
    4,
    { matching_role: 'validity' }
  ],
  // Love languages (touch and romance already existed)
  [
    'needs_words_of_affirmation',
    'Hearing a partner say loving or appreciative words matters a lot to me.',
    'love_languages',
    'expanded_relationship_core',
    'neutral',
    1.0,
    4
  ],
  [
    'needs_quality_time',
    'Undivided time together is how I most feel loved.',
    'love_languages',
    'expanded_relationship_core',
    'neutral',
    1.0,
    4
  ],
  [
    'values_acts_of_service',
    'I feel cared for when a partner helps with tasks or takes things off my plate.',
    'love_languages',
    'expanded_relationship_core',
    'neutral',
    1.0,
    4
  ],
  [
    'values_gifts',
    'Thoughtful gifts, big or small, make me feel loved.',
    'love_languages',
    'expanded_relationship_core',
    'neutral',
    0.8,
    5
  ],
  // Habits & home
  [
    'tidy_home',
    'I keep my living space clean and tidy and am bothered by mess.',
    'habits_health',
    'expanded_relationship_core',
    'neutral',
    1.2,
    3
  ],
  [
    'health_conscious',
    'I pay close attention to my diet, sleep, and health habits.',
    'habits_health',
    'expanded_relationship_core',
    'neutral',
    1.0,
    4
  ],
  [
    'wants_pets',
    'I want to share my home with pets.',
    'habits_health',
    'expanded_relationship_core',
    'neutral',
    1.1,
    3
  ],
  [
    'high_screen_time',
    'I spend a lot of my free time on my phone, social media, or gaming.',
    'habits_health',
    'expanded_relationship_core',
    'neutral',
    0.9,
    4
  ],
  [
    'shares_relationship_publicly',
    'I like to share my relationship publicly, for example on social media.',
    'social_family_ecosystem',
    'expanded_relationship_core',
    'neutral',
    0.8,
    4
  ],
  [
    'materialistic_lifestyle',
    'I want a comfortable, high-end lifestyle with nice things.',
    'financial_life',
    'expanded_relationship_core',
    'neutral',
    1.1,
    4
  ],
  // Social & political values (worded to be meaningful across countries' political systems)
  [
    'politically_engaged',
    'Politics and social issues are an important part of my life and conversations.',
    'social_political_values',
    'expanded_relationship_core',
    'neutral',
    1.0,
    4
  ],
  [
    'traditional_values',
    'I value tradition and established customs in how I live and what I believe.',
    'social_political_values',
    'expanded_relationship_core',
    'neutral',
    1.3,
    3
  ],
  [
    'progressive_values',
    'I welcome changes to social norms and institutions toward new ways of living.',
    'social_political_values',
    'expanded_relationship_core',
    'neutral',
    1.3,
    3
  ],
  [
    'shared_politics_important',
    'I strongly prefer a partner who shares my political views.',
    'social_political_values',
    'expanded_relationship_core',
    'neutral',
    1.1,
    4
  ],
  [
    'egalitarian_roles',
    'I expect partners to share earning, housework, and caregiving regardless of gender.',
    'social_political_values',
    'expanded_relationship_core',
    'neutral',
    1.3,
    3
  ],
  [
    'traditional_gender_roles',
    'I prefer a relationship where partners take on more traditional gender roles.',
    'social_political_values',
    'expanded_relationship_core',
    'neutral',
    1.3,
    3
  ],
  // Culture & language (global app)
  [
    'cultural_heritage_important',
    'Keeping my cultural or ethnic traditions alive is important to me.',
    'culture_language',
    'expanded_relationship_core',
    'neutral',
    1.1,
    4
  ],
  [
    'open_to_intercultural',
    'I would enjoy a relationship with someone from a different culture or country.',
    'culture_language',
    'expanded_relationship_core',
    'neutral',
    1.1,
    4
  ],
  [
    'family_approval_important',
    "My family's approval of my partner matters a great deal to me.",
    'culture_language',
    'expanded_relationship_core',
    'neutral',
    1.2,
    3
  ],
  [
    'multilingual_household_open',
    'I would be happy to live in a household that uses more than one language.',
    'culture_language',
    'expanded_relationship_core',
    'neutral',
    0.8,
    5
  ],
  // Social expectations of a partner: each expectation is paired with the willingness items that
  // fulfil it (FULFILMENT below), so the matcher can check what one person expects against what
  // the other is willing to do.
  [
    'expects_family_participation',
    'I expect a partner to take part in my family gatherings and traditions.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.2,
    3
  ],
  [
    'joins_partner_family',
    "I am happy to take part regularly in a partner's family gatherings and traditions.",
    'social_expectations',
    'social_expectations',
    'neutral',
    1.2,
    3
  ],
  [
    'expects_holidays_together',
    'I expect major holidays and celebrations to be spent together, including with family.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.1,
    3
  ],
  [
    'joins_partner_friends',
    "I enjoy spending regular time with a partner's friends.",
    'social_expectations',
    'social_expectations',
    'neutral',
    1.1,
    3
  ],
  [
    'expects_events_together',
    'I expect us to go to social events, such as weddings and parties, together as a couple.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.0,
    4
  ],
  [
    'attends_events_as_couple',
    'I like going to social events together with a partner rather than separately.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.0,
    4
  ],
  [
    'expects_stay_close_at_events',
    'At social events I expect a partner to stay close to me rather than mingle on their own.',
    'social_expectations',
    'social_expectations',
    'neutral',
    0.9,
    4
  ],
  [
    'stays_close_at_events',
    'At social events I like to stay close to my partner.',
    'social_expectations',
    'social_expectations',
    'neutral',
    0.9,
    4
  ],
  [
    'expects_public_affection',
    'I expect a partner to show affection in public, such as holding hands.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.0,
    4
  ],
  [
    'comfortable_public_affection',
    'I am comfortable showing affection in public.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.0,
    4
  ],
  [
    'expects_public_acknowledgement',
    'I expect a partner to openly acknowledge our relationship to friends and family, and online.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.1,
    3
  ],
  [
    'expects_early_introductions',
    "I expect to meet a partner's family and close friends within the first few months.",
    'social_expectations',
    'social_expectations',
    'neutral',
    1.0,
    4
  ],
  [
    'introduces_partner_openly',
    'I introduce a partner to the important people in my life early on.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.0,
    4
  ],
  [
    'expects_limited_ex_contact',
    'I expect a partner to keep little or no contact with former partners.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.1,
    3
  ],
  [
    'limits_ex_contact',
    'I am comfortable keeping little or no contact with former partners.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.1,
    3
  ],
  [
    'expects_friendship_boundaries',
    'I expect a partner to avoid close one-on-one friendships with people they could be attracted to.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.1,
    3
  ],
  [
    'adjusts_close_friendships',
    'I am willing to adjust close one-on-one friendships if they make a partner uncomfortable.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.1,
    3
  ],
  [
    'expects_couple_time',
    'I expect a partner to spend most evenings and weekends with me rather than out without me.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.2,
    3
  ],
  [
    'prefers_couple_time',
    'I prefer to spend most of my free time with my partner.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.2,
    3
  ],
  [
    'expects_daily_contact',
    'I expect a partner to stay in touch during the day with messages or calls.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.1,
    3
  ],
  [
    'expects_digital_openness',
    'I expect a partner to be open about their phone, messages and whereabouts if I ask.',
    'social_expectations',
    'social_expectations',
    'mixed',
    1.1,
    3
  ],
  [
    'open_about_phone',
    'I am comfortable being open with a partner about my phone, messages and whereabouts.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.1,
    3
  ],
  [
    'expects_courtship',
    'I expect to be courted: a partner who asks me out, plans dates and makes an effort to win me over.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.0,
    4
  ],
  [
    'enjoys_courting',
    'I enjoy courting a partner: asking them out, planning dates and making an effort to win them over.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.0,
    4
  ],
  [
    'expects_hospitality',
    'I expect a partner to be welcoming to my friends and family in our home.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.0,
    4
  ],
  [
    'expects_respect_for_customs',
    'I expect a partner to respect and follow the customs and manners that matter in my family or culture.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.2,
    3
  ],
  [
    'adapts_to_customs',
    "I am happy to learn and follow the customs and manners that matter to a partner's family or culture.",
    'social_expectations',
    'social_expectations',
    'positive',
    1.2,
    3
  ],
  [
    'expects_public_support',
    'I expect a partner to stand by me in front of others and to raise criticism in private.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.2,
    3
  ],
  [
    'supports_partner_publicly',
    'I stand by a partner in front of others and raise disagreements in private.',
    'social_expectations',
    'social_expectations',
    'positive',
    1.2,
    3
  ],
  [
    'expects_occasions_marked',
    'I expect birthdays, anniversaries and other occasions to be marked with gifts or gestures.',
    'social_expectations',
    'social_expectations',
    'neutral',
    1.0,
    4
  ]
];

// ---------------------------------------------------------------------------------------------
// Scale groups: near-duplicate items measure one construct. The matcher averages a group
// (reverse-keyed items flipped) instead of counting each item as independent evidence.
// Reverse-keyed items also counter acquiescence ("agree with everything") bias.
// [id, label, partner_effect of the construct, members ({id: 'forward' | 'reverse'})]
const SCALE_GROUPS = [
  [
    'sg_solitude_need',
    'Need for solitude',
    null,
    { needs_solitude: 'forward', recharges_alone: 'forward', enjoys_solo_time: 'forward' }
  ],
  [
    'sg_sociability',
    'Sociability',
    null,
    { energized_by_people: 'forward', social_lifestyle: 'forward' }
  ],
  [
    'sg_following',
    'Letting others lead',
    null,
    { prefers_to_follow: 'forward', defers_to_others: 'forward' }
  ],
  [
    'sg_loyalty',
    'Loyalty',
    'higher_better',
    { loyal: 'forward', values_loyalty_highly: 'forward' }
  ],
  [
    'sg_follow_through',
    'Follow-through',
    'higher_better',
    { reliable_follow_through: 'forward', keeps_promises: 'forward', promises_slip: 'reverse' }
  ],
  ['sg_humor', 'Humor', null, { humorous: 'forward', laughs_easily: 'forward' }],
  [
    'sg_playful_teasing',
    'Playful teasing',
    null,
    { playful: 'forward', teases_affectionately: 'forward' }
  ],
  [
    'sg_physical_affection',
    'Physical affection',
    null,
    { physically_affectionate: 'forward', physical_affection_high: 'forward' }
  ],
  ['sg_hosting', 'Hosting', null, { enjoys_hosting: 'forward', host_frequently: 'forward' }],
  [
    'sg_spontaneity',
    'Spontaneity',
    null,
    {
      spontaneous_unstructured: 'forward',
      spontaneous_lifestyle: 'forward',
      light_on_planning: 'forward'
    }
  ],
  [
    'sg_structure',
    'Structure & planning',
    null,
    { organized_planner: 'forward', structured_lifestyle: 'forward' }
  ],
  [
    'sg_serious_tone',
    'Serious tone',
    null,
    { serious_minded: 'forward', prefers_serious_tone: 'forward' }
  ],
  [
    'sg_intellect',
    'Intellectual curiosity',
    null,
    { intellectually_curious: 'forward', loves_learning: 'forward', idea_oriented: 'forward' }
  ],
  [
    'sg_novelty_seeking',
    'Novelty seeking',
    null,
    { curious_explorer: 'forward', adventure_oriented: 'forward' }
  ],
  [
    'sg_familiarity',
    'Preference for the familiar',
    null,
    { prefers_familiarity: 'forward', prefers_known_methods: 'forward' }
  ],
  [
    'sg_spirituality',
    'Spiritual orientation',
    null,
    { spiritually_oriented: 'forward', metaphysical_openness: 'forward' }
  ],
  ['sg_ambition', 'Ambition', null, { ambitious: 'forward', career_priority: 'forward' }],
  [
    'sg_rootedness',
    'Rootedness',
    null,
    { rooted_lifestyle: 'forward', geographic_rootedness: 'forward' }
  ],
  [
    'sg_monogamy',
    'Monogamy expectation',
    null,
    { exclusivity_important: 'forward', monogamy_sexual_expectation: 'forward' }
  ],
  [
    'sg_honesty',
    'Honesty',
    'higher_better',
    { honest_direct: 'forward', bends_truth_for_harmony: 'reverse' }
  ],
  [
    'sg_forgiveness',
    'Forgiveness',
    'higher_better',
    { forgiving: 'forward', holds_grudges: 'reverse' }
  ],
  [
    'sg_recovery',
    'Emotional recovery',
    'higher_better',
    { recovers_quickly: 'forward', hard_to_calm_down: 'reverse' }
  ],
  [
    'sg_attachment_anxiety',
    'Attachment anxiety',
    'lower_better',
    { needs_reassurance: 'forward', fears_abandonment: 'forward', secure_in_partner: 'reverse' }
  ],
  [
    'sg_flexibility',
    'Flexibility in disagreement',
    'higher_better',
    { compromise_oriented: 'forward', stubborn: 'reverse' }
  ],
  ['sg_humility', 'Humility', null, { humble: 'forward', enjoys_status: 'reverse' }],
  [
    'sg_self_esteem',
    'Self-esteem',
    'higher_better',
    { self_confident: 'forward', self_conscious: 'reverse' }
  ],
  [
    'sg_vulnerability',
    'Emotional openness',
    'higher_better',
    { shows_vulnerability: 'forward', keeps_things_to_self: 'reverse' }
  ]
];

// Trait-level partner effects for ungrouped traits: research finds a partner's level on these
// predicts satisfaction regardless of one's own level, so the matcher only penalizes a
// candidate who is worse than the target, never one who is better.
const PARTNER_EFFECT = {
  higher_better: [
    'calm_under_pressure',
    'emotionally_steady',
    'warm_and_affectionate',
    'empathetic',
    'supportive',
    'compassionate',
    'patient',
    'listens_deeply',
    'apologizes_readily',
    'open_to_feedback',
    'expresses_appreciation',
    'generous',
    'thoughtful_gestures',
    'comfortable_depending',
    'repair_after_conflict',
    'caregiving_reciprocity'
  ],
  lower_better: [
    'quick_to_anger',
    'easily_upset',
    'withdraws_under_stress',
    'critical_of_partner',
    'sarcastic_when_upset',
    'jealous_possessive',
    'emotionally_distant'
  ]
};

// ---------------------------------------------------------------------------------------------
// Links. Stored undirected here, written to BOTH traits so the catalog is symmetric.
// Complement: A high on x tends to fit B high on y. Conflict: A high on x with B high on y tends
// to cause friction. A self-link (x, x) means "both partners high on x" is the friction.
// Expectation -> willingness items that fulfil it. Written as `fulfilled_by` on the expectation
// and `fulfills` on each willingness item. One-sided: a partner more willing than expected is fine.
const FULFILMENT = [
  ['expects_family_participation', 'joins_partner_family'],
  ['expects_holidays_together', 'joins_partner_family'],
  ['expects_holidays_together', 'attends_events_as_couple'],
  ['partner_social_integration', 'joins_partner_friends'],
  ['expects_events_together', 'attends_events_as_couple'],
  ['expects_stay_close_at_events', 'stays_close_at_events'],
  ['expects_public_affection', 'comfortable_public_affection'],
  ['expects_public_acknowledgement', 'introduces_partner_openly'],
  ['expects_public_acknowledgement', 'shares_relationship_publicly'],
  ['expects_early_introductions', 'introduces_partner_openly'],
  ['expects_limited_ex_contact', 'limits_ex_contact'],
  ['expects_friendship_boundaries', 'adjusts_close_friendships'],
  ['expects_couple_time', 'prefers_couple_time'],
  ['expects_daily_contact', 'checks_in_often'],
  ['expects_digital_openness', 'open_about_phone'],
  ['expects_courtship', 'enjoys_courting'],
  ['expects_hospitality', 'host_frequently'],
  ['expects_hospitality', 'joins_partner_friends'],
  ['expects_respect_for_customs', 'adapts_to_customs'],
  ['expects_public_support', 'supports_partner_publicly'],
  ['expects_occasions_marked', 'thoughtful_gestures']
];

const COMPLEMENTS = [
  ['organized_planner', 'spontaneous_unstructured'],
  ['assertive', 'accommodating'],
  ['dominant_in_decisions', 'prefers_to_follow'],
  ['dominant_in_decisions', 'defers_to_others'],
  ['direct_communicator', 'diplomatic_softener'],
  ['self_reliant', 'enjoys_interdependence'],
  ['self_reliant', 'merges_easily'],
  ['energized_by_people', 'needs_solitude'],
  ['curious_explorer', 'prefers_familiarity'],
  ['curious_explorer', 'prefers_known_methods'],
  ['playful', 'serious_minded'],
  ['playful', 'prefers_serious_tone'],
  ['meaning_seeking', 'present_focused'],
  ['meaning_seeking', 'experience_first'],
  ['spiritually_oriented', 'secular_practical'],
  ['optimistic', 'realistic_cautious'],
  ['ambitious', 'content_with_enough'],
  ['trusting', 'guarded_skeptical'],
  ['idea_oriented', 'practical_thinker'],
  ['warm_and_affectionate', 'emotionally_reserved'],
  ['talkative', 'listens_deeply']
];

const CONFLICTS = [
  ['quick_to_anger', 'calm_under_pressure'],
  ['quick_to_anger', 'patient'],
  ['highly_reactive', 'emotionally_steady'],
  ['highly_reactive', 'calm_under_pressure'],
  ['easily_upset', 'emotionally_steady'],
  ['easily_upset', 'calm_under_pressure'],
  ['ruminates', 'recovers_quickly'],
  ['ruminates', 'emotionally_steady'],
  ['procrastinates', 'disciplined'],
  ['procrastinates', 'reliable_follow_through'],
  ['emotionally_distant', 'warm_and_affectionate'],
  ['emotionally_distant', 'supportive'],
  ['withdraws_under_stress', 'direct_communicator'],
  ['withdraws_under_stress', 'raises_issues_early'],
  ['keeps_score', 'forgiving'],
  ['takes_things_literally', 'teases_affectionately'],
  ['takes_things_literally', 'dry_humor'],
  ['needs_personal_space', 'checks_in_often'],
  ['needs_personal_space', 'merges_easily'],
  ['dominant_in_decisions', 'dominant_in_decisions'],
  ['stubborn', 'stubborn'],
  ['competitive', 'competitive'],
  ['needs_reassurance', 'needs_personal_space'],
  ['needs_reassurance', 'emotionally_distant'],
  ['fears_abandonment', 'withdraws_under_stress'],
  ['jealous_possessive', 'maintains_separate_worlds'],
  ['jealous_possessive', 'open_relationship_receptive'],
  ['critical_of_partner', 'easily_upset'],
  ['sarcastic_when_upset', 'easily_upset'],
  ['sarcastic_when_upset', 'takes_things_literally'],
  ['impulsive', 'saver'],
  ['wants_children', 'does_not_want_children'],
  ['large_family', 'does_not_want_children'],
  ['parenthood_high_priority', 'does_not_want_children'],
  ['exclusivity_important', 'open_relationship_receptive'],
  ['monogamy_sexual_expectation', 'open_relationship_receptive'],
  ['relationship_intent_long_term', 'relationship_intent_casual'],
  ['relationship_intent_marriage', 'relationship_intent_casual'],
  ['slow_relationship_pace', 'fast_relationship_pace'],
  ['early_riser', 'night_owl'],
  ['homebody', 'social_lifestyle'],
  ['urban_lifestyle', 'rural_lifestyle'],
  ['structured_lifestyle', 'spontaneous_lifestyle'],
  ['rooted_lifestyle', 'international_life_open'],
  ['willing_to_relocate', 'geographic_rootedness'],
  ['saver', 'spender'],
  ['financial_independence', 'shared_finances'],
  ['career_priority', 'work_life_balance'],
  ['private_couple', 'partner_social_integration'],
  ['private_couple', 'shares_relationship_publicly'],
  ['shared_religious_practice', 'secular_practical'],
  ['traditional_values', 'progressive_values'],
  ['traditional_gender_roles', 'egalitarian_roles'],
  ['high_screen_time', 'needs_quality_time'],
  ['expects_couple_time', 'needs_personal_space'],
  ['expects_couple_time', 'maintains_separate_worlds'],
  ['expects_digital_openness', 'needs_personal_space']
];

// Intra-person contradictions: one person rating both items very high suggests careless or
// inconsistent answering. Used by response-quality checks, never by matching.
const INCONSISTENT = [
  ['over_explains', 'says_no_easily'],
  ['over_explains', 'clear_boundaries'],
  ['emotionally_steady', 'highly_reactive'],
  ['calm_under_pressure', 'quick_to_anger'],
  ['ruminates', 'recovers_quickly'],
  ['procrastinates', 'disciplined'],
  ['warm_and_affectionate', 'emotionally_distant'],
  ['trusting', 'guarded_skeptical'],
  ['curious_explorer', 'prefers_familiarity'],
  ['organized_planner', 'spontaneous_unstructured'],
  ['wants_children', 'does_not_want_children'],
  ['early_riser', 'night_owl'],
  ['urban_lifestyle', 'rural_lifestyle'],
  ['slow_relationship_pace', 'fast_relationship_pace'],
  ['exclusivity_important', 'open_relationship_receptive'],
  ['structured_lifestyle', 'spontaneous_lifestyle'],
  ['traditional_gender_roles', 'egalitarian_roles'],
  ['self_confident', 'self_conscious'],
  ['humble', 'enjoys_status'],
  ['compromise_oriented', 'stubborn'],
  ['needs_reassurance', 'secure_in_partner'],
  ['honest_direct', 'bends_truth_for_harmony'],
  ['forgiving', 'holds_grudges'],
  ['recovers_quickly', 'hard_to_calm_down'],
  ['reliable_follow_through', 'promises_slip'],
  ['shows_vulnerability', 'keeps_things_to_self']
];

// ---------------------------------------------------------------------------------------------

const DOMAIN_KIND = Object.fromEntries(DOMAINS.map((d) => [d.id, d.kind]));
const DOMAIN_SPECIAL = Object.fromEntries(DOMAINS.map((d) => [d.id, d.special_category ?? null]));

function suggestedRange(tolerance) {
  return [Math.max(1, tolerance - 2), Math.min(9, tolerance + 2)];
}

function newTrait([id, definition, domain, block, valence, prior, tolerance, extra = {}]) {
  return {
    id,
    definition,
    domain_internal: domain,
    valence,
    weights: { research_prior: prior, similarity_weight: 1, complementarity_weight: 1 },
    divergence: { default_tolerance: tolerance, suggested_range: suggestedRange(tolerance) },
    seed_complements: [],
    seed_conflicts: [],
    block,
    ...extra
  };
}

// Similarity vs complementarity. Couples assort strongly on values, religion, politics, children
// and lifestyle; complementarity has support mainly for dominance/submission-type pairs.
function matchingWeights(trait) {
  const kind = DOMAIN_KIND[trait.domain_internal];
  if (kind !== 'personality') return { similarity_weight: 1.3, complementarity_weight: 0.2 };
  if (trait.seed_complements.length > 0) {
    return { similarity_weight: 0.9, complementarity_weight: 1.2 };
  }
  return { similarity_weight: 1.0, complementarity_weight: 0.5 };
}

function addLink(byId, field, a, b) {
  for (const [x, y] of [
    [a, b],
    [b, a]
  ]) {
    const trait = byId.get(x);
    if (!trait) throw new Error(`link references unknown trait ${x}`);
    if (!byId.has(y)) throw new Error(`link references unknown trait ${y}`);
    if (!trait[field].includes(y)) trait[field].push(y);
  }
}

function migrate(v07) {
  const traits = v07.traits.map((t) => JSON.parse(JSON.stringify(t)));
  traits.push(...NEW_TRAITS.map(newTrait));
  const byId = new Map(traits.map((t) => [t.id, t]));

  for (const [out, into] of INITIAL_SWAPS) {
    const a = byId.get(out);
    const b = byId.get(into);
    if (
      a.block !== 'initial' ||
      b.block !== 'refining' ||
      a.domain_internal !== b.domain_internal
    ) {
      throw new Error(`bad initial swap ${out} <-> ${into}`);
    }
    const i = traits.indexOf(a);
    const j = traits.indexOf(b);
    [traits[i], traits[j]] = [b, a];
    a.block = 'refining';
    b.block = 'initial';
  }

  for (const [id, definition] of Object.entries(DEFINITION_UPDATES)) {
    byId.get(id).definition = definition;
  }

  // Reset every link and rebuild from the curated symmetric lists above.
  for (const t of traits) {
    t.seed_complements = [];
    t.seed_conflicts = [];
    t.inconsistent_with = [];
    t.fulfilled_by = [];
    t.fulfills = [];
  }
  for (const [a, b] of COMPLEMENTS) addLink(byId, 'seed_complements', a, b);
  for (const [a, b] of CONFLICTS) addLink(byId, 'seed_conflicts', a, b);
  for (const [a, b] of INCONSISTENT) addLink(byId, 'inconsistent_with', a, b);
  for (const [expectation, willingness] of FULFILMENT) {
    const e = byId.get(expectation);
    const w = byId.get(willingness);
    if (!e || !w) throw new Error(`fulfilment references unknown ${expectation} / ${willingness}`);
    e.fulfilled_by.push(willingness);
    w.fulfills.push(expectation);
  }

  const groupOf = new Map();
  for (const [groupId, , , members] of SCALE_GROUPS) {
    for (const [id, keying] of Object.entries(members)) {
      if (!byId.has(id)) throw new Error(`scale group ${groupId} references unknown ${id}`);
      groupOf.set(id, { groupId, keying });
    }
  }
  const effectOf = new Map();
  for (const [effect, ids] of Object.entries(PARTNER_EFFECT)) {
    for (const id of ids) effectOf.set(id, effect);
  }
  const flip = { higher_better: 'lower_better', lower_better: 'higher_better' };
  for (const [groupId, , effect, members] of SCALE_GROUPS) {
    for (const [id, keying] of Object.entries(members)) {
      if (effect) effectOf.set(id, keying === 'forward' ? effect : flip[effect]);
      else if (effectOf.has(id)) throw new Error(`${id} in ${groupId} has its own partner effect`);
    }
  }

  const result = traits.map((t) => {
    const expanded = t.block === 'expanded_relationship_core';
    let valence = VALENCE_RENAMES[t.valence] ?? t.valence;
    if (NEUTRAL_PREFERENCE_DOMAINS.has(t.domain_internal) && !PROSOCIAL_EXCEPTIONS.has(t.id)) {
      valence = 'neutral';
    }
    const weights = { ...t.weights };
    const divergence = { ...t.divergence, suggested_range: [...t.divergence.suggested_range] };
    if (expanded && EXPANDED_PARAMS[t.id]) {
      const [prior, tolerance] = EXPANDED_PARAMS[t.id];
      weights.research_prior = prior;
      divergence.default_tolerance = tolerance;
      divergence.suggested_range = suggestedRange(tolerance);
    }
    Object.assign(weights, matchingWeights(t));

    const gate = CONSTRAINT_GATES[t.id];
    const matchingRole = t.matching_role ?? (gate ? 'gate' : 'score');
    const special =
      t.id in SPECIAL_CATEGORY_OVERRIDES
        ? SPECIAL_CATEGORY_OVERRIDES[t.id]
        : DOMAIN_SPECIAL[t.domain_internal];
    const group = groupOf.get(t.id);

    return {
      id: t.id,
      i18n_key: `trait.${t.id}`,
      definition: t.definition,
      domain_internal: t.domain_internal,
      block: t.block,
      matching_role: matchingRole,
      valence,
      scale_group: group?.groupId ?? null,
      keying: group?.keying ?? 'forward',
      partner_effect: effectOf.get(t.id) ?? null,
      special_category: special,
      weights,
      divergence,
      seed_complements: t.seed_complements,
      seed_conflicts: t.seed_conflicts,
      inconsistent_with: t.inconsistent_with,
      fulfilled_by: t.fulfilled_by,
      fulfills: t.fulfills,
      ...(gate ? { constraint: gate } : {})
    };
  });

  const blockOrder = ['initial', 'social_expectations', 'refining', 'expanded_relationship_core'];
  result.sort((a, b) => blockOrder.indexOf(a.block) - blockOrder.indexOf(b.block));

  const counts = Object.fromEntries(
    blockOrder.map((block) => [block, result.filter((t) => t.block === block).length])
  );

  return {
    schema_version: '0.8.0',
    version: `0.8-beta-core-${result.length}`,
    description:
      `${result.length} first-person items. First ${counts.initial} = initial blind ` +
      'questionnaire (balanced across the 11 original personality domains). Refining items ' +
      'unlock after the initial block; social-expectation items pair what a person expects of ' +
      'a partner with what they are willing to do; expanded relationship-core items cover ' +
      'goals, family, lifestyle, values and culture. Categorical dealbreakers and social ' +
      'expectation choices (such as who pays) live in dealbreakers.v0.8.json ' +
      'and profile basics in profile.schema.json. Mate-preference step follows the self block.',
    source_language: 'en',
    rating_scale: {
      min: 1,
      max: 10,
      labels: { 1: 'scale.1', 5: 'scale.5', 10: 'scale.10' },
      allow_skip: true,
      note: 'Divergence is measured in scale points, so the largest possible divergence is 9.'
    },
    valence_definitions: {
      positive: 'Generally desirable in a partner.',
      neutral: 'A preference or style; neither end is better.',
      mixed: 'Adaptive in some contexts, costly in others.',
      challenging: 'Generally associated with relationship strain.'
    },
    matching_role_definitions: {
      score: 'Contributes to compatibility scoring.',
      gate: 'Sets strictness of linked categorical dealbreakers; not scored for similarity.',
      validity: 'Response-quality check only; never used for matching.'
    },
    // The app exists to end its own use: success is two people leaving together for good.
    objective: {
      optimize_for: 'lasting_relationships',
      never_optimize_for: [
        'time_in_app',
        'sessions_or_return_visits',
        'swipes_or_profile_views',
        'messages_sent',
        'notification_opens',
        'ad_impressions'
      ],
      outcome_signals: [
        'both_confirm_together_at_3_months',
        'both_confirm_together_at_12_months',
        'both_left_app_together',
        'conversation_led_to_meeting'
      ],
      calibration_note:
        'Research priors and weights may only be re-tuned against outcome_signals, never ' +
        'against engagement. Couples who leave together count as the best result.'
    },
    ranking: {
      best_first: true,
      min_label: 'good',
      label_alpha: 0.5,
      daily_candidates: 5,
      max_active_conversations: 5,
      show_nobody_below_threshold: true,
      hide_when_status: ['paused', 'in_relationship'],
      note:
        'Always show the best available matches first; never hold good matches back to bring ' +
        'people back later. A few strong candidates a day, no infinite feed. When the ' +
        'viewer has max_active_conversations open, show no new candidates until one ends.'
    },
    matching_config: {
      max_mandatory: v07.matching_config.max_mandatory,
      allowed_divergence_range: v07.matching_config.allowed_divergence_range,
      default_divergence_tolerance: v07.matching_config.default_divergence_tolerance,
      implicit_weight: 0.35,
      // Weight of "does the candidate's willingness meet the viewer's expectation" per item,
      // scaled by how strongly the viewer holds the expectation.
      expectation_weight: 1.2,
      // Fuzzy logic replaces every crisp cut-off: ratings belong to low/medium/high by degree,
      // constraints return a satisfaction degree, and the product of all constraint degrees is
      // compared with one alpha-cut instead of each rule excluding on its own.
      fuzzy: {
        rating_sets: {
          low: [1, 1, 3, 5.5],
          medium: [3, 5.5, 5.5, 8],
          high: [5.5, 8, 10, 10]
        },
        rating_spread: 1,
        exclusion_alpha_cut: 0.2,
        conflict_weight: 0.12,
        unknown_mismatch: 0.85,
        baseline_strictness: 0.3,
        mandatory_margin: 2,
        age_margin_years: 2,
        distance_margin_ratio: 0.5,
        match_labels: {
          poor: [0, 0, 0.3, 0.45],
          fair: [0.3, 0.45, 0.5, 0.6],
          good: [0.5, 0.6, 0.75, 0.85],
          excellent: [0.75, 0.85, 1, 1]
        }
      },
      modes: {
        safe: { similarity_boost: 1.2, complementarity_boost: 0.8, conflict_hedge: 'somewhat' },
        curious: { similarity_boost: 0.9, complementarity_boost: 1.3, conflict_hedge: 'very' }
      }
    },
    questionnaire: {
      self_rating: true,
      blocks: [
        { id: 'profile_basics', order: 0, source: 'profile.schema.json', required: true },
        { id: 'dealbreakers', order: 1, source: 'dealbreakers.v0.8.json', required: true },
        { id: 'initial', order: 2, size: counts.initial, blind: true, required: true },
        { id: 'mate_preference', order: 3, required: true },
        {
          id: 'social_expectations',
          order: 4,
          size: counts.social_expectations,
          available_after: 'initial',
          recommended: true
        },
        { id: 'refining', order: 5, size: counts.refining, available_after: 'initial' },
        {
          id: 'expanded_relationship_core',
          order: 6,
          size: counts.expanded_relationship_core,
          available_after: 'initial'
        }
      ],
      initial_block_size: counts.initial,
      refining_block: true,
      refining_available_after: counts.initial,
      mate_preference: true,
      mate_preference_timing: 'next_step_after_self',
      mate_preference_shows_own_rating: true,
      mate_preference_style: 'importance_and_or_desired_score',
      mate_preference_importance_levels: [0, 1, 2, 3],
      mate_preference_max_items: v07.questionnaire.mate_preference_max_items
    },
    adaptation: v07.adaptation,
    domains_internal: DOMAINS.map((d) => d.id),
    domains: DOMAINS,
    scale_groups: SCALE_GROUPS.map(([id, label, effect, members]) => ({
      id,
      label,
      i18n_key: `scale_group.${id}`,
      partner_effect: effect,
      members: Object.keys(members)
    })),
    counts: { total: result.length, ...counts },
    traits: result
  };
}

const v07 = JSON.parse(readFileSync(input, 'utf8'));
const v08 = migrate(v07);
writeFileSync(output, `${JSON.stringify(v08, null, 2)}\n`);
console.log(`wrote ${output}: ${v08.counts.total} traits`, v08.counts);
