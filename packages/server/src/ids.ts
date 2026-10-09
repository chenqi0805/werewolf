import { randomBytes, randomInt } from 'node:crypto';

/** Unambiguous alphabet — no 0/O/1/I — so codes read aloud cleanly. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const CODE_LENGTH = 4;

/** A room code not already in `taken`. Collision probability is negligible; retry anyway. */
export function makeRoomCode(taken: ReadonlySet<string>): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    }
    if (!taken.has(code)) return code;
  }
}

/** Opaque per-seat bearer credential: whoever holds it reattaches to the seat. */
export function makeToken(): string {
  return randomBytes(24).toString('base64url');
}
