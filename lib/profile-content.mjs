// One profile photo and one profile text (profile-content-policy.v0.8.json). Nothing is shown to
// anyone else until it passes these checks.
import { moderateMessage } from './moderation.mjs';

// Photo decision from upload metadata and the screening provider's scores:
//   approve | reject | hold_for_review | pending_photo_check
// `strike` asks the caller to record a strike (explicit uploads).
// `escalate` asks for immediate trust-and-safety attention (possible minor).
export function photoDecision(policy, upload, screening) {
  const p = policy.photo;
  const s = p.screening;
  const reasons = [];
  let decision = 'approve';
  let strike = false;
  let escalate = false;
  const reject = (reason) => {
    reasons.push(reason);
    decision = 'reject';
  };
  const hold = (reason) => {
    reasons.push(reason);
    if (decision === 'approve' || decision === 'pending_photo_check') decision = 'hold_for_review';
  };

  if (!p.accepted_types.includes(upload.type)) reject('unsupported_type');
  if (upload.bytes > p.max_bytes) reject('too_large');
  const shortest = Math.min(upload.width, upload.height);
  const longest = Math.max(upload.width, upload.height);
  if (shortest < p.min_dimension_px) reject('too_small');
  if (longest > p.max_dimension_px) reject('too_large_dimensions');
  if (decision === 'reject') return { decision, reasons, strike, escalate };

  if (screening.nudity >= s.nudity_reject_at) {
    reject('nudity');
    strike = true;
  } else if (screening.nudity >= s.nudity_review_at) {
    hold('possible_nudity');
  }
  if (screening.violence >= s.violence_reject_at) reject('violence');
  if (screening.face_count !== s.faces_required) reject('needs_exactly_one_face');
  if (
    Number.isFinite(screening.estimated_age) &&
    screening.estimated_age < s.minimum_estimated_age
  ) {
    // Never publish; a person must look at this now.
    hold('possible_minor');
    escalate = true;
  }
  if (s.text_in_image_review && screening.contains_text) hold('text_in_image');

  // Catfishing: the photo must show the person who took the live check selfie. No identity
  // document is involved; the selfie is deleted right after the comparison.
  if (screening.face_match === null || screening.face_match === undefined) {
    if (decision === 'approve') decision = 'pending_photo_check';
    reasons.push('awaiting_photo_check');
  } else if (screening.face_match < s.face_match_reject_below) {
    reject('does_not_match_photo_check');
  } else if (screening.face_match < s.face_match_min) {
    hold('uncertain_face_match');
  }

  if (escalate && decision === 'reject') decision = 'hold_for_review';
  return { decision, reasons, strike, escalate };
}

// Whether `viewerId` may see `owner`'s photo.
export function photoVisible(policy, owner, viewerId, { mutualInterest = false } = {}) {
  if (owner.photo?.status !== 'approved') return false;
  if (owner.id === viewerId) return true;
  return policy.photo.visibility === 'with_daily_candidates' || mutualInterest;
}

// Profile text: moderated as if it were a first message to a stranger, so explicit content,
// links and contact details are never allowed, whatever consent exists in conversations.
export function moderateProfileText(policy, messagingPolicy, text) {
  if (text.length > policy.text.max_length) {
    return {
      action: 'block',
      delivered: false,
      strike: false,
      reasons: [{ rule: 'too_long', category: 'format', action: 'block', strike: false }]
    };
  }
  return moderateMessage(
    messagingPolicy,
    { text },
    { messages_exchanged: 0, explicit_consent: false }
  );
}
