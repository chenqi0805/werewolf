import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  connect,
  createRoom,
  joinRoom,
  playScriptedGame,
  scriptTimers,
  sleep,
  startRoom,
  startServer,
  stopServer,
  waitFor,
  type Client,
  type Connected,
} from './helpers';

/**
 * Bots over the wire: the host's add/remove controls, seat-fill order,
 * token custody (the raw token never leaves the server), the lobby-only
 * lifecycle, a full mixed human/scripted-bot game, and runner respawn
 * after a persistence restore.
 */

async function addBot(socket: Client): Promise<{ seat: number; name: string }> {
  return new Promise((resolve, reject) => {
    socket.emit('room:addBot', (resp) => {
      if ('error' in resp) reject(new Error(resp.error));
      else resolve(resp);
    });
  });
}

async function removeBot(socket: Client, seat: number): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.emit('room:removeBot', seat, (resp) => {
      if ('error' in resp) reject(new Error(resp.error));
      else resolve();
    });
  });
}

async function ackError(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected the ack to fail');
}

describe('bot lifecycle over the wire', () => {
  it('seats a bot, surfaces its identity, and never exposes the raw token', async () => {
    const rig = await startServer();
    try {
      const { client, rec } = await connect(rig);
      const created = await createRoom(client); // seat 1
      const ack = await addBot(client);
      expect(ack.seat).toBe(2);
      expect(ack.name).toBeTypeOf('string');
      expect(Object.keys(ack).sort()).toEqual(['name', 'seat']); // no token field
      await waitFor(() => rec.latest !== null);
      const row = rec.latest?.players.find((p) => p.seat === 2);
      expect(row?.isBot).toBe(true);
      expect(row?.botName).toBe(ack.name);
      expect(row?.occupied).toBe(true);
      expect(rig.app.botManager.runnerCount(created.roomCode)).toBe(1);
    } finally {
      await stopServer(rig);
    }
  });

  it('removes a bot, frees the seat, and reuses both on re-add', async () => {
    const rig = await startServer();
    try {
      const { client, rec } = await connect(rig);
      await createRoom(client);
      const first = await addBot(client);
      await removeBot(client, first.seat);
      await waitFor(
        () => rec.latest?.players.find((p) => p.seat === first.seat)?.occupied === false,
      );
      const freed = rec.latest?.players.find((p) => p.seat === first.seat);
      expect(freed?.isBot).toBe(false);
      const second = await addBot(client);
      expect(second.seat).toBe(first.seat);
      expect(second.name).toBe(first.name); // the freed nickname is reused
    } finally {
      await stopServer(rig);
    }
  });

  it('fills seats in join order — the bot takes the lowest free seat', async () => {
    const rig = await startServer();
    try {
      const { client } = await connect(rig);
      const created = await createRoom(client); // seat 1
      const second = await connect(rig);
      await joinRoom(second.client, created.roomCode); // seat 2
      const bot = await addBot(client);
      expect(bot.seat).toBe(3); // the lowest free seat, exactly like a human join
      expect(bot.name).not.toBe('');
    } finally {
      await stopServer(rig);
    }
  });

  it('rejects removal of a human seat and is lobby-only after start', async () => {
    const rig = await startServer();
    try {
      const clients: Connected[] = [];
      for (let i = 0; i < 12; i++) clients.push(await connect(rig));
      const host = clients[0]!;
      const created = await createRoom(host.client);
      for (let i = 1; i < 11; i++) await joinRoom(clients[i]!.client, created.roomCode);
      const bot = await addBot(host.client); // 12 filled: creator + 10 joins + 1 bot
      expect(await ackError(removeBot(host.client, 1))).toBe('NOT_A_BOT');
      await startRoom(host.client);
      expect(await ackError(addBot(host.client))).toBe('ALREADY_STARTED');
      expect(await ackError(removeBot(host.client, bot.seat))).toBe('ALREADY_STARTED');
    } finally {
      await stopServer(rig);
    }
  });
});

describe('mixed human/scripted-bot game', () => {
  it('plays a full 11-human + 1-bot game to a win', async () => {
    const rig = await startServer();
    try {
      const humans: Connected[] = [];
      for (let i = 0; i < 11; i++) humans.push(await connect(rig));
      const host = humans[0]!;
      const created = await createRoom(host.client);
      for (let i = 1; i < 11; i++) await joinRoom(humans[i]!.client, created.roomCode);
      await addBot(host.client); // seat 12, runner-driven
      await startRoom(host.client);
      await playScriptedGame(rig, 50_000);
      const finals = humans
        .map((h) => h.rec.latest)
        .filter((v) => v?.phase === 'game-over' && v.winner !== null);
      expect(finals.length).toBe(11); // every human client saw a decided game
    } finally {
      await stopServer(rig);
    }
  });
});

describe('restore respawn', () => {
  it('respawns runners for restored bot seats and keeps the lobby correct', async () => {
    const dbPath = resolve(tmpdir(), `werewolf-bots-${randomUUID()}.db`);
    const rig1 = await startServer(scriptTimers(), { dbPath });
    let code = '';
    try {
      const { client } = await connect(rig1);
      const created = await createRoom(client);
      code = created.roomCode;
      await addBot(client); // bot takes seat 2
    } finally {
      await stopServer(rig1);
    }
    const rig2 = await startServer(scriptTimers(), { dbPath });
    try {
      await waitFor(() => rig2.app.botManager.runnerCount(code) === 1, 3000);
      await sleep(600); // let the respawned runner finish reattaching
      expect(rig2.app.botManager.runnerCount(code)).toBe(1); // a bad token would have retired it
      const { client, rec } = await connect(rig2);
      const ack = await joinRoom(client, code);
      expect(ack.seat).toBe(3); // seat 1 (creator) and seat 2 (bot) are held
      await waitFor(() => rec.latest !== null);
      const row = rec.latest?.players.find((p) => p.seat === 2);
      expect(row?.isBot).toBe(true);
    } finally {
      await stopServer(rig2);
      await Promise.all(
        [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((f) => rm(f, { force: true })),
      );
    }
  });
});
