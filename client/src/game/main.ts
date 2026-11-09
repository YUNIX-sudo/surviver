// Game page entry: lobby (name / account / room) → connect → Game.

import '../common/style.css';
import type { RoomInfo, ServerMessage } from '@surviver/shared';
import { api, auth, esc, IS_DESKTOP, ORIGIN, page, WS_URL } from '../common/api';
import { Game } from './Game';
import { NetClient } from './net/NetClient';
import { Hud } from './ui/Hud';
import { NetPanel } from './ui/NetPanel';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

async function loadLobby() {
  $<HTMLAnchorElement>('site-link').href = page('index');
  $('server-line').textContent = `сервер: ${ORIGIN.replace(/^https?:\/\//, '')}${IS_DESKTOP ? ' (desktop)' : ''}`;
  const guest = $<HTMLInputElement>('guest-name');
  guest.value = auth.guestName || `Игрок${Math.floor(Math.random() * 900 + 100)}`;
  if (auth.token) {
    try {
      const me = await api<{ account: { username: string } }>('/api/me');
      auth.username = me.account.username;
      $('lobby-account').innerHTML = `<p>Вы вошли как <b>${esc(me.account.username)}</b> — статистика матчей сохраняется.</p>`;
      $('guest-field').hidden = true;
    } catch {
      auth.token = '';
    }
  }
  if (!auth.token) $('lobby-account').innerHTML = `<p class="muted small">Играете как гость. <a href="${page('index')}#account">Войти / зарегистрироваться</a> для сохранения статистики.</p>`;

  const refresh = async () => {
    try {
      const { rooms } = await api<{ rooms: RoomInfo[] }>('/api/rooms');
      $('room-list').innerHTML = rooms.length
        ? rooms
            .map(
              (r) => `<div class="room-item"><div><b>${esc(r.id)}</b> <span class="tag ${r.phase}">${r.phase === 'prep' ? 'подготовка' : r.phase === 'horde' ? `волна ${r.wave}` : 'конец'}</span>
              <div class="names">${r.names.map(esc).join(', ')}</div></div>
              <button class="btn small" data-room="${esc(r.id)}" ${r.players >= r.maxPlayers ? 'disabled' : ''}>${r.players}/${r.maxPlayers} Войти</button></div>`,
            )
            .join('')
        : '<span class="muted">Нет активных комнат — создайте свою!</span>';
      $('room-list')
        .querySelectorAll<HTMLButtonElement>('[data-room]')
        .forEach((b) => (b.onclick = () => start(b.dataset.room)));
    } catch {
      $('room-list').innerHTML = '<span class="error">Сервер недоступен</span>';
    }
  };
  void refresh();
  const timer = setInterval(refresh, 3000);

  const start = async (roomId?: string) => {
    clearInterval(timer);
    const name = (guest.value.trim() || 'Игрок').slice(0, 16);
    auth.guestName = name;
    $('lobby-error').textContent = '';
    try {
      await connect(name, roomId);
      $('lobby').hidden = true;
    } catch (e) {
      $('lobby-error').textContent = e instanceof Error ? e.message : String(e);
    }
  };
  $('quick-join').onclick = () => start();
  $('join-room').onclick = () => {
    const v = $<HTMLInputElement>('room-input').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 24);
    void start(v || undefined);
  };
  const qRoom = new URLSearchParams(location.search).get('room');
  if (qRoom) void start(qRoom);
}

async function connect(name: string, roomId?: string) {
  const net = new NetClient(WS_URL);
  const game = new Game($('canvas-wrap'), $('overlay'), net);
  new NetPanel(game);
  const hud = new Hud(game);
  await new Promise<void>((resolve, reject) => {
    const off = net.on((m: ServerMessage) => {
      if (m.type === 'WELCOME') {
        net.send({ type: 'JOIN_ROOM', ...(roomId ? { roomId } : {}) });
      } else if (m.type === 'ROOM_JOINED') {
        off();
        resolve();
      } else if (m.type === 'ERROR') {
        off();
        reject(new Error(m.message));
      }
    });
    net.connect(name, auth.token).catch(reject);
  });
  $('hud').hidden = false;
  hud.toast(`Добро пожаловать в <b>${esc(game.roomId)}</b>! Добывайте ресурсы и стройте оборону вокруг Ядра.`, 'info');
  history.replaceState(null, '', `?room=${encodeURIComponent(game.roomId)}`);
  net.onClose = (code, reason) => {
    $('disconnected').hidden = false;
    $('disc-reason').textContent = `Код ${code}${reason ? `: ${reason}` : ''}${code === 4003 ? ' — отключено античитом' : ''}`;
  };
  (window as unknown as { game: Game }).game = game; // handy for the lab demo in devtools
}

void loadLobby();
