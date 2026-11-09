import type { BuildingKind, Inventory, MobDef, MobKind, ResourceKind } from '@surviver/shared';
import type { AcSubject } from '../anticheat/AntiCheatEngine';

export type QueuedAction =
  | { type: 'PLAYER_INPUT'; seq: number; mx: number; mz: number; yaw: number; px: number; pz: number }
  | { type: 'INPUT_HARVEST'; seq: number; targetId: number }
  | { type: 'INPUT_ATTACK'; seq: number; targetId: number }
  | { type: 'INPUT_BUILD'; seq: number; kind: BuildingKind; gx: number; gz: number };

export interface Player {
  id: number;
  session: AcSubject & { accountUsername: string | null };
  name: string;
  color: number;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  dead: boolean;
  respawnAt: number;
  act: number;
  actUntil: number;
  inv: Inventory;
  queue: QueuedAction[];
  moveBudget: number;
  lastProcessedSeq: number;
  /** Player simulation clock in ms = processed movement inputs × TICK_MS. Used for cooldowns. */
  simMs: number;
  lastHarvestSim: number;
  lastAttackSim: number;
  lastBuildSim: number;
  ready: boolean;
  stats: { kills: number; harvested: number; built: number; deaths: number; damage: number };
}

export interface Resource {
  id: number;
  k: ResourceKind;
  x: number;
  z: number;
  r: number;
  amt: number;
  max: number;
}

export interface Building {
  id: number;
  k: BuildingKind;
  gx: number;
  gz: number;
  x: number;
  z: number;
  hp: number;
  mhp: number;
  owner: number;
  cooldownUntil: number; // turret
}

export interface Mob {
  id: number;
  k: MobKind;
  def: MobDef;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  targetPlayer: number | null;
  retargetAt: number;
  nextAttackAt: number;
  attackAnimUntil: number;
  /** Last N tick positions for lag-compensated hit validation. */
  history: { x: number; z: number }[];
  steer: number;
}
