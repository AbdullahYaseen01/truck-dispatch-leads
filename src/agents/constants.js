// Shared constants (kept dependency-free so any module can import them without import cycles).

export const REPLY_CATEGORIES = ['interested', 'very_interested', 'wants_pricing', 'wants_more_info', 'wants_call', 'already_has_dispatcher',
  'follow_up_later', 'not_interested', 'unsubscribe', 'out_of_office', 'invalid_response'];
export const POSITIVE = ['interested', 'very_interested', 'wants_pricing', 'wants_more_info', 'wants_call'];

export const VERIFICATION_STATUSES = ['verified', 'likely_valid', 'risky', 'unknown', 'unverified', 'invalid', 'disposable', 'duplicate', 'previously_bounced', 'suppressed'];
// Statuses that can be emailed at all (each further gated by Settings in sendable()).
export const MAILABLE = ['verified', 'likely_valid', 'risky', 'unknown'];

export function priorityOf(score) {
  if (score >= 90) return 'very_high';
  if (score >= 75) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}
