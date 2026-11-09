// Surviver authoritative game server: HTTP (static + REST) and WebSocket (/ws) on one port, 20 TPS loop.

import { TICK_RATE } from '@surviver/shared';
import { AccountStore } from './accounts/AccountStore';
import { AntiCheatEngine } from './anticheat/AntiCheatEngine';
import { config } from './config';
import { GameLoop } from './game/GameLoop';
import { createHttpServer } from './http/HttpServer';
import { Lobby } from './Lobby';
import { attachWsServer } from './net/WsServer';

const accounts = new AccountStore(config.dataDir);
const ac = new AntiCheatEngine(config.logViolations);
const lobby = new Lobby(config, ac, accounts);
const loop = new GameLoop((now) => lobby.tickAll(now));
const http = createHttpServer({ cfg: config, lobby, accounts, ac, loop });
attachWsServer(http, '/ws', lobby);

http.listen(config.port, config.host, () => {
  loop.start();
  console.log(`[surviver] http://${config.host}:${config.port}  ws://…:${config.port}/ws  tick=${TICK_RATE}Hz`);
  console.log(`[surviver] prep=${config.prepSeconds}s waves=${config.totalWaves} debug=${config.allowDebug} seed=${config.mapSeed}`);
  console.log(`[surviver] static: ${config.staticDir ?? '(none)'}  data: ${config.dataDir}`);
  if (config.adminTokenGenerated) console.log(`[surviver] ADMIN_TOKEN not set, generated: ${config.adminToken}`);
});

const shutdown = () => {
  console.log('[surviver] shutting down');
  loop.stop();
  accounts.flush();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
