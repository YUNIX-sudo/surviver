import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PREP_SECONDS, DEFAULT_TOTAL_WAVES } from '@surviver/shared';

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

function findStaticDir(): string | null {
  const candidates = [process.env.STATIC_DIR, 'client/dist', '../client/dist'].filter((p): p is string => !!p);
  for (const c of candidates) {
    const abs = resolve(process.cwd(), c);
    if (existsSync(resolve(abs, 'index.html'))) return abs;
  }
  return null;
}

const generatedAdminToken = randomBytes(12).toString('hex');

export const config = {
  port: num(process.env.PORT, 8080),
  host: process.env.HOST ?? '0.0.0.0',
  prepSeconds: num(process.env.PREP_SECONDS, DEFAULT_PREP_SECONDS),
  totalWaves: num(process.env.TOTAL_WAVES, DEFAULT_TOTAL_WAVES),
  allowDebug: (process.env.ALLOW_DEBUG ?? '1') !== '0',
  mapSeed: num(process.env.MAP_SEED, 20261109),
  adminToken: process.env.ADMIN_TOKEN || generatedAdminToken,
  adminTokenGenerated: !process.env.ADMIN_TOKEN,
  dataDir: resolve(process.cwd(), process.env.DATA_DIR ?? 'data'),
  staticDir: findStaticDir(),
  logViolations: (process.env.LOG_VIOLATIONS ?? '1') !== '0',
};
export type ServerConfig = typeof config;
