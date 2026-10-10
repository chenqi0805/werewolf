/**
 * Pure helpers for the email-invite flow: the address gate the lobby sends
 * through, and the join link's ?room=CODE landing that pre-fills the connect
 * form. Both mirror the server module exactly (invites.ts: isValidInviteEmail
 * and the `${baseUrl}/?room=CODE` link shape) so the browser never sends an
 * address the server would refuse, and a landed link fills the field the way
 * the email promised.
 */

/** Mirrors invites.ts MAX_EMAIL_LENGTH — RFC 5321's forward-path ceiling. */
const MAX_EMAIL_LENGTH = 254;

/** The connect form's room-code cap — a programmatic prefill gets the same ceiling as typing. */
const MAX_ROOM_CODE_LENGTH = 8;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The address gate, client-side: obvious mistakes never leave the browser.
 * Pragmatic on purpose — the table's failure mode is a typo, not a forgery.
 * Callers pass a trimmed address (the server trims the same way).
 */
export function isValidInviteEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email);
}

/** The room code carried by an invite link's query string, or '' when absent. */
export function roomCodeFromUrl(search: string): string {
  const code = new URLSearchParams(search).get('room')?.trim() ?? '';
  return code.slice(0, MAX_ROOM_CODE_LENGTH);
}
