import type { Seat } from '@werewolf/engine';
import type { Room } from '../room';

/**
 * Scripted moves over a fixed-deck Room (see fixtures.ts: wolves 1-4,
 * villagers 5-8, seer 9, witch 10, hunter 11, idiot 12). Every helper applies
 * only legal actions for the room's current phase — a throw here means the
 * script itself is wrong, which is the point.
 */

function livingWolfSeats(room: Room): Seat[] {
  return Object.values(room.state.players)
    .filter((p) => p.alive && p.role === 'werewolf')
    .map((p) => p.seat)
    .sort((a, b) => a - b);
}

/** All living wolves vote the same kill target (unanimous -> resolved). */
export function nightKill(room: Room, target: Seat): void {
  for (const w of livingWolfSeats(room)) {
    room.applyPlayerAction({ type: 'WOLF_KILL', actor: w, target });
  }
}

export function witchPass(room: Room): void {
  room.applyPlayerAction({ type: 'WITCH_PASS', actor: 10 });
}

export function seerCheck(room: Room, target: Seat): void {
  room.applyPlayerAction({ type: 'SEER_CHECK', actor: 9, target });
}

/** Signup -> candidacy speeches -> unanimous 警下 vote. Ends at dawn-announce. */
export function holdElection(room: Room, candidates: Seat[], winner: Seat): void {
  for (const c of candidates) {
    room.applyPlayerAction({ type: 'SHERIFF_SIGNUP', actor: c });
  }
  room.proceed(); // close signup -> sheriff-speech
  for (const c of candidates) {
    room.applyPlayerAction({ type: 'SPEAK', actor: c, text: `candidacy ${c}` });
    room.proceed();
  }
  const electorate = room.state.vote?.electorate ?? [];
  for (const voter of electorate) {
    room.applyPlayerAction({ type: 'SHERIFF_VOTE', actor: voter, target: winner });
  }
}

/** Runs the whole speech round, setting the sheriff's direction when needed. */
export function runSpeech(room: Room): void {
  const state = room.state;
  if (state.phase !== 'speech') throw new Error(`runSpeech called in phase ${state.phase}`);
  if (state.speech?.order === null) {
    const sheriff = Object.values(state.players).find((p) => p.hasBadge && p.alive);
    if (sheriff) {
      room.applyPlayerAction({
        type: 'SET_SPEECH_DIRECTION',
        actor: sheriff.seat,
        direction: 'cw',
      });
    }
  }
  const order = room.state.speech?.order ?? [];
  for (const seat of order) {
    room.applyPlayerAction({ type: 'SPEAK', actor: seat, text: `speech ${seat}` });
    room.proceed();
  }
}

/** Every eligible voter casts the same exile ballot. */
export function unanimousExile(room: Room, target: Seat): void {
  const electorate = room.state.vote?.electorate ?? [];
  for (const voter of electorate) {
    room.applyPlayerAction({ type: 'EXILE_VOTE', actor: voter, target });
  }
}

/** Night-1 last words for the given seat, then hand the floor on. */
export function lastWords(room: Room, seat: Seat): void {
  room.applyPlayerAction({ type: 'SPEAK', actor: seat, text: `last words ${seat}` });
  room.proceed();
}
