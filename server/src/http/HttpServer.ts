// HTTP: static client files + REST API (accounts, rooms, leaderboard) + admin API.

import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { MAX_PLAYERS_PER_ROOM, TICK_RATE, type DebugCommand } from '@surviver/shared';
import { publicAccount, type AccountStore } from '../accounts/AccountStore';
import type { AntiCheatEngine } from '../anticheat/AntiCheatEngine';
import type { ServerConfig } from '../config';
import type { GameLoop } from '../game/GameLoop';
import type { Lobby } from '../Lobby';
import { netTotals } from '../net/Connection';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.exe': 'application/octet-stream',
  '.zip': 'application/zip',
  '.dmg': 'application/x-apple-diskimage',
};

type Handler = (req: IncomingMessage, body: Record<string, unknown>, url: URL) => Promise<[number, unknown]> | [number, unknown];

export function createHttpServer(deps: { cfg: ServerConfig; lobby: Lobby; accounts: AccountStore; ac: AntiCheatEngine; loop: GameLoop }) {
  const { cfg, lobby, accounts, ac, loop } = deps;
  const startedAt = Date.now();

  const bearer = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  };
  const isAdmin = (req: IncomingMessage) => {
    const a = Buffer.from(bearer(req));
    const b = Buffer.from(cfg.adminToken);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const str = (v: unknown) => (typeof v === 'string' ? v : '');

  const publicStats = () => ({
    online: lobby.sessions.size,
    rooms: lobby.rooms.size,
    tickRate: TICK_RATE,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    avgTickMs: +loop.stats.avgTickMs.toFixed(3),
  });

  const api: Record<string, Handler> = {
    'GET /api/health': () => [200, { ok: true }],
    'GET /api/stats': () => [200, publicStats()],
    'GET /api/rooms': () => [200, { rooms: lobby.roomList(), maxPlayers: MAX_PLAYERS_PER_ROOM }],
    'GET /api/leaderboard': () => [200, { players: accounts.leaderboard(20) }],
    'POST /api/register': (_r, b) => {
      const res = accounts.register(str(b.username).trim(), str(b.password));
      return res.ok ? [200, { token: res.token, account: publicAccount(res.account) }] : [400, { error: res.error }];
    },
    'POST /api/login': (_r, b) => {
      const res = accounts.login(str(b.username).trim(), str(b.password));
      return res.ok ? [200, { token: res.token, account: publicAccount(res.account) }] : [401, { error: res.error }];
    },
    'POST /api/logout': (r) => {
      accounts.logout(bearer(r));
      return [200, { ok: true }];
    },
    'GET /api/me': (r) => {
      const a = accounts.byToken(bearer(r));
      return a ? [200, { account: publicAccount(a) }] : [401, { error: 'not logged in' }];
    },

    // ── admin ──
    'GET /api/admin/state': () => [
      200,
      {
        server: { ...publicStats(), loop: loop.stats, net: netTotals, config: { prepSeconds: cfg.prepSeconds, totalWaves: cfg.totalWaves, allowDebug: cfg.allowDebug, mapSeed: cfg.mapSeed } },
        rooms: [...lobby.rooms.values()].map((r) => ({
          ...r.info(),
          tick: r.tick,
          lastTickMs: +r.lastTickMs.toFixed(3),
          mobs: r.mobs.size,
          buildings: r.world.buildings.size,
          resources: r.world.resources.size,
          resourceTotals: r.world.totals(),
          core: r.world.core,
          endsAt: r.phaseEndsAt,
          intermission: r.intermission,
        })),
        sessions: [...lobby.sessions.values()].map((s) => ({
          clientId: s.link.id,
          name: s.name,
          account: s.accountUsername,
          remote: s.link.remote,
          room: s.roomId,
          playerId: s.player?.id ?? null,
          hp: s.player?.hp ?? null,
          inv: s.player?.inv ?? null,
          stats: s.player?.stats ?? null,
          net: s.link.stats,
          acScore: Math.round(s.ac.score),
          acTotal: s.ac.total,
          acByKind: s.ac.byKind,
        })),
        violations: ac.log.slice(-150).reverse(),
        violationCounters: ac.counters,
        accounts: accounts.list().map((a) => ({ username: a.username, banned: a.banned, createdAt: a.createdAt, lastSeen: a.lastSeen, stats: a.stats })),
      },
    ],
    'POST /api/admin/kick': (_r, b) => [lobby.kick(Number(b.clientId), str(b.reason) || 'Kicked by admin') ? 200 : 404, { ok: true }],
    'POST /api/admin/ban': (_r, b) => {
      const username = str(b.username);
      const ok = accounts.setBanned(username, b.banned !== false);
      if (ok && b.banned !== false) for (const s of lobby.sessions.values()) if (s.accountUsername?.toLowerCase() === username.toLowerCase()) lobby.kick(s.link.id, 'Banned');
      return [ok ? 200 : 404, { ok }];
    },
    'POST /api/admin/room': (_r, b) => {
      const room = lobby.rooms.get(str(b.roomId));
      if (!room) return [404, { error: 'no such room' }];
      const cmd = str(b.cmd);
      if (!['skip_phase', 'give_resources', 'spawn_wave', 'heal_core', 'reset'].includes(cmd)) return [400, { error: 'bad cmd' }];
      room.debugCommand(cmd as DebugCommand, 'admin');
      return [200, { ok: true }];
    },
    'POST /api/admin/broadcast': (_r, b) => {
      const text = str(b.text).slice(0, 200);
      if (!text) return [400, { error: 'empty' }];
      for (const room of lobby.rooms.values()) room.broadcast({ type: 'CHAT', from: 'Админ', text, system: true });
      return [200, { ok: true }];
    },
  };

  const send = (res: ServerResponse, code: number, data: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolveBody, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 8192) {
          reject(new Error('body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolveBody({});
        try {
          const v: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolveBody(typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
      req.on('error', reject);
    });

  const serveStatic = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    // /downloads/* (e.g. the Windows build) is served from DATA_DIR/downloads so it lives outside the image
    if (url.pathname.startsWith('/downloads/')) {
      const root = resolve(cfg.dataDir, 'downloads');
      const file = normalize(join(root, decodeURIComponent(url.pathname.slice('/downloads/'.length))));
      if (!file.startsWith(root + '/') || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Файл ещё не загружен на сервер');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'content-length': statSync(file).size, 'content-disposition': 'attachment' });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).pipe(res);
      return;
    }
    if (!cfg.staticDir) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Surviver server is running. Client build not found (run `npm run build -w @surviver/client` or use Vite dev server).');
      return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const root = resolve(cfg.staticDir);
    const file = normalize(join(root, p));
    if (!file.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    let target = file;
    if (!existsSync(target) || statSync(target).isDirectory()) {
      if (existsSync(target + '.html')) target += '.html';
      else {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('404');
        return;
      }
    }
    const immutable = p.startsWith('/assets/');
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'content-length': statSync(target).size,
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(target).pipe(res);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // public API is CORS-enabled so the Electron build (file://) can use it
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
    if (req.method === 'OPTIONS') return res.writeHead(204).end();

    if (url.pathname.startsWith('/api/')) {
      const handler = api[`${req.method} ${url.pathname}`];
      if (!handler) return send(res, 404, { error: 'not found' });
      if (url.pathname.startsWith('/api/admin/') && !isAdmin(req)) return send(res, 401, { error: 'admin token required' });
      try {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const [code, data] = await handler(req, body, url);
        return send(res, code, data);
      } catch (e) {
        return send(res, 400, { error: e instanceof Error ? e.message : 'bad request' });
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
    serveStatic(req, res, url);
  });
}
