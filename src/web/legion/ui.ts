// 軍團戰觀戰畫面：電競轉播風的計分條、雙方兵力名冊、解說字幕、開戰前陣容、結算、自動導播與操作。
import type { RegimentStatus } from '../../legion/api.ts';
import { FORMATION_NAMES, MODE_NAMES, RULES, TERRAIN_NAMES, TILE, TPS, UNITS, VERSUS, dashDefOf, type UnitKind } from '../../legion/config.ts';
import { unitSvg } from './icons.ts';
import type { Caption, FromLegionWorker, LegionFrame, LegionMeta, ToLegionWorker } from './protocol.ts';
import { LegionRenderer } from './render.ts';

const STATUS_NAME: Record<RegimentStatus, string> = {
  idle: '待命',
  moving: '行軍',
  attacking: '進攻',
  engaged: '交戰中',
  charging: '衝鋒',
  assaulting: '突擊',
  infiltrating: '切入',
  bracing: '架槍林中',
  braced: '槍林',
  unbracing: '收陣中',
  walling: '盾牆架設中',
  walled: '盾牆',
  reforming: '換陣形',
  volleying: '齊射',
  routed: '潰散',
};
const ORDER_NAME: Record<string, string> = { idle: '待命', move: '移動', attackMove: '邊走邊打', attack: '攻擊', hold: '堅守', charge: '衝鋒' };
const TERRAIN_TIP = ['', '移動 ×1.25', '移動 ×0.6（輕步兵不減速）・隱蔽：敵人要很近才看得到・騎兵不能衝鋒', '視野 +4 格・射程 +2 格、遠程傷害 ×1.2・由下往上的近戰 ×0.85', '移動 ×0.5・在這裡受到的近戰傷害 ×1.2・不能衝鋒', '不可通行', '移動 ×1.25・只有 3 格寬', '不可通行', '不可通行'];
const SPEEDS = [1, 2, 4, 8];

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function clock(tick: number): string {
  const s = Math.floor(tick / TPS);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class LegionScreen {
  private readonly root: HTMLElement;
  private readonly worker: Worker;
  private readonly meta: LegionMeta;
  private readonly onExit: () => void;
  private readonly r: LegionRenderer;
  private readonly el: Record<string, HTMLElement> = {};
  private raf = 0;
  private frameAt = 0;
  private frameGap = 100;
  private speed = 1;
  private paused = true;
  private started = false;
  private director = true;
  private viewer = -1;
  private selected = -1;
  private hovered = -1;
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private mouse: { x: number; y: number } | null = null;
  private captions: Caption[] = [];
  private bigUntil = 0;
  private lineupTimer = 0;
  private rosterSig = '';
  private ended = false;
  private readonly disposers: (() => void)[] = [];

  constructor(root: HTMLElement, worker: Worker, meta: LegionMeta, onExit: () => void) {
    this.root = root;
    this.worker = worker;
    this.meta = meta;
    this.onExit = onExit;
    root.innerHTML = this.layout();
    for (const n of root.querySelectorAll<HTMLElement>('[data-el]')) this.el[n.dataset.el!] = n;
    this.r = new LegionRenderer(this.el.canvas as HTMLCanvasElement, meta);
    root.classList.remove('hidden');
    requestAnimationFrame(() => {
      this.r.fit();
      if (!this.started) this.showLineup();
    });
    this.bind();
    this.raf = requestAnimationFrame(this.tick);
  }

  private send(msg: ToLegionWorker): void {
    this.worker.postMessage(msg);
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    clearInterval(this.lineupTimer);
    for (const d of this.disposers) d();
    this.root.innerHTML = '';
  }

  // ───────── 版面 ─────────

  private layout(): string {
    const p = this.meta.players;
    const team = (i: number): string =>
      `<div class="team t${i}"><span class="sw" style="background:${p[i].color}"></span><span class="nm">${esc(p[i].side)}</span><span class="bot">${esc(p[i].bot)}</span></div>`;
    return `<div class="lg">
  <div class="lg-stage">
    <canvas data-el="canvas" class="lg-canvas"></canvas>
    <div class="lg-bug">
      ${team(0)}
      <div class="bar t0" title="剩餘兵力（點數 × 剩餘人數比例；潰散不算）"><i data-el="bar0" style="background:${p[0].color}"></i><span data-el="pct0"></span></div>
      <div class="mid"><div class="clock" data-el="clock">0:00</div><div class="mode">${MODE_NAMES[this.meta.mode]}・${esc(this.meta.mapName)}</div><div class="pips" data-el="pips"></div><div class="dom hidden" data-el="dom"></div></div>
      <div class="bar t1" title="剩餘兵力（點數 × 剩餘人數比例；潰散不算）"><span data-el="pct1"></span><i data-el="bar1" style="background:${p[1].color}"></i></div>
      ${team(1)}
    </div>
    <div class="lg-big hidden" data-el="big"></div>
    <div class="lg-feed" data-el="feed"></div>
    <div class="lg-tip hidden" data-el="tip"></div>
    <div class="lg-ctrl">
      <button data-act="play" data-el="play" title="播放／暫停（空白鍵）">▶</button>
      ${SPEEDS.map((s) => `<button data-act="speed" data-speed="${s}" class="${s === 1 ? 'active' : ''}" title="播放速度（${SPEEDS.indexOf(s) + 1}）">${s}×</button>`).join('')}
      <button data-act="skip" title="快轉到下一個交戰、衝鋒或埋伏（N）">⏭ 下一場</button>
      <span class="sep"></span>
      <select data-el="viewer" title="視角：上帝視角看得到全部；選一方只顯示那一方看得到的敵軍">
        <option value="-1">上帝視角</option><option value="0">${esc(p[0].side)}視角</option><option value="1">${esc(p[1].side)}視角</option>
      </select>
      <button data-act="director" data-el="director" class="active" title="自動導播：鏡頭跟著主要戰場（F）">導播</button>
      <button data-act="fit" title="看全圖（Home）">全圖</button>
      <span class="sep"></span>
      <button data-act="help" title="規則說明（H）">說明</button>
      <button data-act="replay" title="下載這場比賽的回放檔">回放</button>
      <button data-act="restart" title="同一組合重看一次">重看</button>
      <button data-act="exit" title="回到選單">返回</button>
    </div>
    <div class="lg-overlay hidden" data-el="lineup"></div>
    <div class="lg-overlay hidden" data-el="result"></div>
    <div class="lg-overlay hidden" data-el="help"></div>
  </div>
  <aside class="lg-side">
    <section class="roster" data-el="roster0"></section>
    <section class="roster" data-el="roster1"></section>
    <section class="detail" data-el="detail"><div class="muted small">點地圖上的軍團或名冊查看詳細資訊。滾輪縮放、拖曳平移。</div></section>
  </aside>
</div>`;
  }

  // ───────── 事件 ─────────

  private bind(): void {
    const canvas = this.el.canvas as HTMLCanvasElement;
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, type: K | string, fn: (e: Event) => void): void => {
      t.addEventListener(type, fn);
      this.disposers.push(() => t.removeEventListener(type, fn));
    };
    on(this.root, 'click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (b === null) return;
      this.action(b.dataset.act!, b);
    });
    on(this.el.viewer, 'change', () => {
      this.viewer = Number((this.el.viewer as HTMLSelectElement).value);
    });
    on(canvas, 'wheel', (e) => {
      const we = e as WheelEvent;
      we.preventDefault();
      this.setDirector(false);
      const rect = canvas.getBoundingClientRect();
      const before = this.r.toWorld(we.clientX - rect.left, we.clientY - rect.top);
      this.r.cam.scale *= we.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.r.clamp();
      const after = this.r.toWorld(we.clientX - rect.left, we.clientY - rect.top);
      this.r.cam.x += (before.x - after.x) / TILE;
      this.r.cam.y += (before.y - after.y) / TILE;
      this.r.clamp();
    });
    on(canvas, 'mousedown', (e) => {
      const me = e as MouseEvent;
      this.drag = { x: me.clientX, y: me.clientY, cx: this.r.cam.x, cy: this.r.cam.y, moved: false };
    });
    on(window, 'mousemove', (e) => {
      const me = e as MouseEvent;
      const rect = canvas.getBoundingClientRect();
      this.mouse = { x: me.clientX - rect.left, y: me.clientY - rect.top };
      if (this.drag !== null && (me.buttons & 1) === 1) {
        const dx = me.clientX - this.drag.x;
        const dy = me.clientY - this.drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) {
          this.drag.moved = true;
          this.setDirector(false);
        }
        if (this.drag.moved) {
          this.r.cam.x = this.drag.cx - dx / this.r.cam.scale;
          this.r.cam.y = this.drag.cy - dy / this.r.cam.scale;
          this.r.clamp();
        }
      } else if (this.drag !== null) this.drag = null;
    });
    on(window, 'mouseup', (e) => {
      const me = e as MouseEvent;
      if (this.drag !== null && !this.drag.moved && me.target === canvas) {
        const rect = canvas.getBoundingClientRect();
        this.select(this.r.pick(me.clientX - rect.left, me.clientY - rect.top, this.viewer, this.alpha()), false);
      }
      this.drag = null;
    });
    on(canvas, 'mouseleave', () => {
      this.mouse = null;
    });
    on(canvas, 'dblclick', () => {
      if (this.selected >= 0) this.focusReg(this.selected, 2.2);
    });
    on(window, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      if ((ke.target as HTMLElement).tagName === 'SELECT') return;
      if (ke.key === ' ') {
        ke.preventDefault();
        this.action('play');
      } else if (ke.key >= '1' && ke.key <= '4') this.setSpeed(SPEEDS[Number(ke.key) - 1]);
      else if (ke.key === 'n' || ke.key === 'N') this.action('skip');
      else if (ke.key === 'f' || ke.key === 'F') this.setDirector(!this.director);
      else if (ke.key === 'h' || ke.key === 'H') this.action('help');
      else if (ke.key === 'Home') this.action('fit');
      else if (ke.key === 'Escape') {
        if (!this.el.help.classList.contains('hidden')) this.el.help.classList.add('hidden');
        else this.select(-1, false);
      }
    });
    on(window, 'resize', () => this.r.clamp());
    for (const i of [0, 1]) {
      on(this.el[`roster${i}`], 'click', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-reg]');
        if (row !== null) this.select(Number(row.dataset.reg), true);
      });
      on(this.el[`roster${i}`], 'mouseover', (e) => {
        const row = (e.target as HTMLElement).closest<HTMLElement>('[data-reg]');
        this.hovered = row === null ? -1 : Number(row.dataset.reg);
      });
      on(this.el[`roster${i}`], 'mouseleave', () => {
        this.hovered = -1;
      });
    }
  }

  private action(act: string, el?: HTMLElement): void {
    switch (act) {
      case 'play':
        if (!this.started) return this.startBattle();
        this.paused = !this.paused;
        this.send({ type: this.paused ? 'pause' : 'play' });
        this.el.play.textContent = this.paused ? '▶' : '❚❚';
        return;
      case 'speed':
        return this.setSpeed(Number(el?.dataset.speed ?? 1));
      case 'skip':
        if (!this.started) this.startBattle();
        this.send({ type: 'skip' });
        return;
      case 'director':
        return this.setDirector(!this.director);
      case 'fit':
        this.setDirector(false);
        this.r.fit();
        return;
      case 'help':
        this.toggleHelp();
        return;
      case 'replay':
        this.send({ type: 'replay' });
        return;
      case 'restart':
        this.ended = false;
        this.captions = [];
        this.el.feed.innerHTML = '';
        this.el.result.classList.add('hidden');
        this.r.reset();
        this.send({ type: 'restart' });
        this.started = true;
        this.paused = false;
        this.el.play.textContent = '❚❚';
        return;
      case 'exit':
        this.onExit();
        return;
      case 'start':
        this.startBattle();
        return;
      case 'closeHelp':
        this.el.help.classList.add('hidden');
        return;
    }
  }

  private setSpeed(s: number): void {
    this.speed = s;
    this.send({ type: 'speed', speed: s });
    for (const b of this.root.querySelectorAll<HTMLElement>('[data-act=speed]')) b.classList.toggle('active', Number(b.dataset.speed) === s);
  }

  private setDirector(on: boolean): void {
    this.director = on;
    this.el.director.classList.toggle('active', on);
  }

  private select(id: number, focus: boolean): void {
    this.selected = id;
    if (focus && id >= 0) this.focusReg(id, Math.max(this.r.cam.scale, this.r.fitScale * 2));
    this.renderDetail();
  }

  private focusReg(id: number, scale: number): void {
    const p = this.r.regAt(id, this.alpha());
    if (p === null) return;
    this.setDirector(false);
    this.r.cam.x = p.x / TILE;
    this.r.cam.y = p.y / TILE;
    this.r.cam.scale = scale;
    this.r.clamp();
  }

  // ───────── 開戰前陣容 ─────────

  private showLineup(): void {
    const side = (i: number): string => {
      const p = this.meta.players[i];
      const regs = this.meta.regs.filter((r) => r.owner === i);
      const counts = new Map<UnitKind, number>();
      for (const r of regs) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1);
      const men = regs.reduce((s, r) => s + r.men0, 0);
      const rej = this.meta.rejected.filter((x) => x.player === i);
      return `<div class="lu-side t${i}">
        <div class="lu-head" style="border-color:${p.color}"><span class="sw" style="background:${p.color}"></span><b>${esc(p.side)}</b><span class="bot">${esc(p.bot)}</span></div>
        <p class="muted small">${esc(p.style)}</p>
        <div class="lu-units">${[...counts]
          .map(([k, c]) => `<div class="lu-unit"><span class="ic" style="background:${p.color}">${unitSvg(k, 20, '#fff')}</span><span>${UNITS[k].name}</span><b>× ${c}</b><span class="muted small">${UNITS[k].cost} 點／${UNITS[k].men} 人</span></div>`)
          .join('')}</div>
        <div class="lu-total"><b>${p.cost}</b> / ${RULES.budget} 點・${regs.length} 團・${men} 人</div>
        ${rej.length ? `<div class="warn small">有 ${rej.length} 團布陣失敗：${esc(rej.map((x) => x.reason).join('、'))}</div>` : ''}
      </div>`;
    };
    this.el.lineup.innerHTML = `<div class="lu">
      <h2>開戰前陣容</h2>
      <p class="muted">雙方各有 ${RULES.budget} 點，在<b>看不到對手</b>的情況下選兵、布陣。觀眾是上帝視角：埋伏在樹林裡的軍團會以黃色虛線框標示。</p>
      <div class="lu-cols">${side(0)}<div class="lu-vs">VS</div>${side(1)}</div>
      <div class="lu-foot"><button class="primary" data-act="start">開戰 <span data-el="countdown"></span></button><button data-act="help">規則說明</button></div>
    </div>`;
    this.el.countdown = this.el.lineup.querySelector<HTMLElement>('[data-el=countdown]')!;
    this.el.lineup.classList.remove('hidden');
    let left = 10;
    this.el.countdown.textContent = `（${left}）`;
    this.lineupTimer = window.setInterval(() => {
      left -= 1;
      if (this.el.countdown) this.el.countdown.textContent = `（${left}）`;
      if (left <= 0 && this.el.help.classList.contains('hidden')) this.startBattle();
    }, 1000);
  }

  private startBattle(): void {
    if (this.started) return;
    clearInterval(this.lineupTimer);
    this.started = true;
    this.paused = false;
    this.el.lineup.classList.add('hidden');
    this.el.play.textContent = '❚❚';
    this.send({ type: 'play' });
  }

  // ───────── 說明 ─────────

  private toggleHelp(): void {
    const h = this.el.help;
    if (!h.classList.contains('hidden')) {
      h.classList.add('hidden');
      return;
    }
    const pct = (n: number): string => `×${(n / 100).toFixed(n % 100 === 0 ? 0 : n % 10 === 0 ? 1 : 2)}`;
    const rows = (Object.keys(UNITS) as UnitKind[])
      .map((k) => {
        const u = UNITS[k];
        const good = Object.entries(VERSUS[k])
          .filter(([, v]) => v! > 100)
          .map(([t, v]) => `${UNITS[t as UnitKind].name} ${pct(v!)}`)
          .join('、');
        return `<tr><td>${unitSvg(k, 16)} ${u.name}</td><td>${u.cost}</td><td>${u.men}</td><td>${u.hp / 10}</td><td>${u.attack / 10}／${(u.cooldown / TPS).toFixed(1)} 秒</td><td>${u.range ? `${u.range / TILE} 格` : '近戰'}</td><td>${((u.speed * TPS) / TILE).toFixed(1)}${dashDefOf(k) ? `（${dashDefOf(k)!.kind === 'charge' ? '衝鋒' : dashDefOf(k)!.kind === 'assault' ? '突擊' : '切入'} ${((dashDefOf(k)!.speed * TPS) / TILE).toFixed(1)}）` : ''}</td><td>${good || '—'}</td></tr>`;
      })
      .join('');
    h.innerHTML = `<div class="lg-helpbox">
      <button class="ghost close" data-act="closeHelp">✕</button>
      <h2>軍團戰怎麼看</h2>
      <p>兩個 AI 選手各用 <b>${RULES.budget} 點</b>選兵、在看不到對方的情況下布陣，開戰後指揮軍團（不是單兵）。<b>沒有資源、沒有建築</b>，開場就行軍接敵。</p>
      <h3>勝利條件</h3>
      <ul><li><b>殲滅戰</b>：對手全軍陣亡或潰散；剩餘兵力低於開場 ${RULES.collapsePercent}% 視為全軍潰敗。時間到（${RULES.timeLimitTicks / TPS / 60} 分鐘）比剩餘兵力。</li>
      <li><b>佔點</b>：同時控制超過半數的旗點 ${RULES.capture.dominationTicks / TPS} 秒（被奪回就歸零）；或殲滅對手。時間到先比旗點、再比兵力。</li></ul>
      <h3>戰術</h3>
      <ul><li><b>側擊 ×1.5、背擊 ×2</b>：看攻擊方在目標陣型的哪一面（陣型前方的小白箭頭是正面）。</li>
      <li><b>衝鋒</b>（騎兵）：助跑 4 格後撞擊，傷害極高但轉向很慢；撞擊後要先脫離 6 格才能再衝。樹林、淺灘不能衝鋒。</li>
      <li><b>架陣</b>（長槍方陣）：3 秒架好，正面受到的衝鋒只剩 20% 並反彈一半給騎兵；被側擊、背擊時無效。</li>
      <li><b>接觸前迷霧</b>：地形公開，但敵軍要進入視野才看得到；<b>樹林中隱蔽</b>，要 3 格內（輕步兵 5 格）才發現，攻擊後曝光 10 秒。</li>
      <li><b>老兵</b>：累積傷害達本團血量的 50%、120% 升級，攻擊與血量 +10%、+20%（旗標上的 ★）。</li>
      <li><b>殘兵潰散</b>：人數低於 ${RULES.routPercent}% 就失控，往己方後方撤離，只在被近身時反擊；潰散視同陣亡。</li></ul>
      <h3>兵種</h3>
      <table class="lg-table"><tr><th>兵種</th><th>點數</th><th>人數</th><th>血量</th><th>攻擊</th><th>射程</th><th>速度（格／秒）</th><th>剋制</th></tr>${rows}</table>
      <p class="muted small">盾兵：自己受到的遠程傷害 ×0.25，周圍 3 格友軍 ×0.5。弓兵近戰 ×0.5。</p>
      <h3>地形</h3>
      <table class="lg-table">${TERRAIN_NAMES.map((n, i) => (TERRAIN_TIP[i] ? `<tr><td>${n}</td><td>${TERRAIN_TIP[i]}</td></tr>` : '')).join('')}</table>
      <h3>操作</h3>
      <p class="small"><kbd>空白</kbd> 播放／暫停・<kbd>1</kbd>～<kbd>4</kbd> 速度・<kbd>N</kbd> 下一場交戰・<kbd>F</kbd> 自動導播・<kbd>Home</kbd> 全圖・滾輪縮放、拖曳平移、點軍團看詳情（雙擊跟過去）</p>
    </div>`;
    h.classList.remove('hidden');
  }

  // ───────── 訊息 ─────────

  handle(msg: FromLegionWorker): void {
    switch (msg.type) {
      case 'frame': {
        const now = performance.now();
        if (this.r.frame !== null) {
          const gap = now - this.frameAt;
          this.frameGap = this.frameGap * 0.7 + Math.min(400, Math.max(16, gap)) * 0.3;
        }
        this.frameAt = now;
        this.r.push(msg.frame, now);
        this.onFrame(msg.frame);
        return;
      }
      case 'skipped':
        if (this.director) {
          this.r.cam.x = msg.x / TILE;
          this.r.cam.y = msg.y / TILE;
          this.r.cam.scale = Math.max(this.r.cam.scale, this.r.fitScale * 2);
          this.r.clamp();
        }
        return;
      case 'replayFile': {
        const blob = new Blob([msg.json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `legion-${this.meta.seed}.json`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return;
      }
      default:
        return;
    }
  }

  private onFrame(f: LegionFrame): void {
    this.el.clock.textContent = clock(f.tick);
    const costs = this.meta.players.map((p) => p.cost);
    for (const i of [0, 1]) {
      const pct = Math.floor(f.strength[i] / Math.max(1, costs[i]));
      this.el[`bar${i}`].style.width = `${Math.max(0, Math.min(100, pct))}%`;
      this.el[`pct${i}`].textContent = `${pct}%`;
    }
    if (this.meta.mode === 'capture') {
      this.el.pips.innerHTML = f.flags
        .map((fl, i) => {
          const c = fl.owner >= 0 ? this.meta.players[fl.owner].color : 'transparent';
          return `<i title="${esc(this.meta.flags[i].name)}" style="background:${c};border-color:${fl.owner >= 0 ? c : 'rgba(255,255,255,0.55)'}"></i>`;
        })
        .join('');
      const d = f.domination.findIndex((x) => x > 0);
      if (d >= 0) {
        const left = Math.ceil((RULES.capture.dominationTicks - f.domination[d]) / TPS);
        this.el.dom.textContent = `${this.meta.players[d].side}壓制中・${left} 秒`;
        this.el.dom.style.background = this.meta.players[d].color;
        this.el.dom.classList.remove('hidden');
      } else this.el.dom.classList.add('hidden');
    }
    for (const c of f.captions) this.caption(c);
    this.renderRosters(f);
    if (this.selected >= 0) this.renderDetail();
    if (f.over && !this.ended) {
      this.ended = true;
      setTimeout(() => this.showResult(f), 1800);
    }
  }

  private caption(c: Caption): void {
    this.captions.push(c);
    const row = document.createElement('div');
    row.className = `cap${c.big ? ' big' : ''}`;
    row.innerHTML = `<span class="t">${clock(c.tick)}</span>${esc(c.text)}`;
    this.el.feed.append(row);
    while (this.el.feed.children.length > 5) this.el.feed.firstElementChild?.remove();
    if (c.big && this.started) {
      this.el.big.textContent = c.text;
      this.el.big.classList.remove('hidden');
      this.el.big.classList.remove('pop');
      void this.el.big.offsetWidth;
      this.el.big.classList.add('pop');
      this.bigUntil = performance.now() + 3200;
    }
  }

  private renderRosters(f: LegionFrame): void {
    const byId = new Map(f.regs.map((r) => [r.id, r]));
    const sig = f.regs.map((r) => `${r.id}:${r.men}:${r.status}:${r.level}:${r.concealed ? 1 : 0}`).join(',') + `|${this.selected}`;
    if (sig === this.rosterSig) return;
    this.rosterSig = sig;
    for (const i of [0, 1]) {
      const p = this.meta.players[i];
      const regs = this.meta.regs.filter((r) => r.owner === i);
      const alive = regs.filter((r) => {
        const x = byId.get(r.id);
        return x !== undefined && x.status !== 'routed';
      }).length;
      this.el[`roster${i}`].innerHTML = `<h3 style="border-color:${p.color}"><span class="sw" style="background:${p.color}"></span>${esc(p.side)}<span class="bot">${esc(p.bot)}</span><span class="cnt">${alive}/${regs.length} 團・擊殺 ${f.kills[i]}</span></h3>
        ${regs
          .map((s) => {
            const r = byId.get(s.id);
            const men = r?.men ?? 0;
            const frac = men / s.men0;
            const st = r === undefined ? '覆滅' : STATUS_NAME[r.status] + (r.concealed ? '・埋伏中' : '');
            const cls = r === undefined ? 'dead' : r.status === 'routed' ? 'routed' : r.status === 'engaged' || r.status === 'charging' ? 'hot' : '';
            return `<div class="rr ${cls}${this.selected === s.id ? ' sel' : ''}" data-reg="${s.id}">
              <span class="ic" style="background:${r === undefined || r.status === 'routed' ? '#475569' : p.color}">${unitSvg(s.kind, 16, '#fff')}</span>
              <span class="nm">${esc(s.name)}${r && r.level > 1 ? `<span class="lv">${'★'.repeat(r.level - 1)}</span>` : ''}</span>
              <span class="st">${st}</span>
              <span class="mb"><i style="width:${Math.round(frac * 100)}%;background:${frac > 0.5 ? '#4ade80' : frac > 0.25 ? '#facc15' : '#f87171'}"></i></span>
              <span class="mn">${men}</span>
            </div>`;
          })
          .join('')}`;
    }
  }

  private renderDetail(): void {
    const id = this.selected;
    if (id < 0) {
      this.el.detail.innerHTML = '<div class="muted small">點地圖上的軍團或名冊查看詳細資訊。滾輪縮放、拖曳平移。</div>';
      return;
    }
    const s = this.meta.regs[id];
    const r = this.r.reg(id);
    const p = this.meta.players[s.owner];
    const u = UNITS[s.kind];
    const vs = Object.entries(VERSUS[s.kind])
      .map(([t, v]) => `${UNITS[t as UnitKind].name} ×${(v! / 100).toFixed(2).replace(/0$/, '')}`)
      .join('、');
    const target = r !== undefined && (r.target >= 0 || r.fireTarget >= 0) ? this.meta.regs[r.target >= 0 ? r.target : r.fireTarget] : undefined;
    const terrain = r !== undefined ? this.terrainName(r.x, r.y) : '';
    this.el.detail.innerHTML = `<div class="dt-head"><span class="ic" style="background:${p.color}">${unitSvg(s.kind, 22, '#fff')}</span><div><b>${esc(p.side)} ${esc(s.name)}</b><div class="muted small">${u.name}・${u.cost} 點</div></div></div>
      ${
        r === undefined
          ? '<div class="muted">已覆滅</div>'
          : `<div class="dt-grid">
        <span>人數</span><b>${r.men} / ${s.men0}</b>
        <span>血量</span><b>${Math.round(r.hp / 10)} / ${Math.round(r.hpMax / 10)}</b>
        <span>狀態</span><b>${STATUS_NAME[r.status]}${r.concealed ? '・埋伏中' : ''}${r.seen ? '' : '・敵方看不到'}</b>
        <span>指令</span><b>${ORDER_NAME[r.order] ?? r.order}${target ? ` → ${esc(this.meta.players[target.owner].side)}${esc(target.name)}` : ''}</b>
        <span>等級</span><b>${r.level} 級${r.level > 1 ? `（攻擊、血量 +${RULES.veteran.levels[r.level - 1].attack - 100}%）` : ''}</b>
        <span>擊殺</span><b>${r.kills}</b>
        <span>地形</span><b>${terrain}</b>
        <span>陣形</span><b>${FORMATION_NAMES[r.formation]}${r.stance ? `・${r.stance === 'raise' ? '舉盾' : r.stance === 'wall' ? '盾牆' : '持盾'}` : ''}</b>
        <span>招牌技能</span><b>${r.skillCd > 0 ? `冷卻 ${Math.ceil(r.skillCd / TPS)} 秒` : '可以使用'}</b>
        ${r.intent ? `<span>意圖</span><b>${esc(r.intent)}</b>` : ''}
      </div>`
      }
      <div class="dt-stats small muted">攻擊 ${u.attack / 10}／${(u.cooldown / TPS).toFixed(1)} 秒・${u.range ? `射程 ${u.range / TILE} 格` : '近戰'}・速度 ${((u.speed * TPS) / TILE).toFixed(1)} 格／秒・視野 ${u.sight / TILE} 格${vs ? `<br>相剋：${vs}` : ''}</div>`;
  }

  private terrainName(x: number, y: number): string {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    const t = this.meta.terrain[ty * this.meta.width + tx] ?? 0;
    return TERRAIN_NAMES[t];
  }

  private showResult(f: LegionFrame): void {
    const res = f.result;
    if (res === null) return;
    const byId = new Map(f.regs.map((r) => [r.id, r]));
    const stat = (i: number): string => {
      const regs = this.meta.regs.filter((r) => r.owner === i);
      const men0 = regs.reduce((s, r) => s + r.men0, 0);
      const men = regs.reduce((s, r) => s + (byId.get(r.id)?.men ?? 0), 0);
      const routed = regs.filter((r) => byId.get(r.id) === undefined || byId.get(r.id)!.status === 'routed').length;
      const p = this.meta.players[i];
      return `<div class="rs-side${res.winner === i ? ' win' : ''}" style="border-color:${p.color}"><div class="lu-head"><span class="sw" style="background:${p.color}"></span><b>${esc(p.side)}</b><span class="bot">${esc(p.bot)}</span>${res.winner === i ? '<span class="crown">勝</span>' : ''}</div>
        <div class="dt-grid"><span>剩餘兵力</span><b>${Math.floor(res.strength[i] / Math.max(1, p.cost))}%</b><span>存活士兵</span><b>${men} / ${men0}</b><span>擊殺</span><b>${f.kills[i]}</b><span>潰散或覆滅</span><b>${routed} / ${regs.length} 團</b>${this.meta.mode === 'capture' ? `<span>旗點</span><b>${res.flagsHeld[i]}</b>` : ''}</div></div>`;
    };
    const why = res.reason === 'domination' ? '控制過半旗點撐完倒數' : res.reason === 'annihilation' ? '打垮對手全軍' : '時間到，比較剩餘兵力';
    const title = res.winner === null ? '平手' : `${this.meta.players[res.winner].side}「${esc(this.meta.players[res.winner].bot)}」獲勝`;
    this.el.result.innerHTML = `<div class="lu"><h2>${title}</h2><p class="muted">${why}・比賽時間 ${clock(res.durationTicks)}</p><div class="lu-cols">${stat(0)}<div class="lu-vs">VS</div>${stat(1)}</div>
      <div class="lu-foot"><button class="primary" data-act="restart">重看一次</button><button data-act="replay">下載回放</button><button data-act="exit">換組合</button><button data-act="closeResult">看戰場</button></div></div>`;
    this.el.result.classList.remove('hidden');
    this.el.result.querySelector('[data-act=closeResult]')?.addEventListener('click', () => this.el.result.classList.add('hidden'));
  }

  // ───────── 每格畫面 ─────────

  private alpha(): number {
    return Math.max(0, Math.min(1, (performance.now() - this.frameAt) / Math.max(16, this.frameGap)));
  }

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    const now = performance.now();
    const a = this.paused ? 1 : this.alpha();
    if (this.director && this.started) this.direct();
    this.r.draw(a, now, { viewer: this.viewer, selected: this.selected, hovered: this.hovered, showRanges: true });
    if (this.bigUntil > 0 && now > this.bigUntil) {
      this.bigUntil = 0;
      this.el.big.classList.add('hidden');
    }
    this.updateTip(a);
  };

  /** 自動導播：鏡頭移向交戰中軍團的重心，交戰範圍越集中拉得越近 */
  private direct(): void {
    const f = this.r.frame;
    if (f === null) return;
    const hot = f.regs.filter((r) => r.status === 'engaged' || r.status === 'charging' || r.fireTarget >= 0);
    const pool = hot.length > 0 ? hot : f.regs.filter((r) => r.status !== 'routed');
    if (pool.length === 0) return;
    let sx = 0;
    let sy = 0;
    let w = 0;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const r of pool) {
      const k = r.men + (r.status === 'charging' ? 30 : 0);
      sx += r.x * k;
      sy += r.y * k;
      w += k;
      x0 = Math.min(x0, r.x - r.rad);
      x1 = Math.max(x1, r.x + r.rad);
      y0 = Math.min(y0, r.y - r.rad);
      y1 = Math.max(y1, r.y + r.rad);
    }
    const tx = sx / w / TILE;
    const ty = sy / w / TILE;
    const cw = this.r.canvas.clientWidth;
    const ch = this.r.canvas.clientHeight;
    const span = Math.max((x1 - x0) / TILE + 16, ((y1 - y0) / TILE + 12) * (cw / ch));
    const fit = this.r.fitScale;
    const ts = Math.max(fit, Math.min(fit * 3.2, cw / span));
    const c = this.r.cam;
    c.x += (tx - c.x) * 0.035;
    c.y += (ty - c.y) * 0.035;
    c.scale += (ts - c.scale) * 0.02;
    this.r.clamp();
  }

  private updateTip(a: number): void {
    const tip = this.el.tip;
    if (this.mouse === null || this.drag?.moved) {
      tip.classList.add('hidden');
      return;
    }
    const id = this.r.pick(this.mouse.x, this.mouse.y, this.viewer, a);
    if (id !== this.hovered && !this.root.querySelector('.roster:hover')) this.hovered = id;
    let html = '';
    if (id >= 0) {
      const s = this.meta.regs[id];
      const r = this.r.reg(id);
      const p = this.meta.players[s.owner];
      if (r !== undefined)
        html = `<b style="color:${p.color}">${esc(p.side)} ${esc(s.name)}</b>　${r.men}/${s.men0} 人<br>${STATUS_NAME[r.status]}${r.concealed ? '・<span class="hint">埋伏中（敵方看不到）</span>' : ''}${r.level > 1 ? `・${r.level} 級老兵` : ''}`;
    } else {
      const w = this.r.toWorld(this.mouse.x, this.mouse.y);
      const tx = Math.floor(w.x / TILE);
      const ty = Math.floor(w.y / TILE);
      if (tx >= 0 && ty >= 0 && tx < this.meta.width && ty < this.meta.height) {
        const t = this.meta.terrain[ty * this.meta.width + tx];
        const flag = this.meta.flags.findIndex((fl) => Math.hypot(fl.x - w.x, fl.y - w.y) <= RULES.capture.radius);
        if (this.meta.mode === 'capture' && flag >= 0) {
          const st = this.r.frame?.flags[flag];
          const own = st === undefined || st.owner < 0 ? '中立' : this.meta.players[st.owner].side;
          html = `<b>旗點：${esc(this.meta.flags[flag].name)}</b>　目前：${own}<br><span class="muted">只有一方的士兵在圈內就會慢慢佔領；同時控制過半旗點 ${RULES.capture.dominationTicks / TPS} 秒獲勝</span>`;
        } else if (t !== 0) html = `<b>${TERRAIN_NAMES[t]}</b><br><span class="muted">${TERRAIN_TIP[t]}</span>`;
      }
    }
    if (html === '') {
      tip.classList.add('hidden');
      return;
    }
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    const cw = this.r.canvas.clientWidth;
    tip.style.left = `${Math.min(cw - tip.offsetWidth - 8, this.mouse.x + 16)}px`;
    tip.style.top = `${this.mouse.y + 18}px`;
  }
}
