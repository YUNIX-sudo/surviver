// Game client orchestration: applies server messages, samples input at the server tick rate,
// predicts the local player, interpolates everything else and renders at display refresh rate.

import * as THREE from 'three';
import {
  ATTACK_COOLDOWN_MS,
  ATTACK_REACH,
  Act,
  BUILDING_DEFS,
  BUILDING_KINDS,
  BUILD_RANGE,
  BuildingKind,
  CELL_SIZE,
  CollisionWorld,
  CORE_HALF,
  HARVEST_COOLDOWN_MS,
  HARVEST_REACH,
  MOB_DEFS,
  Mask,
  MobKind,
  PLAYER_MAX_HP,
  RESOURCE_DEFS,
  ResourceKind,
  TICK_MS,
  TURRET_RANGE,
  cellCenter,
  dist,
  emptyInventory,
  isCoreCell,
  worldToCell,
  type BuildingState,
  type DebugCommand,
  type GameConfig,
  type GameEvent,
  type GameOverMsg,
  type Inventory,
  type PhaseUpdateMsg,
  type PlayerState,
  type ResourceState,
  type ServerMessage,
  type SnapshotMsg,
  type ViolationMsg,
} from '@surviver/shared';
import { Interpolator } from './net/Interpolator';
import type { NetClient } from './net/NetClient';
import { Predictor } from './net/Predictor';
import { Effects } from './render/Effects';
import { SceneSetup } from './render/SceneSetup';
import { TabsCharacter, type CharacterStyle } from './render/TabsCharacter';
import { CoreMesh, HpBar, makeBuilding, makeLabel, makeResource } from './render/WorldMeshes';

interface ResourceView { s: ResourceState; obj: THREE.Group; shake: number }
interface BuildingView { s: BuildingState; obj: THREE.Group; bar: HpBar; aimYaw: number; recoil: number }
interface PlayerView { char: TabsCharacter; label: THREE.Sprite; bar: HpBar; lastAct: number }
interface MobView { char: TabsCharacter; bar: HpBar; k: number; lastA: number }

const MOB_STYLE: Record<number, { style: CharacterStyle; color: number }> = {
  [MobKind.Runner]: { style: 'runner', color: 0xe4572e },
  [MobKind.Grunt]: { style: 'grunt', color: 0x6a994e },
  [MobKind.Giant]: { style: 'giant', color: 0x7b2cbf },
};
const RES_COLOR = [0x8b5a2b, 0x9ca3af, 0xd97706];

export type LogKind = 'info' | 'sent' | 'violation' | 'reconcile' | 'debug';

export class Game {
  readonly sc: SceneSetup;
  readonly effects: Effects;
  readonly collision = new CollisionWorld();
  readonly predictor = new Predictor(this.collision);
  readonly interp = new Interpolator();
  readonly core = new CoreMesh();
  private coreBar = new HpBar(4, 0x38bdf8);

  playerId = 0;
  roomId = '';
  config: GameConfig | null = null;
  me: PlayerState | null = null;
  inv: Inventory = emptyInventory();
  coreHp = { hp: 1, mhp: 1 };
  phase: PhaseUpdateMsg | null = null;
  lastSnap: SnapshotMsg | null = null;
  gameOver: GameOverMsg | null = null;
  violations: ViolationMsg[] = [];

  readonly resources = new Map<number, ResourceView>();
  readonly buildings = new Map<number, BuildingView>();
  readonly players = new Map<number, PlayerView>();
  readonly mobs = new Map<number, MobView>();
  private deadMobs = new Set<number>();
  private dying: { char: TabsCharacter; bar: HpBar; t: number }[] = [];
  private renderedMobs = new Map<number, { x: number; z: number }>();
  private renderedPlayers = new Map<number, { x: number; z: number }>();

  // input state
  private seq = 0;
  inputTick = 0;
  private acc = 0;
  private lastHarvestTick = -1e9;
  private lastAttackTick = -1e9;
  private keys = new Set<string>();
  private mouseDown = false;
  readonly aim = new THREE.Vector3();
  private mouseNdc = new THREE.Vector2();
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  buildMode: BuildingKind | null = null;
  private buildGhost: THREE.Mesh;
  private ghostValid = false;
  private serverGhost: THREE.Mesh;
  private needSpawn = true;
  private lastTick = 0;
  inputBlocked = false; // chat focused

  // demo toggles (network monitor)
  predictionEnabled = true;
  showServerGhost = false;
  // cheat toggles (anti-cheat test panel)
  private speedhackUntil = 0;
  private dilationUntil = 0;

  // callbacks to UI
  onLog: (kind: LogKind, text: string) => void = () => {};
  onHint: (text: string) => void = () => {};
  onViolation: (v: ViolationMsg) => void = () => {};
  onChat: (from: string, text: string, system: boolean) => void = () => {};
  onGameOver: (m: GameOverMsg) => void = () => {};
  onJoined: () => void = () => {};
  onDamaged: () => void = () => {};

  private last = performance.now();
  fps = 0;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private hintAt = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly overlay: HTMLElement,
    readonly net: NetClient,
  ) {
    this.sc = new SceneSetup(container);
    this.effects = new Effects(this.sc.scene, this.sc.camera, overlay);
    this.sc.scene.add(this.core.root);
    this.coreBar.root.position.set(0, 5, 0);
    this.sc.scene.add(this.coreBar.root);

    this.buildGhost = new THREE.Mesh(
      new THREE.BoxGeometry(CELL_SIZE * 0.98, 1.2, CELL_SIZE * 0.98),
      new THREE.MeshBasicMaterial({ color: 0x22c55e, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.buildGhost.visible = false;
    this.sc.scene.add(this.buildGhost);

    this.serverGhost = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.45, 1.0, 4, 8),
      new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true, transparent: true, opacity: 0.8 }),
    );
    this.serverGhost.visible = false;
    this.sc.scene.add(this.serverGhost);

    net.on((m) => this.onMessage(m));
    this.bindInput();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ───────────────────────────── network messages ─────────────────────────────

  private onMessage(m: ServerMessage) {
    switch (m.type) {
      case 'ROOM_JOINED':
        this.initWorld(m.roomId, m.playerId, m.config, m.world.resources, m.world.buildings, m.world.core);
        this.onLog('info', `ROOM_JOINED ${m.roomId} as #${m.playerId}, seed ${m.seed}, ${m.world.resources.length} resources`);
        this.onJoined();
        break;
      case 'WORLD_STATE_SNAPSHOT':
        this.onSnapshot(m);
        break;
      case 'GAME_PHASE_UPDATE':
        if (this.phase?.phase !== m.phase || this.phase.wave !== m.wave) this.onLog('info', `GAME_PHASE_UPDATE ${m.phase} wave ${m.wave}/${m.totalWaves}`);
        this.phase = m;
        break;
      case 'SERVER_RECONCILE':
        this.predictor.reconcile(m.seq, m.x, m.z, true);
        this.onLog('reconcile', `SERVER_RECONCILE seq=${m.seq} → (${m.x.toFixed(1)}, ${m.z.toFixed(1)}) ${m.reason}`);
        break;
      case 'ANTICHEAT_VIOLATION':
        this.violations.unshift(m);
        if (this.violations.length > 100) this.violations.pop();
        this.onViolation(m);
        break;
      case 'GAME_OVER':
        this.gameOver = m;
        this.onGameOver(m);
        break;
      case 'CHAT':
        this.onChat(m.from, m.text, !!m.system);
        break;
      case 'ERROR':
        this.onLog('violation', `ERROR ${m.code}: ${m.message}`);
        this.onHint(m.message);
        break;
      default:
        break;
    }
  }

  private initWorld(roomId: string, playerId: number, config: GameConfig, resources: ResourceState[], buildings: BuildingState[], core: { hp: number; mhp: number }) {
    this.roomId = roomId;
    this.playerId = playerId;
    this.config = config;
    this.gameOver = null;
    for (const r of this.resources.values()) r.obj.removeFromParent();
    for (const b of this.buildings.values()) {
      b.obj.removeFromParent();
      b.bar.dispose();
    }
    for (const mv of this.mobs.values()) {
      mv.char.dispose();
      mv.bar.dispose();
    }
    this.resources.clear();
    this.buildings.clear();
    this.mobs.clear();
    this.deadMobs.clear();
    this.collision.clear();
    this.collision.addBox(1, 'core', 0, 0, CORE_HALF, CORE_HALF, Mask.Player | Mask.Mob);
    for (const r of resources) this.upsertResource(r);
    for (const b of buildings) this.upsertBuilding(b);
    this.coreHp = core;
    this.interp.clear();
    this.needSpawn = true;
    this.lastTick = 0;
  }

  private upsertResource(r: ResourceState) {
    let v = this.resources.get(r.id);
    if (!v) {
      const obj = makeResource(r.id, r.k);
      obj.position.set(r.x, 0, r.z);
      this.sc.scene.add(obj);
      v = { s: r, obj, shake: 0 };
      this.resources.set(r.id, v);
      this.collision.addCircle(r.id, 'resource', r.x, r.z, RESOURCE_DEFS[r.k as ResourceKind].radius, Mask.Player | Mask.Mob);
    }
    v.s = r;
    const ratio = r.amt / r.max;
    v.obj.scale.setScalar(0.55 + 0.45 * ratio);
  }

  private removeResource(id: number) {
    const v = this.resources.get(id);
    if (!v) return;
    this.effects.burst(v.s.x, 0.8, v.s.z, RES_COLOR[v.s.k] ?? 0x888888, 16, 5);
    v.obj.removeFromParent();
    this.resources.delete(id);
    this.collision.remove(id);
  }

  private upsertBuilding(b: BuildingState) {
    let v = this.buildings.get(b.id);
    if (!v) {
      const obj = makeBuilding(b.k);
      obj.position.set(cellCenter(b.gx), 0, cellCenter(b.gz));
      this.sc.scene.add(obj);
      const bar = new HpBar(1.6);
      bar.root.position.set(cellCenter(b.gx), b.k === BuildingKind.Spikes ? 1.2 : 2.6, cellCenter(b.gz));
      this.sc.scene.add(bar.root);
      v = { s: b, obj, bar, aimYaw: 0, recoil: 0 };
      this.buildings.set(b.id, v);
      if (BUILDING_DEFS[b.k as BuildingKind].solid) this.collision.addBox(b.id, 'building', cellCenter(b.gx), cellCenter(b.gz), CELL_SIZE / 2, CELL_SIZE / 2, Mask.Player | Mask.Mob);
    }
    v.s = b;
  }

  private removeBuilding(id: number) {
    const v = this.buildings.get(id);
    if (!v) return;
    this.effects.burst(v.obj.position.x, 1, v.obj.position.z, 0x8b5a2b, 20, 6);
    v.obj.removeFromParent();
    v.bar.dispose();
    this.buildings.delete(id);
    this.collision.remove(id);
  }

  private onSnapshot(s: SnapshotMsg) {
    const st = this.net.stats;
    st.snapCount++;
    if (this.lastTick && s.tick > this.lastTick + 1) st.missedTicks += s.tick - this.lastTick - 1;
    this.lastTick = s.tick;

    // world deltas are always applied (reliable stream); only positions may be "lost" by the simulator
    for (const id of s.removedResources ?? []) this.removeResource(id);
    for (const r of s.resources ?? []) this.upsertResource(r);
    for (const id of s.removedBuildings ?? []) this.removeBuilding(id);
    for (const b of s.buildings ?? []) this.upsertBuilding(b);
    this.inv = s.inv;
    if (s.core.hp < this.coreHp.hp) this.core.hit();
    this.coreHp = s.core;
    for (const e of s.ev) this.onEvent(e);

    const me = s.players.find((p) => p.id === this.playerId) ?? null;
    if (me && this.me?.dead && !me.dead) this.onLog('info', 'respawned');
    this.me = me;
    this.lastSnap = s;

    if (this.net.lag.dropSnapshot()) {
      st.droppedSnapshots++;
      return;
    }
    this.interp.push(s.time, s.players, s.mobs);
    if (me) {
      if (this.needSpawn) {
        this.needSpawn = false;
        this.predictor.reset(me.x, me.z);
        this.sc.snapCamera(me.x, me.z);
      } else this.predictor.reconcile(s.ack, me.x, me.z);
    }
  }

  private onEvent(e: GameEvent) {
    switch (e.e) {
      case 'hit': {
        const mv = this.mobs.get(e.id);
        const pos = this.renderedMobs.get(e.id);
        if (mv && pos) {
          mv.char.hit();
          this.effects.burst(pos.x, 0.8 * mv.char.s, pos.z, 0xb91c1c, 5, 3);
          if (e.by === this.playerId || this.players.has(e.by)) this.effects.number(pos.x, mv.char.height, pos.z, String(e.dmg), e.by === this.playerId ? '#fde047' : '#fff');
        }
        const pv = this.players.get(e.id);
        const pp = this.renderedPlayers.get(e.id);
        if (pv && pp) {
          pv.char.hit();
          this.effects.number(pp.x, 2, pp.z, `-${e.dmg}`, '#f87171');
          if (e.id === this.playerId) {
            this.sc.addShake(0.35);
            this.onDamaged();
          }
        }
        break;
      }
      case 'harvest': {
        const r = this.resources.get(e.id);
        if (r) {
          r.shake = 1;
          this.effects.burst(r.s.x, 1, r.s.z, RES_COLOR[e.res] ?? 0x888888, 6, 3);
        }
        if (e.by !== this.playerId) this.players.get(e.by)?.char.swing(1);
        break;
      }
      case 'shot': {
        const b = this.buildings.get(e.from);
        const target = this.renderedMobs.get(e.to);
        if (b && target) {
          b.aimYaw = Math.atan2(target.x - b.obj.position.x, target.z - b.obj.position.z);
          b.recoil = 1;
          this.effects.tracer(new THREE.Vector3(b.obj.position.x, 1.4, b.obj.position.z), new THREE.Vector3(target.x, 0.8, target.z));
        }
        break;
      }
      case 'death':
        if (e.k === 'mob') {
          this.deadMobs.add(e.id);
          const mv = this.mobs.get(e.id);
          if (mv) {
            mv.char.die();
            const p = this.renderedMobs.get(e.id);
            if (p) this.effects.burst(p.x, 0.6, p.z, MOB_STYLE[mv.k]?.color ?? 0xffffff, 10, 4);
            this.dying.push({ char: mv.char, bar: mv.bar, t: 0 });
            this.mobs.delete(e.id);
          }
        } else if (e.k === 'player' && e.id === this.playerId) {
          this.onHint('Вы погибли! Респавн через 5 секунд');
        }
        break;
      case 'built': {
        const b = this.buildings.get(e.id);
        if (b) this.effects.burst(b.obj.position.x, 0.3, b.obj.position.z, 0xd6c29b, 10, 3);
        if (e.by !== this.playerId) this.players.get(e.by)?.char.swing(1);
        break;
      }
      case 'core_hit':
        this.sc.addShake(0.08);
        break;
      case 'mob_attack':
        this.mobs.get(e.id)?.char.swing(2);
        break;
    }
  }

  // ───────────────────────────── input ─────────────────────────────

  private bindInput() {
    window.addEventListener('keydown', (e) => {
      if (this.inputBlocked) return;
      this.keys.add(e.code);
      if (e.code === 'Digit1') this.toggleBuild(BuildingKind.Wall);
      if (e.code === 'Digit2') this.toggleBuild(BuildingKind.Spikes);
      if (e.code === 'Digit3') this.toggleBuild(BuildingKind.Turret);
      if (e.code === 'Escape' || e.code === 'KeyQ') this.toggleBuild(null);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = false;
    });
    const canvas = this.sc.renderer.domElement;
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.mouseNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    });
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) {
        this.toggleBuild(null);
        return;
      }
      if (e.button !== 0) return;
      if (this.buildMode !== null) this.tryBuild();
      else this.mouseDown = true;
    });
    window.addEventListener('mouseup', () => (this.mouseDown = false));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener(
      'wheel',
      (e) => {
        this.sc.zoom = Math.max(0.55, Math.min(1.8, this.sc.zoom * (e.deltaY > 0 ? 1.08 : 0.92)));
        e.preventDefault();
      },
      { passive: false },
    );
  }

  toggleBuild(k: BuildingKind | null) {
    this.buildMode = this.buildMode === k ? null : k;
    this.sc.grid.visible = this.buildMode !== null;
    this.buildGhost.visible = this.buildMode !== null;
  }

  private nextSeq() {
    return ++this.seq;
  }

  /** Fixed-rate input sampling (20 Hz = server tick). Each sample is predicted locally and sent. */
  private sampleInput() {
    let mx = 0;
    let mz = 0;
    if (!this.inputBlocked) {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mz -= 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mz += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    }
    const len = Math.hypot(mx, mz);
    if (len > 0) {
      mx /= len;
      mz /= len;
    }
    const now = performance.now();
    const pos = this.predictor.pos;
    const yaw = Math.atan2(this.aim.x - pos.x, this.aim.z - pos.z);
    const frozen = !this.me || this.me.dead;
    const copies = now < this.dilationUntil ? 3 : 1; // CHEAT: time dilation (more inputs than ticks)
    const mul = now < this.speedhackUntil ? 5 : 1; // CHEAT: oversized move vector
    for (let i = 0; i < copies; i++) {
      const seq = this.nextSeq();
      this.predictor.apply(seq, mx, mz, frozen);
      if (copies > 1) {
        // a time-dilation cheater also *predicts* the extra steps, so it really runs faster locally
      }
      this.net.send({ type: 'PLAYER_INPUT', seq, ts: Date.now(), mx: +(mx * mul).toFixed(3), mz: +(mz * mul).toFixed(3), yaw: +yaw.toFixed(3), px: +this.predictor.pos.x.toFixed(2), pz: +this.predictor.pos.z.toFixed(2) });
    }
    this.inputTick++;
    if ((this.mouseDown || this.keys.has('Space')) && this.buildMode === null && !frozen) this.tryAction();
  }

  private hint(text: string) {
    const now = performance.now();
    if (now - this.hintAt < 1200) return;
    this.hintAt = now;
    this.onHint(text);
  }

  /** Choose what the player wants to hit: thing under the cursor, else nearest thing in reach. */
  private pickTarget(): { kind: 'mob' | 'res'; id: number; d: number } | null {
    const p = this.predictor.pos;
    let best: { kind: 'mob' | 'res'; id: number; d: number; score: number } | null = null;
    for (const [id, m] of this.renderedMobs) {
      const mv = this.mobs.get(id);
      if (!mv) continue;
      const r = MOB_DEFS[mv.k as MobKind].radius;
      const da = dist(this.aim.x, this.aim.z, m.x, m.z) - r;
      const dp = dist(p.x, p.z, m.x, m.z) - r;
      const score = da < 1.2 ? da - 100 : dp; // cursor hit wins, otherwise proximity
      if (da < 1.2 || dp <= ATTACK_REACH) if (!best || score < best.score) best = { kind: 'mob', id, d: dp, score };
    }
    if (best) return best;
    for (const [id, r] of this.resources) {
      const rr = RESOURCE_DEFS[r.s.k as ResourceKind].radius;
      const da = dist(this.aim.x, this.aim.z, r.s.x, r.s.z) - rr;
      const dp = dist(p.x, p.z, r.s.x, r.s.z) - rr;
      const score = da < 0.8 ? da - 100 : dp;
      if (da < 0.8 || dp <= HARVEST_REACH) if (!best || score < best.score) best = { kind: 'res', id, d: dp, score };
    }
    return best;
  }

  private tryAction() {
    const t = this.pickTarget();
    if (!t) return;
    const me = this.players.get(this.playerId);
    if (t.kind === 'mob') {
      if (this.inputTick - this.lastAttackTick < Math.ceil(ATTACK_COOLDOWN_MS / TICK_MS)) return;
      if (t.d > ATTACK_REACH) return this.hint('Слишком далеко — подойдите ближе');
      this.lastAttackTick = this.inputTick;
      this.net.send({ type: 'INPUT_ATTACK', seq: this.nextSeq(), ts: Date.now(), targetId: t.id });
      me?.char.swing(2);
    } else {
      if (this.inputTick - this.lastHarvestTick < Math.ceil(HARVEST_COOLDOWN_MS / TICK_MS)) return;
      if (t.d > HARVEST_REACH) return this.hint('Слишком далеко — подойдите ближе');
      this.lastHarvestTick = this.inputTick;
      this.net.send({ type: 'INPUT_HARVEST', seq: this.nextSeq(), ts: Date.now(), targetId: t.id });
      me?.char.swing(1);
    }
  }

  private ghostCell() {
    return { gx: worldToCell(this.aim.x), gz: worldToCell(this.aim.z) };
  }

  /** Client-side pre-validation (honest client). The server re-checks everything. */
  buildCheck(k: BuildingKind, gx: number, gz: number): string | null {
    const def = BUILDING_DEFS[k];
    const p = this.predictor.pos;
    if (dist(p.x, p.z, cellCenter(gx), cellCenter(gz)) > BUILD_RANGE) return 'Слишком далеко для постройки';
    for (const [res, n] of Object.entries(def.cost)) if (this.inv[res as keyof Inventory] < (n ?? 0)) return `Не хватает ресурсов (${res})`;
    if (isCoreCell(gx, gz)) return 'Здесь Ядро';
    if (Math.abs(gx) > 25 || Math.abs(gz) > 25) return 'За пределами карты';
    for (const b of this.buildings.values()) if (b.s.gx === gx && b.s.gz === gz) return 'Клетка занята';
    const cx = cellCenter(gx);
    const cz = cellCenter(gz);
    for (const r of this.resources.values()) {
      const rr = RESOURCE_DEFS[r.s.k as ResourceKind].radius;
      if (Math.abs(r.s.x - cx) < 1 + rr && Math.abs(r.s.z - cz) < 1 + rr) return 'Мешает ресурс';
    }
    if (def.solid && Math.abs(p.x - cx) < 1.45 && Math.abs(p.z - cz) < 1.45) return 'Вы стоите на клетке';
    return null;
  }

  private tryBuild() {
    if (this.buildMode === null || !this.me || this.me.dead) return;
    const { gx, gz } = this.ghostCell();
    const err = this.buildCheck(this.buildMode, gx, gz);
    if (err) return this.hint(err);
    this.net.send({ type: 'INPUT_BUILD', seq: this.nextSeq(), ts: Date.now(), kind: BUILDING_KINDS[this.buildMode], gx, gz });
    this.players.get(this.playerId)?.char.swing(1);
  }

  sendReady(ready: boolean) {
    this.net.send({ type: 'READY', ready });
  }

  // ───────────────────────────── cheats (anti-cheat demo) ─────────────────────────────

  readonly cheat = {
    teleport: () => {
      const p = this.predictor.pos;
      const yaw = Math.atan2(this.aim.x - p.x, this.aim.z - p.z);
      p.x += Math.sin(yaw) * 15;
      p.z += Math.cos(yaw) * 15;
      this.predictor.prev = { ...p };
      this.onLog('sent', 'CHEAT teleport: local position +15 m, next PLAYER_INPUT claims it');
    },
    speedhack: () => {
      this.speedhackUntil = performance.now() + 3000;
      this.onLog('sent', 'CHEAT speedhack: move vector ×5 for 3 s');
    },
    timeDilation: () => {
      this.dilationUntil = performance.now() + 2500;
      this.onLog('sent', 'CHEAT time dilation: 3 inputs per tick (60/s) for 2.5 s');
    },
    buildNoResources: () => {
      const p = this.predictor.pos;
      const gx = worldToCell(p.x);
      const gz = worldToCell(p.z);
      for (let i = 0; i < 8; i++) {
        this.net.send({ type: 'INPUT_BUILD', seq: this.nextSeq(), ts: Date.now(), kind: 'turret', gx: gx + 2 + (i % 2), gz: gz - 1 + Math.floor(i / 2) });
      }
      this.onLog('sent', `CHEAT 8× INPUT_BUILD turret around (${gx},${gz}) ignoring inventory`);
    },
    remoteBuild: () => {
      const p = this.predictor.pos;
      const gx = worldToCell(-p.x * 0.8);
      const gz = worldToCell(-p.z * 0.8 + 30);
      this.net.send({ type: 'INPUT_BUILD', seq: this.nextSeq(), ts: Date.now(), kind: 'wall', gx: Math.max(-25, Math.min(24, gx)), gz: Math.max(-25, Math.min(24, gz)) });
      this.onLog('sent', `CHEAT remote build at cell (${gx},${gz}) far away`);
    },
    killAura: () => {
      const p = this.predictor.pos;
      let far: number | null = null;
      let farD = -1;
      for (const [id, m] of this.renderedMobs) {
        const d = dist(p.x, p.z, m.x, m.z);
        if (d > farD) {
          farD = d;
          far = id;
        }
      }
      if (far === null) {
        this.onLog('info', 'kill aura: нет мобов — используйте «Пропустить фазу» или «Спавн волны»');
        return;
      }
      for (const id of [...this.renderedMobs.keys()].slice(0, 5)) this.net.send({ type: 'INPUT_ATTACK', seq: this.nextSeq(), ts: Date.now(), targetId: id });
      this.onLog('sent', `CHEAT kill aura: INPUT_ATTACK on up to 5 mobs (farthest ${farD.toFixed(1)} m)`);
    },
    farHarvest: () => {
      const p = this.predictor.pos;
      let far: ResourceView | null = null;
      for (const r of this.resources.values()) if (!far || dist(p.x, p.z, r.s.x, r.s.z) > dist(p.x, p.z, far.s.x, far.s.z)) far = r;
      if (!far) return;
      this.net.send({ type: 'INPUT_HARVEST', seq: this.nextSeq(), ts: Date.now(), targetId: far.s.id });
      this.onLog('sent', `CHEAT far harvest #${far.s.id} at ${dist(p.x, p.z, far.s.x, far.s.z).toFixed(1)} m`);
    },
    rapidFire: () => {
      const t = this.pickTarget();
      const p = this.predictor.pos;
      let id = t?.id;
      let kind = t?.kind;
      if (!id) {
        let best: ResourceView | null = null;
        for (const r of this.resources.values()) if (!best || dist(p.x, p.z, r.s.x, r.s.z) < dist(p.x, p.z, best.s.x, best.s.z)) best = r;
        id = best?.s.id;
        kind = 'res';
      }
      if (!id) return;
      for (let i = 0; i < 10; i++) this.net.send({ type: kind === 'mob' ? 'INPUT_ATTACK' : 'INPUT_HARVEST', seq: this.nextSeq(), ts: Date.now(), targetId: id });
      this.onLog('sent', `CHEAT rapid fire: 10× ${kind === 'mob' ? 'INPUT_ATTACK' : 'INPUT_HARVEST'} in one frame`);
    },
    spam: () => {
      for (let i = 0; i < 500; i++) this.net.sendNow(JSON.stringify({ type: 'PING', id: 100000 + i, ts: Date.now() }));
      this.onLog('sent', 'CHEAT packet spam: 500 frames in one burst');
    },
    malformed: () => {
      this.net.sendRaw('{"type":"PLAYER_INPUT","seq":"1; DROP TABLE players"}');
      this.net.sendRaw('this is not json at all');
      this.net.sendRaw(JSON.stringify({ type: 'INPUT_BUILD', seq: this.nextSeq(), ts: 0, kind: 'nuke', gx: 0, gz: 0 }));
      this.net.sendRaw(JSON.stringify({ type: 'CHAT', text: 'x'.repeat(5000) }));
      this.onLog('sent', 'CHEAT 4 malformed frames (bad types, garbage, unknown enum, 5 KB frame)');
    },
    replay: () => {
      this.net.send({ type: 'PLAYER_INPUT', seq: Math.max(1, this.seq - 50), ts: Date.now(), mx: 1, mz: 0, yaw: 0, px: this.predictor.pos.x, pz: this.predictor.pos.z });
      this.onLog('sent', `CHEAT replay old PLAYER_INPUT seq=${Math.max(1, this.seq - 50)}`);
    },
    debug: (cmd: DebugCommand) => {
      this.net.send({ type: 'DEBUG_COMMAND', cmd });
      this.onLog('debug', `DEBUG_COMMAND ${cmd}`);
    },
  };

  // ───────────────────────────── render loop ─────────────────────────────

  private frame(t: number) {
    requestAnimationFrame((tt) => this.frame(tt));
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }

    // aim point on the ground
    this.raycaster.setFromCamera(this.mouseNdc, this.sc.camera);
    this.raycaster.ray.intersectPlane(this.groundPlane, this.aim);

    // fixed-step input sampling (max 3 catch-up steps to avoid bursts after a hitch)
    if (this.playerId && !this.needSpawn) {
      this.acc = Math.min(this.acc + dt * 1000, TICK_MS * 3);
      while (this.acc >= TICK_MS) {
        this.acc -= TICK_MS;
        this.sampleInput();
      }
    }
    const alpha = this.acc / TICK_MS;

    const sample = this.interp.sample();
    // ── players ──
    const seen = new Set<number>();
    let camX = 0;
    let camZ = 0;
    for (const [id, ps] of sample.players) {
      seen.add(id);
      let v = this.players.get(id);
      if (!v) {
        const char = new TabsCharacter({ color: ps.color, style: 'player', scale: 1.25 });
        const label = makeLabel(ps.name, id === this.playerId ? '#fde047' : '#ffffff');
        const bar = new HpBar(1.1);
        this.sc.scene.add(char.root, label, bar.root);
        v = { char, label, bar, lastAct: 0 };
        this.players.set(id, v);
      }
      const isMe = id === this.playerId;
      let x = ps.x;
      let z = ps.z;
      let yaw = ps.yaw;
      const latest = isMe ? this.me : null;
      const dead = latest ? latest.dead : ps.dead;
      if (isMe && this.predictionEnabled && !this.needSpawn) {
        const rp = this.predictor.renderPos(alpha, dt);
        x = rp.x;
        z = rp.z;
        yaw = Math.atan2(this.aim.x - x, this.aim.z - z);
      }
      if (dead && !v.char.isDead) v.char.die();
      if (!dead && v.char.isDead) v.char.revive();
      if (!isMe && ps.act !== Act.Idle && v.lastAct === Act.Idle) v.char.swing(ps.act);
      v.lastAct = ps.act;
      v.char.update(dt, x, z, yaw);
      v.label.position.set(x, 2.75, z);
      const hp = (isMe && this.me ? this.me.hp : ps.hp) / PLAYER_MAX_HP;
      v.bar.root.position.set(x, 2.45, z);
      v.bar.set(dead ? 0 : hp, this.sc.camera);
      v.bar.root.visible = !dead && hp < 0.999;
      this.renderedPlayers.set(id, { x, z });
      if (isMe) {
        camX = x;
        camZ = z;
      }
    }
    for (const [id, v] of this.players) {
      if (!seen.has(id)) {
        v.char.dispose();
        v.label.removeFromParent();
        v.bar.dispose();
        this.players.delete(id);
        this.renderedPlayers.delete(id);
      }
    }

    // ── mobs ──
    this.renderedMobs.clear();
    for (const [id, ms] of sample.mobs) {
      if (this.deadMobs.has(id)) continue;
      let v = this.mobs.get(id);
      if (!v) {
        const st = MOB_STYLE[ms.k]!;
        const char = new TabsCharacter({ color: st.color, style: st.style, scale: MOB_DEFS[ms.k as MobKind].scale });
        const bar = new HpBar(ms.k === MobKind.Giant ? 2 : 1);
        this.sc.scene.add(char.root, bar.root);
        v = { char, bar, k: ms.k, lastA: 0 };
        this.mobs.set(id, v);
      }
      v.char.update(dt, ms.x, ms.z, ms.yaw);
      v.bar.root.position.set(ms.x, v.char.height + 0.2, ms.z);
      v.bar.set(ms.hp / ms.mhp, this.sc.camera);
      this.renderedMobs.set(id, { x: ms.x, z: ms.z });
    }
    for (const [id, v] of this.mobs) {
      if (!sample.mobs.has(id)) {
        v.char.dispose();
        v.bar.dispose();
        this.mobs.delete(id);
      }
    }
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i]!;
      d.t += dt;
      d.bar.root.visible = false;
      const p = d.char.root.position;
      d.char.update(dt, p.x, p.z, d.char.root.rotation.y);
      if (d.t > 1.2) {
        d.char.root.position.y = -(d.t - 1.2) * 1.5;
      }
      if (d.t > 2) {
        d.char.dispose();
        d.bar.dispose();
        this.dying.splice(i, 1);
      }
    }

    // ── resources shake, turrets aim, building bars ──
    for (const r of this.resources.values()) {
      if (r.shake > 0) {
        r.shake = Math.max(0, r.shake - dt * 3);
        r.obj.rotation.z = Math.sin(r.shake * 30) * r.shake * 0.12;
      }
    }
    for (const b of this.buildings.values()) {
      b.bar.set(b.s.hp / b.s.mhp, this.sc.camera);
      if (b.s.k === BuildingKind.Turret) {
        const head = b.obj.getObjectByName('head');
        if (head) {
          if (b.recoil <= 0) {
            // idle: track nearest rendered mob in range
            let best = TURRET_RANGE;
            for (const m of this.renderedMobs.values()) {
              const d = dist(b.obj.position.x, b.obj.position.z, m.x, m.z);
              if (d < best) {
                best = d;
                b.aimYaw = Math.atan2(m.x - b.obj.position.x, m.z - b.obj.position.z);
              }
            }
          }
          let diff = b.aimYaw - head.rotation.y;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          head.rotation.y += diff * Math.min(1, dt * 12);
          b.recoil = Math.max(0, b.recoil - dt * 6);
          const barrel = head.getObjectByName('barrel');
          if (barrel) barrel.position.z = 0.6 - b.recoil * 0.2;
        }
      }
    }
    this.core.update(dt, this.coreHp.hp / this.coreHp.mhp);
    this.coreBar.set(this.coreHp.hp / this.coreHp.mhp, this.sc.camera);
    this.coreBar.root.visible = true;

    // ── build ghost ──
    if (this.buildMode !== null) {
      const { gx, gz } = this.ghostCell();
      this.buildGhost.position.set(cellCenter(gx), 0.6, cellCenter(gz));
      this.ghostValid = this.buildCheck(this.buildMode, gx, gz) === null;
      (this.buildGhost.material as THREE.MeshBasicMaterial).color.setHex(this.ghostValid ? 0x22c55e : 0xef4444);
    }
    // ── server-authoritative ghost of the local player (debug) ──
    this.serverGhost.visible = this.showServerGhost && !!this.me;
    if (this.me) this.serverGhost.position.set(this.me.x, 0.95, this.me.z);

    this.effects.update(dt, this.container.clientWidth, this.container.clientHeight);
    if (this.playerId) this.sc.follow(camX, camZ, dt);
    this.sc.renderer.render(this.sc.scene, this.sc.camera);
  }

  /** For HUD: remaining resources on the map. */
  mapTotals() {
    const t = { wood: 0, stone: 0, iron: 0 };
    for (const r of this.resources.values()) {
      if (r.s.k === ResourceKind.Tree) t.wood += r.s.amt;
      else if (r.s.k === ResourceKind.Rock) t.stone += r.s.amt;
      else t.iron += r.s.amt;
    }
    return t;
  }

  minimapData() {
    return { resources: this.resources, buildings: this.buildings, mobs: this.renderedMobs, players: this.renderedPlayers, me: this.playerId };
  }
}
