# Integration guide (for the web and app developer)

This repository is the **engine**: data files and pure functions for matching, ranking, safety,
privacy and legal duties. It has no UI, API, database or providers; those are yours to build
around it. Read `README.md` first for what the product is and why.

## Ground rules

- **Server-side only.** Run everything in `lib/` on the server (Node 22, ES modules, no runtime
  dependencies). Never ship matching weights, moderation rules or other people's data to the
  browser or app.
- **Privacy is part of the spec.** Store only the fields in `data/profile.schema.json`; each
  one's purpose is in `data/privacy.v0.8.json` and the tests fail if a field is added without
  one. No analytics or tracking SDKs, no stored IP addresses, no device fingerprinting, no
  phone numbers, birth month only (`YYYY-MM`). Login with passkeys, or an email used only for
  login and recovery.
- **The objective is lasting relationships.** Don't add engagement features (streaks, "someone
  viewed you", extra notifications, infinite lists). `data/features.v0.8.json` lists what is
  deliberately not offered.
- **Data files are configuration.** Tune behaviour there, not in code. After changing one, run
  `npm run validate && npm test`.

## Fields the server sets (never trust the client for these)

`photo`, `photo_check`, `matching_status` (`in_relationship` only via `confirmTogether`),
`expressed_interest_in`, `blocked_ids`, and the ids. Everything else in the profile schema
is user-editable.

## Flows and which function to call

| Flow | Call | Notes |
| --- | --- | --- |
| Sign-up / profile edit | `validateProfile` (`lib/validate.mjs`) | Also validate against `data/profile.schema.json` with any JSON Schema validator. Sensitive answers need `consents`. |
| Questionnaire | `nextQuestions`, `questionnaireProgress` (`lib/questionnaire.mjs`), `responseQuality` (`lib/response-quality.mjs`) | Matching unlocks when `can_match` is true (initial 60 done). Show response-quality flags gently, never block. |
| Profile photo | strip metadata and re-encode → your screening provider → `photoDecision` (`lib/profile-content.mjs`) → `statementForPhoto` (`lib/decisions.mjs`) if restricted | One photo only. `escalate: true` means a possible minor: queue for a person now. |
| Live photo check | provider compares the live selfie with the profile photo and estimates age; delete the selfie; set `photo_check.status` | Required to message (`canStartConversation`). |
| Profile text | `moderateProfileText` (`lib/profile-content.mjs`) | Publish only on `allow`. |
| Showing a photo | `photoVisible` (`lib/profile-content.mjs`) | Default: only after mutual interest. |
| Daily candidates | `prefilterSpec` (`lib/candidates.mjs`) → your DB query → `rankCandidates` (`lib/rank.mjs`) | Pass `activeConversations` (`openConversationCount`), `alreadySeen`, and `exposure` counters. `prefilterBlocker` is the in-memory reference for the query. |
| No candidates | `constraintImpact`, `areaStatus` (`lib/candidates.mjs`) | Waitlist below the area minimum. |
| Match details | `explainMatch` (`lib/match.mjs`) | Strengths, friction, expectations to discuss. |
| Starting a chat | `canStartConversation` (`lib/trust.mjs`) | Feed it rate counters and short-lived first-message hashes (`messageHash`). |
| Every message | `moderateMessage` (`lib/moderation.mjs`) → deliver / reject / hold → `statementForMessage` if restricted | Chat is text-only. `strike: true` → record a strike. |
| Closing a chat | `closeConversation` (`lib/conversations.mjs`) | Offer the kind templates from `data/lifecycle-policy.v0.8.json`. |
| Blocking / reporting | add to `blocked_ids`; `reportReceipt`, then `reportDecisionNotice` (`lib/decisions.mjs`) | Copy reported messages into the report case at once (see retention). |
| Complaints | `fileComplaint`, `resolveComplaint` (`lib/decisions.mjs`) | Resolution must be by a person (moderator tool). |
| After a date | `afterDateOutcome` (`lib/relationship.mjs`) | Never show one person's answers to the other. |
| "We're together" | `confirmTogether` (`lib/relationship.mjs`); if both opted in, `departureRecord` (`lib/calibration.mjs`) | Give the couple the check-in link with the token; a public page calls `applyCheckin`. |
| Ads | `adDecision`, `recordImpression`, `adRequest` (`lib/ads.mjs`) | Per person per 24 h: 2 video + 1 text. Context-only requests. |
| Data export / deletion | `exportAccountData`, `deletionPlan`, `requestDeadline` (`lib/account-data.mjs`) | Answer within 30 days. |

## Scheduled jobs

- **Hourly:** `conversationState` for open conversations → send the one reminder, or auto-close.
- **Daily:** delete messages where `shouldDelete` (`lib/retention.mjs`) and destroy day keys from
  `keyDaysToDestroy`. Reset exposure counters. Expire first-message hashes (24 h) and strikes
  (90 days). Delete couples whose grace period has ended.
- **On a schedule:** submit statements of reasons to the DSA transparency database (no personal
  data).

## Message encryption (needed for real deletion)

Encrypt each message with a key for the day it was sent (`encryptionKeyDay`). Destroying the
key after 15 days makes backups unreadable too. Reported messages are copied into their report
case, encrypted separately, when reported.

## Providers to choose

- **Image screening:** nudity and violence scores, face count, age estimate, text-in-image, and
  a face match between the live selfie and the profile photo. It must delete images after
  processing and must not keep face templates.
- **Object storage** for the one photo per profile (for example Cloudflare R2, no egress fees),
  with direct uploads to a signed URL.
- **Ad network** that supports context-only targeting and the excluded categories in
  `data/ads-policy.v0.8.json`.

## Before launch (not code)

- Terms of Service sections referenced as `tos.*` in `data/moderation-decisions.v0.8.json`, and
  the privacy policy.
- Legal review of `data/region-policy.example.json` (ages, hidden fields, disabled questions,
  hotlines), age assurance and message retention per country.
- Translations of `i18n/en.json` with cultural review; per-locale moderation lists.

## Commands

```sh
npm install
npm test            # 87 tests
npm run lint        # prettier + eslint
npm run validate    # data files
npm run migrate     # regenerate the catalog from source/ (only when changing the migration)
```
