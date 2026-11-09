// Session/lobby layer: glues network connections to rooms. Handles the handshake, room membership,
// PING/PONG and routes validated game intents to the player's Room.

import { MAX_PLAYERS_PER_ROOM, PROTOCOL_VERSION, TICK_RATE, type ClientMessage, type RoomInfo } from '@surviver/shared';
import type { AccountStore } from './accounts/AccountStore';
import { newAcState, type AntiCheatEngine } from './anticheat/AntiCheatEngine';
import type { ServerConfig } from './config';
import type { Player } from './game/entities';
import { Room, type RoomSession } from './game/Room';
import type { Connection, ConnectionHandler } from './net/Connection';

export interface Session extends RoomSession {
  link: Connection;
  hello: boolean;
  room: Room | null;
  player: Player | null;
}

export class Lobby implements ConnectionHandler {
  readonly sessions = new Map<number, Session>();
  readonly rooms = new Map<string, Room>();
  private roomCounter = 0;

  constructor(
    private readonly cfg: ServerConfig,
    private readonly ac: AntiCheatEngine,
    private readonly accounts: AccountStore,
  ) {}

  private session(conn: Connection): Session {
    let s = this.sessions.get(conn.id);
    if (!s) {
      s = { link: conn, ac: newAcState(), name: `guest${conn.id}`, roomId: null, accountUsername: null, hello: false, room: null, player: null };
      this.sessions.set(conn.id, s);
    }
    return s;
  }

  onProtocolViolation(conn: Connection, kind: 'RATE_LIMIT' | 'MALFORMED_PACKET', detail: string) {
    const s = this.session(conn);
    this.ac.report(s, kind, detail, kind === 'RATE_LIMIT' ? 'medium' : 'low', 'dropped', s.room?.tick ?? 0, kind === 'MALFORMED_PACKET' ? 300 : 0);
  }

  onClose(conn: Connection) {
    const s = this.sessions.get(conn.id);
    if (!s) return;
    this.leaveRoom(s);
    this.sessions.delete(conn.id);
  }

  onMessage(conn: Connection, msg: ClientMessage) {
    const s = this.session(conn);
    if (msg.type === 'PING') {
      conn.send({ type: 'PONG', id: msg.id, ts: msg.ts, serverTime: Date.now() });
      return;
    }
    if (msg.type === 'HELLO') return this.hello(s, msg.v, msg.name, msg.token);
    if (!s.hello) {
      conn.send({ type: 'ERROR', code: 'NO_HELLO', message: 'Send HELLO first' });
      return;
    }
    switch (msg.type) {
      case 'JOIN_ROOM':
        return this.joinRoom(s, msg.roomId);
      case 'LEAVE_ROOM':
        return this.leaveRoom(s);
      default:
        if (!s.room || !s.player) {
          conn.send({ type: 'ERROR', code: 'NOT_IN_ROOM', message: `${msg.type} requires a room` });
          return;
        }
        s.room.handle(s.player, msg);
    }
  }

  private hello(s: Session, v: number, name: string, token?: string) {
    if (v !== PROTOCOL_VERSION) {
      s.link.send({ type: 'ERROR', code: 'VERSION', message: `Protocol v${PROTOCOL_VERSION} required, got v${v}` });
      s.link.close(4000, 'protocol version');
      return;
    }
    const acc = this.accounts.byToken(token);
    if (acc?.banned) {
      s.link.send({ type: 'ERROR', code: 'BANNED', message: 'Аккаунт заблокирован' });
      s.link.close(4004, 'banned');
      return;
    }
    s.hello = true;
    s.accountUsername = acc?.username ?? null;
    s.name = acc?.username ?? name.trim();
    if (acc) this.accounts.touch(acc.username);
    s.link.send({
      type: 'WELCOME',
      clientId: s.link.id,
      name: s.name,
      account: acc ? { username: acc.username } : null,
      tickRate: TICK_RATE,
      serverTime: Date.now(),
      debugAllowed: this.cfg.allowDebug,
    });
  }

  private joinRoom(s: Session, roomId?: string) {
    this.leaveRoom(s);
    let room: Room | undefined;
    if (roomId) {
      room = this.rooms.get(roomId) ?? this.createRoom(roomId);
    } else {
      room = [...this.rooms.values()]
        .filter((r) => r.players.size < MAX_PLAYERS_PER_ROOM && r.phase !== 'ended')
        .sort((a, b) => (a.phase === 'prep' ? 0 : 1) - (b.phase === 'prep' ? 0 : 1) || b.players.size - a.players.size)[0];
      room ??= this.createRoom();
    }
    const p = room.addPlayer(s);
    if (!p) {
      s.link.send({ type: 'ERROR', code: 'ROOM_FULL', message: `Комната ${room.id} заполнена` });
      return;
    }
    s.room = room;
    s.player = p;
  }

  leaveRoom(s: Session) {
    if (!s.room || !s.player) return;
    const room = s.room;
    room.removePlayer(s.player);
    s.room = null;
    s.player = null;
    if (room.players.size === 0) this.rooms.delete(room.id);
  }

  createRoom(id?: string) {
    const roomId = id ?? `room-${(++this.roomCounter).toString().padStart(3, '0')}`;
    const room = new Room(
      roomId,
      { prepSeconds: this.cfg.prepSeconds, totalWaves: this.cfg.totalWaves, allowDebug: this.cfg.allowDebug, seed: this.cfg.mapSeed },
      this.ac,
      {
        onGameOver: (r, result, players) => {
          for (const p of players) {
            if (p.session.accountUsername) this.accounts.recordMatch(p.session.accountUsername, result === 'victory', r.wave, p.stats);
          }
          console.log(`[room ${r.id}] game over: ${result} at wave ${r.wave}`);
        },
      },
    );
    this.rooms.set(roomId, room);
    return room;
  }

  roomList(): RoomInfo[] {
    return [...this.rooms.values()].map((r) => r.info());
  }

  /** Fixed-step game loop for all rooms. */
  tickAll(now: number) {
    for (const room of this.rooms.values()) {
      try {
        room.update(now);
      } catch (e) {
        console.error(`[room ${room.id}] tick error`, e);
      }
    }
  }

  kick(clientId: number, reason: string) {
    const s = this.sessions.get(clientId);
    if (!s) return false;
    s.link.send({ type: 'ERROR', code: 'KICKED', message: reason });
    s.link.close(4005, 'kicked by admin');
    return true;
  }
}
