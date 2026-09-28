# Changelog

## 0.8.0

Everything below is applied by `scripts/migrate-v0.7-to-v0.8.mjs` to
`source/core_traits_v0.7.json`, except the new files listed at the end.

### Fixed

- **Metadata.** v0.7 said 110 traits and 11 domains; the file had 183 traits using 22 domains.
  Version, description and `counts` are now computed from the data. All domains are declared
  (`domains` with label, kind and special-category class; `domains_internal` keeps the id list).
  The `expanded_relationship_core` block is now defined in `questionnaire.blocks`.
- **Rating scale.** Defined as 1–10, so the largest divergence (9) matches
  `allowed_divergence_range` [1, 9].
- **Hard constraints.** The six `*_non_negotiable` items were scored on a scale with tolerance 4,
  which says how strict but not which answer is required. They are now `matching_role: gate`:
  the rating sets the strictness of the linked categorical questions in
  `dealbreakers.v0.8.json` (fuzzy: the degree the rating is "high") and amplifies the related
  domains' weight. They are no longer scored for similarity.
- **Children.** `wants_children` / `does_not_want_children` stay as rating items, but the
  deciding answer is now the categorical `children_want` and `children_have` questions.
- **Links are symmetric.** Every complement, conflict and inconsistency is written to both traits.
- **Contradictions resolved:**
  - `calm_under_pressure` ↔ `highly_reactive` was both complement and conflict → conflict only.
  - `warm_and_affectionate` listed `emotionally_reserved` as a conflict while the reverse was a
    complement → complement; the conflict moved to `emotionally_distant`.
  - `trusting` ↔ `guarded_skeptical` was conflict one way, complement the other → complement.
- **Questionable links:**
  - removed `present_focused` ↔ `adventure_oriented` (similar, not complementary)
  - removed `reliable_follow_through` ↔ `spontaneous_unstructured` conflict (flexible ≠
    unreliable); `procrastinates` carries that conflict
  - removed `meaning_seeking` ↔ `light_on_planning` complement (about planning, not meaning)
  - `takes_things_literally` now conflicts with `teases_affectionately` and `dry_humor` (irony
    and teasing) rather than with humor in general
  - `checks_in_often` ↔ `needs_personal_space` and `merges_easily` ↔ `needs_personal_space`
    moved from complement to conflict (the pursuer–distancer pattern)
- **Intra-person vs partner conflicts.** v0.7 used `seed_conflicts` for things like
  `over_explains` ↔ `says_no_easily`, which is one person answering inconsistently, not partner
  friction. These are now `inconsistent_with`, used by response-quality checks only.
- **Expanded block links.** It had none; obvious opposites are now linked (children,
  monogamy, pace, sleep schedule, city/rural, saver/spender, finances, career vs balance,
  relocation vs rootedness, homebody vs social, private vs integrated couple).
- **Weights.** `similarity_weight` / `complementarity_weight` were all 1.0. Now: values,
  relationship and lifestyle items 1.3 / 0.2 (couples assort strongly on these); personality
  items with complements 0.9 / 1.2; other personality items 1.0 / 0.5. The 73 expanded items
  got individual research priors and tolerances instead of 1.0 / 4 placeholders (e.g. children
  and monogamy 1.5 / 2, voice and mannerisms 0.8 / 5).
- **Duplicates.** Near-duplicate items are grouped into 27 `scale_groups` and averaged, so one
  construct is not counted twice (e.g. `needs_solitude` + `recharges_alone` + `enjoys_solo_time`).
- **Initial block.** Six same-construct pairs in the first 60 were split by swapping one item
  of each pair with a refining item from the same domain: `recharges_alone`↔`initiates_plans`,
  `laughs_easily`↔`brings_levity`, `teases_affectionately`↔`dry_humor`,
  `keeps_promises`↔`transparent`, `loves_learning`↔`open_to_feedback`,
  `enjoys_solo_time`↔`maintains_separate_worlds`. Still 60 items, still
  balanced (5–6 per domain).
- **Valence.** Preferences are no longer value-laden: `wants_children`, `exclusivity_important`,
  `relationship_intent_long_term`, etc. were "positive" while their opposites were "neutral";
  all preference items are now neutral. `context_sensitive` (undefined, used once) → `mixed`.
  All valences are defined in `valence_definitions`.
- **Wording for a global audience:** marriage → "marriage, or an equivalent lifelong
  commitment"; relocation items clarified.

### Added

- **Objective: lasting relationships.** `objective` and `ranking` in the catalog: best first,
  a few "good or better" candidates a day, a cap on open conversations, couples hidden once
  together, tuning only against long-term outcomes, never engagement.
- **Fuzzy-logic matching.** Crisp thresholds (conflict ≥ 7, complement ≥ 6, strict at 8,
  hard mandatory tolerance, hard age and distance limits, minimum score) are replaced by fuzzy
  sets, satisfaction degrees combined by algebraic AND with one α-cut, conflicts accumulated by
  probabilistic OR with mode hedges, and linguistic match labels. See `matching_config.fuzzy`.

- **51 new items** (183 → 234), including:
  - attachment anxiety (`needs_reassurance`, `fears_abandonment`, `secure_in_partner`)
  - jealousy / possessiveness
  - the criticism and contempt horsemen (`critical_of_partner`, `sarcastic_when_upset`)
  - compromise vs stubbornness, humility vs status-seeking, generosity, appreciation,
    thoughtful gestures, vulnerability
  - self-esteem, anxiety, impulsivity, decisiveness, punctuality, competitiveness, creativity,
    unconventionality
  - reverse-keyed items for honesty, follow-through, forgiveness and recovery
  - two social-desirability check items
  - love languages
  - tidiness, health habits, pets, screen time, public couple, materialism
  - political engagement, traditional vs progressive values, gender roles
  - cultural heritage, intercultural openness, family approval, multilingual household
- **`partner_effect`** (higher_better / lower_better) on traits where a partner's level matters in
  itself; the matcher only penalizes the worse side.
- **`special_category`** on religion, sex-life, political, ethnic and health items; answers need
  explicit consent.
- **New files:**
  - `dealbreakers.v0.8.json` (global option lists)
  - `profile.schema.json`
  - `region-policy.example.json`
  - `messaging-policy.v0.8.json` (no images; unsolicited sexual content, harassment, threats,
    scams, commercial sex, trafficking recruitment; account-trust limits; report reasons)
  - `i18n/en.json`
  - `lib/` (matcher, validator, response quality, moderation, account trust)
  - unit tests
