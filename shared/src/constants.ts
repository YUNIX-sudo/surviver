// Game & network constants shared by server and client.
// Server may override some of them at runtime via env (sent to clients in ROOM_JOINED.config).

export const PROTOCOL_VERSION = 1;

export const TICK_RATE = 20; // server ticks per second
export const TICK_MS = 1000 / TICK_RATE; // 50 ms
export const TICK_DT = 1 / TICK_RATE; // seconds per tick

export const MAX_FRAME_BYTES = 4096;
export const MAX_PLAYERS_PER_ROOM = 4;

// Map: square arena [-MAP_HALF, MAP_HALF]^2 meters, build grid of CELL_SIZE meters.
export const MAP_HALF = 50;
export const CELL_SIZE = 2;
export const GRID_MIN = -MAP_HALF / CELL_SIZE; // -25
export const GRID_MAX = MAP_HALF / CELL_SIZE - 1; // 24

// Player
export const PLAYER_SPEED = 6; // m/s
export const PLAYER_RADIUS = 0.45;
export const PLAYER_MAX_HP = 100;
export const PLAYER_RESPAWN_MS = 5000;
export const HARVEST_REACH = 2.6; // edge-to-edge-ish: centre distance minus target radius
export const ATTACK_REACH = 2.4;
export const BUILD_RANGE = 7; // player centre -> cell centre
export const HARVEST_COOLDOWN_MS = 450;
export const ATTACK_COOLDOWN_MS = 400;
export const PLAYER_ATTACK_DAMAGE = 22;

// Core (base heart) at map centre, occupies 2x2 cells.
export const CORE_HALF = 2;
export const CORE_MAX_HP = 1500;

// Anti-cheat tuning
export const AC = {
  /**
   * Movement credit: the server simulates 1 input per tick and banks up to this many ticks.
   * A lag spike delivers a burst of inputs at once; banked credit lets the server catch up
   * instead of punishing the player. Time dilation is still impossible: credit grows in real time.
   */
  MOVE_BANK_TICKS: TICK_RATE * 5, // 5 s
  /** Backlog after a lag spike is replayed at most this many inputs per tick (smooth catch-up, no teleport). */
  MAX_MOVES_PER_TICK: 4,
  /** Queued, not yet simulated inputs. Above this the client sends faster than real time (time-dilation speedhack). */
  MAX_INPUT_QUEUE: TICK_RATE * 6, // 6 s worth of inputs
  /** Claimed step longer than PLAYER_SPEED*dt*factor is suspicious. */
  STEP_TOLERANCE_FACTOR: 3,
  /** Divergence between claimed and server position considered "real" desync. */
  DIVERGENCE_TOLERANCE: 2,
  /** Claimed jump bigger than this is a teleport. */
  TELEPORT_DISTANCE: 8,
  /** After a SERVER_RECONCILE: resend it (without penalty) if the client has not converged after this long. */
  RESYNC_RETRY_MS: 1500,
  /** Token bucket for all incoming frames (burst covers a ~5 s lag spike flushing at once). */
  RATE_PER_SEC: 60,
  RATE_BURST: 300,
  /** Dropped-by-rate-limit frames within 10 s that lead to kick. */
  FLOOD_KICK_DROPS: 3000,
  /** Violation score with decay; reaching this kicks the client. */
  KICK_SCORE: 600,
  SCORE_DECAY_PER_SEC: 10,
  /** Tiny grace for network jitter on cooldowns. */
  COOLDOWN_GRACE_MS: 60,
} as const;

// Resources
export const ResourceKind = { Tree: 0, Rock: 1, Iron: 2 } as const;
export type ResourceKind = (typeof ResourceKind)[keyof typeof ResourceKind];
export const RESOURCE_NAMES = ['wood', 'stone', 'iron'] as const;
export type ResourceName = (typeof RESOURCE_NAMES)[number];
export const RESOURCE_DEFS: Record<ResourceKind, { radius: number; amount: number; count: number; yieldPerHit: number }> = {
  [ResourceKind.Tree]: { radius: 0.7, amount: 12, count: 42, yieldPerHit: 1 },
  [ResourceKind.Rock]: { radius: 1.0, amount: 10, count: 20, yieldPerHit: 1 },
  [ResourceKind.Iron]: { radius: 0.9, amount: 6, count: 12, yieldPerHit: 1 },
};

export type Inventory = Record<ResourceName, number>;
export const emptyInventory = (): Inventory => ({ wood: 0, stone: 0, iron: 0 });

// Buildings
export const BUILDING_KINDS = ['wall', 'spikes', 'turret'] as const;
export type BuildingKindName = (typeof BUILDING_KINDS)[number];
export const BuildingKind = { Wall: 0, Spikes: 1, Turret: 2 } as const;
export type BuildingKind = (typeof BuildingKind)[keyof typeof BuildingKind];

export interface BuildingDef {
  name: BuildingKindName;
  title: string;
  cost: Partial<Inventory>;
  hp: number;
  solid: boolean;
}
export const BUILDING_DEFS: Record<BuildingKind, BuildingDef> = {
  [BuildingKind.Wall]: { name: 'wall', title: 'Стена', cost: { wood: 4 }, hp: 320, solid: true },
  [BuildingKind.Spikes]: { name: 'spikes', title: 'Шипы', cost: { wood: 2, iron: 1 }, hp: 140, solid: false },
  [BuildingKind.Turret]: { name: 'turret', title: 'Турель', cost: { stone: 5, iron: 2 }, hp: 220, solid: true },
};
export const SPIKES_DPS = 18;
export const SPIKES_SLOW = 0.5;
export const SPIKES_WEAR_PER_SEC = 4; // hp lost per mob-second standing on it
export const TURRET_RANGE = 13;
export const TURRET_DAMAGE = 14;
export const TURRET_COOLDOWN_MS = 650;

// Mobs (TABS-style creatures)
export const MobKind = { Runner: 0, Grunt: 1, Giant: 2 } as const;
export type MobKind = (typeof MobKind)[keyof typeof MobKind];
export interface MobDef {
  name: string;
  hp: number;
  speed: number;
  radius: number;
  damage: number;
  buildingDamageMul: number;
  attackCooldownMs: number;
  reach: number;
  aggroRange: number;
  scale: number;
}
export const MOB_DEFS: Record<MobKind, MobDef> = {
  [MobKind.Runner]: { name: 'Бегун', hp: 30, speed: 6.5, radius: 0.35, damage: 5, buildingDamageMul: 1, attackCooldownMs: 500, reach: 0.9, aggroRange: 14, scale: 0.65 },
  [MobKind.Grunt]: { name: 'Боец', hp: 90, speed: 3.4, radius: 0.5, damage: 11, buildingDamageMul: 1.5, attackCooldownMs: 900, reach: 1.1, aggroRange: 10, scale: 1 },
  [MobKind.Giant]: { name: 'Гигант', hp: 600, speed: 1.7, radius: 1.2, damage: 38, buildingDamageMul: 3, attackCooldownMs: 1600, reach: 1.8, aggroRange: 6, scale: 2.3 },
};
export const MAX_MOBS = 140;

// Phases
export const DEFAULT_PREP_SECONDS = 600;
export const DEFAULT_TOTAL_WAVES = 5;
export const INTERMISSION_SECONDS = 15;
export const ROOM_RESET_SECONDS = 20;

export interface GameConfig {
  prepSeconds: number;
  totalWaves: number;
  debugAllowed: boolean;
  tickRate: number;
}

export const PLAYER_COLORS = [0x3b82f6, 0xf59e0b, 0x10b981, 0xec4899] as const;
