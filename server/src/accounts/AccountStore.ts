// Tiny persistent account store: JSON file + scrypt password hashes + random session tokens.
// Good enough for a lab project (single process); writes are debounced and atomic (tmp + rename).

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface AccountStats {
  games: number;
  wins: number;
  kills: number;
  bestWave: number;
  harvested: number;
  built: number;
  deaths: number;
}

export interface Account {
  username: string;
  salt: string;
  hash: string;
  createdAt: number;
  lastSeen: number;
  banned: boolean;
  stats: AccountStats;
}

interface Db {
  users: Record<string, Account>;
  sessions: Record<string, { username: string; createdAt: number }>;
}

const USERNAME_RE = /^[\p{L}\p{N}_-]{3,16}$/u;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export class AccountStore {
  private db: Db = { users: {}, sessions: {} };
  private file: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'accounts.json');
    if (existsSync(this.file)) {
      try {
        this.db = JSON.parse(readFileSync(this.file, 'utf8')) as Db;
      } catch (e) {
        console.error('[accounts] failed to read db, starting empty', e);
      }
    }
  }

  private hash(password: string, salt: string) {
    return scryptSync(password, salt, 32).toString('hex');
  }

  register(username: string, password: string): { ok: true; token: string; account: Account } | { ok: false; error: string } {
    if (!USERNAME_RE.test(username)) return { ok: false, error: 'Логин: 3–16 символов (буквы, цифры, _ -)' };
    if (password.length < 4 || password.length > 64) return { ok: false, error: 'Пароль: 4–64 символа' };
    const key = username.toLowerCase();
    if (this.db.users[key]) return { ok: false, error: 'Такой логин уже занят' };
    const salt = randomBytes(16).toString('hex');
    const account: Account = {
      username,
      salt,
      hash: this.hash(password, salt),
      createdAt: Date.now(),
      lastSeen: Date.now(),
      banned: false,
      stats: { games: 0, wins: 0, kills: 0, bestWave: 0, harvested: 0, built: 0, deaths: 0 },
    };
    this.db.users[key] = account;
    const token = this.newSession(username);
    this.save();
    return { ok: true, token, account };
  }

  login(username: string, password: string): { ok: true; token: string; account: Account } | { ok: false; error: string } {
    const acc = this.db.users[username.toLowerCase()];
    if (!acc) return { ok: false, error: 'Неверный логин или пароль' };
    const a = Buffer.from(acc.hash, 'hex');
    const b = Buffer.from(this.hash(password, acc.salt), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, error: 'Неверный логин или пароль' };
    if (acc.banned) return { ok: false, error: 'Аккаунт заблокирован администратором' };
    const token = this.newSession(acc.username);
    return { ok: true, token, account: acc };
  }

  private newSession(username: string) {
    const token = randomBytes(24).toString('hex');
    this.db.sessions[token] = { username, createdAt: Date.now() };
    this.save();
    return token;
  }

  logout(token: string) {
    delete this.db.sessions[token];
    this.save();
  }

  byToken(token: string | undefined): Account | null {
    if (!token) return null;
    const s = this.db.sessions[token];
    if (!s) return null;
    if (Date.now() - s.createdAt > SESSION_TTL_MS) {
      delete this.db.sessions[token];
      return null;
    }
    return this.db.users[s.username.toLowerCase()] ?? null;
  }

  get(username: string) {
    return this.db.users[username.toLowerCase()] ?? null;
  }

  setBanned(username: string, banned: boolean) {
    const a = this.get(username);
    if (!a) return false;
    a.banned = banned;
    if (banned) for (const [t, s] of Object.entries(this.db.sessions)) if (s.username.toLowerCase() === username.toLowerCase()) delete this.db.sessions[t];
    this.save();
    return true;
  }

  recordMatch(username: string, win: boolean, wave: number, st: { kills: number; harvested: number; built: number; deaths: number }) {
    const a = this.get(username);
    if (!a) return;
    a.stats.games++;
    if (win) a.stats.wins++;
    a.stats.kills += st.kills;
    a.stats.harvested += st.harvested;
    a.stats.built += st.built;
    a.stats.deaths += st.deaths;
    a.stats.bestWave = Math.max(a.stats.bestWave, wave);
    a.lastSeen = Date.now();
    this.save();
  }

  touch(username: string) {
    const a = this.get(username);
    if (a) {
      a.lastSeen = Date.now();
      this.save();
    }
  }

  list(): Account[] {
    return Object.values(this.db.users);
  }

  leaderboard(limit = 20) {
    return this.list()
      .filter((a) => !a.banned)
      .sort((a, b) => b.stats.wins - a.stats.wins || b.stats.bestWave - a.stats.bestWave || b.stats.kills - a.stats.kills)
      .slice(0, limit)
      .map((a) => ({ username: a.username, ...a.stats }));
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 500);
  }

  flush() {
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, JSON.stringify(this.db));
    renameSync(tmp, this.file);
  }
}

export function publicAccount(a: Account) {
  return { username: a.username, createdAt: a.createdAt, stats: a.stats };
}
