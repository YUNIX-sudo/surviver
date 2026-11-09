// AntiCheatEngine: every rule that protects the authoritative simulation from a modified client.
// Each check either passes, or reports a violation (logged on server, sent to the offender, shown in admin panel)
// and tells the caller what to do (drop / clamp / correct). A decaying score kicks persistent cheaters.

import {
  AC,
  PLAYER_SPEED,
  TICK_DT,
  dist,
  sanitizeMove,
  type Inventory,
  type Severity,
  type ViolationAction,
  type ViolationKind,
} from '@surviver/shared';
import type { PlayerLink } from '../net/Connection';

export interface AcState {
  score: number;
  scoreAt: number;
  total: number;
  byKind: Partial<Record<ViolationKind, number>>;
  lastReportAt: Partial<Record<string, number>>;
  lastSeq: number;
  lastClaimed: { x: number; z: number } | null;
  lastReconcileAt: number;
  /** A correction was sent; claims are not judged until the client converges (inputs already in flight carry stale predictions). */
  resyncing: boolean;
  kicked: boolean;
}

export const newAcState = (): AcState => ({
  score: 0,
  scoreAt: Date.now(),
  total: 0,
  byKind: {},
  lastReportAt: {},
  lastSeq: -1,
  lastClaimed: null,
  lastReconcileAt: 0,
  resyncing: false,
  kicked: false,
});

/** Anything the engine can judge: a connected client session. */
export interface AcSubject {
  link: PlayerLink;
  ac: AcState;
  name: string;
  roomId: string | null;
}

export interface ViolationRecord {
  at: number;
  clientId: number;
  name: string;
  remote: string;
  roomId: string | null;
  kind: ViolationKind;
  message: string;
  severity: Severity;
  action: ViolationAction;
  score: number;
}

const WEIGHT: Record<Severity, number> = { low: 4, medium: 15, high: 40 };

export class AntiCheatEngine {
  readonly log: ViolationRecord[] = [];
  readonly counters: Partial<Record<ViolationKind, number>> = {};
  private listeners = new Set<(v: ViolationRecord) => void>();

  constructor(private readonly verbose: boolean) {}

  onViolation(fn: (v: ViolationRecord) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Record a violation. `throttleMs` collapses repeated identical reports (e.g. 20 speedhack inputs/s)
   * into one log line — the offending packets are still rejected every time.
   */
  report(s: AcSubject, kind: ViolationKind, message: string, severity: Severity, action: ViolationAction, tick = 0, throttleMs = 0) {
    const now = Date.now();
    const ac = s.ac;
    ac.score = Math.max(0, ac.score - ((now - ac.scoreAt) / 1000) * AC.SCORE_DECAY_PER_SEC);
    ac.scoreAt = now;
    ac.total++;
    ac.byKind[kind] = (ac.byKind[kind] ?? 0) + 1;
    this.counters[kind] = (this.counters[kind] ?? 0) + 1;

    // Collapsed repeats are still rejected but neither logged nor scored: one burst (e.g. a lag spike
    // flushing a backlog) must not add up to a kick. Persistent cheating still scores once per window.
    const throttleKey = kind + action;
    if (throttleMs > 0 && now - (ac.lastReportAt[throttleKey] ?? 0) < throttleMs) return;
    ac.lastReportAt[throttleKey] = now;
    ac.score += WEIGHT[severity];

    const rec: ViolationRecord = {
      at: now,
      clientId: s.link.id,
      name: s.name,
      remote: s.link.remote,
      roomId: s.roomId,
      kind,
      message,
      severity,
      action,
      score: Math.round(ac.score),
    };
    this.push(rec);
    s.link.send({ type: 'ANTICHEAT_VIOLATION', kind, message, severity, action, tick, score: rec.score });
    if (ac.score >= AC.KICK_SCORE) this.kick(s, kind, tick);
  }

  private kick(s: AcSubject, kind: ViolationKind, tick: number) {
    if (s.ac.kicked) return;
    s.ac.kicked = true;
    const message = `violation score ${Math.round(s.ac.score)} ≥ ${AC.KICK_SCORE}: disconnected`;
    this.push({ at: Date.now(), clientId: s.link.id, name: s.name, remote: s.link.remote, roomId: s.roomId, kind, message, severity: 'high', action: 'kicked', score: Math.round(s.ac.score) });
    s.link.send({ type: 'ANTICHEAT_VIOLATION', kind, message, severity: 'high', action: 'kicked', tick, score: Math.round(s.ac.score) });
    s.link.close(4003, 'anticheat');
  }

  private push(rec: ViolationRecord) {
    this.log.push(rec);
    if (this.log.length > 500) this.log.shift();
    if (this.verbose) {
      console.warn(`[anticheat] ${rec.action.toUpperCase().padEnd(9)} ${rec.kind.padEnd(22)} #${rec.clientId} ${rec.name} (${rec.remote}) room=${rec.roomId ?? '-'} score=${rec.score} :: ${rec.message}`);
    }
    this.listeners.forEach((l) => l(rec));
  }

  // ───────────────────────── checks ─────────────────────────

  /** Sequence numbers must strictly increase (protects against replayed / reordered packets). */
  checkSeq(s: AcSubject, seq: number, tick: number): boolean {
    if (seq <= s.ac.lastSeq) {
      this.report(s, 'SEQ_REPLAY', `seq ${seq} ≤ last ${s.ac.lastSeq}`, 'medium', 'dropped', tick, 500);
      return false;
    }
    s.ac.lastSeq = seq;
    return true;
  }

  /**
   * Input frequency: the client samples at TICK_RATE and the server simulates at most that fast (movement credit).
   * Bursts after a lag spike are fine; only a backlog that keeps growing (more inputs than real time allows)
   * means time dilation.
   */
  checkInputRate(s: AcSubject, queueLen: number, tick: number): boolean {
    if (queueLen >= AC.MAX_INPUT_QUEUE) {
      this.report(s, 'SPEEDHACK', `input queue overflow (${queueLen}) — inputs faster than server tick`, 'medium', 'dropped', tick, 1000);
      return false;
    }
    return true;
  }

  /** Movement vector must be at most unit length. Longer vectors are clamped. */
  checkMoveVector(s: AcSubject, mx: number, mz: number, tick: number) {
    const m = sanitizeMove(mx, mz);
    if (m.clamped) {
      this.report(s, 'SPEEDHACK', `move vector |v|=${Math.hypot(mx, mz).toFixed(2)} > 1 → clamped`, 'medium', 'clamped', tick, 1000);
    }
    return m;
  }

  /**
   * v·Δt check on the client's claimed (predicted) position.
   * The server never *uses* the claimed position — it only compares it with its own authoritative result.
   * Returns true if the client must be hard-corrected (SERVER_RECONCILE).
   */
  checkClaimedPosition(s: AcSubject, server: { x: number; z: number }, px: number, pz: number, tick: number): boolean {
    const prev = s.ac.lastClaimed;
    s.ac.lastClaimed = { x: px, z: pz };
    const divergence = dist(server.x, server.z, px, pz);
    const now = Date.now();
    if (s.ac.resyncing) {
      // Waiting for the client to apply the correction. The claimed position is never used for simulation,
      // so not judging it here costs nothing; on a slow link the correction may also be lost/late → resend.
      if (divergence <= AC.DIVERGENCE_TOLERANCE) s.ac.resyncing = false;
      else if (now - s.ac.lastReconcileAt > AC.RESYNC_RETRY_MS) {
        s.ac.lastReconcileAt = now;
        return true;
      }
      return false;
    }
    if (divergence <= AC.DIVERGENCE_TOLERANCE) return false;
    const maxStep = PLAYER_SPEED * TICK_DT;
    const step = prev ? dist(prev.x, prev.z, px, pz) : 0;
    if (step > maxStep * AC.STEP_TOLERANCE_FACTOR) {
      const kind: ViolationKind = step > AC.TELEPORT_DISTANCE ? 'TELEPORT' : 'SPEEDHACK';
      this.report(
        s,
        kind,
        `claimed step ${step.toFixed(2)} m > v·Δt=${maxStep.toFixed(2)} m (×${AC.STEP_TOLERANCE_FACTOR}); off by ${divergence.toFixed(2)} m`,
        kind === 'TELEPORT' ? 'high' : 'low',
        'corrected',
        tick,
        kind === 'TELEPORT' ? 0 : 1000,
      );
      s.ac.lastReconcileAt = now;
      s.ac.resyncing = true;
      return true;
    }
    // Large silent desync (e.g. lost snapshots on a bad link): resync without punishing.
    if (divergence > AC.TELEPORT_DISTANCE * 0.6) {
      s.ac.lastReconcileAt = now;
      s.ac.resyncing = true;
      return true;
    }
    return false;
  }

  /** Rapid-fire protection. Times are in *player simulation time* (processed inputs × Δt), immune to jitter. */
  checkCooldown(s: AcSubject, what: string, simNow: number, lastAt: number, cooldownMs: number, tick: number): boolean {
    const elapsed = simNow - lastAt;
    if (elapsed + AC.COOLDOWN_GRACE_MS < cooldownMs) {
      this.report(s, 'COOLDOWN', `${what} again after ${elapsed} ms < cooldown ${cooldownMs} ms (rapid fire)`, 'low', 'dropped', tick, 500);
      return false;
    }
    return true;
  }

  /** Far-reach / kill-aura protection: Euclidean distance to target. */
  checkReach(s: AcSubject, what: string, d: number, reach: number, tick: number): boolean {
    if (d > reach) {
      this.report(s, 'OUT_OF_RANGE', `${what}: target ${d.toFixed(2)} m away > reach ${reach} m (kill aura / far reach)`, d > reach * 3 ? 'high' : 'medium', 'dropped', tick, 300);
      return false;
    }
    return true;
  }

  checkBuildRange(s: AcSubject, d: number, range: number, tick: number): boolean {
    if (d > range) {
      this.report(s, 'BUILD_OUT_OF_RANGE', `build ${d.toFixed(1)} m from player > ${range} m (remote build hack)`, 'medium', 'dropped', tick, 300);
      return false;
    }
    return true;
  }

  checkResources(s: AcSubject, inv: Inventory, cost: Partial<Inventory>, what: string, tick: number): boolean {
    const missing = (Object.keys(cost) as (keyof Inventory)[]).filter((k) => inv[k] < (cost[k] ?? 0));
    if (missing.length) {
      const need = missing.map((k) => `${k} ${inv[k]}/${cost[k]}`).join(', ');
      this.report(s, 'INSUFFICIENT_RESOURCES', `${what}: not enough ${need} (server inventory is authoritative)`, 'low', 'dropped', tick, 250);
      return false;
    }
    return true;
  }
}
