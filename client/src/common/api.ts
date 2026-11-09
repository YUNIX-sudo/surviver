// Endpoint resolution shared by the site, the game and the admin panel.
// Web build: same origin. Electron (file://): production server, overridable via ?server= or localStorage.

const PROD = 'https://surviver.yunix.software';

function serverOrigin(): string {
  const q = new URLSearchParams(location.search).get('server');
  if (q) localStorage.setItem('surviver.server', q);
  const saved = localStorage.getItem('surviver.server');
  if (saved) return saved.replace(/\/$/, '');
  if (location.protocol === 'file:') return PROD;
  return location.origin;
}

export const ORIGIN = serverOrigin();
export const IS_DESKTOP = location.protocol === 'file:';
export const WS_URL = ORIGIN.replace(/^http/, 'ws') + '/ws';

export const auth = {
  get token() {
    return localStorage.getItem('surviver.token') ?? '';
  },
  set token(v: string) {
    if (v) localStorage.setItem('surviver.token', v);
    else localStorage.removeItem('surviver.token');
  },
  get username() {
    return localStorage.getItem('surviver.username') ?? '';
  },
  set username(v: string) {
    if (v) localStorage.setItem('surviver.username', v);
    else localStorage.removeItem('surviver.username');
  },
  get guestName() {
    return localStorage.getItem('surviver.guest') ?? '';
  },
  set guestName(v: string) {
    localStorage.setItem('surviver.guest', v);
  },
};

export async function api<T>(path: string, opts: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = opts.token ?? auth.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(ORIGIN + path, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const page = (name: 'index' | 'play' | 'admin') => (IS_DESKTOP ? `${name}.html` : name === 'index' ? '/' : `/${name}.html`);

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
