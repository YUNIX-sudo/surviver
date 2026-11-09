import '../common/style.css';
import './admin.css';
import { api, esc } from '../common/api';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const KEY = 'surviver.admin';
let token = sessionStorage.getItem(KEY) ?? '';
let timer = 0;

interface AdminState {
  server: { online: number; rooms: number; tickRate: number; uptimeSec: number; avgTickMs: number; loop: { ticks: number; avgTickMs: number; maxTickMs: number; avgIntervalMs: number }; net: { bytesIn: number; bytesOut: number; msgsIn: number; msgsOut: number; dropped: number; connections: number }; config: Record<string, unknown> };
  rooms: { id: string; players: number; maxPlayers: number; phase: string; wave: number; names: string[]; tick: number; lastTickMs: number; mobs: number; buildings: number; resources: number; resourceTotals: Record<string, number>; core: { hp: number; mhp: number }; endsAt: number | null; intermission: boolean }[];
  sessions: { clientId: number; name: string; account: string | null; remote: string; room: string | null; playerId: number | null; hp: number | null; inv: Record<string, number> | null; net: { bytesIn: number; bytesOut: number; msgsIn: number; msgsOut: number; dropped: number; rtt: number; connectedAt: number }; acScore: number; acTotal: number }[];
  violations: { at: number; clientId: number; name: string; remote: string; roomId: string | null; kind: string; message: string; severity: string; action: string; score: number }[];
  violationCounters: Record<string, number>;
  accounts: { username: string; banned: boolean; createdAt: number; lastSeen: number; stats: { games: number; wins: number; kills: number; bestWave: number } }[];
}

const kb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${(n / 1024).toFixed(1)} КБ`);
const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s} с` : s < 3600 ? `${Math.floor(s / 60)} мин` : `${Math.floor(s / 3600)} ч`;
};

async function post(path: string, body: unknown) {
  try {
    await api(path, { body, token });
    void refresh();
  } catch (e) {
    alert(e instanceof Error ? e.message : String(e));
  }
}
(window as unknown as Record<string, unknown>).adm = {
  kick: (id: number) => post('/api/admin/kick', { clientId: id }),
  room: (roomId: string, cmd: string) => post('/api/admin/room', { roomId, cmd }),
  ban: (username: string, banned: boolean) => post('/api/admin/ban', { username, banned }),
};

async function refresh() {
  let s: AdminState;
  try {
    s = await api<AdminState>('/api/admin/state', { token });
  } catch (e) {
    $('adm-status').textContent = `ошибка: ${e instanceof Error ? e.message : e}`;
    if (String(e).includes('admin token')) logout();
    return;
  }
  $('adm-status').textContent = `обновлено ${new Date().toLocaleTimeString()}`;
  const sv = s.server;
  const kpi = (v: string | number, l: string) => `<div class="kpi"><b>${v}</b><span>${l}</span></div>`;
  $('adm-server').innerHTML = [
    kpi(sv.online, 'подключений'),
    kpi(sv.rooms, 'комнат'),
    kpi(`${sv.tickRate} Гц`, 'тикрейт'),
    kpi(`${sv.loop.avgTickMs.toFixed(2)} мс`, 'ср. время тика'),
    kpi(`${sv.loop.avgIntervalMs.toFixed(1)} мс`, 'реальный интервал'),
    kpi(sv.loop.ticks, 'тиков всего'),
    kpi(kb(sv.net.bytesOut), '↑ отправлено'),
    kpi(kb(sv.net.bytesIn), '↓ получено'),
    kpi(sv.net.dropped, 'отброшено rate-limit'),
    kpi(`${Math.floor(sv.uptimeSec / 60)} мин`, 'аптайм'),
  ].join('');

  $('adm-rooms').innerHTML = s.rooms.length
    ? s.rooms
        .map((r) => {
          const id = esc(r.id);
          return `<div class="room-card"><h3><span>${id}</span><span class="tag ${r.phase}">${r.phase}${r.phase === 'horde' ? ` · волна ${r.wave}` : ''}</span></h3>
        <div class="kv"><span>Игроки</span><b>${r.players}/${r.maxPlayers}: ${r.names.map(esc).join(', ')}</b><span>Тик</span><b>${r.tick} (${r.lastTickMs} мс)</b>
        <span>Ядро</span><b>${r.core.hp}/${r.core.mhp}</b><span>Мобы</span><b>${r.mobs}</b><span>Постройки</span><b>${r.buildings}</b>
        <span>Ресурсы</span><b>${r.resources} узлов (🌲${r.resourceTotals.wood} 🪨${r.resourceTotals.stone} ⛓${r.resourceTotals.iron})</b>
        <span>Таймер</span><b>${r.endsAt ? Math.max(0, Math.round((r.endsAt - Date.now()) / 1000)) + ' с' : '—'}</b></div>
        <div class="row">
          <button class="btn small warn" onclick="adm.room('${id}','skip_phase')">⏭ Фаза</button>
          <button class="btn small" onclick="adm.room('${id}','spawn_wave')">Волна</button>
          <button class="btn small" onclick="adm.room('${id}','give_resources')">+Ресурсы</button>
          <button class="btn small" onclick="adm.room('${id}','heal_core')">Лечить ядро</button>
          <button class="btn small danger" onclick="adm.room('${id}','reset')">Сброс</button>
        </div></div>`;
        })
        .join('')
    : '<p class="muted">Нет активных комнат</p>';

  $('adm-sessions').innerHTML =
    '<tr><th>#</th><th>Имя</th><th>Аккаунт</th><th>IP</th><th>Комната</th><th>HP</th><th>Инвентарь</th><th>RTT</th><th>↓/↑</th><th>Сообщ.</th><th>Отброшено</th><th>AC score</th><th>Онлайн</th><th></th></tr>' +
    s.sessions
      .map(
        (x) => `<tr><td>${x.clientId}</td><td>${esc(x.name)}</td><td>${x.account ? esc(x.account) : '<span class="muted">гость</span>'}</td><td>${esc(x.remote)}</td>
      <td>${x.room ? esc(x.room) : '—'}</td><td>${x.hp ?? '—'}</td><td>${x.inv ? `${x.inv.wood}/${x.inv.stone}/${x.inv.iron}` : '—'}</td><td>${x.net.rtt} мс</td>
      <td>${kb(x.net.bytesIn)} / ${kb(x.net.bytesOut)}</td><td>${x.net.msgsIn}</td><td>${x.net.dropped}</td>
      <td class="${x.acScore > 200 ? 'sev-high' : x.acScore > 50 ? 'sev-medium' : ''}">${x.acScore} (${x.acTotal})</td><td>${ago(x.net.connectedAt)}</td>
      <td><button class="btn small danger" onclick="adm.kick(${x.clientId})">Kick</button></td></tr>`,
      )
      .join('');

  $('adm-counts').innerHTML = Object.entries(s.violationCounters)
    .map(([k, n]) => `<span>${k}: <b>${n}</b></span>`)
    .join('');
  $('adm-violations').innerHTML = s.violations.length
    ? s.violations
        .map(
          (v) => `<div class="violation"><span class="t">${new Date(v.at).toLocaleTimeString()}</span><span class="sev-${v.severity}">${v.kind}</span> → <b>${v.action}</b>
      · ${esc(v.name)} #${v.clientId} (${esc(v.remote)}) ${v.roomId ? '· ' + esc(v.roomId) : ''} · score ${v.score}<br>${esc(v.message)}</div>`,
        )
        .join('')
    : '<span class="muted">Нарушений нет</span>';

  $('adm-accounts').innerHTML =
    '<tr><th>Логин</th><th>Игр</th><th>Побед</th><th>Убийств</th><th>Был</th><th></th></tr>' +
    s.accounts
      .map(
        (a) => `<tr><td>${esc(a.username)}${a.banned ? ' <span class="sev-high">BAN</span>' : ''}</td><td>${a.stats.games}</td><td>${a.stats.wins}</td><td>${a.stats.kills}</td><td>${ago(a.lastSeen)}</td>
      <td><button class="btn small ${a.banned ? '' : 'danger'}" onclick="adm.ban('${esc(a.username)}', ${!a.banned})">${a.banned ? 'Разбан' : 'Бан'}</button></td></tr>`,
      )
      .join('');
}

function logout() {
  token = '';
  sessionStorage.removeItem(KEY);
  clearInterval(timer);
  $('adm-app').hidden = true;
  $('adm-login').hidden = false;
  $('adm-logout').hidden = true;
}

async function login(t: string) {
  try {
    await api('/api/admin/state', { token: t });
  } catch (e) {
    $('adm-err').textContent = e instanceof Error ? e.message : String(e);
    return;
  }
  token = t;
  sessionStorage.setItem(KEY, t);
  $('adm-login').hidden = true;
  $('adm-app').hidden = false;
  $('adm-logout').hidden = false;
  void refresh();
  timer = window.setInterval(refresh, 1000);
}

$('adm-form').onsubmit = (e) => {
  e.preventDefault();
  void login($<HTMLInputElement>('adm-token').value.trim());
};
$('adm-logout').onclick = logout;
$('adm-bc').onsubmit = (e) => {
  e.preventDefault();
  const i = $<HTMLInputElement>('adm-bc-text');
  if (i.value.trim()) void post('/api/admin/broadcast', { text: i.value.trim() });
  i.value = '';
};
if (token) void login(token);
