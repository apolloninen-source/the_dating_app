# the_dating_app

The matching foundation for a dating app built to end its own use: it finds people a lasting
partner and counts two people leaving together as success.

It is deliberately **not** a swipe platform. Swipe apps are social feeds tuned for engagement
(time in app, return visits, endless profiles, photo-first snap judgements). This is a
**matcher**: people describe who they are and what they need, the algorithm finds the few people
they are most likely to build something lasting with, and it gets out of the way.

|                      | Swipe / social platform            | This matcher                                          |
| -------------------- | ---------------------------------- | ----------------------------------------------------- |
| Optimizes for        | engagement: sessions, swipes, time | lasting relationships; engagement is never optimized  |
| Discovery            | endless feed                       | a few strong candidates a day, only "good" or better  |
| Basis for a match    | photos, snap judgement             | 234 trait items, values, dealbreakers, preferences    |
| Best matches         | rationed to bring people back      | always shown first                                    |
| Many open chats      | encouraged                         | capped, to focus on the people you're talking to      |
| Success              | the user keeps coming back         | the couple leaves together and is hidden from matching |
| Pictures             | central                            | none at all                                           |

Status: **v0.8, data model and reference logic.** No app, API or database yet; this is the core
the app will be built on. Everything is plain Node 22 ES modules with no runtime dependencies.

## Layout

```
data/traits.v0.8.json            trait catalog, 234 items (generated from source/ by the migration)
data/dealbreakers.v0.8.json      categorical dealbreaker questions (global option lists)
data/profile.schema.json         JSON Schema for a profile: basics, answers, preferences, consents
data/messaging-policy.v0.8.json  no-images rule, message rules, account-trust limits, report reasons
data/region-policy.example.json  per-country rules (min age, hidden fields, disabled questions); example only
i18n/en.json                     English source strings for translators (generated)
source/core_traits_v0.7.json     the v0.7 input, kept for provenance
lib/fuzzy.mjs                    fuzzy sets, hedges, fuzzy AND/OR, linguistic labels
lib/constructs.mjs               scale groups -> constructs, reverse keying
lib/match.mjs                    fuzzy constraints + preference/similarity/complement/friction scoring
lib/rank.mjs                     daily ranking for lasting relationships (best first, few, focused)
lib/response-quality.mjs         contradiction, social-desirability and straight-lining flags
lib/validate.mjs                 catalog, dealbreaker and profile validation
lib/moderation.mjs               pre-delivery message checks (ToS violations only)
lib/trust.mjs                    account trust signals: verification, mass messaging, reports
scripts/migrate-v0.7-to-v0.8.mjs the v0.7 -> v0.8 migration (see CHANGELOG.md)
scripts/extract-i18n.mjs         regenerates i18n/en.json
scripts/validate.mjs             validates the data files
tests/dating.test.mjs            unit tests
```

## Commands

```sh
npm install
npm test            # unit tests
npm run lint        # prettier + eslint
npm run validate    # validate the data files
npm run migrate     # regenerate the catalog and i18n/en.json from source/
```

## Onboarding flow

1. **Profile basics** (`profile.schema.json`): age (18+, higher where region policy says so),
   gender, who they seek, location (country + coarse coordinates), languages, UI locale.
2. **Identity verification**: government ID + liveness check through a vendor. Required to
   message. The images go only to the vendor and are never shown or kept by the app.
3. **Dealbreakers** (`dealbreakers.v0.8.json`): relationship goal and structure, children,
   smoking, alcohol, drugs, religion, diet, pets, politics, shared language, location.
4. **Initial 60** blind personality items, balanced across 11 domains.
5. **Mate preferences**: up to 25 items, importance 0–3, optional desired score and
   tolerance, at most 10 mandatory.
6. **Refining** and **relationship-core** items, available after the initial block.

## What the algorithm optimizes

**Lasting relationships, not engagement.** This is part of the data (`objective`, `ranking` in
the catalog) and checked by the validator:

- weights may only be re-tuned against long-term outcomes (both confirm they're together at 3
  and 12 months, left together, met in person), never time in app, sessions, swipes or messages
- best matches are always shown first; good matches are never held back to bring people back
- a few strong candidates a day (`daily_candidates`), only those at least "good"; no filler,
  no infinite feed
- no new candidates while `max_active_conversations` are open: focus on the people you're
  talking to
- people who confirm they're together (`matching_status: in_relationship`) are hidden

## How matching works (`lib/match.mjs`, `lib/fuzzy.mjs`)

Matching uses **fuzzy logic**: no crisp cut-offs, everything is a degree in [0, 1].

- **Ratings** belong to `low` / `medium` / `high` by degree (trapezoids in
  `matching_config.fuzzy.rating_sets`): a 7 is "high" to degree 0.6, not simply high or not.
- **Closeness** of two ratings: differences within `rating_spread` (1 point) count as identical,
  because self-ratings are imprecise; then it falls smoothly with distance.

For viewer → candidate:

1. **Crisp gates** (legal or identity facts only): gender sought, 18+, verified-only.
2. **Fuzzy constraints**, each a satisfaction degree:
   - age range and distance fade out over a margin (2 years, 50 % of the distance)
   - dealbreakers: strictness = degree to which the viewer's linked hard-constraint rating is
     "high" (e.g. `children_non_negotiable` → `children_want`, `children_have`), at least 0.3
     for any stated preference; explicit `strict: true` = 1. "Prefer not to say" = mostly a
     mismatch (0.85). Questions disabled in either person's region are skipped.
   - mandatory preferences fade out over 2 points past the tolerance
   - degrees combine with algebraic AND (product); below the **α-cut 0.2** the candidate is
     excluded, so several near-misses together can exclude, but one near-miss never does
3. **Compatibility**: explicit preferences and implicit similarity as weighted means of
   closeness; complements count in proportion to how "high" the viewer is on the trait.
4. **Friction**: each conflict fires to degree `min(high(a), high(b))`; conflicts accumulate by
   probabilistic OR. The mode applies a hedge: `safe` = _somewhat_ (mild friction weighs more),
   `curious` = _very_ (only strong friction counts).
5. **Score** = compatibility × (1 − friction) × constraint satisfaction. **Mutual score** =
   geometric mean of both directions, with a label: poor / fair / good / excellent.

**Constructs.** Near-duplicate items form a scale group (e.g. `sg_solitude_need`), averaged
into one score so they are not counted twice. Reverse-keyed items (e.g. `promises_slip` in
`sg_follow_through`) are flipped before averaging; they also counter "agree with everything"
answering.

**Partner effects.** For traits where a partner's level matters in itself (patience, anger,
jealousy, contempt, …), only the worse side counts: a candidate more patient than you is never
penalized for it.

## Safety

- **No pictures anywhere.** No profile photos, no chat images or files. Messages with image
  links, image hosts, data-URI or markup images are rejected (`lib/moderation.mjs`).
- **Message checks, ToS violations only**, before delivery:
  - unsolicited sexual content is blocked (with a strike) unless both people switched on
    explicit talk for the conversation; requests for pictures are always blocked
  - harassment is blocked; threats, scams, commercial-sex and trafficking-recruitment
    language is held for trust-and-safety review
  - links and contact details are blocked early in a conversation, which stops scammers and
    traffickers moving people off the platform quickly
  - evasions (spaced letters, l33t, accents, zero-width characters) are normalized first
  - 3 active strikes suspend messaging; 5 trigger an account review
- **Catfishing / scams** (`lib/trust.mjs`): verified identity required to message; one account
  per person (salted document hash); a flag when the declared country doesn't match where the
  person connects from; limits on first messages per day (stricter for new accounts); a flag
  for the same opener sent to many people.
- **Trafficking / exploitation**: ID-based age checks; exploitation language held for review;
  reports for `underage`, `trafficking_or_exploitation` or threats suspend the account
  immediately pending review; region policy lists local hotlines in the report flow.
- **Sensitive data**: religion, sex life/orientation, politics, ethnicity and health answers
  need explicit consent (`profile.consents`) and default to `match_only` or `private`.
  Region policy can hide fields (e.g. orientation where it is criminalized) or disable
  questions (e.g. drug use).

## Before launch

- The English message rules are a seed. Add maintained per-locale rules (`locale_rules`) and
  the external slur list; consider a classifier for languages without lists.
- Fill `region-policy` from legal review (ages, hidden fields, hotlines). The shipped file is
  an example structure with placeholder country codes.
- Research priors and weights are informed defaults; recalibrate them against real outcomes
  (confirmed lasting couples), never engagement.
- Translate item wording with cultural review, not literally: some items (dating pace,
  gender roles, family approval) read differently across cultures.
