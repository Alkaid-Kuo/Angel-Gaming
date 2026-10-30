// 三個方向共用的頁面骨架：1920×1080 舞台、畫面切換（對局／計分板／全圖）、HUD 的 HTML 結構。
// 版面與語彙在各方向自己的 CSS；這裡只決定有哪些資訊，跟可玩版 hud.ts 的欄位一一對應。
import { initStage, still } from '../stage.ts';
import { BOARD_THEM, BOARD_US, HUD, type BoardLine } from './scene.ts';
import { MAP, OPEN_LOOPS } from './world.ts';

export type ViewId = 'play' | 'board' | 'map';

export interface Direction {
  readonly id: 'a' | 'b' | 'c';
  /** 對局畫面（1920×1080，含世界裡的一切，不含 HUD） */
  paintScene(g: CanvasRenderingContext2D): void;
  /** 全圖（看材質、道具在整張地圖上的樣子） */
  paintOverview(g: CanvasRenderingContext2D): void;
  /** 小地圖（正方形，邊長 size） */
  paintRadar(g: CanvasRenderingContext2D, size: number): void;
}

const VIEWS: readonly { readonly id: ViewId; readonly label: string }[] = [
  { id: 'play', label: '對局' },
  { id: 'board', label: '計分板' },
  { id: 'map', label: '全圖' },
];

const pips = (n: number): string => Array.from({ length: 5 }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');

function hudHtml(): string {
  const h = HUD;
  const slots = h.slots.map((s) => `<div class="ws${s.on ? ' sel' : ''}${s.has ? '' : ' empty'}"><kbd>${s.key}</kbd><span class="nm">${s.has ? s.name : '—'}</span></div>`).join('');
  const feed = h.feed.map((f) => `<div class="k"><b class="us">${f.killer}</b><span class="w">${f.weapon}</span><b class="them">${f.victim}</b></div>`).join('');
  return `
  <div class="h-radar"><canvas id="radar" width="540" height="540"></canvas><div class="rz"><b>${h.zone}</b><span>赤岩鎮</span></div></div>
  <div class="h-top">
    <div class="tm us"><b class="n">${h.us}</b><small>T</small><span class="pips">${pips(h.aliveUs)}</span><span class="sc">${h.scoreUs}</span></div>
    <div class="mid"><span class="clock">${h.clock}</span><span class="rd">${h.round}</span></div>
    <div class="tm them"><span class="sc">${h.scoreThem}</span><span class="pips">${pips(h.aliveThem)}</span><small>CT</small><b class="n">${h.them}</b></div>
  </div>
  <div class="h-feed">${feed}</div>
  <div class="h-hint">${h.hint}</div>
  <div class="h-vitals">
    <div class="stat hp"><span class="lb">血量</span><b>${h.hp}</b><i class="bar"><u style="width:${h.hp}%"></u></i></div>
    <div class="stat ar"><span class="lb">護甲</span><b>${h.armor}</b><i class="bar"><u style="width:${h.armor}%"></u></i></div>
    <div class="stat mo"><span class="lb">金錢</span><b>$${h.money}</b></div>
  </div>
  <div class="h-wpn">
    <div class="am"><span class="wn">${h.weapon}</span><b>${h.ammo}</b><span class="res">/ ${h.reserve}</span></div>
    <div class="wbar">${slots}</div>
  </div>`;
}

export function boardHtml(): string {
  const row = (l: BoardLine, us: boolean): string => `<tr class="${l.alive ? '' : 'dead'}${l.me === true ? ' me' : ''}"><td class="pn"><b>${l.name}</b><small>${l.role}</small></td><td>${l.k}</td><td>${l.d}</td><td>${l.a}</td><td>${us ? `$${l.money}` : '—'}</td></tr>`;
  const table = (head: string, side: string, cls: string, list: readonly BoardLine[], us: boolean): string => `<table class="${cls}"><thead><tr><th class="pn">${head}<small>${side}</small></th><th>擊殺</th><th>死亡</th><th>助攻</th><th>金錢</th></tr></thead><tbody>${list.map((l) => row(l, us)).join('')}</tbody></table>`;
  return `<div class="cols">${table(HUD.us, 'T', 'us', BOARD_US, true)}${table(HUD.them, 'CT', 'them', BOARD_THEM, false)}</div>`;
}

/** 回合紀錄：o＝我方、x＝對手；炸／拆／時是勝因（順序就是第 1～12 回合） */
const ROUNDS = ['o', 'x', 'x炸', 'o', 'o拆', 'x', 'o', 'x時', 'o', 'o', 'o炸', 'x'] as const;

export function roundsHtml(list: readonly string[] = ROUNDS): string {
  return list.map((r) => `<i class="${r[0] === 'o' ? 'us' : 'them'}">${r.slice(1)}</i>`).join('');
}

/** 小地圖的底：牆色鋪滿、可走區挖開、包點上色；鏡頭內的資訊由各方向再畫 */
export function radarBase(g: CanvasRenderingContext2D, size: number, wall: string, floor: string, site: string): void {
  const k = size / MAP.width;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = wall;
  g.fillRect(0, 0, size, size);
  g.setTransform(k, 0, 0, k, 0, 0);
  g.fillStyle = floor;
  const p = new Path2D();
  for (const loop of OPEN_LOOPS) {
    loop.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
    p.closePath();
  }
  g.fill(p, 'evenodd');
  g.fillStyle = site;
  for (const s of MAP.sites) g.fillRect(s.x0, s.y0, s.x1 - s.x0, s.y1 - s.y0);
}

/** 字型載入逾時就照用後備字型，樣張不能卡住 */
async function fontsReady(fonts: readonly string[]): Promise<void> {
  await Promise.race([Promise.all(fonts.map((f) => document.fonts.load(f, '天使B7'))), new Promise((r) => setTimeout(r, 1800))]);
}

export async function mountPage(d: Direction, fonts: readonly string[]): Promise<void> {
  const stage = initStage();
  stage.classList.add(`dir-${d.id}`);
  stage.innerHTML =
    `<canvas id="view" width="1920" height="1080"></canvas><canvas id="overview" width="1920" height="1080" class="off"></canvas>` +
    `<div class="hud" id="hud">${hudHtml()}</div>` +
    `<div class="sheet board off" id="sheet-board"><div class="box"><h2><span>計分板</span><em>${HUD.scoreUs} : ${HUD.scoreThem}</em></h2>${boardHtml()}<div class="hist">${roundsHtml()}</div></div></div>`;
  await fontsReady(fonts);
  const view = (stage.querySelector('#view') as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D;
  d.paintScene(view);
  d.paintRadar((stage.querySelector('#radar') as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D, 540);
  let overviewDone = false;
  const show = (v: ViewId): void => {
    if (v === 'map' && !overviewDone) {
      overviewDone = true;
      d.paintOverview((stage.querySelector('#overview') as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D);
    }
    stage.querySelector('#view')?.classList.toggle('off', v === 'map');
    stage.querySelector('#overview')?.classList.toggle('off', v !== 'map');
    stage.querySelector('#hud')?.classList.toggle('off', v === 'map');
    stage.querySelector('#sheet-board')?.classList.toggle('off', v !== 'board');
    bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  };
  const bar = document.createElement('div');
  bar.className = 'sk-bar';
  bar.innerHTML = `<a href="./index.html">←</a>${VIEWS.map((v) => `<button type="button" data-v="${v.id}">${v.label}</button>`).join('')}`;
  bar.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b !== null) show(b.dataset.v as ViewId);
  });
  if (!still) document.body.appendChild(bar);
  const wanted = new URLSearchParams(location.search).get('view');
  show(VIEWS.some((v) => v.id === wanted) ? (wanted as ViewId) : 'play');
  document.documentElement.dataset.ready = '1';
}
