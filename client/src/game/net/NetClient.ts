// Network layer of the client: WebSocket, (de)serialization, ping/RTT, traffic statistics.
// Knows nothing about rendering; the game subscribes to typed messages.

import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@surviver/shared';
import { LagSimulator } from './LagSimulator';

type Handler = (msg: ServerMessage) => void;

export class NetStats {
  bytesIn = 0;
  bytesOut = 0;
  msgsIn = 0;
  msgsOut = 0;
  rtt = 0;
  rttAvg = 0;
  jitter = 0;
  rttHistory: number[] = [];
  bwHistory: number[] = []; // KiB/s down per second
  inRate = 0; // B/s
  outRate = 0;
  snapRate = 0; // snapshots/s
  missedTicks = 0;
  droppedSnapshots = 0; // simulated loss
  private lastBytesIn = 0;
  private lastBytesOut = 0;
  snapCount = 0;
  private lastSnapCount = 0;

  /** called once per second */
  roll() {
    this.inRate = this.bytesIn - this.lastBytesIn;
    this.outRate = this.bytesOut - this.lastBytesOut;
    this.snapRate = this.snapCount - this.lastSnapCount;
    this.lastBytesIn = this.bytesIn;
    this.lastBytesOut = this.bytesOut;
    this.lastSnapCount = this.snapCount;
    this.bwHistory.push(this.inRate / 1024);
    if (this.bwHistory.length > 60) this.bwHistory.shift();
  }
}

export class NetClient {
  ws: WebSocket | null = null;
  readonly stats = new NetStats();
  readonly lag = new LagSimulator();
  /** server clock offset from PING/PONG (NTP-like): serverTime ≈ Date.now() + clockOffset */
  clockOffset = 0;
  private handlers = new Set<Handler>();
  private pingId = 0;
  private timers: number[] = [];
  onClose: ((code: number, reason: string) => void) | null = null;

  constructor(readonly url: string) {}

  connect(name: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        this.send({ type: 'HELLO', v: PROTOCOL_VERSION, name, ...(token ? { token } : {}) });
        this.timers.push(window.setInterval(() => this.ping(), 1000));
        this.timers.push(window.setInterval(() => this.stats.roll(), 1000));
        resolve();
      };
      ws.onerror = () => reject(new Error('WebSocket error'));
      ws.onclose = (e) => {
        this.timers.forEach(clearInterval);
        this.timers = [];
        this.onClose?.(e.code, e.reason);
      };
      ws.onmessage = (e: MessageEvent<string>) => {
        const size = e.data.length;
        this.lag.incoming(() => {
          this.stats.bytesIn += size;
          this.stats.msgsIn++;
          let msg: ServerMessage;
          try {
            msg = JSON.parse(e.data) as ServerMessage;
          } catch {
            return;
          }
          if (msg.type === 'PONG') this.onPong(msg.ts, msg.serverTime);
          this.handlers.forEach((h) => h(msg));
        });
      };
    });
  }

  on(h: Handler) {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  send(msg: ClientMessage) {
    this.sendRaw(JSON.stringify(msg));
  }

  /** Raw text frame — used by the anti-cheat test panel to send malformed packets. */
  sendRaw(text: string) {
    this.lag.outgoing(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(text);
      this.stats.bytesOut += text.length;
      this.stats.msgsOut++;
    });
  }

  /** Bypasses the lag simulator (for packet spam tests). */
  sendNow(text: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(text);
    this.stats.bytesOut += text.length;
    this.stats.msgsOut++;
  }

  serverNow() {
    return Date.now() + this.clockOffset;
  }

  private ping() {
    this.send({ type: 'PING', id: ++this.pingId, ts: Date.now() });
  }

  private onPong(ts: number, serverTime: number) {
    const now = Date.now();
    const rtt = now - ts;
    const s = this.stats;
    s.jitter = s.rttHistory.length ? s.jitter * 0.8 + Math.abs(rtt - s.rtt) * 0.2 : 0;
    s.rtt = rtt;
    s.rttAvg = s.rttAvg ? s.rttAvg * 0.8 + rtt * 0.2 : rtt;
    s.rttHistory.push(rtt);
    if (s.rttHistory.length > 60) s.rttHistory.shift();
    const offset = serverTime + rtt / 2 - now;
    this.clockOffset = s.rttHistory.length <= 1 ? offset : this.clockOffset * 0.8 + offset * 0.2;
  }

  close() {
    this.ws?.close();
  }
}
