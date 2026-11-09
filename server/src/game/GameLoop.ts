import { TICK_MS } from '@surviver/shared';

/** Fixed 20 TPS loop (setInterval, 50 ms) with timing statistics for the admin panel / report. */
export class GameLoop {
  readonly stats = { ticks: 0, avgTickMs: 0, maxTickMs: 0, avgIntervalMs: TICK_MS, startedAt: Date.now() };
  private timer: NodeJS.Timeout | null = null;
  private last = 0;

  constructor(private readonly step: (now: number) => void) {}

  start() {
    this.last = performance.now();
    this.timer = setInterval(() => {
      const t0 = performance.now();
      const interval = t0 - this.last;
      this.last = t0;
      this.step(Date.now());
      const took = performance.now() - t0;
      const s = this.stats;
      s.ticks++;
      s.avgTickMs = s.avgTickMs * 0.98 + took * 0.02;
      s.avgIntervalMs = s.avgIntervalMs * 0.98 + interval * 0.02;
      s.maxTickMs = Math.max(s.maxTickMs * 0.999, took);
    }, TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
