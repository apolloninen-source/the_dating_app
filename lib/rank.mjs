// Daily candidate ranking. The objective is lasting relationships, not engagement, so:
//   - best matches first, always; nothing is held back for later
//   - a small daily set above a quality threshold; nobody is shown to fill a quota
//   - no new candidates while the viewer already has enough open conversations
//   - people who paused or are in a relationship (including ones formed here) are never shown
import { indexCatalog } from './constructs.mjs';
import { mutualMatch } from './match.mjs';

// Fuzzy quality threshold: the match must belong to min_label (or a better label) to at least
// label_alpha. Labels are ordered worst to best in fuzzy.match_labels.
function goodEnough(catalog, memberships) {
  const { min_label: minLabel, label_alpha: alpha } = catalog.ranking;
  const labels = Object.keys(catalog.matching_config.fuzzy.match_labels);
  return labels.slice(labels.indexOf(minLabel)).some((l) => memberships[l] >= alpha);
}

export function rankCandidates(catalog, dealbreakers, viewer, candidates, options = {}) {
  const { activeConversations = 0, alreadySeen = [], now = new Date(), regionPolicy } = options;
  const cfg = catalog.ranking;
  const hidden = new Set(cfg.hide_when_status);

  if (hidden.has(viewer.matching_status)) return { candidates: [], reason: 'viewer_not_active' };
  if (activeConversations >= cfg.max_active_conversations) {
    return { candidates: [], reason: 'focus_on_current_conversations' };
  }

  const seen = new Set(alreadySeen);
  const index = indexCatalog(catalog);
  const scored = [];
  for (const candidate of candidates) {
    if (candidate.id === viewer.id || seen.has(candidate.id)) continue;
    if (hidden.has(candidate.matching_status)) continue;
    const match = mutualMatch(index, dealbreakers, viewer, candidate, { now, regionPolicy });
    if (match.excluded || !goodEnough(catalog, match.memberships)) continue;
    scored.push({ id: candidate.id, score: match.score, label: match.label });
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const slots = Math.min(cfg.daily_candidates, cfg.max_active_conversations - activeConversations);
  const picked = scored.slice(0, slots);
  return { candidates: picked, reason: picked.length ? null : 'no_strong_matches_today' };
}
