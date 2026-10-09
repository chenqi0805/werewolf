/**
 * Engine rejections. The server maps these onto a per-socket `game:error`
 * message — never a disconnect, never a 500. Codes are stable protocol values.
 */
export type GameErrorCode =
  /** Action is not legal in the current phase. */
  | 'WRONG_PHASE'
  /** It is not this actor's turn or slot. */
  | 'NOT_YOUR_TURN'
  /** The actor — or a target that must be living — is dead. */
  | 'PLAYER_DEAD'
  /** Vote rights absent or revoked (revealed idiot, 非警下). */
  | 'NO_VOTE_RIGHTS'
  /** That witch potion is already spent for the game. */
  | 'POTION_USED'
  /** Self-save outside night 1, or self-poison (never allowed). */
  | 'POTION_SELF_SAVE'
  /** Hunter shot attempted with no open (and un-voided) shot window. */
  | 'NOT_ELIGIBLE_SHOOTER'
  /** Seat assigned twice. */
  | 'SEAT_TAKEN'
  /** Target seat out of range or not valid for the action. */
  | 'INVALID_TARGET'
  /** One-shot action repeated (e.g. signing up twice). */
  | 'ALREADY_DONE'
  /** Role assignment does not match the standard board. */
  | 'INVALID_LINEUP';

export class GameError extends Error {
  constructor(
    public readonly code: GameErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GameError';
  }
}
