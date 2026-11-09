// "Сетевой монитор & Тест античита" — slide-out drawer for the lab demo.
// Shows live network stats, toggles prediction/reconciliation/interpolation, simulates lag/loss,
// fires cheat packets and lists the server's ANTICHEAT_VIOLATION responses.

import type { DebugCommand, ViolationMsg } from '@surviver/shared';
import { esc } from '../../common/api';
import type { Game, LogKind } from '../Game';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class NetPanel {
  private el = $('netpanel');
  private logEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private rttCanvas!: HTMLCanvasElement;
  private bwCanvas!: HTMLCanvasElement;
  private counts = new Map<string, number>();

  constructor(private readonly game: Game) {
    this.render();
    $('panel-btn').onclick = () => this.toggle();
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F2' || (e.code === 'Backquote' && !game.inputBlocked)) {
        this.toggle();
        e.preventDefault();
      }
    });
    game.onLog = (k, t) => this.log(k, esc(t));
    game.onViolation = (v) => this.onViolation(v);
    setInterval(() => this.update(), 250);
  }

  toggle() {
    this.el.classList.toggle('open');
  }

  private render() {
    const g = this.game;
    this.el.innerHTML = `
      <h2>📡 Сетевой монитор <button class="btn small" id="np-close">✕</button></h2>
      <div class="stat-grid" id="np-stats"></div>
      <canvas class="spark" id="np-rtt" width="400" height="50"></canvas>
      <canvas class="spark" id="np-bw" width="400" height="50"></canvas>

      <h3>Синхронизация</h3>
      <div class="toggles">
        <button class="btn small on" id="t-pred">Client-Side Prediction</button>
        <button class="btn small on" id="t-rec">Reconciliation</button>
        <button class="btn small on" id="t-int">Interpolation</button>
        <button class="btn small" id="t-ghost">Серверный «призрак»</button>
      </div>
      <div class="slider"><span>Задержка интерп.</span><input type="range" id="s-delay" min="0" max="300" step="10" value="100"><b id="v-delay">100 мс</b></div>

      <h3>Симуляция плохой сети</h3>
      <div class="slider"><span>Пинг (RTT)</span><input type="range" id="s-lat" min="0" max="600" step="10" value="0"><b id="v-lat">0 мс</b></div>
      <div class="slider"><span>Джиттер</span><input type="range" id="s-jit" min="0" max="150" step="5" value="0"><b id="v-jit">0 мс</b></div>
      <div class="slider"><span>Потеря снапшотов</span><input type="range" id="s-loss" min="0" max="60" step="5" value="0"><b id="v-loss">0%</b></div>

      <h3>🛡 Тест античита</h3>
      <div class="cheats">
        <button class="btn danger" data-c="teleport">Телепорт<small>+15 м → TELEPORT, rubberband</small></button>
        <button class="btn danger" data-c="speedhack">Speedhack ×5<small>|v|>1 → clamp</small></button>
        <button class="btn danger" data-c="timeDilation">Ускорение времени<small>60 инпутов/с</small></button>
        <button class="btn danger" data-c="buildNoResources">Стены без ресурсов<small>INSUFFICIENT_RESOURCES</small></button>
        <button class="btn danger" data-c="remoteBuild">Удалённая постройка<small>BUILD_OUT_OF_RANGE</small></button>
        <button class="btn danger" data-c="killAura">Kill Aura<small>атака далёких мобов</small></button>
        <button class="btn danger" data-c="farHarvest">Far Reach<small>добыча через карту</small></button>
        <button class="btn danger" data-c="rapidFire">Rapid Fire<small>10 ударов за кадр</small></button>
        <button class="btn danger" data-c="spam">Спам пакетами<small>500 фреймов → rate limit</small></button>
        <button class="btn danger" data-c="malformed">Битые пакеты<small>схема / JSON / 5 КБ</small></button>
        <button class="btn danger" data-c="replay">Replay-атака<small>старый seq</small></button>
      </div>

      <div id="np-debug" ${g.config?.debugAllowed === false ? 'hidden' : ''}>
        <h3>Debug-команды (ALLOW_DEBUG)</h3>
        <div class="toggles">
          <button class="btn small warn" data-d="skip_phase">⏭ Пропустить фазу</button>
          <button class="btn small warn" data-d="give_resources">+20 ресурсов</button>
          <button class="btn small warn" data-d="spawn_wave">Спавн волны</button>
          <button class="btn small warn" data-d="heal_core">Лечить ядро</button>
        </div>
      </div>

      <h3>Нарушения по типам</h3>
      <div class="stat-grid" id="np-counts"><span class="muted">пока нет</span></div>
      <h3>Журнал (ответы сервера)</h3>
      <div class="log" id="np-log"></div>`;

    this.logEl = $('np-log');
    this.statsEl = $('np-stats');
    this.rttCanvas = $<HTMLCanvasElement>('np-rtt');
    this.bwCanvas = $<HTMLCanvasElement>('np-bw');
    $('np-close').onclick = () => this.toggle();

    const tog = (id: string, get: () => boolean, set: (v: boolean) => void) => {
      const b = $(id);
      b.onclick = () => {
        set(!get());
        b.classList.toggle('on', get());
      };
    };
    tog('t-pred', () => g.predictionEnabled, (v) => (g.predictionEnabled = v));
    tog('t-rec', () => g.predictor.enabledReconcile, (v) => (g.predictor.enabledReconcile = v));
    tog('t-int', () => g.interp.enabled, (v) => (g.interp.enabled = v));
    tog('t-ghost', () => g.showServerGhost, (v) => (g.showServerGhost = v));

    const slider = (id: string, out: string, fmt: (v: number) => string, set: (v: number) => void) => {
      const s = $<HTMLInputElement>(id);
      s.oninput = () => {
        const v = Number(s.value);
        $(out).textContent = fmt(v);
        set(v);
      };
    };
    slider('s-delay', 'v-delay', (v) => `${v} мс`, (v) => (g.interp.delayMs = v));
    slider('s-lat', 'v-lat', (v) => `${v} мс`, (v) => (g.net.lag.latencyMs = v));
    slider('s-jit', 'v-jit', (v) => `${v} мс`, (v) => (g.net.lag.jitterMs = v));
    slider('s-loss', 'v-loss', (v) => `${v}%`, (v) => (g.net.lag.snapshotLoss = v / 100));

    this.el.querySelectorAll<HTMLButtonElement>('[data-c]').forEach((b) => {
      b.onclick = () => (g.cheat as unknown as Record<string, () => void>)[b.dataset.c!]!();
    });
    this.el.querySelectorAll<HTMLButtonElement>('[data-d]').forEach((b) => {
      b.onclick = () => g.cheat.debug(b.dataset.d as DebugCommand);
    });
    // buttons must not keep keyboard focus (Space would re-trigger them)
    this.el.addEventListener('mouseup', () => (document.activeElement as HTMLElement | null)?.blur());
  }

  log(kind: LogKind, html: string) {
    const d = document.createElement('div');
    d.className = kind;
    d.innerHTML = `<span class="t">${new Date().toLocaleTimeString()}</span>${html}`;
    this.logEl.prepend(d);
    while (this.logEl.children.length > 150) this.logEl.lastChild?.remove();
  }

  private onViolation(v: ViolationMsg) {
    this.counts.set(v.kind, (this.counts.get(v.kind) ?? 0) + 1);
    this.log('violation', `<b>ANTICHEAT_VIOLATION</b> <span class="sev-${v.severity}">${v.kind}</span> → <b>${v.action}</b> (score ${v.score})<br>${esc(v.message)}`);
    $('np-counts').innerHTML = [...this.counts].map(([k, n]) => `<div><span>${k}</span><b>${n}</b></div>`).join('');
  }

  private update() {
    if (!this.el.classList.contains('open')) return;
    const g = this.game;
    const s = g.net.stats;
    const rows: [string, string][] = [
      ['RTT', `${s.rtt} мс`],
      ['RTT ср. / джиттер', `${Math.round(s.rttAvg)} / ${Math.round(s.jitter)} мс`],
      ['Снапшоты', `${s.snapRate}/с (тик ${g.config?.tickRate ?? 20} Гц)`],
      ['Тик сервера', String(g.lastSnap?.tick ?? 0)],
      ['↓ входящий', `${(s.inRate / 1024).toFixed(1)} КБ/с`],
      ['↑ исходящий', `${(s.outRate / 1024).toFixed(2)} КБ/с`],
      ['Сообщений ↓/↑', `${s.msgsIn} / ${s.msgsOut}`],
      ['Пропущено тиков', String(s.missedTicks)],
      ['Отброшено (сим.)', String(s.droppedSnapshots)],
      ['Неподтв. инпутов', String(g.predictor.pending.length)],
      ['Реконсиляций', String(g.predictor.reconciliations)],
      ['Посл. коррекция', `${g.predictor.lastCorrection.toFixed(3)} м`],
      ['Буфер интерп.', `${g.interp.bufferSize} кадров`],
      ['Смещение часов', `${Math.round(g.net.clockOffset)} мс`],
      ['FPS рендера', String(g.fps)],
      ['Сущностей', `${g.players.size} игр. / ${g.mobs.size} мобов`],
    ];
    this.statsEl.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
    this.spark(this.rttCanvas, s.rttHistory, '#38bdf8', 'RTT, мс');
    this.spark(this.bwCanvas, s.bwHistory, '#f59e0b', '↓ КБ/с');
  }

  private spark(c: HTMLCanvasElement, data: number[], color: string, label: string) {
    const ctx = c.getContext('2d')!;
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    const max = Math.max(10, ...data) * 1.15;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / 59) * W;
      const y = H - (v / max) * H;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = '#8ea0bb';
    ctx.font = '11px ui-monospace, monospace';
    const last = data[data.length - 1] ?? 0;
    ctx.fillText(`${label}: ${last.toFixed(1)}  max ${Math.max(0, ...data).toFixed(1)}`, 6, 13);
  }
}
