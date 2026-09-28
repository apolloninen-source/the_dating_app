// EU Digital Services Act: statements of reasons (Art. 17), internal complaints (Art. 20),
// notices to reporters (Art. 16) and measures against misuse of reporting (Art. 23), per
// data/moderation-decisions.v0.8.json.
import { randomUUID } from 'node:crypto';

const DAY_MS = 86_400_000;
const addDays = (now, days) => new Date(now.getTime() + days * DAY_MS).toISOString();

function redress(policy, now) {
  return {
    internal_complaint_until: addDays(now, policy.redress.internal_complaint_days),
    internal_complaint_how: 'in_app, free of charge',
    out_of_court: policy.redress.out_of_court,
    judicial: policy.redress.judicial
  };
}

// input: { subject, decision_type, grounds: [ground ids], facts, automated_detection,
//          automated_decision, content_ref?, now? }
// `facts` must describe the decision without other people's personal data.
export function statementOfReasons(policy, input) {
  const now = input.now ?? new Date();
  const type = policy.decision_types[input.decision_type];
  if (!type) throw new Error(`unknown decision type ${input.decision_type}`);
  const grounds = [...new Set(input.grounds)].map((g) => {
    const ground = policy.grounds[g];
    if (!ground) throw new Error(`unknown ground ${g}`);
    return { ground: g, section: ground.section, explanation: ground.explanation };
  });
  if (!grounds.length) throw new Error('a statement of reasons needs at least one ground');
  return {
    id: randomUUID(),
    issued_at: now.toISOString(),
    subject: input.subject,
    decision_type: input.decision_type,
    restriction: type.restriction,
    content_ref: input.content_ref ?? null,
    facts: input.facts,
    grounds: { kind: 'terms_of_service', items: grounds },
    automated: {
      detection: Boolean(input.automated_detection),
      decision: Boolean(input.automated_decision)
    },
    redress: redress(policy, now),
    transparency_database: policy.transparency_database
  };
}

// From a lib/moderation.mjs result. Null when the message was delivered.
export function statementForMessage(policy, subject, moderation, { content_ref, now } = {}) {
  if (moderation.action === 'allow') return null;
  const held = moderation.action === 'hold_for_review';
  const grounds = moderation.reasons
    .map((r) => (r.category === 'format' ? null : r.category))
    .filter((c) => c && policy.grounds[c]);
  if (!grounds.length) return null;
  return statementOfReasons(policy, {
    subject,
    decision_type: held ? 'content_held_for_review' : 'message_blocked',
    grounds,
    facts: held
      ? 'Your message was held before delivery and will be reviewed by a person.'
      : `Your message was not delivered because it matched: ${moderation.reasons
          .map((r) => r.rule)
          .join(', ')}.`,
    automated_detection: true,
    automated_decision: !held,
    content_ref,
    now
  });
}

// From a lib/profile-content.mjs photo decision. Null when approved, waiting for the photo check,
// or rejected only for technical reasons (file type or size), which are not moderation decisions.
export function statementForPhoto(policy, subject, decision, { content_ref, now } = {}) {
  if (decision.decision !== 'reject' && decision.decision !== 'hold_for_review') return null;
  const grounds = decision.reasons.map((r) => policy.photo_reason_grounds[r]).filter(Boolean);
  if (!grounds.length) return null;
  const held = decision.decision === 'hold_for_review';
  return statementOfReasons(policy, {
    subject,
    decision_type: held ? 'content_held_for_review' : 'photo_rejected',
    grounds,
    facts: held
      ? 'Your photo is waiting for review by a person before it can be shown.'
      : `Your photo was not published: ${decision.reasons.join(', ')}.`,
    automated_detection: true,
    automated_decision: !held,
    content_ref,
    now
  });
}

// Internal complaint against a statement of reasons, free and open for at least six months.
export function fileComplaint(policy, statement, { by, text, now = new Date() }) {
  if (now > new Date(statement.redress.internal_complaint_until)) {
    throw new Error('the complaint period for this decision has ended');
  }
  if (typeof text !== 'string' || text.length > policy.redress.complaint_max_length) {
    throw new Error('complaint text is missing or too long');
  }
  return {
    id: randomUUID(),
    statement_id: statement.id,
    filed_by: by,
    filed_at: now.toISOString(),
    text,
    status: 'open',
    requires_human_review: true,
    respond_by: addDays(now, policy.redress.response_target_days)
  };
}

// Complaints are never decided solely by automated means.
export function resolveComplaint(
  policy,
  complaint,
  { reviewer, outcome, explanation, now = new Date() }
) {
  if (reviewer?.type !== 'human') throw new Error('complaints must be decided by a person');
  if (!['upheld', 'reversed', 'partially_reversed'].includes(outcome)) {
    throw new Error(`unknown outcome ${outcome}`);
  }
  if (!explanation) throw new Error('a reasoned decision is required');
  const actions =
    outcome === 'upheld' ? [] : ['restore_content_or_access', 'remove_related_strike'];
  return {
    ...complaint,
    status: 'resolved',
    outcome,
    explanation,
    resolved_at: now.toISOString(),
    reviewed_by: reviewer.id,
    actions,
    further_redress: {
      out_of_court: policy.redress.out_of_court,
      judicial: policy.redress.judicial
    }
  };
}

// Notices to the person who reported: a receipt, then the decision. Nothing about the reported
// person beyond whether action was taken.
export function reportReceipt(report, now = new Date()) {
  return { report_id: report.id, received_at: now.toISOString(), status: 'received' };
}

export function reportDecisionNotice(
  policy,
  report,
  { action_taken, automated, now = new Date() }
) {
  return {
    report_id: report.id,
    decided_at: now.toISOString(),
    decision: action_taken ? 'action_taken' : 'no_action',
    automated: Boolean(automated),
    redress: redress(policy, now)
  };
}

// Art. 23: people who often send manifestly unfounded reports are warned, then their reporting is
// suspended for a while.
export function reportingMisuse(policy, unfoundedReportsLast90Days) {
  const m = policy.misuse;
  if (unfoundedReportsLast90Days >= m.unfounded_reports_suspend_at) {
    return { action: 'suspend_reporting', days: m.reporting_suspension_days };
  }
  if (unfoundedReportsLast90Days >= m.unfounded_reports_warning_at) return { action: 'warn' };
  return { action: 'none' };
}
