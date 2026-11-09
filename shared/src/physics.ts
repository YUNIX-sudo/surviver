// Shared deterministic movement & collision. The very same code runs on the server (authoritative)
// and on the client (prediction), which is what makes Client-Side Prediction accurate.

import { CELL_SIZE, CORE_HALF, MAP_HALF, PLAYER_RADIUS, PLAYER_SPEED } from './constants';
import { clamp } from './math';

export const Mask = { Player: 1, Mob: 2 } as const;

export type ColliderTag = 'resource' | 'building' | 'core';
export interface Collider {
  id: number;
  tag: ColliderTag;
  /** 0 = circle (r), 1 = axis-aligned box (hw, hd half extents). */
  shape: 0 | 1;
  x: number;
  z: number;
  r: number;
  hw: number;
  hd: number;
  /** Bit mask of Mask.* this collider blocks. */
  blocks: number;
  stamp: number;
}

const SPATIAL_CELL = 4;
const key = (ix: number, iz: number) => (ix + 512) * 1024 + (iz + 512);

/** Spatial-hash collision world of static obstacles (resources, buildings, core). */
export class CollisionWorld {
  private cells = new Map<number, Collider[]>();
  private byId = new Map<number, Collider>();
  private stampCounter = 0;

  get size() {
    return this.byId.size;
  }

  addCircle(id: number, tag: ColliderTag, x: number, z: number, r: number, blocks: number) {
    this.insert({ id, tag, shape: 0, x, z, r, hw: r, hd: r, blocks, stamp: 0 });
  }

  addBox(id: number, tag: ColliderTag, x: number, z: number, hw: number, hd: number, blocks: number) {
    this.insert({ id, tag, shape: 1, x, z, r: Math.max(hw, hd), hw, hd, blocks, stamp: 0 });
  }

  get(id: number) {
    return this.byId.get(id);
  }

  remove(id: number) {
    const c = this.byId.get(id);
    if (!c) return;
    this.byId.delete(id);
    this.forCells(c, (k) => {
      const list = this.cells.get(k);
      if (!list) return;
      const i = list.indexOf(c);
      if (i >= 0) list.splice(i, 1);
      if (list.length === 0) this.cells.delete(k);
    });
  }

  clear() {
    this.cells.clear();
    this.byId.clear();
  }

  /** All colliders whose bounds intersect the square around (x,z) with half size r. Deduplicated. */
  query(x: number, z: number, r: number, out: Collider[] = []): Collider[] {
    const stamp = ++this.stampCounter;
    const x0 = Math.floor((x - r) / SPATIAL_CELL);
    const x1 = Math.floor((x + r) / SPATIAL_CELL);
    const z0 = Math.floor((z - r) / SPATIAL_CELL);
    const z1 = Math.floor((z + r) / SPATIAL_CELL);
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const list = this.cells.get(key(ix, iz));
        if (!list) continue;
        for (const c of list) {
          if (c.stamp === stamp) continue;
          c.stamp = stamp;
          out.push(c);
        }
      }
    }
    return out;
  }

  /**
   * Push a circle out of every blocking collider. Returns the corrected position.
   * `hits` (optional) receives colliders that were touched.
   */
  resolveCircle(x: number, z: number, r: number, mask: number, hits?: Collider[]): { x: number; z: number } {
    for (let pass = 0; pass < 3; pass++) {
      const near = this.query(x, z, r + 0.1);
      near.sort((a, b) => a.id - b.id); // deterministic order on client & server
      let moved = false;
      for (const c of near) {
        if ((c.blocks & mask) === 0) continue;
        const p = pushOut(x, z, r, c);
        if (p) {
          x = p.x;
          z = p.z;
          moved = true;
          if (hits && !hits.includes(c)) hits.push(c);
        }
      }
      if (!moved) break;
    }
    return { x, z };
  }

  /** True if a circle overlaps any collider matching mask. */
  overlaps(x: number, z: number, r: number, mask: number): Collider | null {
    for (const c of this.query(x, z, r)) {
      if ((c.blocks & mask) === 0) continue;
      if (pushOut(x, z, r, c)) return c;
    }
    return null;
  }

  private insert(c: Collider) {
    if (this.byId.has(c.id)) this.remove(c.id);
    this.byId.set(c.id, c);
    this.forCells(c, (k) => {
      let list = this.cells.get(k);
      if (!list) this.cells.set(k, (list = []));
      list.push(c);
    });
  }

  private forCells(c: Collider, fn: (k: number) => void) {
    const x0 = Math.floor((c.x - c.hw) / SPATIAL_CELL);
    const x1 = Math.floor((c.x + c.hw) / SPATIAL_CELL);
    const z0 = Math.floor((c.z - c.hd) / SPATIAL_CELL);
    const z1 = Math.floor((c.z + c.hd) / SPATIAL_CELL);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) fn(key(ix, iz));
  }
}

/** Minimal translation to separate circle (x,z,r) from collider, or null if not overlapping. */
export function pushOut(x: number, z: number, r: number, c: Collider): { x: number; z: number } | null {
  if (c.shape === 0) {
    const dx = x - c.x;
    const dz = z - c.z;
    const rr = r + c.r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) return null;
    const d = Math.sqrt(d2);
    if (d < 1e-6) return { x: c.x + rr, z };
    const k = rr / d;
    return { x: c.x + dx * k, z: c.z + dz * k };
  }
  const cx = clamp(x, c.x - c.hw, c.x + c.hw);
  const cz = clamp(z, c.z - c.hd, c.z + c.hd);
  const dx = x - cx;
  const dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return null;
  if (d2 > 1e-12) {
    const d = Math.sqrt(d2);
    return { x: cx + (dx / d) * r, z: cz + (dz / d) * r };
  }
  // centre inside the box: push along the axis of least penetration
  const px = c.hw - Math.abs(x - c.x) + r;
  const pz = c.hd - Math.abs(z - c.z) + r;
  if (px < pz) return { x: x + Math.sign(x - c.x || 1) * px, z };
  return { x, z: z + Math.sign(z - c.z || 1) * pz };
}

/** Clamp an input vector to unit length. `clamped` = the client tried to exceed it. */
export function sanitizeMove(mx: number, mz: number): { mx: number; mz: number; clamped: boolean } {
  const len = Math.hypot(mx, mz);
  if (len <= 1.0001) return { mx, mz, clamped: false };
  return { mx: mx / len, mz: mz / len, clamped: true };
}

/**
 * One fixed simulation step of a player. Pure function of (position, input, world).
 * Used by the server (authority) and the client (prediction + reconciliation replay).
 */
export function stepPlayer(pos: { x: number; z: number }, mx: number, mz: number, dt: number, world: CollisionWorld) {
  const m = sanitizeMove(mx, mz);
  let x = pos.x + m.mx * PLAYER_SPEED * dt;
  let z = pos.z + m.mz * PLAYER_SPEED * dt;
  const r = world.resolveCircle(x, z, PLAYER_RADIUS, Mask.Player);
  x = clamp(r.x, -MAP_HALF + PLAYER_RADIUS, MAP_HALF - PLAYER_RADIUS);
  z = clamp(r.z, -MAP_HALF + PLAYER_RADIUS, MAP_HALF - PLAYER_RADIUS);
  pos.x = x;
  pos.z = z;
  return pos;
}

// ── Build grid helpers ──
export const cellCenter = (g: number) => g * CELL_SIZE + CELL_SIZE / 2;
export const worldToCell = (v: number) => Math.floor(v / CELL_SIZE);
export const isCoreCell = (gx: number, gz: number) => {
  const n = CORE_HALF / CELL_SIZE; // core spans cells [-n, n-1]
  return gx >= -n && gx <= n - 1 && gz >= -n && gz <= n - 1;
};
