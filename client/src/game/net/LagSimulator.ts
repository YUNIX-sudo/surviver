// Artificial network conditions for demonstrations (prediction/interpolation under bad networks).
// Preserves message order (like TCP): release time = max(previous release, now + delay).

export class LagSimulator {
  latencyMs = 0; // round-trip; applied half per direction
  jitterMs = 0;
  snapshotLoss = 0; // 0..1 — fraction of incoming snapshots whose *positions* are discarded
  private lastOut = 0;
  private lastIn = 0;

  get active() {
    return this.latencyMs > 0 || this.jitterMs > 0;
  }

  private delay() {
    return this.latencyMs / 2 + Math.random() * this.jitterMs;
  }

  outgoing(fn: () => void) {
    if (!this.active) return fn();
    const t = Math.max(this.lastOut, performance.now() + this.delay());
    this.lastOut = t;
    setTimeout(fn, t - performance.now());
  }

  incoming(fn: () => void) {
    if (!this.active) return fn();
    const t = Math.max(this.lastIn, performance.now() + this.delay());
    this.lastIn = t;
    setTimeout(fn, t - performance.now());
  }

  dropSnapshot() {
    return this.snapshotLoss > 0 && Math.random() < this.snapshotLoss;
  }
}
