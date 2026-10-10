import { afterEach, describe, expect, it } from 'vitest';
import type { Seat } from '@werewolf/engine';
import { DEFAULT_TIMERS } from '../../defaults';
import { currentSpeechSlot, type SttConfig } from '../../voice';
import type { ClientToServerEvents, ServerToClientEvents } from '../../index';
import type { Socket } from 'socket.io-client';
import {
  connect,
  connectAll,
  createRoom,
  joinRoom,
  sendRaw,
  startRoom,
  startServer,
  stopServer,
  waitFor,
  type Rig,
} from './helpers';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const rigs: Rig[] = [];

async function freshRig(...args: Parameters<typeof startServer>): Promise<Rig> {
  const rig = await startServer(...args);
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  while (rigs.length > 0) {
    const rig = rigs.pop();
    if (rig) await stopServer(rig);
  }
});

const STT: SttConfig = {
  provider: 'openai',
  apiKey: 'sk-test',
  model: 'test-stt',
  language: 'zh-CN',
};

/** Clocks long enough that no expiry ever fires — the test paces the game itself. */
function quietTimers(overrides: Record<string, number> = {}): Record<string, number> {
  const timers: Record<string, number> = {};
  for (const key of Object.keys(DEFAULT_TIMERS)) timers[key] = 60_000;
  return { ...timers, ...overrides };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function roomOf(rig: Rig, code: string) {
  const room = rig.app.registry.get(code);
  if (!room) throw new Error(`room ${code} vanished from the registry`);
  return room;
}

/** A full 12-seat started table; seat N is mapped to the Nth connected socket. */
async function seatTwelve(rig: Rig): Promise<{ code: string; bySeat: Map<Seat, Client> }> {
  const creator = await connect(rig);
  const { roomCode } = await createRoom(creator.client);
  const joiners = await connectAll(rig, 11);
  const bySeat = new Map<Seat, Client>([[1, creator.client]]);
  for (const [i, j] of joiners.entries()) {
    const ack = await joinRoom(j.client, roomCode);
    if ('spectator' in ack) throw new Error('unexpected spectator join');
    if (ack.seat !== i + 2) throw new Error(`joiner ${i} landed in seat ${ack.seat}`);
    bySeat.set(ack.seat, j.client);
  }
  await startRoom(creator.client);
  return { code: roomCode, bySeat };
}

/**
 * Drives a full scripted game to game-over through real sockets, pacing the
 * PROCEED-only steps server-side (no expiry ever fires on quiet clocks).
 * Every speech slot is voiced by its seat and ended by that seat's own
 * client SPEAK. Wolves are exiled by unanimous ballot until the last one
 * dies with the camp — 屠边 ends the game at the ballot's resolution drain.
 * Returns the slot key of the last buffered frame.
 */
async function playVoicedGame(
  rig: Rig,
  code: string,
  bySeat: Map<Seat, Client>,
): Promise<string | null> {
  const frame = new TextEncoder().encode('fake-pcm-audio').buffer as ArrayBuffer;
  let lastFramedKey: string | null = null;
  const deadline = Date.now() + 25_000;
  const errors: string[] = [];
  for (const [seat, client] of bySeat) {
    client.on('game:error', (payload: unknown) => {
      errors.push(`seat ${seat}: ${JSON.stringify(payload)}`);
    });
  }

  for (;;) {
    const room = roomOf(rig, code);
    const state = room.state;
    if (state.winner !== null) return lastFramedKey;
    if (Date.now() > deadline) {
      throw new Error(
        `game did not finish in time (phase=${state.phase}, night=${state.night?.step ?? '-'}, ` +
          `day=${state.dayNumber}, log=${state.log.length}, ` +
          `speech=${state.speech ? `${state.speech.cursor}/${state.speech.order?.length}` : '-'}, ` +
          `vote=${state.vote ? `${Object.keys(state.vote.votes).length}/${state.vote.electorate.length}` : '-'}) ` +
          `recent game:error: ${errors.slice(-8).join(' | ') || 'none'}`,
      );
    }

    switch (state.phase) {
      case 'night': {
        const night = state.night;
        if (!night) throw new Error('night phase without night state');
        const alive = Object.values(state.players).filter((p) => p.alive);
        if (night.step === 'wolf') {
          // Only villagers ever die by night — the hunter, seer, and witch
          // survive, so no hunter-shot window ever opens in this flow.
          const target = alive.find((p) => p.role === 'villager');
          if (!target) throw new Error('no villager left for the wolf kill');
          for (const wolf of alive.filter((p) => p.role === 'werewolf')) {
            sendRaw(bySeat.get(wolf.seat)!, {
              type: 'WOLF_KILL',
              actor: wolf.seat,
              target: target.seat,
            });
          }
        } else if (night.step === 'witch') {
          const witch = alive.find((p) => p.role === 'witch');
          if (!witch) throw new Error('witch step with no living witch');
          // Night 2 the witch poisons the lowest-seat wolf: one wolf dies by
          // poison plus one per exile, so the wolf camp is wiped at the day-3
          // ballot — before the four night villager deaths could wipe the
          // villager camp (屠边 flips the winner). Every other night: pass.
          // The poison does not itself close the witch's turn — a follow-up
          // WITCH_PASS ends the step once the potion is spent.
          const poisonTarget =
            state.dayNumber === 2 && !night.poisonUsedTonight
              ? alive.find((p) => p.role === 'werewolf' && p.seat !== witch.seat)
              : undefined;
          if (poisonTarget) {
            sendRaw(bySeat.get(witch.seat)!, {
              type: 'WITCH_POISON',
              actor: witch.seat,
              target: poisonTarget.seat,
            });
          } else {
            sendRaw(bySeat.get(witch.seat)!, { type: 'WITCH_PASS', actor: witch.seat });
          }
        } else {
          const seer = alive.find((p) => p.role === 'seer');
          if (!seer) throw new Error('seer step with no living seer');
          const target = alive.find((p) => p.seat !== seer.seat);
          if (!target) throw new Error('no seer check target');
          sendRaw(bySeat.get(seer.seat)!, {
            type: 'SEER_CHECK',
            actor: seer.seat,
            target: target.seat,
          });
        }
        break;
      }
      case 'sheriff-signup':
      case 'dawn-announce':
        // Nobody signs up — the election voids; the dawn announcement passes.
        room.proceed();
        break;
      case 'exile-vote': {
        const vote = state.vote;
        if (!vote) throw new Error('exile-vote without vote state');
        const voter = vote.electorate.find((s) => vote.votes[s] === undefined);
        if (voter === undefined) {
          await sleep(5); // ballot resolves with the last vote — just yield
          break;
        }
        const alive = Object.values(state.players).filter((p) => p.alive);
        const target =
          alive.find((p) => p.role === 'werewolf' && p.seat !== voter) ??
          alive.find((p) => p.seat !== voter);
        if (!target) throw new Error('no exile target available');
        sendRaw(bySeat.get(voter)!, { type: 'EXILE_VOTE', actor: voter, target: target.seat });
        break;
      }
      case 'last-words':
      case 'speech':
      case 'pk-speech': {
        const slot = currentSpeechSlot(state);
        if (!slot) throw new Error(`${state.phase} without a speech slot`);
        bySeat.get(slot.seat)!.emit('voice:frame', frame);
        lastFramedKey = slot.key;
        // End the slot by the seat's own client SPEAK — the normal path —
        // then advance the cursor server-side before any expiry can.
        const before = state.log.length;
        sendRaw(bySeat.get(slot.seat)!, {
          type: 'SPEAK',
          actor: slot.seat,
          text: `发言 ${slot.seat}`,
        });
        await waitFor(() => roomOf(rig, code).state.log.length > before, 2000);
        room.proceed();
        break;
      }
      default:
        throw new Error(`unhandled phase ${state.phase}`);
    }
    await sleep(5);
  }
}

describe('speech-slot buffer lifecycle over real sockets', () => {
  it('drops a stale buffer when an expiry runs with no speech slot open', async () => {
    const rig = await freshRig(quietTimers({ speech: 300 }), {
      voice: { stt: STT, transcribe: async () => '转写文本' },
    });
    const { code, bySeat } = await seatTwelve(rig);
    const room = roomOf(rig, code);

    // Night 1 through real sockets; the election voids and the day-1 floor
    // opens server-side (PROCEED is server-injected — no expiry involved).
    await waitFor(() => room.state.phase === 'night', 2000);
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (room.state.phase !== 'night') break;
      if (Date.now() > deadline) throw new Error('night never resolved');
      const night = room.state.night;
      if (!night) throw new Error('night phase without night state');
      const alive = Object.values(room.state.players).filter((p) => p.alive);
      if (night.step === 'wolf') {
        const target = alive.find((p) => p.role === 'villager');
        if (!target) throw new Error('no villager left for the wolf kill');
        for (const wolf of alive.filter((p) => p.role === 'werewolf')) {
          sendRaw(bySeat.get(wolf.seat)!, {
            type: 'WOLF_KILL',
            actor: wolf.seat,
            target: target.seat,
          });
        }
      } else if (night.step === 'witch') {
        const witch = alive.find((p) => p.role === 'witch');
        if (!witch) throw new Error('witch step with no living witch');
        sendRaw(bySeat.get(witch.seat)!, { type: 'WITCH_PASS', actor: witch.seat });
      } else {
        const seer = alive.find((p) => p.role === 'seer');
        if (!seer) throw new Error('seer step with no living seer');
        const target = alive.find((p) => p.seat !== seer.seat);
        if (!target) throw new Error('no seer check target');
        sendRaw(bySeat.get(seer.seat)!, {
          type: 'SEER_CHECK',
          actor: seer.seat,
          target: target.seat,
        });
      }
      await sleep(5);
    }
    room.proceed(); // void election -> dawn-announce
    room.proceed(); // -> last-words
    const lwSlot = currentSpeechSlot(room.state);
    if (!lwSlot) throw new Error('last-words without a speech slot');
    const lwBefore = room.state.log.length;
    sendRaw(bySeat.get(lwSlot.seat)!, { type: 'SPEAK', actor: lwSlot.seat, text: '遗言' });
    await waitFor(() => room.state.log.length > lwBefore, 2000);
    room.proceed(); // -> speech

    // Buffer the day-1 slot, end it by the seat's own client SPEAK, then
    // advance past every remaining slot server-side so the only expiry that
    // fires does so with no speech slot open.
    const slot = currentSpeechSlot(room.state);
    if (!slot) throw new Error('speech phase without a slot');
    bySeat.get(slot.seat)!.emit('voice:frame', new TextEncoder().encode('fake-pcm-audio').buffer);
    const framedKey = slot.key; // the day-1 slot this test later proves is dropped
    const before = room.state.log.length;
    sendRaw(bySeat.get(slot.seat)!, { type: 'SPEAK', actor: slot.seat, text: '发言' });
    await waitFor(() => room.state.log.length > before, 2000);
    while (room.state.phase === 'speech') room.proceed();
    expect(room.state.phase).toBe('exile-vote');

    await sleep(400); // the SPEAK-armed 300ms clock fires in exile-vote
    expect(rig.app.voiceHub.takeBuffer(code, framedKey)).toBeNull();
  }, 15_000);

  it('leaves no buffer for the room at game-over when the final slot ended by client SPEAK', async () => {
    const rig = await freshRig(quietTimers(), {
      voice: { stt: STT, transcribe: async () => '转写文本' },
    });
    const { code, bySeat } = await seatTwelve(rig);

    const lastFramedKey = await playVoicedGame(rig, code, bySeat);
    expect(lastFramedKey, 'the game should have voiced at least one slot').not.toBeNull();

    const room = roomOf(rig, code);
    expect(room.state.winner).toBe('good');
    expect(room.state.phase).toBe('game-over');
    // Audio never outlives its slot: the game-over transition drops the hub's
    // last buffer even though no expiry ever ran after the final SPEAK.
    expect(rig.app.voiceHub.takeBuffer(code, lastFramedKey!)).toBeNull();
  }, 30_000);
});
