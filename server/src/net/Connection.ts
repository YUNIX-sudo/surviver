// Network layer: one WebSocket connection. Knows about bytes, frames, rate limiting and schema validation,
// but nothing about game rules. Game code sees it only through the PlayerLink interface.

import type { WebSocket, RawData } from 'ws';
import { AC, MAX_FRAME_BYTES, parseClientFrame, type ClientMessage, type ServerMessage } from '@surviver/shared';
import { TokenBucket } from './RateLimiter';

/** Heartbeat runs every 3 s; terminate only after ~15 s of total silence (lag spikes must not drop players). */
const HEARTBEAT_MAX_MISSED = 5;

export interface PlayerLink {
  readonly id: number;
  readonly remote: string;
  send(msg: ServerMessage): void;
  sendRaw(json: string): void;
  close(code: number, reason: string): void;
  readonly stats: ConnStats;
}

export interface ConnStats {
  bytesIn: number;
  bytesOut: number;
  msgsIn: number;
  msgsOut: number;
  dropped: number;
  rtt: number; // ms, from WS ping/pong heartbeat
  connectedAt: number;
}

export interface ConnectionHandler {
  onMessage(conn: Connection, msg: ClientMessage): void;
  /** Network-level violation (flood, malformed frame). */
  onProtocolViolation(conn: Connection, kind: 'RATE_LIMIT' | 'MALFORMED_PACKET', detail: string): void;
  onClose(conn: Connection): void;
}

export const netTotals = { bytesIn: 0, bytesOut: 0, msgsIn: 0, msgsOut: 0, dropped: 0, connections: 0 };

let nextId = 1;

export class Connection implements PlayerLink {
  readonly id = nextId++;
  readonly stats: ConnStats = { bytesIn: 0, bytesOut: 0, msgsIn: 0, msgsOut: 0, dropped: 0, rtt: 0, connectedAt: Date.now() };
  private bucket = new TokenBucket(AC.RATE_PER_SEC, AC.RATE_BURST);
  private droppedWindow: number[] = []; // timestamps (s) of rate-limited frames, for flood-kick
  private rateReportAt = 0;
  private droppedSinceReport = 0;
  private pingSentAt = 0;
  /** Heartbeats without a pong / any frame. A bad link may stall for seconds: be patient. */
  private missed = 0;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    readonly remote: string,
    private readonly handler: ConnectionHandler,
  ) {
    netTotals.connections++;
    ws.on('message', (data, isBinary) => this.onFrame(data, isBinary));
    ws.on('close', () => this.onClosed());
    ws.on('error', () => this.onClosed());
    ws.on('pong', () => {
      this.missed = 0;
      this.stats.rtt = Date.now() - this.pingSentAt;
    });
  }

  /** Heartbeat: called every few seconds by the WS server. Terminates dead peers. */
  heartbeat() {
    if (this.missed >= HEARTBEAT_MAX_MISSED) {
      this.ws.terminate();
      return;
    }
    this.missed++;
    this.pingSentAt = Date.now();
    try {
      this.ws.ping();
    } catch {
      /* socket already closing */
    }
  }

  send(msg: ServerMessage) {
    this.sendRaw(JSON.stringify(msg));
  }

  sendRaw(json: string) {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    this.ws.send(json);
    const n = Buffer.byteLength(json);
    this.stats.bytesOut += n;
    this.stats.msgsOut++;
    netTotals.bytesOut += n;
    netTotals.msgsOut++;
  }

  close(code: number, reason: string) {
    if (this.closed) return;
    this.ws.close(code, reason.slice(0, 120));
    setTimeout(() => this.ws.terminate(), 1000).unref();
  }

  private onFrame(data: RawData, isBinary: boolean) {
    const size = Array.isArray(data) ? data.reduce((s, b) => s + b.length, 0) : (data as Buffer | ArrayBuffer).byteLength;
    this.stats.bytesIn += size;
    this.stats.msgsIn++;
    this.missed = 0; // any frame proves the peer is alive
    netTotals.bytesIn += size;
    netTotals.msgsIn++;

    // 1) Rate limiting (token bucket). Excess frames are dropped before any parsing work.
    const now = Date.now();
    if (!this.bucket.take(now)) {
      this.stats.dropped++;
      netTotals.dropped++;
      this.droppedSinceReport++;
      this.droppedWindow.push(now);
      while (this.droppedWindow.length && this.droppedWindow[0]! < now - 10_000) this.droppedWindow.shift();
      if (this.droppedWindow.length >= AC.FLOOD_KICK_DROPS) {
        this.handler.onProtocolViolation(this, 'RATE_LIMIT', `flood: ${this.droppedWindow.length} frames dropped in 10s — kick`);
        this.close(4008, 'flood');
        return;
      }
      // Aggregate: one report per burst (300 ms window) with the number of dropped frames.
      if (now - this.rateReportAt > 1000) {
        this.rateReportAt = now;
        setTimeout(() => {
          if (this.closed) return;
          this.handler.onProtocolViolation(this, 'RATE_LIMIT', `${this.droppedSinceReport} frame(s) dropped by token bucket (${AC.RATE_PER_SEC}/s, burst ${AC.RATE_BURST})`);
          this.droppedSinceReport = 0;
        }, 300).unref();
      }
      return;
    }
    // 2) Size + framing sanitization.
    if (isBinary) {
      this.handler.onProtocolViolation(this, 'MALFORMED_PACKET', 'binary frames are not accepted');
      return;
    }
    if (size > MAX_FRAME_BYTES) {
      this.handler.onProtocolViolation(this, 'MALFORMED_PACKET', `frame too large: ${size} B`);
      return;
    }
    // 3) JSON parse + schema validation.
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as Buffer).toString('utf8');
    const res = parseClientFrame(text);
    if (!res.ok) {
      this.handler.onProtocolViolation(this, 'MALFORMED_PACKET', res.error);
      return;
    }
    this.handler.onMessage(this, res.msg);
  }

  private onClosed() {
    if (this.closed) return;
    this.closed = true;
    netTotals.connections--;
    this.handler.onClose(this);
  }
}
