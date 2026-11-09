// Room = one authoritative match. Pure game logic: it never touches sockets directly,
// only PlayerLink.send()/sendRaw() of the sessions that joined.

import {
  AC,
  ATTACK_COOLDOWN_MS,
  ATTACK_REACH,
  Act,
  BUILDING_DEFS,
  BUILDING_KINDS,
  BUILD_RANGE,
  CORE_HALF,
  HARVEST_COOLDOWN_MS,
  HARVEST_REACH,
  INTERMISSION_SECONDS,
  MAX_PLAYERS_PER_ROOM,
  Mask,
  PLAYER_ATTACK_DAMAGE,
  PLAYER_COLORS,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  PLAYER_RESPAWN_MS,
  RESOURCE_DEFS,
  RESOURCE_NAMES,
  ROOM_RESET_SECONDS,
  TICK_DT,
  TICK_MS,
  TICK_RATE,
  cellCenter,
  dist,
  emptyInventory,
  round2,
  stepPlayer,
  type BuildingKind,
  type ClientMessage,
  type GameConfig,
  type GameEvent,
  type GamePhase,
  type Inventory,
  type MobState,
  type PhaseUpdateMsg,
  type PlayerState,
  type RoomInfo,
  type ServerMessage,
  type SnapshotMsg,
} from '@surviver/shared';
import type { AcSubject, AntiCheatEngine } from '../anticheat/AntiCheatEngine';
import type { Building, Mob, Player } from './entities';
import { Horde } from './Horde';
import { CORE_ID, World } from './World';

export interface RoomSession extends AcSubject {
  accountUsername: string | null;
}

export interface RoomConfig {
  prepSeconds: number;
  totalWaves: number;
  allowDebug: boolean;
  seed: number;
}

export interface RoomHooks {
  onGameOver(room: Room, result: 'victory' | 'defeat', players: Player[]): void;
}

const MAX_QUEUE = AC.MAX_INPUT_QUEUE + 20; // moves + actions

export class Room {
  tick = 0;
  private idCounter = 100;
  readonly nextId = () => ++this.idCounter;
  world: World;
  readonly players = new Map<number, Player>();
  readonly mobs = new Map<number, Mob>();
  readonly horde = new Horde(this);
  phase: GamePhase = 'prep';
  phaseEndsAt: number | null;
  wave = 0;
  intermission = false;
  result: 'victory' | 'defeat' | null = null;
  events: GameEvent[] = [];
  private dirtyBuildings = new Set<number>();
  private removedBuildings: number[] = [];
  private dirtyResources = new Set<number>();
  private removedResources: number[] = [];
  private lastPhaseBroadcast = 0;
  readonly createdAt = Date.now();
  lastTickMs = 0;

  constructor(
    readonly id: string,
    readonly cfg: RoomConfig,
    private readonly ac: AntiCheatEngine,
    private readonly hooks: RoomHooks,
  ) {
    this.world = new World(cfg.seed, this.nextId);
    this.phaseEndsAt = Date.now() + cfg.prepSeconds * 1000;
  }

  get gameConfig(): GameConfig {
    return { prepSeconds: this.cfg.prepSeconds, totalWaves: this.cfg.totalWaves, debugAllowed: this.cfg.allowDebug, tickRate: TICK_RATE };
  }

  info(): RoomInfo {
    return { id: this.id, players: this.players.size, maxPlayers: MAX_PLAYERS_PER_ROOM, phase: this.phase, wave: this.wave, names: [...this.players.values()].map((p) => p.name) };
  }

  // ───────────────────────────── membership ─────────────────────────────

  addPlayer(session: RoomSession): Player | null {
    if (this.players.size >= MAX_PLAYERS_PER_ROOM) return null;
    const used = new Set([...this.players.values()].map((p) => p.color));
    const color = PLAYER_COLORS.find((c) => !used.has(c)) ?? PLAYER_COLORS[0];
    const p: Player = {
      id: this.nextId(),
      session,
      name: session.name,
      color,
      x: 0,
      z: 0,
      yaw: 0,
      hp: PLAYER_MAX_HP,
      dead: false,
      respawnAt: 0,
      act: Act.Idle,
      actUntil: 0,
      inv: emptyInventory(),
      queue: [],
      moveBudget: 1,
      lastProcessedSeq: session.ac.lastSeq,
      simMs: 0,
      lastHarvestSim: -1e9,
      lastAttackSim: -1e9,
      lastBuildSim: -1e9,
      ready: false,
      stats: { kills: 0, harvested: 0, built: 0, deaths: 0, damage: 0 },
    };
    this.placeAtSpawn(p);
    this.players.set(p.id, p);
    session.roomId = this.id;
    session.ac.lastClaimed = null;
    this.sendJoined(p);
    this.systemChat(`${p.name} присоединился`);
    this.broadcastPhase();
    return p;
  }

  removePlayer(p: Player) {
    if (!this.players.delete(p.id)) return;
    p.session.roomId = null;
    this.systemChat(`${p.name} вышел`);
    this.broadcastPhase();
  }

  private sendJoined(p: Player) {
    p.session.link.send({
      type: 'ROOM_JOINED',
      roomId: this.id,
      playerId: p.id,
      seed: this.world.seed,
      mapHalf: 50,
      config: this.gameConfig,
      world: {
        resources: [...this.world.resources.values()].map((r) => this.world.resourceState(r)),
        buildings: [...this.world.buildings.values()].map((b) => this.world.buildingState(b)),
        core: { ...this.world.core },
      },
    });
  }

  private placeAtSpawn(p: Player) {
    const idx = [...this.players.keys()].indexOf(p.id);
    const base = (idx < 0 ? this.players.size : idx) * (Math.PI / 2) + Math.PI / 4;
    for (let r = CORE_HALF + 1.5; r < 30; r += 1) {
      for (let a = 0; a < 8; a++) {
        const ang = base + (a * Math.PI) / 4;
        const x = Math.cos(ang) * r;
        const z = Math.sin(ang) * r;
        if (!this.world.collision.overlaps(x, z, PLAYER_RADIUS + 0.05, Mask.Player)) {
          p.x = round2(x);
          p.z = round2(z);
          return;
        }
      }
    }
  }

  // ───────────────────────────── incoming intents ─────────────────────────────

  /** Called by the session layer for every validated message of a player in this room. */
  handle(p: Player, msg: ClientMessage) {
    const s = p.session;
    switch (msg.type) {
      case 'PLAYER_INPUT': {
        if (!this.ac.checkSeq(s, msg.seq, this.tick)) return;
        const moves = p.queue.reduce((n, a) => n + (a.type === 'PLAYER_INPUT' ? 1 : 0), 0);
        if (!this.ac.checkInputRate(s, moves, this.tick)) return;
        this.enqueue(p, { type: 'PLAYER_INPUT', seq: msg.seq, mx: msg.mx, mz: msg.mz, yaw: msg.yaw, px: msg.px, pz: msg.pz });
        return;
      }
      case 'INPUT_HARVEST':
      case 'INPUT_ATTACK':
        if (!this.ac.checkSeq(s, msg.seq, this.tick)) return;
        this.enqueue(p, { type: msg.type, seq: msg.seq, targetId: msg.targetId });
        return;
      case 'INPUT_BUILD':
        if (!this.ac.checkSeq(s, msg.seq, this.tick)) return;
        this.enqueue(p, { type: 'INPUT_BUILD', seq: msg.seq, kind: BUILDING_KINDS.indexOf(msg.kind) as BuildingKind, gx: msg.gx, gz: msg.gz });
        return;
      case 'READY':
        p.ready = msg.ready;
        this.systemChat(`${p.name}: ${msg.ready ? 'готов ✔' : 'не готов'}`);
        this.broadcastPhase();
        return;
      case 'CHAT':
        this.broadcast({ type: 'CHAT', from: p.name, text: msg.text.trim().slice(0, 120) });
        return;
      case 'DEBUG_COMMAND':
        if (!this.cfg.allowDebug) {
          this.ac.report(s, 'DEBUG_DISABLED', `debug command "${msg.cmd}" rejected: ALLOW_DEBUG=0`, 'medium', 'dropped', this.tick);
          return;
        }
        this.debugCommand(msg.cmd, p.name);
        return;
      default:
        return;
    }
  }

  private enqueue(p: Player, a: Player['queue'][number]) {
    if (p.queue.length >= MAX_QUEUE) {
      this.ac.report(p.session, 'RATE_LIMIT', `action queue overflow (${MAX_QUEUE})`, 'medium', 'dropped', this.tick, 1000);
      return;
    }
    p.queue.push(a);
  }

  debugCommand(cmd: string, by: string) {
    switch (cmd) {
      case 'skip_phase':
        if (this.phase === 'prep') this.startHorde();
        else if (this.phase === 'horde') {
          for (const m of this.mobs.values()) this.events.push({ e: 'death', id: m.id, k: 'mob' });
          this.mobs.clear();
          this.horde.clear();
          this.phaseEndsAt = Date.now();
        } else if (this.phase === 'ended') this.reset();
        break;
      case 'give_resources':
        for (const p of this.players.values()) for (const k of RESOURCE_NAMES) p.inv[k] += 20;
        break;
      case 'spawn_wave':
        this.horde.queueWave(Math.max(1, this.wave));
        break;
      case 'heal_core':
        this.world.core.hp = this.world.core.mhp;
        break;
      case 'reset':
        this.reset();
        break;
    }
    this.systemChat(`[debug] ${by}: ${cmd}`);
    this.broadcastPhase();
  }

  // ───────────────────────────── simulation ─────────────────────────────

  update(now: number) {
    const t0 = performance.now();
    this.tick++;
    this.updatePhase(now);
    for (const p of this.players.values()) this.updatePlayer(p, now);
    if (this.phase === 'horde' || this.mobs.size) this.horde.update(TICK_DT, now);
    if (this.phase === 'horde' && this.world.core.hp <= 0) this.endGame('defeat');
    this.broadcastSnapshot(now);
    if (now - this.lastPhaseBroadcast >= 1000) this.broadcastPhase();
    this.lastTickMs = performance.now() - t0;
  }

  private updatePhase(now: number) {
    if (this.phase === 'prep') {
      const allReady = this.players.size > 0 && [...this.players.values()].every((p) => p.ready);
      if (allReady || (this.phaseEndsAt !== null && now >= this.phaseEndsAt)) this.startHorde();
    } else if (this.phase === 'horde') {
      const cleared = this.mobs.size === 0 && this.horde.spawnQueue.length === 0;
      if (!this.intermission && cleared) {
        if (this.wave >= this.cfg.totalWaves) return this.endGame('victory');
        this.intermission = true;
        this.phaseEndsAt = now + INTERMISSION_SECONDS * 1000;
        this.systemChat(`Волна ${this.wave} отбита! Следующая через ${INTERMISSION_SECONDS} с`);
        this.broadcastPhase();
      } else if (this.intermission && this.phaseEndsAt !== null && now >= this.phaseEndsAt) {
        this.nextWave();
      }
    } else if (this.phase === 'ended' && this.phaseEndsAt !== null && now >= this.phaseEndsAt) {
      this.reset();
    }
  }

  private startHorde() {
    this.phase = 'horde';
    this.wave = 0;
    for (const p of this.players.values()) p.ready = false;
    this.systemChat('Орда приближается! Защищайте Ядро!');
    this.nextWave();
  }

  private nextWave() {
    this.wave++;
    this.intermission = false;
    this.phaseEndsAt = null;
    this.horde.queueWave(this.wave);
    this.broadcastPhase();
  }

  private endGame(result: 'victory' | 'defeat') {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.result = result;
    this.intermission = false;
    this.phaseEndsAt = Date.now() + ROOM_RESET_SECONDS * 1000;
    const players = [...this.players.values()];
    this.broadcast({
      type: 'GAME_OVER',
      result,
      wave: this.wave,
      stats: players.map((p) => ({ playerId: p.id, name: p.name, ...p.stats })),
    });
    this.hooks.onGameOver(this, result, players);
    this.broadcastPhase();
  }

  /** New match in the same room: same seed (fixed map), fresh state. */
  reset() {
    this.world = new World(this.cfg.seed, this.nextId);
    this.mobs.clear();
    this.horde.clear();
    this.phase = 'prep';
    this.wave = 0;
    this.result = null;
    this.intermission = false;
    this.phaseEndsAt = Date.now() + this.cfg.prepSeconds * 1000;
    this.dirtyBuildings.clear();
    this.removedBuildings = [];
    this.dirtyResources.clear();
    this.removedResources = [];
    for (const p of this.players.values()) {
      p.hp = PLAYER_MAX_HP;
      p.dead = false;
      p.inv = emptyInventory();
      p.ready = false;
      p.stats = { kills: 0, harvested: 0, built: 0, deaths: 0, damage: 0 };
      this.placeAtSpawn(p);
      this.sendJoined(p);
    }
    this.systemChat('Новый матч! Фаза подготовки.');
    this.broadcastPhase();
  }

  private updatePlayer(p: Player, now: number) {
    if (p.dead && now >= p.respawnAt) {
      p.dead = false;
      p.hp = PLAYER_MAX_HP;
      this.placeAtSpawn(p);
    }
    if (p.act !== Act.Idle && now >= p.actUntil) p.act = Act.Idle;

    // Process queued intents strictly in client order. Movement consumes a per-tick budget
    // (1 per tick, up to AC.MOVE_BANK_TICKS banked so a lag-spike burst catches up at once)
    // => a client can never simulate faster than real time.
    p.moveBudget = Math.min(p.moveBudget + 1, AC.MOVE_BANK_TICKS);
    let movesThisTick = 0;
    while (p.queue.length) {
      const a = p.queue[0]!;
      if (a.type === 'PLAYER_INPUT') {
        if (p.moveBudget < 1 || movesThisTick >= AC.MAX_MOVES_PER_TICK) break;
        p.moveBudget--;
        movesThisTick++;
        p.queue.shift();
        this.processMove(p, a);
      } else {
        p.queue.shift();
        if (!p.dead) this.processAction(p, a, now);
      }
    }
  }

  private processMove(p: Player, a: Extract<Player['queue'][number], { type: 'PLAYER_INPUT' }>) {
    const s = p.session;
    p.lastProcessedSeq = a.seq;
    p.simMs += TICK_MS;
    if (p.dead) return;
    const m = this.ac.checkMoveVector(s, a.mx, a.mz, this.tick);
    const ox = p.x;
    const oz = p.z;
    stepPlayer(p, m.mx, m.mz, TICK_DT, this.world.collision);
    // Server-side v·Δt sanity of our own result (collision push-outs are bounded too).
    if (dist(ox, oz, p.x, p.z) > 6 * TICK_DT * 2.5) {
      p.x = ox;
      p.z = oz;
    }
    p.yaw = a.yaw;
    if (this.ac.checkClaimedPosition(s, p, a.px, a.pz, this.tick)) {
      s.link.send({ type: 'SERVER_RECONCILE', seq: a.seq, x: round2(p.x), z: round2(p.z), reason: 'position rejected by server' });
    }
  }

  private processAction(p: Player, a: Exclude<Player['queue'][number], { type: 'PLAYER_INPUT' }>, now: number) {
    const s = p.session;
    const tick = this.tick;
    switch (a.type) {
      case 'INPUT_HARVEST': {
        const r = this.world.resources.get(a.targetId);
        if (!r) {
          this.ac.report(s, 'INVALID_TARGET', `harvest target #${a.targetId} does not exist`, 'low', 'dropped', tick, 500);
          return;
        }
        if (!this.ac.checkCooldown(s, 'harvest', p.simMs, p.lastHarvestSim, HARVEST_COOLDOWN_MS, tick)) return;
        if (!this.ac.checkReach(s, 'harvest', dist(p.x, p.z, r.x, r.z) - r.r, HARVEST_REACH, tick)) return;
        p.lastHarvestSim = p.simMs;
        const take = Math.min(RESOURCE_DEFS[r.k].yieldPerHit, r.amt);
        r.amt -= take;
        const res = RESOURCE_NAMES[r.k];
        p.inv[res] += take;
        p.stats.harvested += take;
        p.act = Act.Harvest;
        p.actUntil = now + 300;
        p.yaw = Math.atan2(r.x - p.x, r.z - p.z);
        this.events.push({ e: 'harvest', id: r.id, by: p.id, res: r.k });
        if (r.amt <= 0) {
          this.world.removeResource(r.id);
          this.removedResources.push(r.id);
          this.dirtyResources.delete(r.id);
        } else this.dirtyResources.add(r.id);
        return;
      }
      case 'INPUT_ATTACK': {
        const m = this.mobs.get(a.targetId);
        if (!m) {
          // Usually the mob simply died in the meantime: not punished, just ignored.
          if (a.targetId > this.idCounter) this.ac.report(s, 'INVALID_TARGET', `attack target #${a.targetId} never existed`, 'low', 'dropped', tick, 500);
          return;
        }
        if (!this.ac.checkCooldown(s, 'attack', p.simMs, p.lastAttackSim, ATTACK_COOLDOWN_MS, tick)) return;
        // Lag compensation: the client saw the mob up to ~1 interpolation delay in the past,
        // so accept the closest of the mob's recent positions.
        let d = dist(p.x, p.z, m.x, m.z);
        for (const h of m.history) d = Math.min(d, dist(p.x, p.z, h.x, h.z));
        if (!this.ac.checkReach(s, 'attack', d - m.def.radius, ATTACK_REACH, tick)) return;
        p.lastAttackSim = p.simMs;
        p.act = Act.Attack;
        p.actUntil = now + 300;
        p.yaw = Math.atan2(m.x - p.x, m.z - p.z);
        this.damageMob(m, PLAYER_ATTACK_DAMAGE, p.id, true);
        return;
      }
      case 'INPUT_BUILD': {
        const def = BUILDING_DEFS[a.kind];
        if (!this.ac.checkCooldown(s, 'build', p.simMs, p.lastBuildSim, 150, tick)) return;
        const d = dist(p.x, p.z, cellCenter(a.gx), cellCenter(a.gz));
        if (!this.ac.checkBuildRange(s, d, BUILD_RANGE, tick)) return;
        if (!this.ac.checkResources(s, p.inv, def.cost, `build ${def.name}`, tick)) return;
        const reason = this.world.cellBlockedReason(a.gx, a.gz) ?? (def.solid ? this.entityInCell(a.gx, a.gz) : null);
        if (reason) {
          this.ac.report(s, 'BUILD_BLOCKED', `cell (${a.gx},${a.gz}): ${reason}`, 'low', 'dropped', tick, 250);
          return;
        }
        for (const k of Object.keys(def.cost) as (keyof Inventory)[]) p.inv[k] -= def.cost[k] ?? 0;
        const b = this.world.addBuilding(a.kind, a.gx, a.gz, p.id);
        p.lastBuildSim = p.simMs;
        p.stats.built++;
        p.act = Act.Build;
        p.actUntil = now + 300;
        this.dirtyBuildings.add(b.id);
        this.events.push({ e: 'built', id: b.id, by: p.id });
        return;
      }
    }
  }

  private entityInCell(gx: number, gz: number): string | null {
    const cx = cellCenter(gx);
    const cz = cellCenter(gz);
    const inside = (x: number, z: number, r: number) => Math.abs(x - cx) < 1 + r && Math.abs(z - cz) < 1 + r;
    for (const p of this.players.values()) if (!p.dead && inside(p.x, p.z, PLAYER_RADIUS)) return 'a player is standing there';
    for (const m of this.mobs.values()) if (inside(m.x, m.z, m.def.radius)) return 'a creature is standing there';
    return null;
  }

  // ───────────────────────────── damage ─────────────────────────────

  damageMob(m: Mob, dmg: number, by: number, byPlayer: boolean) {
    if (m.hp <= 0) return;
    m.hp -= dmg;
    if (byPlayer || dmg >= 5) this.events.push({ e: 'hit', id: m.id, by, dmg: Math.round(dmg) });
    const p = byPlayer ? this.players.get(by) : undefined;
    if (p) p.stats.damage += dmg;
    if (m.hp <= 0) {
      this.mobs.delete(m.id);
      this.events.push({ e: 'death', id: m.id, k: 'mob' });
      if (p) p.stats.kills++;
    }
  }

  damagePlayer(p: Player, dmg: number, by: number) {
    if (p.dead) return;
    p.hp -= dmg;
    this.events.push({ e: 'hit', id: p.id, by, dmg });
    if (p.hp <= 0) {
      p.hp = 0;
      p.dead = true;
      p.respawnAt = Date.now() + PLAYER_RESPAWN_MS;
      p.stats.deaths++;
      p.queue = p.queue.filter((a) => a.type === 'PLAYER_INPUT');
      this.events.push({ e: 'death', id: p.id, k: 'player' });
    }
  }

  damageBuilding(b: Building, dmg: number) {
    if (!this.world.buildings.has(b.id)) return;
    b.hp -= dmg;
    this.dirtyBuildings.add(b.id);
    if (b.hp <= 0) {
      this.world.removeBuilding(b.id);
      this.dirtyBuildings.delete(b.id);
      this.removedBuildings.push(b.id);
      this.events.push({ e: 'death', id: b.id, k: 'building' });
    }
  }

  damageCore(dmg: number) {
    this.world.core.hp = Math.max(0, this.world.core.hp - dmg);
    this.events.push({ e: 'core_hit', dmg });
  }

  // ───────────────────────────── outgoing ─────────────────────────────

  broadcast(msg: ServerMessage) {
    const json = JSON.stringify(msg);
    for (const p of this.players.values()) p.session.link.sendRaw(json);
  }

  systemChat(text: string) {
    this.broadcast({ type: 'CHAT', from: 'Сервер', text, system: true });
  }

  phaseMsg(): PhaseUpdateMsg {
    return {
      type: 'GAME_PHASE_UPDATE',
      phase: this.phase,
      endsAt: this.phaseEndsAt,
      wave: this.wave,
      totalWaves: this.cfg.totalWaves,
      intermission: this.intermission,
      ready: [...this.players.values()].filter((p) => p.ready).length,
      players: this.players.size,
      mobsAlive: this.mobs.size + this.horde.spawnQueue.length,
    };
  }

  broadcastPhase() {
    this.lastPhaseBroadcast = Date.now();
    this.broadcast(this.phaseMsg());
  }

  private broadcastSnapshot(now: number) {
    const players: PlayerState[] = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      x: round2(p.x),
      z: round2(p.z),
      yaw: round2(p.yaw),
      hp: Math.ceil(p.hp),
      dead: p.dead,
      act: p.act,
      color: p.color,
    }));
    const mobs: MobState[] = [...this.mobs.values()].map((m) => ({
      id: m.id,
      k: m.k,
      x: round2(m.x),
      z: round2(m.z),
      yaw: round2(m.yaw),
      hp: Math.ceil(m.hp),
      mhp: m.def.hp,
      a: now < m.attackAnimUntil ? 1 : 0,
    }));
    const base: Omit<SnapshotMsg, 'ack' | 'inv'> = {
      type: 'WORLD_STATE_SNAPSHOT',
      tick: this.tick,
      time: now,
      players,
      mobs,
      core: { hp: Math.ceil(this.world.core.hp), mhp: this.world.core.mhp },
      ev: this.events,
    };
    if (this.dirtyBuildings.size) base.buildings = [...this.dirtyBuildings].flatMap((id) => {
      const b = this.world.buildings.get(id);
      return b ? [this.world.buildingState(b)] : [];
    });
    if (this.removedBuildings.length) base.removedBuildings = this.removedBuildings;
    if (this.dirtyResources.size) base.resources = [...this.dirtyResources].flatMap((id) => {
      const r = this.world.resources.get(id);
      return r ? [this.world.resourceState(r)] : [];
    });
    if (this.removedResources.length) base.removedResources = this.removedResources;

    // Serialize the shared part once; splice in per-recipient fields (ack + private inventory).
    const shared = JSON.stringify(base).slice(1);
    for (const p of this.players.values()) {
      p.session.link.sendRaw(`{"ack":${p.lastProcessedSeq},"inv":${JSON.stringify(p.inv)},${shared}`);
    }
    this.events = [];
    this.dirtyBuildings.clear();
    this.removedBuildings = [];
    this.dirtyResources.clear();
    this.removedResources = [];
  }
}

export { CORE_ID };
