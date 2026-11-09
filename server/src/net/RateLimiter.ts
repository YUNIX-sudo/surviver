/** Classic token bucket: `rate` tokens/s refill, at most `burst` stored. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {
    this.tokens = burst;
    this.last = Date.now();
  }
  take(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
