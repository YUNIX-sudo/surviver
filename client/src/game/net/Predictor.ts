// Client-Side Prediction + Server Reconciliation for the local player.
// Uses the exact same stepPlayer() as the server, so a prediction is only wrong when the world differs.

import { TICK_DT, stepPlayer, type CollisionWorld } from '@surviver/shared';

interface PendingInput {
  seq: number;
  mx: number;
  mz: number;
}

export class Predictor {
  pos = { x: 0, z: 0 };
  prev = { x: 0, z: 0 }; // position before the latest step (for render interpolation between 20 Hz steps)
  pending: PendingInput[] = [];
  /** visual error offset, decays to 0 => corrections are smoothed instead of popping */
  errX = 0;
  errZ = 0;
  reconciliations = 0;
  lastCorrection = 0;
  enabledReconcile = true;
  serverPos = { x: 0, z: 0 };

  constructor(private readonly world: CollisionWorld) {}

  reset(x: number, z: number) {
    this.pos = { x, z };
    this.prev = { x, z };
    this.pending = [];
    this.errX = this.errZ = 0;
  }

  /** Apply one input locally right away (no waiting for the server). */
  apply(seq: number, mx: number, mz: number, frozen: boolean) {
    this.prev = { ...this.pos };
    if (!frozen) stepPlayer(this.pos, mx, mz, TICK_DT, this.world);
    this.pending.push({ seq, mx: frozen ? 0 : mx, mz: frozen ? 0 : mz });
    if (this.pending.length > 120) this.pending.shift();
  }

  /**
   * Server says: after processing input `ack` you were at (x,z).
   * Rewind to that, drop acknowledged inputs, replay the rest.
   */
  reconcile(ack: number, x: number, z: number, hard = false) {
    this.serverPos = { x, z };
    this.pending = this.pending.filter((p) => p.seq > ack);
    const before = { ...this.pos };
    const replay = { x, z };
    if (this.enabledReconcile || hard) {
      for (const p of this.pending) stepPlayer(replay, p.mx, p.mz, TICK_DT, this.world);
    }
    const ex = before.x - replay.x;
    const ez = before.z - replay.z;
    const err = Math.hypot(ex, ez);
    if (err > 0.01) {
      this.reconciliations++;
      this.lastCorrection = err;
    }
    this.pos = replay;
    this.prev = { x: this.prev.x - ex, z: this.prev.z - ez };
    if (err > 2.5 || hard) {
      // rubberband / teleport correction: show it, don't smooth it away
      this.errX = this.errZ = 0;
      this.prev = { ...replay };
    } else {
      this.errX += ex;
      this.errZ += ez;
    }
  }

  /** Render position: interpolate between last two fixed steps (alpha in [0,1]) + decaying error offset. */
  renderPos(alpha: number, dt: number) {
    const k = Math.exp(-dt * 12);
    this.errX *= k;
    this.errZ *= k;
    return {
      x: this.prev.x + (this.pos.x - this.prev.x) * alpha + this.errX,
      z: this.prev.z + (this.pos.z - this.prev.z) * alpha + this.errZ,
    };
  }
}
