// Wire protocol v1. Every frame is a flat JSON object: { type: "...", ...payload }.
// Client -> Server messages carry only intents; the server is authoritative for everything.

import type { BuildingKindName, GameConfig, Inventory } from './constants';

// ───────────────────────────── Client → Server ─────────────────────────────

export const C2S = {
  HELLO: 'HELLO',
  JOIN_ROOM: 'JOIN_ROOM',
  LEAVE_ROOM: 'LEAVE_ROOM',
  PLAYER_INPUT: 'PLAYER_INPUT',
  INPUT_HARVEST: 'INPUT_HARVEST',
  INPUT_ATTACK: 'INPUT_ATTACK',
  INPUT_BUILD: 'INPUT_BUILD',
  READY: 'READY',
  DEBUG_COMMAND: 'DEBUG_COMMAND',
  CHAT: 'CHAT',
  PING: 'PING',
} as const;
export type C2SType = (typeof C2S)[keyof typeof C2S];

export interface HelloMsg { type: 'HELLO'; v: number; name: string; token?: string }
export interface JoinRoomMsg { type: 'JOIN_ROOM'; roomId?: string }
export interface LeaveRoomMsg { type: 'LEAVE_ROOM' }
/** Movement intent for one fixed simulation step (TICK_DT). px/pz = client-predicted position after the step. */
export interface PlayerInputMsg { type: 'PLAYER_INPUT'; seq: number; ts: number; mx: number; mz: number; yaw: number; px: number; pz: number }
export interface HarvestMsg { type: 'INPUT_HARVEST'; seq: number; ts: number; targetId: number }
export interface AttackMsg { type: 'INPUT_ATTACK'; seq: number; ts: number; targetId: number }
export interface BuildMsg { type: 'INPUT_BUILD'; seq: number; ts: number; kind: BuildingKindName; gx: number; gz: number }
export interface ReadyMsg { type: 'READY'; ready: boolean }
export const DEBUG_COMMANDS = ['skip_phase', 'give_resources', 'spawn_wave', 'heal_core'] as const;
export type DebugCommand = (typeof DEBUG_COMMANDS)[number];
export interface DebugCommandMsg { type: 'DEBUG_COMMAND'; cmd: DebugCommand }
export interface ChatMsg { type: 'CHAT'; text: string }
export interface PingMsg { type: 'PING'; id: number; ts: number }

export type ClientMessage =
  | HelloMsg | JoinRoomMsg | LeaveRoomMsg | PlayerInputMsg | HarvestMsg | AttackMsg | BuildMsg
  | ReadyMsg | DebugCommandMsg | ChatMsg | PingMsg;

// ───────────────────────────── Server → Client ─────────────────────────────

export const S2C = {
  WELCOME: 'WELCOME',
  ROOM_JOINED: 'ROOM_JOINED',
  WORLD_STATE_SNAPSHOT: 'WORLD_STATE_SNAPSHOT',
  GAME_PHASE_UPDATE: 'GAME_PHASE_UPDATE',
  SERVER_RECONCILE: 'SERVER_RECONCILE',
  ANTICHEAT_VIOLATION: 'ANTICHEAT_VIOLATION',
  GAME_OVER: 'GAME_OVER',
  CHAT: 'CHAT',
  PONG: 'PONG',
  ERROR: 'ERROR',
} as const;
export type S2CType = (typeof S2C)[keyof typeof S2C];

export interface PlayerState { id: number; name: string; x: number; z: number; yaw: number; hp: number; dead: boolean; act: number; color: number }
export interface MobState { id: number; k: number; x: number; z: number; yaw: number; hp: number; mhp: number; a: number }
export interface BuildingState { id: number; k: number; gx: number; gz: number; hp: number; mhp: number }
export interface ResourceState { id: number; k: number; x: number; z: number; amt: number; max: number }
export interface CoreState { hp: number; mhp: number }

/** Player action animation codes (PlayerState.act). */
export const Act = { Idle: 0, Harvest: 1, Attack: 2, Build: 3 } as const;

export type GameEvent =
  | { e: 'hit'; id: number; by: number; dmg: number } // entity id got damaged
  | { e: 'harvest'; id: number; by: number; res: number }
  | { e: 'shot'; from: number; to: number } // turret tracer
  | { e: 'death'; id: number; k: 'mob' | 'player' | 'building' }
  | { e: 'built'; id: number; by: number }
  | { e: 'core_hit'; dmg: number }
  | { e: 'mob_attack'; id: number; target: number };

export interface WelcomeMsg { type: 'WELCOME'; clientId: number; name: string; account: { username: string } | null; tickRate: number; serverTime: number; debugAllowed: boolean }
export interface RoomJoinedMsg {
  type: 'ROOM_JOINED';
  roomId: string;
  playerId: number;
  seed: number;
  mapHalf: number;
  config: GameConfig;
  world: { resources: ResourceState[]; buildings: BuildingState[]; core: CoreState };
}
export interface SnapshotMsg {
  type: 'WORLD_STATE_SNAPSHOT';
  tick: number;
  time: number; // server wall time (ms) of this tick
  ack: number; // last processed PLAYER_INPUT.seq of the recipient
  players: PlayerState[];
  mobs: MobState[];
  buildings?: BuildingState[]; // created/changed since last snapshot
  removedBuildings?: number[];
  resources?: ResourceState[]; // changed since last snapshot
  removedResources?: number[];
  core: CoreState;
  inv: Inventory; // recipient's server-side inventory
  ev: GameEvent[];
}
export type GamePhase = 'prep' | 'horde' | 'ended';
export interface PhaseUpdateMsg {
  type: 'GAME_PHASE_UPDATE';
  phase: GamePhase;
  endsAt: number | null; // server time (ms) when current phase/intermission ends
  wave: number;
  totalWaves: number;
  intermission: boolean;
  ready: number;
  players: number;
  mobsAlive: number;
}
export interface ReconcileMsg { type: 'SERVER_RECONCILE'; seq: number; x: number; z: number; reason: string }
export type ViolationKind =
  | 'SPEEDHACK' | 'TELEPORT' | 'INSUFFICIENT_RESOURCES' | 'BUILD_OUT_OF_RANGE' | 'BUILD_BLOCKED'
  | 'OUT_OF_RANGE' | 'COOLDOWN' | 'RATE_LIMIT' | 'MALFORMED_PACKET' | 'SEQ_REPLAY' | 'INVALID_TARGET' | 'DEBUG_DISABLED';
export type Severity = 'low' | 'medium' | 'high';
export type ViolationAction = 'dropped' | 'clamped' | 'corrected' | 'kicked';
export interface ViolationMsg { type: 'ANTICHEAT_VIOLATION'; kind: ViolationKind; message: string; severity: Severity; action: ViolationAction; tick: number; score: number }
export interface PlayerMatchStats { playerId: number; name: string; kills: number; harvested: number; built: number; deaths: number; damage: number }
export interface GameOverMsg { type: 'GAME_OVER'; result: 'victory' | 'defeat'; wave: number; stats: PlayerMatchStats[] }
export interface ServerChatMsg { type: 'CHAT'; from: string; text: string; system?: boolean }
export interface PongMsg { type: 'PONG'; id: number; ts: number; serverTime: number }
export interface ErrorMsg { type: 'ERROR'; code: string; message: string }

export type ServerMessage =
  | WelcomeMsg | RoomJoinedMsg | SnapshotMsg | PhaseUpdateMsg | ReconcileMsg | ViolationMsg
  | GameOverMsg | ServerChatMsg | PongMsg | ErrorMsg;

/** Public room info (REST /api/rooms and admin). */
export interface RoomInfo { id: string; players: number; maxPlayers: number; phase: GamePhase; wave: number; names: string[] }
