// Horde: wave composition, spawning and mob AI (vector movement to nearest player / Core,
// breaking buildings that block the path), plus building effects (spikes, turrets).

import {
  BuildingKind,
  CORE_HALF,
  MAP_HALF,
  MAX_MOBS,
  MOB_DEFS,
  Mask,
  MobKind,
  SPIKES_DPS,
  SPIKES_SLOW,
  SPIKES_WEAR_PER_SEC,
  TURRET_COOLDOWN_MS,
  TURRET_DAMAGE,
  TURRET_RANGE,
  clamp,
  dist,
  dist2,
  worldToCell,
  type Collider,
} from '@surviver/shared';
import type { Mob } from './entities';
import type { Room } from './Room';

const HISTORY_TICKS = 10;

/** Number of creatures of each kind for wave `n` (1-based), scaled by player count. */
export function waveComposition(n: number, totalWaves: number, players: number): MobKind[] {
  const pf = 1 + 0.6 * Math.max(0, players - 1);
  const runners = Math.round((3 + 2 * n) * pf);
  const grunts = Math.round((1 + 2 * n) * pf);
  const giants = Math.round((Math.floor(n / 2) + (n === totalWaves ? 1 : 0)) * (players > 2 ? 1.5 : 1));
  const list: MobKind[] = [];
  // interleave so that fast runners arrive first, giants last
  for (let i = 0; i < runners; i++) list.push(MobKind.Runner);
  for (let i = 0; i < grunts; i++) list.splice(Math.min(list.length, i * 2 + 2), 0, MobKind.Grunt);
  for (let i = 0; i < giants; i++) list.push(MobKind.Giant);
  return list;
}

export class Horde {
  spawnQueue: MobKind[] = [];
  private nextSpawnAt = 0;
  private spawnAngle = Math.random() * Math.PI * 2;
  private tmpHits: Collider[] = [];

  constructor(private readonly room: Room) {}

  queueWave(n: number) {
    this.spawnQueue.push(...waveComposition(n, this.room.cfg.totalWaves, Math.max(1, this.room.players.size)));
    // each wave comes mostly from one side of the map (rotates between waves)
    this.spawnAngle += 1.3 + Math.random();
  }

  clear() {
    this.spawnQueue = [];
  }

  update(dt: number, now: number) {
    this.spawn(now);
    this.updateMobs(dt, now);
    this.updateTurrets(now);
  }

  private spawn(now: number) {
    if (!this.spawnQueue.length || now < this.nextSpawnAt || this.room.mobs.size >= MAX_MOBS) return;
    const k = this.spawnQueue.shift()!;
    const def = MOB_DEFS[k];
    const ang = this.spawnAngle + (Math.random() - 0.5) * 1.6;
    const rad = MAP_HALF - 2;
    let x = Math.cos(ang) * rad;
    let z = Math.sin(ang) * rad;
    const p = this.room.world.collision.resolveCircle(x, z, def.radius, Mask.Mob);
    x = p.x;
    z = p.z;
    const id = this.room.nextId();
    const mob: Mob = {
      id,
      k,
      def,
      x,
      z,
      yaw: Math.atan2(-x, -z),
      hp: def.hp,
      targetPlayer: null,
      retargetAt: 0,
      nextAttackAt: 0,
      attackAnimUntil: 0,
      history: [],
      steer: id % 2 === 0 ? 1 : -1,
    };
    this.room.mobs.set(id, mob);
    this.nextSpawnAt = now + (k === MobKind.Giant ? 900 : 280);
  }

  private updateMobs(dt: number, now: number) {
    const room = this.room;
    const world = room.world;
    for (const m of room.mobs.values()) {
      const def = m.def;
      // ── target selection (nearest alive player in aggro range, otherwise the Core) ──
      if (now >= m.retargetAt) {
        m.retargetAt = now + 400;
        let best: number | null = null;
        let bestD = (m.targetPlayer !== null ? def.aggroRange * 1.5 : def.aggroRange) ** 2;
        for (const p of room.players.values()) {
          if (p.dead) continue;
          const d = dist2(m.x, m.z, p.x, p.z);
          if (d < bestD) {
            bestD = d;
            best = p.id;
          }
        }
        m.targetPlayer = best;
      }
      const tp = m.targetPlayer !== null ? room.players.get(m.targetPlayer) : undefined;
      if (tp && tp.dead) m.targetPlayer = null;

      let tx: number;
      let tz: number;
      let edge: number; // distance from mob edge to target surface
      if (tp && !tp.dead) {
        tx = tp.x;
        tz = tp.z;
        edge = dist(m.x, m.z, tx, tz) - def.radius - 0.45;
      } else {
        tx = clamp(m.x, -CORE_HALF, CORE_HALF);
        tz = clamp(m.z, -CORE_HALF, CORE_HALF);
        edge = dist(m.x, m.z, tx, tz) - def.radius;
      }

      // ── spikes under the mob: damage + slow + wear ──
      let speed = def.speed;
      const sb = world.buildingAtCell(worldToCell(m.x), worldToCell(m.z));
      if (sb && sb.k === BuildingKind.Spikes) {
        speed *= SPIKES_SLOW;
        room.damageMob(m, SPIKES_DPS * dt, sb.owner, false);
        room.damageBuilding(sb, SPIKES_WEAR_PER_SEC * dt * (m.k === MobKind.Giant ? 4 : 1));
        if (m.hp <= 0) continue;
      }

      // ── attack target in reach ──
      if (edge <= def.reach) {
        m.yaw = Math.atan2(tx - m.x, tz - m.z);
        if (now >= m.nextAttackAt) {
          m.nextAttackAt = now + def.attackCooldownMs;
          m.attackAnimUntil = now + 350;
          if (tp && !tp.dead) room.damagePlayer(tp, def.damage, m.id);
          else room.damageCore(def.damage * def.buildingDamageMul);
          room.events.push({ e: 'mob_attack', id: m.id, target: tp ? tp.id : 1 });
        }
        this.recordHistory(m);
        continue;
      }

      // ── vector movement toward target ──
      let dx = tx - m.x;
      let dz = tz - m.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      const step = speed * dt;
      const ox = m.x;
      const oz = m.z;
      this.tmpHits.length = 0;
      let p = world.collision.resolveCircle(m.x + dx * step, m.z + dz * step, def.radius, Mask.Mob, this.tmpHits);
      const moved = dist(ox, oz, p.x, p.z);
      if (moved < step * 0.45 && this.tmpHits.length) {
        // blocked: a building in the path gets attacked, a tree/rock gets walked around
        const blocker = this.tmpHits.find((h) => h.tag === 'building') ?? this.tmpHits.find((h) => h.tag === 'core');
        if (blocker) {
          m.yaw = Math.atan2(blocker.x - m.x, blocker.z - m.z);
          if (now >= m.nextAttackAt) {
            m.nextAttackAt = now + def.attackCooldownMs;
            m.attackAnimUntil = now + 350;
            if (blocker.tag === 'core') room.damageCore(def.damage * def.buildingDamageMul);
            else {
              const b = world.buildings.get(blocker.id);
              if (b) room.damageBuilding(b, def.damage * def.buildingDamageMul);
            }
            room.events.push({ e: 'mob_attack', id: m.id, target: blocker.id });
          }
        } else {
          const obstacle = this.tmpHits[0]!;
          // tangent around the obstacle, keep turning the same way to avoid oscillation
          let nx = m.x - obstacle.x;
          let nz = m.z - obstacle.z;
          const nl = Math.hypot(nx, nz) || 1;
          nx /= nl;
          nz /= nl;
          const tx2 = -nz * m.steer;
          const tz2 = nx * m.steer;
          p = world.collision.resolveCircle(m.x + tx2 * step, m.z + tz2 * step, def.radius, Mask.Mob);
          if (dist(m.x, m.z, p.x, p.z) < step * 0.2) m.steer = -m.steer;
        }
      }
      if (dist(ox, oz, p.x, p.z) > 0.01) m.yaw = Math.atan2(p.x - ox, p.z - oz);
      m.x = clamp(p.x, -MAP_HALF + def.radius, MAP_HALF - def.radius);
      m.z = clamp(p.z, -MAP_HALF + def.radius, MAP_HALF - def.radius);
      this.recordHistory(m);
    }
    this.separate();
  }

  /** Mobs push each other apart so the horde spreads out instead of stacking. */
  private separate() {
    const mobs = [...this.room.mobs.values()];
    for (let i = 0; i < mobs.length; i++) {
      const a = mobs[i]!;
      for (let j = i + 1; j < mobs.length; j++) {
        const b = mobs[j]!;
        const rr = a.def.radius + b.def.radius;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= rr * rr || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const push = (rr - d) / 2;
        const wa = b.def.radius / rr; // heavier (bigger) mobs get pushed less
        const wb = a.def.radius / rr;
        a.x -= (dx / d) * push * wa * 2;
        a.z -= (dz / d) * push * wa * 2;
        b.x += (dx / d) * push * wb * 2;
        b.z += (dz / d) * push * wb * 2;
      }
    }
    const world = this.room.world;
    for (const m of mobs) {
      const p = world.collision.resolveCircle(m.x, m.z, m.def.radius, Mask.Mob);
      m.x = p.x;
      m.z = p.z;
    }
  }

  private recordHistory(m: Mob) {
    m.history.push({ x: m.x, z: m.z });
    if (m.history.length > HISTORY_TICKS) m.history.shift();
  }

  private updateTurrets(now: number) {
    const room = this.room;
    if (!room.mobs.size) return;
    for (const b of room.world.buildings.values()) {
      if (b.k !== BuildingKind.Turret || now < b.cooldownUntil) continue;
      let best: Mob | null = null;
      let bestD = TURRET_RANGE * TURRET_RANGE;
      for (const m of room.mobs.values()) {
        const d = dist2(b.x, b.z, m.x, m.z);
        if (d < bestD) {
          bestD = d;
          best = m;
        }
      }
      if (!best) continue;
      b.cooldownUntil = now + TURRET_COOLDOWN_MS;
      room.events.push({ e: 'shot', from: b.id, to: best.id });
      room.damageMob(best, TURRET_DAMAGE, b.owner, false);
    }
  }
}
