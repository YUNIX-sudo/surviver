import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { MAX_FRAME_BYTES } from '@surviver/shared';
import { Connection, type ConnectionHandler } from './Connection';

/** Attaches a WebSocket endpoint at `path` to an existing HTTP server (handles the HTTP Upgrade). */
export function attachWsServer(http: Server, path: string, handler: ConnectionHandler) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES * 4, // hard cap at the socket level; finer check in Connection
    perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 3 } }, // snapshots compress ~5-8x
  });
  const conns = new Set<Connection>();

  http.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const fwd = req.headers['x-forwarded-for'];
      const remote = (Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0])?.trim() ?? req.socket.remoteAddress ?? '?';
      const conn = new Connection(ws, remote, {
        onMessage: (c, m) => handler.onMessage(c, m),
        onProtocolViolation: (c, k, d) => handler.onProtocolViolation(c, k, d),
        onClose: (c) => {
          conns.delete(c);
          handler.onClose(c);
        },
      });
      conns.add(conn);
    });
  });

  const hb = setInterval(() => conns.forEach((c) => c.heartbeat()), 3000);
  hb.unref();
  return { wss, conns };
}
