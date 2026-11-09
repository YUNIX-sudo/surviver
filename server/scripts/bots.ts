// Headless integration test: 2 honest bots (predicting with shared stepPlayer) + cheat attempts.
// Usage: PREP_SECONDS=3 npm run dev:server   then   npm run test:bots [ws://localhost:8080/ws]

import WebSocket from 'ws';
import {
  BUILDING_DEFS,
  BuildingKind,
  CollisionWorld,
  Mask,
  PROTOCOL_VERSION,
  TICK_DT,
  TICK_MS,
  cellCenter,
  dist,
  stepPlayer,
  worldToCell,
  type ResourceState,
  type ServerMessage,
  type SnapshotMsg,
  type ViolationKind,
} from '@surviver/shared';

const URL = process.argv[2] ?? 'ws://localhost:8080/ws';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Bot {
  ws: WebSocket;
  seq = 0;
  pos = { x: 0, z: 0 };
  playerId = 0;
  world = new CollisionWorld();
  resources = new Map<number, ResourceState>();
  snap: SnapshotMsg | null = null;
  violations: ViolationKind[] = [];
  reconciles = 0;
  snapshots = 0;
  phase = '';
  maxMobs = 0;
  gameOver = '';
  bytes = 0;
  opened: Promise<void>;
  joined: Promise<void>;
  private resolveJoined!: () => void;

  constructor(readonly name: string) {
    this.ws = new WebSocket(URL);
    this.opened = new Promise((r) => this.ws.once('open', () => r()));
    this.joined = new Promise((r) => (this.resolveJoined = r));
    this.ws.on('message', (d) => {
      this.bytes += (d as Buffer).length;
      this.onMsg(JSON.parse(d.toString()) as ServerMessage);
    });
  }

  send(o: object) {
    this.ws.send(JSON.stringify(o));
  }

  onMsg(m: ServerMessage) {
    switch (m.type) {
      case 'ROOM_JOINED':
        this.playerId = m.playerId;
        this.world.clear();
        this.world.addBox(1, 'core', 0, 0, 2, 2, 3);
        for (const r of m.world.resources) {
          this.resources.set(r.id, r);
          this.world.addCircle(r.id, 'resource', r.x, r.z, [0.7, 1, 0.9][r.k]!, 3);
        }
        break;
      case 'WORLD_STATE_SNAPSHOT': {
        this.snapshots++;
        this.snap = m;
        this.maxMobs = Math.max(this.maxMobs, m.mobs.length);
        for (const id of m.removedResources ?? []) {
          this.resources.delete(id);
          this.world.remove(id);
        }
        for (const r of m.resources ?? []) this.resources.set(r.id, r);
        for (const b of m.buildings ?? []) if (BUILDING_DEFS[b.k as BuildingKind].solid) this.world.addBox(b.id, 'building', cellCenter(b.gx), cellCenter(b.gz), 1, 1, 3);
        for (const id of m.removedBuildings ?? []) this.world.remove(id);
        const me = m.players.find((p) => p.id === this.playerId);
        // simplest reconciliation: trust server position (bots send 1 input per server tick)
        if (me) this.pos = { x: me.x, z: me.z };
        if (!me && this.playerId) break;
        if (this.playerId && this.snapshots === 1) this.resolveJoined();
        break;
      }
      case 'SERVER_RECONCILE':
        this.reconciles++;
        this.pos = { x: m.x, z: m.z };
        break;
      case 'ANTICHEAT_VIOLATION':
        this.violations.push(m.kind);
        console.log(`  [${this.name}] ⚠ ${m.kind} (${m.action}) ${m.message}`);
        break;
      case 'GAME_PHASE_UPDATE':
        if (m.phase !== this.phase) console.log(`  [${this.name}] phase → ${m.phase} wave ${m.wave}`);
        this.phase = m.phase;
        break;
      case 'GAME_OVER':
        this.gameOver = m.result;
        break;
      case 'ERROR':
        console.log(`  [${this.name}] ERROR ${m.code}: ${m.message}`);
        break;
    }
  }

  move(mx: number, mz: number, claim?: { x: number; z: number }) {
    stepPlayer(this.pos, mx, mz, TICK_DT, this.world);
    const c = claim ?? this.pos;
    this.send({ type: 'PLAYER_INPUT', seq: ++this.seq, ts: Date.now(), mx, mz, yaw: 0, px: c.x, pz: c.z });
  }

  async walkTo(x: number, z: number, stopAt: number, maxTicks = 200) {
    for (let i = 0; i < maxTicks; i++) {
      const d = dist(this.pos.x, this.pos.z, x, z);
      if (d <= stopAt) return true;
      this.move((x - this.pos.x) / d, (z - this.pos.z) / d);
      await sleep(TICK_MS);
    }
    return false;
  }

  async idle(ticks: number) {
    for (let i = 0; i < ticks; i++) {
      this.move(0, 0);
      await sleep(TICK_MS);
    }
  }
}

function check(name: string, ok: boolean) {
  console.log(`${ok ? '✅' : '❌'} ${name}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  console.log(`connecting to ${URL}`);
  const a = new Bot('alice');
  const b = new Bot('bob');
  await Promise.all([a.opened, b.opened]);
  a.send({ type: 'HELLO', v: PROTOCOL_VERSION, name: 'alice' });
  b.send({ type: 'HELLO', v: PROTOCOL_VERSION, name: 'bob' });
  a.send({ type: 'JOIN_ROOM', roomId: 'bots' });
  await sleep(100);
  b.send({ type: 'JOIN_ROOM', roomId: 'bots' });
  await Promise.all([a.joined, b.joined]);
  await sleep(300); // let alice see a snapshot that already includes bob
  check('both bots joined the same room', a.snap!.players.length === 2);

  // ── honest gameplay: walk to the nearest tree and harvest it ──
  const tree = [...a.resources.values()].filter((r) => r.k === 0).sort((p, q) => dist(0, 0, p.x, p.z) - dist(0, 0, q.x, q.z))[0]!;
  const bobIdle = b.idle(400);
  await a.walkTo(tree.x, tree.z, 1.7 + 0.7);
  for (let i = 0; i < 8; i++) {
    a.send({ type: 'INPUT_HARVEST', seq: ++a.seq, ts: Date.now(), targetId: tree.id });
    await a.idle(10); // 10 ticks = 500 ms > cooldown 450 ms
  }
  check(`honest harvest gives wood (inv.wood=${a.snap!.inv.wood})`, a.snap!.inv.wood >= 6);
  check('no violations for honest play', a.violations.length === 0);

  // honest build: wall next to the player
  const gx = worldToCell(a.pos.x) + 1;
  const gz = worldToCell(a.pos.z) + 1;
  a.send({ type: 'INPUT_BUILD', seq: ++a.seq, ts: Date.now(), kind: 'wall', gx, gz });
  await a.idle(4);
  check('honest build accepted', a.violations.length === 0 && a.world.size > a.resources.size + 1);

  // ── cheats ──
  const before = () => a.violations.length;
  let n = before();
  a.move(10, 0); // speedhack vector
  await a.idle(3);
  check('SPEEDHACK vector detected', a.violations.slice(n).includes('SPEEDHACK'));

  n = before();
  const r0 = a.reconciles;
  a.move(0, 0, { x: a.pos.x + 25, z: a.pos.z });
  await a.idle(6);
  check('TELEPORT detected + SERVER_RECONCILE', a.violations.slice(n).includes('TELEPORT') && a.reconciles > r0);

  n = before();
  for (let i = 0; i < 5; i++) a.send({ type: 'INPUT_BUILD', seq: ++a.seq, ts: Date.now(), kind: 'turret', gx: gx + 1, gz });
  await a.idle(3);
  check('INSUFFICIENT_RESOURCES detected', a.violations.slice(n).includes('INSUFFICIENT_RESOURCES'));

  n = before();
  a.send({ type: 'INPUT_BUILD', seq: ++a.seq, ts: Date.now(), kind: 'wall', gx: 20, gz: 20 });
  await a.idle(3);
  check('BUILD_OUT_OF_RANGE (remote build) detected', a.violations.slice(n).includes('BUILD_OUT_OF_RANGE'));

  n = before();
  const far = [...a.resources.values()].sort((p, q) => dist(a.pos.x, a.pos.z, q.x, q.z) - dist(a.pos.x, a.pos.z, p.x, p.z))[0]!;
  a.send({ type: 'INPUT_HARVEST', seq: ++a.seq, ts: Date.now(), targetId: far.id });
  await a.idle(3);
  check('OUT_OF_RANGE (far reach) detected', a.violations.slice(n).includes('OUT_OF_RANGE'));

  n = before();
  for (let i = 0; i < 5; i++) a.send({ type: 'INPUT_HARVEST', seq: ++a.seq, ts: Date.now(), targetId: tree.id });
  await a.idle(3);
  check('COOLDOWN (rapid fire) detected', a.violations.slice(n).includes('COOLDOWN'));

  n = before();
  a.send({ type: 'PLAYER_INPUT', seq: 1, ts: Date.now(), mx: 0, mz: 0, yaw: 0, px: a.pos.x, pz: a.pos.z });
  await a.idle(2);
  check('SEQ_REPLAY detected', a.violations.slice(n).includes('SEQ_REPLAY'));

  n = before();
  a.ws.send('{not json');
  a.send({ type: 'PLAYER_INPUT', seq: 'x' });
  a.send({ type: 'HACK_SERVER' });
  await a.idle(2);
  check('MALFORMED_PACKET detected', a.violations.slice(n).includes('MALFORMED_PACKET'));

  n = before();
  await sleep(2500); // refill token bucket
  for (let i = 0; i < 400; i++) a.send({ type: 'PING', id: i, ts: Date.now() });
  await a.idle(14); // report is aggregated over 300 ms
  check('RATE_LIMIT detected on 400-packet burst', a.violations.slice(n).includes('RATE_LIMIT'));

  await sleep(2500); // let the token bucket refill, otherwise the rate limiter eats the burst first
  n = before();
  for (let i = 0; i < 12; i++) a.move(0, 0); // inputs faster than the tick rate
  await a.idle(4);
  check('SPEEDHACK (input time-dilation) detected', a.violations.slice(n).includes('SPEEDHACK'));
  check(`server still connected (not kicked) state=${a.ws.readyState}`, a.ws.readyState === WebSocket.OPEN);

  // ── horde: READY from both → waves spawn, mobs walk to the core ──
  a.send({ type: 'READY', ready: true });
  b.send({ type: 'READY', ready: true });
  await Promise.all([a.idle(160), bobIdle]);
  check(`horde phase started (phase=${a.phase})`, a.phase === 'horde');
  check(`mobs spawned (max seen ${a.maxMobs})`, a.maxMobs > 0);
  const mobs = a.snap!.mobs;
  const avgD = mobs.reduce((s, m) => s + dist(0, 0, m.x, m.z), 0) / Math.max(1, mobs.length);
  check(`mobs approach the core (avg dist ${avgD.toFixed(1)} m < 46)`, mobs.length === 0 || avgD < 46);
  const kb = (a.bytes / 1024).toFixed(0);
  console.log(`  snapshots received by alice: ${a.snapshots}, ${kb} KiB total (after permessage-deflate: ws decompresses transparently)`);
  a.ws.close();
  b.ws.close();
  await sleep(200);
  process.exit();
}

void Mask;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
