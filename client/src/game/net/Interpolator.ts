// Entity Interpolation: remote players and mobs are rendered ~100 ms in the past,
// linearly interpolated between the two snapshots surrounding renderTime. 20 Hz in, 60-120 FPS out.

import { lerp, lerpAngle, type MobState, type PlayerState } from '@surviver/shared';

interface Frame {
  time: number; // server time of snapshot
  players: Map<number, PlayerState>;
  mobs: Map<number, MobState>;
}

export interface InterpEntity {
  x: number;
  z: number;
  yaw: number;
}

export class Interpolator {
  delayMs = 100;
  enabled = true;
  private frames: Frame[] = [];
  /** snapshot-clock offset: serverTime - localTime as seen on arrival (smoothed) */
  private offset: number | null = null;

  push(time: number, players: PlayerState[], mobs: MobState[]) {
    const now = performance.now();
    const sample = time - now;
    // track arrival clock; follow quickly when snapshots come "early", slowly when late (jitter)
    if (this.offset === null) this.offset = sample;
    else this.offset += (sample - this.offset) * (sample > this.offset ? 0.2 : 0.02);
    this.frames.push({ time, players: new Map(players.map((p) => [p.id, p])), mobs: new Map(mobs.map((m) => [m.id, m])) });
    if (this.frames.length > 40) this.frames.shift();
  }

  clear() {
    this.frames = [];
    this.offset = null;
  }

  get bufferSize() {
    return this.frames.length;
  }

  renderTime() {
    return performance.now() + (this.offset ?? 0) - (this.enabled ? this.delayMs : 0);
  }

  /** Returns the two frames to blend and t. */
  private bracket(): { a: Frame; b: Frame; t: number } | null {
    const n = this.frames.length;
    if (!n) return null;
    const last = this.frames[n - 1]!;
    if (!this.enabled || n === 1) return { a: last, b: last, t: 1 };
    const rt = this.renderTime();
    for (let i = n - 1; i > 0; i--) {
      const a = this.frames[i - 1]!;
      const b = this.frames[i]!;
      if (a.time <= rt) {
        if (rt >= b.time) return { a: b, b, t: 1 }; // buffer starved: hold newest
        return { a, b, t: (rt - a.time) / (b.time - a.time) };
      }
    }
    return { a: this.frames[0]!, b: this.frames[0]!, t: 1 };
  }

  sample(): { players: Map<number, PlayerState & InterpEntity>; mobs: Map<number, MobState & InterpEntity> } {
    const players = new Map<number, PlayerState & InterpEntity>();
    const mobs = new Map<number, MobState & InterpEntity>();
    const br = this.bracket();
    if (!br) return { players, mobs };
    const { a, b, t } = br;
    for (const [id, pb] of b.players) {
      const pa = a.players.get(id) ?? pb;
      players.set(id, { ...pb, x: lerp(pa.x, pb.x, t), z: lerp(pa.z, pb.z, t), yaw: lerpAngle(pa.yaw, pb.yaw, t) });
    }
    for (const [id, mb] of b.mobs) {
      const ma = a.mobs.get(id) ?? mb;
      mobs.set(id, { ...mb, x: lerp(ma.x, mb.x, t), z: lerp(ma.z, mb.z, t), yaw: lerpAngle(ma.yaw, mb.yaw, t) });
    }
    return { players, mobs };
  }
}
