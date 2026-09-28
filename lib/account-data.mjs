// GDPR rights of access and portability (Art. 15, 20) and erasure (Art. 17): export everything
// held about a person as JSON, and plan a complete deletion. Answer within
// privacy.data_subject_requests.respond_within_days.
//
// stores (all optional): {
//   conversations: [{ id, participants, status, created_at, closed_at?, messages: [{ from, text, sent_at }] }],
//   statements_of_reasons: [{ subject, ... }], complaints: [{ filed_by, status, ... }],
//   reports: [{ id, reporter, subject, reason, status, created_at }], strikes: [{ account, ... }],
//   banned_photo_hashes: [{ account, hash }]
// }

const DAY_MS = 86_400_000;

export function requestDeadline(privacy, receivedAt) {
  const days = privacy.data_subject_requests.respond_within_days;
  return new Date(new Date(receivedAt).getTime() + days * DAY_MS).toISOString();
}

export function exportAccountData(privacy, profile, stores = {}, now = new Date()) {
  const me = profile.id;
  const own = (list, key) => (list ?? []).filter((x) => x[key] === me);
  return {
    generated_at: now.toISOString(),
    format: 'application/json',
    about:
      'Everything this service holds about you. Other people in your conversations appear only ' +
      'as "them". Messages older than the retention period no longer exist.',
    profile: Object.fromEntries(
      Object.keys(privacy.profile_fields)
        .filter((field) => field in profile)
        .map((field) => [field, profile[field]])
    ),
    conversations: (stores.conversations ?? [])
      .filter((c) => c.participants.includes(me))
      .map((c) => ({
        id: c.id,
        status: c.status,
        created_at: c.created_at,
        closed_at: c.closed_at ?? null,
        messages: (c.messages ?? []).map((m) => ({
          from: m.from === me ? 'you' : 'them',
          text: m.text,
          sent_at: m.sent_at
        }))
      })),
    moderation_decisions: own(stores.statements_of_reasons, 'subject'),
    complaints: own(stores.complaints, 'filed_by'),
    reports_you_made: own(stores.reports, 'reporter').map((r) => ({
      id: r.id,
      reason: r.reason,
      status: r.status,
      created_at: r.created_at
    })),
    strikes: own(stores.strikes, 'account'),
    never_collected: privacy.never_collected,
    retention: privacy.retention
  };
}

// What deleting the account removes now, and the few things abuse prevention must keep (and for
// how long). Conversations are deleted for both people.
export function deletionPlan(privacy, profile, stores = {}) {
  const me = profile.id;
  const openCases = (stores.reports ?? []).filter(
    (r) => r.status !== 'closed' && (r.reporter === me || r.subject === me)
  );
  const openComplaints = (stores.complaints ?? []).filter(
    (c) => c.filed_by === me && c.status !== 'resolved'
  );
  const keep = [
    ...openCases.map((r) => ({
      store: 'report_case',
      id: r.id,
      purpose: 'abuse_prevention',
      until: 'the case is closed and any legal hold has ended'
    })),
    ...openComplaints.map((c) => ({
      store: 'complaint',
      id: c.id,
      purpose: 'abuse_prevention',
      until: 'the complaint is resolved'
    })),
    ...(stores.banned_photo_hashes ?? [])
      .filter((b) => b.account === me)
      .map(() => ({
        store: 'banned_photo_hash',
        purpose: 'abuse_prevention',
        until: 'kept as a perceptual hash only, not linked to the deleted account'
      }))
  ];
  return {
    delete_now: [
      'profile_and_answers',
      'profile_photo_file',
      'profile_text',
      'interest_and_block_lists',
      'exposure_counters',
      'conversations_and_messages_for_both_people',
      'strikes',
      'moderation_decisions',
      'closed_reports_and_resolved_complaints',
      'login_credentials'
    ],
    keep,
    not_affected: [
      'de-identified calibration records (not linked to any account, so not personal data)'
    ]
  };
}
