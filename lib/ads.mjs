// Ad frequency and placement rules (ads-policy.v0.8.json). Per person per 24 hours: at most two
// video ads, each only when viable, and one small text ad; then nothing until 24 hours after the
// first ad of the window. Revenue is capped per day, so more time in the app never earns more.
//
// Usage: const d = adDecision(policy, state, context); show d.ad (or nothing), and after an ad
// was actually shown call recordImpression(policy, state, d.ad, now) and persist the new state.

const HOUR_MS = 3_600_000;

function activeWindow(policy, state, now) {
  if (!state?.window_started_at) return null;
  const age = now - new Date(state.window_started_at);
  return age < policy.frequency.window_hours * HOUR_MS ? state : null;
}

// Why a video ad cannot be shown right now, or null if it can.
export function videoBlocker(policy, context) {
  const v = policy.video.viability;
  if (v.requires_foreground && !context.foreground) return 'not_foreground';
  if (v.block_when_offline && context.connection === 'offline') return 'offline';
  if (
    v.block_on_cellular_with_data_saver &&
    context.connection === 'cellular' &&
    context.data_saver
  ) {
    return 'data_saver';
  }
  if (
    Number.isFinite(context.battery_level) &&
    context.battery_level < v.min_battery_level_unless_charging &&
    !context.charging
  ) {
    return 'low_battery';
  }
  if (v.block_when_reduced_motion && context.reduced_motion) return 'reduced_motion';
  if (v.block_during_call && context.in_call) return 'in_call';
  return null;
}

export function adDecision(policy, state, context, now = new Date()) {
  const { placement } = context;
  const none = (reason) => ({ ad: null, reason });
  if (policy.placements.never.includes(placement)) return none('protected_placement');

  const window = activeWindow(policy, state, now);
  const shown = { video: window?.video ?? 0, text: window?.text ?? 0 };
  const { max_video: maxVideo, max_text: maxText } = policy.frequency;
  if (window && shown.video >= maxVideo && shown.text >= maxText) return none('daily_cap_reached');

  if (policy.placements.video.includes(placement)) {
    if (shown.video >= maxVideo) return none('video_cap_reached');
    const last = window?.last_video_at ? new Date(window.last_video_at) : null;
    if (last && now - last < policy.frequency.min_minutes_between_videos * 60_000) {
      return none('too_soon_after_video');
    }
    const blocker = videoBlocker(policy, context);
    return blocker ? none(`video_not_viable:${blocker}`) : { ad: 'video', reason: null };
  }
  if (policy.placements.text.includes(placement)) {
    return shown.text >= maxText ? none('text_cap_reached') : { ad: 'text', reason: null };
  }
  return none('not_an_ad_placement');
}

// New state after an ad was actually shown. The window starts at the first ad.
export function recordImpression(policy, state, type, now = new Date()) {
  const window = activeWindow(policy, state, now) ?? {
    window_started_at: now.toISOString(),
    video: 0,
    text: 0
  };
  return {
    ...window,
    [type]: window[type] + 1,
    ...(type === 'video' ? { last_video_at: now.toISOString() } : {})
  };
}

// The same ad request for everyone in the same country, language and placement: nothing a person
// told the app is ever used.
export function adRequest(policy, profile, placement) {
  return {
    placement,
    country: profile.location.country,
    ui_locale: profile.ui_locale,
    excluded_categories: policy.prohibited_categories
  };
}
