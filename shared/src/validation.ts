// Hand-written schema validation for every Client -> Server frame.
// Nothing coming from the network is trusted: types, ranges, integer-ness, finiteness and string lengths are checked.

import { BUILDING_KINDS, GRID_MAX, GRID_MIN, MAP_HALF } from './constants';
import { C2S, DEBUG_COMMANDS, type ClientMessage } from './protocol';

export type ValidationResult = { ok: true; msg: ClientMessage } | { ok: false; error: string };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v);
const inRange = (v: number, lo: number, hi: number) => v >= lo && v <= hi;
const MAX_SEQ = 2 ** 31;
const NAME_RE = /^[\p{L}\p{N}_\- ]{1,16}$/u;

class SchemaError extends Error {}
function req(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new SchemaError(msg);
}
function onlyKeys(o: Obj, allowed: readonly string[]) {
  for (const k of Object.keys(o)) req(allowed.includes(k), `unexpected field "${k}"`);
}
function seqTs(o: Obj) {
  req(isInt(o.seq) && inRange(o.seq, 0, MAX_SEQ), 'seq must be uint32');
  req(isNum(o.ts) && o.ts >= 0, 'ts must be a non-negative number');
}

/** Validate a parsed JSON value. Returns a typed message or a human-readable error. */
export function validateClientMessage(raw: unknown): ValidationResult {
  try {
    req(isObj(raw), 'frame must be a JSON object');
    const o = raw;
    req(typeof o.type === 'string', 'missing "type"');
    switch (o.type) {
      case C2S.HELLO:
        onlyKeys(o, ['type', 'v', 'name', 'token']);
        req(isInt(o.v), 'v must be integer');
        req(typeof o.name === 'string' && NAME_RE.test(o.name.trim()), 'name: 1..16 letters/digits/_-');
        req(o.token === undefined || (typeof o.token === 'string' && o.token.length <= 128), 'token too long');
        break;
      case C2S.JOIN_ROOM:
        onlyKeys(o, ['type', 'roomId']);
        req(o.roomId === undefined || (typeof o.roomId === 'string' && /^[a-z0-9-]{1,24}$/.test(o.roomId)), 'bad roomId');
        break;
      case C2S.LEAVE_ROOM:
        onlyKeys(o, ['type']);
        break;
      case C2S.PLAYER_INPUT:
        onlyKeys(o, ['type', 'seq', 'ts', 'mx', 'mz', 'yaw', 'px', 'pz']);
        seqTs(o);
        // Magnitude > 1 is NOT a schema error: it is a speedhack and is handled by the AntiCheatEngine.
        req(isNum(o.mx) && inRange(o.mx, -100, 100), 'mx out of range');
        req(isNum(o.mz) && inRange(o.mz, -100, 100), 'mz out of range');
        req(isNum(o.yaw) && inRange(o.yaw, -100, 100), 'yaw out of range');
        req(isNum(o.px) && inRange(o.px, -MAP_HALF * 10, MAP_HALF * 10), 'px out of range');
        req(isNum(o.pz) && inRange(o.pz, -MAP_HALF * 10, MAP_HALF * 10), 'pz out of range');
        break;
      case C2S.INPUT_HARVEST:
      case C2S.INPUT_ATTACK:
        onlyKeys(o, ['type', 'seq', 'ts', 'targetId']);
        seqTs(o);
        req(isInt(o.targetId) && o.targetId > 0, 'targetId must be positive int');
        break;
      case C2S.INPUT_BUILD:
        onlyKeys(o, ['type', 'seq', 'ts', 'kind', 'gx', 'gz']);
        seqTs(o);
        req(typeof o.kind === 'string' && (BUILDING_KINDS as readonly string[]).includes(o.kind), 'unknown building kind');
        req(isInt(o.gx) && inRange(o.gx, GRID_MIN * 4, GRID_MAX * 4), 'gx must be int');
        req(isInt(o.gz) && inRange(o.gz, GRID_MIN * 4, GRID_MAX * 4), 'gz must be int');
        break;
      case C2S.READY:
        onlyKeys(o, ['type', 'ready']);
        req(typeof o.ready === 'boolean', 'ready must be boolean');
        break;
      case C2S.DEBUG_COMMAND:
        onlyKeys(o, ['type', 'cmd']);
        req(typeof o.cmd === 'string' && (DEBUG_COMMANDS as readonly string[]).includes(o.cmd), 'unknown debug cmd');
        break;
      case C2S.CHAT:
        onlyKeys(o, ['type', 'text']);
        req(typeof o.text === 'string' && o.text.trim().length >= 1 && o.text.length <= 120, 'text: 1..120 chars');
        break;
      case C2S.PING:
        onlyKeys(o, ['type', 'id', 'ts']);
        req(isInt(o.id) && o.id >= 0, 'id must be uint');
        req(isNum(o.ts), 'ts must be number');
        break;
      default:
        throw new SchemaError(`unknown type "${String(o.type).slice(0, 32)}"`);
    }
    return { ok: true, msg: o as unknown as ClientMessage };
  } catch (e) {
    if (e instanceof SchemaError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Parse + validate a raw text frame. */
export function parseClientFrame(text: string): ValidationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  return validateClientMessage(raw);
}
