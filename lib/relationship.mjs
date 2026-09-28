// Dates and relationships (lifecycle-policy.v0.8.json): a private check-in after a date, and the
// "we're together" flow that hides a couple, offers an anonymous check-in, and deletes them
// after a grace period.

const DAY_MS = 86_400_000;

// pair: { a, b, together_confirmations?: { [userId]: iso } }
// Both must confirm within confirm_window_days; a lone confirmation is never shown to the other.
export function confirmTogether(policy, pair, userId, now = new Date()) {
  if (userId !== pair.a && userId !== pair.b) throw new Error('not part of this pair');
  const windowMs = policy.relationship.confirm_window_days * DAY_MS;
  const confirmations = Object.fromEntries(
    Object.entries({ ...pair.together_confirmations, [userId]: now.toISOString() }).filter(
      ([, at]) => now - new Date(at) <= windowMs
    )
  );
  const together = Boolean(confirmations[pair.a] && confirmations[pair.b]);
  const graceMs = policy.relationship.grace_days_before_deletion * DAY_MS;
  return {
    pair: { ...pair, together_confirmations: confirmations },
    status: together ? 'together' : 'waiting_for_partner',
    actions: together
      ? ['set_both_in_relationship', 'hide_both_from_matching', 'offer_anonymous_checkin']
      : [],
    delete_after: together ? new Date(now.getTime() + graceMs).toISOString() : null
  };
}

// Returning after a relationship ends (within the grace period, or with a new account later).
export function returnToMatching(profile) {
  return { ...profile, matching_status: 'active' };
}

// responses: { [userId]: { met: boolean, see_again: 'yes' | 'no' | 'unsure', felt_safe: boolean } }
// Answers are never shown to the other person; they only produce actions.
export function afterDateOutcome(pair, responses) {
  const people = [pair.a, pair.b];
  const actions = [];
  for (const id of people) {
    const r = responses[id];
    if (r && r.felt_safe === false) actions.push({ user: id, action: 'offer_support_and_report' });
  }
  const answered = people.filter((id) => responses[id]);
  const bothMet = answered.length === 2 && people.every((id) => responses[id].met);
  const someoneSaysNo = people.find((id) => responses[id]?.see_again === 'no');
  if (someoneSaysNo) {
    actions.push({ user: someoneSaysNo, action: 'suggest_closing_kindly' });
  } else if (answered.length === 2 && people.every((id) => responses[id].see_again === 'yes')) {
    for (const id of people) actions.push({ user: id, action: 'keep_talking' });
  }
  let outcome = null;
  if (bothMet)
    outcome = someoneSaysNo ? 'did_not_want_to_meet_again' : 'conversation_led_to_meeting';
  return { actions, outcome_signal: outcome };
}
