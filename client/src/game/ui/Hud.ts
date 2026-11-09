// DOM HUD over the canvas: phase timer, bars, inventory, hotbar, chat, minimap, toasts.

import { BUILDING_DEFS, BuildingKind, MAP_HALF, ResourceKind, type GameOverMsg, type ViolationMsg } from '@surviver/shared';
import { esc } from '../../common/api';
import type { Game } from '../Game';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const RES_RU: Record<string, string> = { wood: 'дерево', stone: 'камень', iron: 'железо' };

export class Hud {
  private ready = false;
  private hintTimer = 0;
  private miniCtx: CanvasRenderingContext2D;
  private lastMini = 0;
  private slots: HTMLDivElement[] = [];

  constructor(private readonly game: Game) {
    this.miniCtx = $<HTMLCanvasElement>('minimap').getContext('2d')!;
    const hotbar = $('hotbar');
    for (const k of [BuildingKind.Wall, BuildingKind.Spikes, BuildingKind.Turret]) {
      const def = BUILDING_DEFS[k];
      const el = document.createElement('div');
      el.className = 'slot';
      const cost = Object.entries(def.cost)
        .map(([r, n]) => `${n} ${RES_RU[r]}`)
        .join(', ');
      el.innerHTML = `<span class="k">${k + 1}</span><div class="n">${def.title}</div><div class="c">${cost}</div>`;
      el.onclick = () => game.toggleBuild(k);
      hotbar.appendChild(el);
      this.slots.push(el);
    }
    $('ready-btn').onclick = () => this.toggleReady();
    window.addEventListener('keydown', (e) => {
      if (game.inputBlocked) return;
      if (e.code === 'KeyR') this.toggleReady();
    });

    // chat
    const input = $<HTMLInputElement>('chat-input');
    input.addEventListener('focus', () => (game.inputBlocked = true));
    input.addEventListener('blur', () => (game.inputBlocked = false));
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        const t = input.value.trim();
        if (t) game.net.send({ type: 'CHAT', text: t });
        input.value = '';
        input.blur();
      } else if (e.key === 'Escape') input.blur();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && document.activeElement !== input) {
        input.focus();
        e.preventDefault();
      }
    });

    game.onChat = (from, text, system) => this.chat(from, text, system);
    game.onHint = (t) => this.hint(t);
    game.onDamaged = () => {
      const v = $('vignette');
      v.classList.add('hurt');
      setTimeout(() => v.classList.remove('hurt'), 120);
    };
    const prevViolation = game.onViolation;
    game.onViolation = (v) => {
      prevViolation(v);
      this.violationToast(v);
    };
    game.onGameOver = (m) => this.showGameOver(m);
    game.onJoined = () => {
      $('gameover').hidden = true;
      this.ready = false;
    };
    setInterval(() => this.update(), 100);
  }

  private toggleReady() {
    if (this.game.phase?.phase !== 'prep') return;
    this.ready = !this.ready;
    this.game.sendReady(this.ready);
  }

  chat(from: string, text: string, system: boolean) {
    const log = $('chat-log');
    const d = document.createElement('div');
    d.innerHTML = system ? `<span class="sys">• ${esc(text)}</span>` : `<span class="who">${esc(from)}:</span> ${esc(text)}`;
    log.appendChild(d);
    while (log.children.length > 80) log.firstChild?.remove();
    log.scrollTop = log.scrollHeight;
  }

  hint(text: string) {
    const h = $('hint');
    h.textContent = text;
    h.classList.add('show');
    clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => h.classList.remove('show'), 1600);
  }

  toast(html: string, cls = '') {
    const t = document.createElement('div');
    t.className = `toast ${cls}`;
    t.innerHTML = html;
    const box = $('toasts');
    box.appendChild(t);
    while (box.children.length > 4) box.firstChild?.remove();
    setTimeout(() => t.remove(), 3600);
  }

  private violationToast(v: ViolationMsg) {
    this.toast(`🛡 Античит: <b>${v.kind}</b> → ${v.action} <span class="muted">(score ${v.score})</span>`);
  }

  private showGameOver(m: GameOverMsg) {
    const rows = m.stats
      .map((s) => `<tr><td>${esc(s.name)}</td><td>${s.kills}</td><td>${Math.round(s.damage)}</td><td>${s.harvested}</td><td>${s.built}</td><td>${s.deaths}</td></tr>`)
      .join('');
    $('gameover-card').innerHTML = `
      <p class="result ${m.result}">${m.result === 'victory' ? 'ПОБЕДА!' : 'ЯДРО РАЗРУШЕНО'}</p>
      <p class="muted" style="text-align:center">${m.result === 'victory' ? 'Все волны отбиты' : `Орда прорвалась на волне ${m.wave}`}</p>
      <table class="stats"><tr><th>Игрок</th><th>Убийства</th><th>Урон</th><th>Добыто</th><th>Построено</th><th>Смерти</th></tr>${rows}</table>
      <p class="muted small" style="text-align:center">Новый матч начнётся автоматически через несколько секунд.</p>
      <div class="row" style="justify-content:center"><button class="btn" id="go-close">Смотреть</button></div>`;
    $('gameover').hidden = false;
    $('go-close').onclick = () => ($('gameover').hidden = true);
  }

  private fmt(ms: number) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  update() {
    const g = this.game;
    const ph = g.phase;
    const box = $('phase-box');
    if (ph) {
      box.className = `hud-tc panel ${ph.phase}`;
      const left = ph.endsAt !== null ? ph.endsAt - g.net.serverNow() : 0;
      if (ph.phase === 'prep') {
        $('phase-title').textContent = 'ПОДГОТОВКА';
        $('phase-timer').textContent = this.fmt(left);
        $('phase-sub').textContent = `Готовы ${ph.ready}/${ph.players} · стройте оборону!`;
      } else if (ph.phase === 'horde') {
        $('phase-title').textContent = ph.intermission ? 'ПЕРЕДЫШКА' : `ВОЛНА ${ph.wave}/${ph.totalWaves}`;
        $('phase-timer').textContent = ph.intermission ? this.fmt(left) : `👾 ${ph.mobsAlive}`;
        $('phase-sub').textContent = ph.intermission ? `Следующая волна ${ph.wave + 1}/${ph.totalWaves}` : 'Защищайте Ядро!';
      } else {
        $('phase-title').textContent = 'МАТЧ ОКОНЧЕН';
        $('phase-timer').textContent = this.fmt(left);
        $('phase-sub').textContent = 'новый матч через';
      }
      const rb = $('ready-btn');
      rb.hidden = ph.phase !== 'prep';
      rb.classList.toggle('on', this.ready);
      rb.innerHTML = `${this.ready ? '✔ Готов' : 'Готов'} (${ph.ready}/${ph.players}) <kbd>R</kbd>`;
      if (ph.phase !== 'prep') this.ready = false;
      $('player-count').textContent = `игроков: ${ph.players}`;
    }
    $('room-name').textContent = g.roomId;

    const core = g.coreHp;
    $('core-fill').style.width = `${(core.hp / core.mhp) * 100}%`;
    $('core-text').textContent = `${core.hp} / ${core.mhp}`;
    const hp = g.me?.hp ?? 0;
    $('hp-fill').style.width = `${hp}%`;
    $('hp-fill').style.background = hp > 50 ? 'var(--good)' : hp > 25 ? 'var(--warn)' : 'var(--bad)';
    $('hp-text').textContent = `${hp} / 100`;
    $('dead-msg').hidden = !g.me?.dead;

    const tot = g.mapTotals();
    for (const r of ['wood', 'stone', 'iron'] as const) {
      $(`inv-${r}`).textContent = String(g.inv[r]);
      $(`map-${r}`).textContent = `/ ${tot[r]} на карте`;
    }
    [BuildingKind.Wall, BuildingKind.Spikes, BuildingKind.Turret].forEach((k, i) => {
      const el = this.slots[i]!;
      el.classList.toggle('active', g.buildMode === k);
      const def = BUILDING_DEFS[k];
      const can = Object.entries(def.cost).every(([r, n]) => g.inv[r as 'wood'] >= (n ?? 0));
      el.classList.toggle('cant', !can);
    });

    const st = g.net.stats;
    $('mini-ping').textContent = `${Math.round(st.rttAvg)} мс`;
    $('mini-fps').textContent = String(g.fps);
    $('mini-loss').textContent = String(st.missedTicks + st.droppedSnapshots);

    if (performance.now() - this.lastMini > 150) {
      this.lastMini = performance.now();
      this.drawMinimap();
    }
  }

  private drawMinimap() {
    const ctx = this.miniCtx;
    const W = 180;
    const k = W / (MAP_HALF * 2);
    const tx = (v: number) => (v + MAP_HALF) * k;
    ctx.clearRect(0, 0, W, W);
    const d = this.game.minimapData();
    const colors = { [ResourceKind.Tree]: '#2f7d32', [ResourceKind.Rock]: '#9ca3af', [ResourceKind.Iron]: '#f59e0b' } as Record<number, string>;
    for (const r of d.resources.values()) {
      ctx.fillStyle = colors[r.s.k] ?? '#fff';
      ctx.fillRect(tx(r.s.x) - 1.5, tx(r.s.z) - 1.5, 3, 3);
    }
    for (const b of d.buildings.values()) {
      ctx.fillStyle = b.s.k === BuildingKind.Wall ? '#a0673a' : b.s.k === BuildingKind.Spikes ? '#cbd5e1' : '#64748b';
      ctx.fillRect(tx(b.s.gx * 2), tx(b.s.gz * 2), 2 * k + 0.5, 2 * k + 0.5);
    }
    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(tx(-2), tx(-2), 4 * k, 4 * k);
    ctx.fillStyle = '#ef4444';
    for (const m of d.mobs.values()) {
      ctx.beginPath();
      ctx.arc(tx(m.x), tx(m.z), 2, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const [id, p] of d.players) {
      ctx.fillStyle = id === d.me ? '#fde047' : '#ffffff';
      ctx.beginPath();
      ctx.arc(tx(p.x), tx(p.z), id === d.me ? 3.5 : 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
