// Static & semi-static world: limited resource nodes (seeded), buildings, the Core and the collision world.

import {
  BUILDING_DEFS,
  CELL_SIZE,
  CORE_HALF,
  CORE_MAX_HP,
  CollisionWorld,
  GRID_MAX,
  GRID_MIN,
  MAP_HALF,
  Mask,
  RESOURCE_DEFS,
  ResourceKind,
  cellCenter,
  dist,
  isCoreCell,
  mulberry32,
  round2,
  type BuildingKind,
  type BuildingState,
  type ResourceState,
} from '@surviver/shared';
import type { Building, Resource } from './entities';

export const CORE_ID = 1;

export class World {
  readonly collision = new CollisionWorld();
  readonly resources = new Map<number, Resource>();
  readonly buildings = new Map<number, Building>();
  /** cell key -> building id */
  readonly cells = new Map<string, number>();
  core = { hp: CORE_MAX_HP, mhp: CORE_MAX_HP };

  constructor(
    readonly seed: number,
    private readonly nextId: () => number,
  ) {
    this.collision.addBox(CORE_ID, 'core', 0, 0, CORE_HALF, CORE_HALF, Mask.Player | Mask.Mob);
    this.generateResources();
  }

  /** Deterministic placement of a strictly limited pool of resources. */
  private generateResources() {
    const rnd = mulberry32(this.seed);
    const order = [ResourceKind.Iron, ResourceKind.Rock, ResourceKind.Tree] as const;
    for (const k of order) {
      const def = RESOURCE_DEFS[k];
      let placed = 0;
      let attempts = 0;
      while (placed < def.count && attempts++ < 5000) {
        // iron is rarer and further away from the base; trees are everywhere
        const minR = k === ResourceKind.Iron ? 22 : 10;
        const ang = rnd() * Math.PI * 2;
        const rad = minR + rnd() * (MAP_HALF - 4 - minR);
        const x = round2(Math.cos(ang) * rad);
        const z = round2(Math.sin(ang) * rad);
        let ok = true;
        for (const r of this.resources.values()) {
          if (dist(x, z, r.x, r.z) < r.r + def.radius + 2.2) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const id = this.nextId();
        this.resources.set(id, { id, k, x, z, r: def.radius, amt: def.amount, max: def.amount });
        this.collision.addCircle(id, 'resource', x, z, def.radius, Mask.Player | Mask.Mob);
        placed++;
      }
    }
  }

  removeResource(id: number) {
    this.resources.delete(id);
    this.collision.remove(id);
  }

  static cellKey(gx: number, gz: number) {
    return `${gx},${gz}`;
  }

  inGrid(gx: number, gz: number) {
    return gx >= GRID_MIN && gx <= GRID_MAX && gz >= GRID_MIN && gz <= GRID_MAX;
  }

  /** Reason the cell cannot hold a building, or null if free. */
  cellBlockedReason(gx: number, gz: number): string | null {
    if (!this.inGrid(gx, gz)) return 'outside the map';
    if (isCoreCell(gx, gz)) return 'cell is occupied by the Core';
    if (this.cells.has(World.cellKey(gx, gz))) return 'cell already has a building';
    const cx = cellCenter(gx);
    const cz = cellCenter(gz);
    for (const c of this.collision.query(cx, cz, CELL_SIZE)) {
      if (c.tag !== 'resource') continue;
      if (Math.abs(c.x - cx) < CELL_SIZE / 2 + c.r && Math.abs(c.z - cz) < CELL_SIZE / 2 + c.r) return 'resource node in the way';
    }
    return null;
  }

  addBuilding(k: BuildingKind, gx: number, gz: number, owner: number): Building {
    const def = BUILDING_DEFS[k];
    const id = this.nextId();
    const b: Building = { id, k, gx, gz, x: cellCenter(gx), z: cellCenter(gz), hp: def.hp, mhp: def.hp, owner, cooldownUntil: 0 };
    this.buildings.set(id, b);
    this.cells.set(World.cellKey(gx, gz), id);
    if (def.solid) this.collision.addBox(id, 'building', b.x, b.z, CELL_SIZE / 2, CELL_SIZE / 2, Mask.Player | Mask.Mob);
    return b;
  }

  removeBuilding(id: number) {
    const b = this.buildings.get(id);
    if (!b) return;
    this.buildings.delete(id);
    this.cells.delete(World.cellKey(b.gx, b.gz));
    this.collision.remove(id);
  }

  buildingAtCell(gx: number, gz: number) {
    const id = this.cells.get(World.cellKey(gx, gz));
    return id === undefined ? undefined : this.buildings.get(id);
  }

  resourceState(r: Resource): ResourceState {
    return { id: r.id, k: r.k, x: r.x, z: r.z, amt: r.amt, max: r.max };
  }

  buildingState(b: Building): BuildingState {
    return { id: b.id, k: b.k, gx: b.gx, gz: b.gz, hp: Math.ceil(b.hp), mhp: b.mhp };
  }

  totals() {
    const t = { wood: 0, stone: 0, iron: 0 };
    for (const r of this.resources.values()) {
      if (r.k === ResourceKind.Tree) t.wood += r.amt;
      else if (r.k === ResourceKind.Rock) t.stone += r.amt;
      else t.iron += r.amt;
    }
    return t;
  }
}
