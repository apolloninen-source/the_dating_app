// Daily candidate ranking. The objective is lasting relationships, not engagement, so:
//   - best matches first, always; nothing is held back for later
//   - a small daily set above a quality threshold; nobody is shown to fill a quota
//   - no new candidates while the viewer already has enough open conversations
//   - people who paused or are in a relationship (including ones formed here) are never shown
//   - incognito people are only shown to those they have shown interest in
//   - blocked pairs never see each other again, in either direction
//   - fair exposure: nobody is shown to more people a day, or kept in rotation with more
//     unanswered interest, than they could reasonably respond to
import { indexCatalog } from './constructs.mjs';
import { mutualMatch } from './match.mjs';

// Fuzzy quality threshold: the match must belong to min_label (or a better label) to at least
// label_alpha. Labels are ordered worst to best in fuzzy.match_labels.
export function goodEnough(catalog, memberships) {
  const { min_label: minLabel, label_alpha: alpha } = catalog.ranking;
  const labels = Object.keys(catalog.matching_config.fuzzy.match_labels);
  return labels.slice(labels.indexOf(minLabel)).some((l) => memberships[l] >= alpha);
}

// Why `candidate` may not be shown to `viewer` at all, before any scoring (null if they may).
// exposure: { [id]: { shown_today, pending_incoming_interest } } kept by the server per day.
export function visibilityBlocker(catalog, viewer, candidate, exposure = {}) {
  const cfg = catalog.ranking;
  if (candidate.id === viewer.id) return 'self';
  if (cfg.hide_when_status.includes(candidate.matching_status)) return 'not_active';
  if ((viewer.blocked_ids ?? []).includes(candidate.id)) return 'blocked';
  if ((candidate.blocked_ids ?? []).includes(viewer.id)) return 'blocked';
  if (candidate.incognito && !(candidate.expressed_interest_in ?? []).includes(viewer.id)) {
    return 'incognito';
  }
  const load = exposure[candidate.id] ?? {};
  if ((load.shown_today ?? 0) >= cfg.max_daily_exposure) return 'exposure_cap';
  if ((load.pending_incoming_interest ?? 0) >= cfg.max_pending_incoming_interest) {
    return 'interest_cap';
  }
  return null;
}

export function rankCandidates(catalog, dealbreakers, viewer, candidates, options = {}) {
  const {
    activeConversations = 0,
    alreadySeen = [],
    exposure = {},
    now = new Date(),
    regionPolicy
  } = options;
  const cfg = catalog.ranking;

  if (cfg.hide_when_status.includes(viewer.matching_status)) {
    return { candidates: [], reason: 'viewer_not_active' };
  }
  if (activeConversations >= cfg.max_active_conversations) {
    return { candidates: [], reason: 'focus_on_current_conversations' };
  }

  const seen = new Set(alreadySeen);
  const index = indexCatalog(catalog);
  const scored = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id) || visibilityBlocker(catalog, viewer, candidate, exposure)) continue;
    const match = mutualMatch(index, dealbreakers, viewer, candidate, { now, regionPolicy });
    if (match.excluded || !goodEnough(catalog, match.memberships)) continue;
    scored.push({ id: candidate.id, score: match.score, label: match.label });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const slots = Math.min(cfg.daily_candidates, cfg.max_active_conversations - activeConversations);
  const picked = scored.slice(0, slots);
  return { candidates: picked, reason: picked.length ? null : 'no_strong_matches_today' };
}
