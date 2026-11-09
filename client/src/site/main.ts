import '../common/style.css';
import './site.css';
import { api, auth, esc, page } from '../common/api';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Stats { games: number; wins: number; kills: number; bestWave: number; harvested: number; built: number; deaths: number }

for (const id of ['play-top', 'play-hero']) $<HTMLAnchorElement>(id).href = page('play');

async function live() {
  try {
    const s = await api<{ online: number; rooms: number; tickRate: number }>('/api/stats');
    $('live-text').textContent = `сервер онлайн · игроков: ${s.online} · комнат: ${s.rooms} · ${s.tickRate} тиков/с`;
    document.querySelector('.dot')?.classList.add('on');
  } catch {
    $('live-text').textContent = 'сервер недоступен';
    document.querySelector('.dot')?.classList.remove('on');
  }
}

async function leaderboard() {
  try {
    const { players } = await api<{ players: (Stats & { username: string })[] }>('/api/leaderboard');
    $('leaderboard').innerHTML =
      '<tr><th>#</th><th>Игрок</th><th>Победы</th><th>Лучш. волна</th><th>Убийства</th><th>Игр</th></tr>' +
      (players.length
        ? players.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.username)}</td><td>${p.wins}</td><td>${p.bestWave}</td><td>${p.kills}</td><td>${p.games}</td></tr>`).join('')
        : '<tr><td colspan="6" class="muted">Пока пусто — сыграйте первым!</td></tr>');
  } catch {
    $('leaderboard').innerHTML = '<tr><td class="error">не удалось загрузить</td></tr>';
  }
}

function renderLoggedIn(username: string, s: Stats) {
  $('acc-box').innerHTML = `
    <p>Вы вошли как <b>${esc(username)}</b></p>
    <div class="acc-stats">
      <div><b>${s.games}</b><span>игр</span></div><div><b>${s.wins}</b><span>побед</span></div><div><b>${s.bestWave}</b><span>лучшая волна</span></div>
      <div><b>${s.kills}</b><span>убийств</span></div><div><b>${s.harvested}</b><span>добыто</span></div><div><b>${s.built}</b><span>построено</span></div>
    </div>
    <div class="row"><a class="btn primary" href="${page('play')}">Играть</a><button class="btn" id="logout">Выйти</button></div>`;
  $('nav-account').textContent = username;
  $('logout').onclick = async () => {
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    auth.token = '';
    auth.username = '';
    renderForm();
  };
}

function renderForm() {
  $('nav-account').textContent = 'Аккаунт';
  $('acc-box').innerHTML = `
    <form class="acc-form" id="acc-form">
      <p class="muted">Аккаунт сохраняет статистику матчей и место в рейтинге. Играть можно и гостем.</p>
      <input id="acc-user" placeholder="Логин (3–16 символов)" autocomplete="username" required />
      <input id="acc-pass" type="password" placeholder="Пароль" autocomplete="current-password" required />
      <div class="row"><button class="btn primary" data-mode="login">Войти</button><button class="btn" data-mode="register">Регистрация</button></div>
      <div class="error" id="acc-err"></div>
    </form>`;
  let mode = 'login';
  $('acc-form').querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.onclick = () => (mode = b.dataset.mode!)));
  $('acc-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await api<{ token: string; account: { username: string; stats: Stats } }>(`/api/${mode}`, {
        body: { username: $<HTMLInputElement>('acc-user').value, password: $<HTMLInputElement>('acc-pass').value },
        token: '',
      });
      auth.token = res.token;
      auth.username = res.account.username;
      renderLoggedIn(res.account.username, res.account.stats);
    } catch (err) {
      $('acc-err').textContent = err instanceof Error ? err.message : String(err);
    }
  };
}

async function account() {
  if (!auth.token) return renderForm();
  try {
    const { account } = await api<{ account: { username: string; stats: Stats } }>('/api/me');
    renderLoggedIn(account.username, account.stats);
  } catch {
    auth.token = '';
    renderForm();
  }
}

void live();
void leaderboard();
void account();
setInterval(live, 5000);
