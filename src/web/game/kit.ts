// 正式版共用小元件：隊徽、頭像、流派徽記、選手收藏卡、畫面頁首。只輸出 HTML 字串，資料只讀已知層視圖。
// 配色規則（見 web/sketch/angel.css）：金只給我方、選中、主要行動；紅只給本週對手與警示；其他隊一律墨黑＋灰白。
import type { ContentPack, KnownPlayer, KnownView } from '../../manage/index.ts';
import { esc, lineageName, wan } from '../manage/format.ts';
import type { ClubUi } from '../club/model.ts';
import { myFixture, opponentOf } from '../club/model.ts';
import { LINEAGE_LOOK, avatarSvg, crestSvg, npcCrest, tierOf, type CrestSpec, type IconName } from '../club/art.ts';
import { icon } from '../club/art.ts';
import type { Prefs } from '../club/prefs.ts';

export type Screen = 'title' | 'create' | 'hub' | 'squad' | 'player' | 'market' | 'training' | 'league' | 'betting' | 'finance' | 'inbox';

export interface GameUi extends ClubUi {
  /** 市場裡選中的自由球員 */
  marketPick: string | null;
  /** 市場分頁 */
  marketTab: 'free' | 'teams' | 'intel';
  /** 新增排程：練習賽或戰術研發 */
  trainMode: 'scrim' | 'research';
  /** 信件裡打開的那封（inbox 陣列的索引） */
  mailSel: number | null;
  /** 選手詳情看的是誰 */
  player: string | null;
}

export function newGameUi(base: ClubUi): GameUi {
  return { ...base, marketPick: null, marketTab: 'free', trainMode: 'research', mailSel: null, player: null };
}

export interface Ctx {
  v: KnownView;
  c: ContentPack;
  ui: GameUi;
  prefs: Prefs;
  pm: Map<string, KnownPlayer>;
}

export { esc, icon, wan };

/** 單獨發布的試玩版（打包時設 VITE_STANDALONE=1）：沒有首頁與舊介面，不放這兩個連結 */
export const STANDALONE = import.meta.env.VITE_STANDALONE === '1';

/** 隊徽可選的配色（介面主色固定是金，隊徽只在金、白、墨之間配） */
export const CREST_SCHEMES: { name: string; primary: string; secondary: string }[] = [
  { name: '白金', primary: '#eef2f6', secondary: '#f0b54a' },
  { name: '墨金', primary: '#1c2535', secondary: '#f0b54a' },
  { name: '金墨', primary: '#f0b54a', secondary: '#0b0e14' },
  { name: '墨白', primary: '#1c2535', secondary: '#eef2f6' },
  { name: '灰金', primary: '#8b95a4', secondary: '#f0b54a' },
  { name: '白墨', primary: '#eef2f6', secondary: '#1c2535' },
];
export const DEFAULT_MY_CREST: CrestSpec = { shape: 0, primary: '#eef2f6', secondary: '#f0b54a', emblem: 'wings' };

/** 玩家自選的隊徽；舊介面存的顏色不在配色表裡時換成白金（外形與圖騰保留） */
export function myCrest(prefs: Prefs): CrestSpec {
  const c = prefs.crest ?? DEFAULT_MY_CREST;
  const ok = CREST_SCHEMES.some((s) => s.primary === c.primary && s.secondary === c.secondary);
  return ok ? c : { ...c, primary: DEFAULT_MY_CREST.primary, secondary: DEFAULT_MY_CREST.secondary };
}

/** 本週對手（沒有比賽時是 null） */
export function foeOf(v: KnownView): string | null {
  const f = myFixture(v);
  return f ? opponentOf(f, v.me.teamId) : null;
}

export function teamName(v: KnownView, teamId: string | null): string {
  if (teamId === null) return '自由球員';
  return v.teams.find((t) => t.id === teamId)?.name ?? teamId;
}

/** foeId：要標紅的對手（預設本週對手；比賽日演出改傳剛交手的隊，null＝不標） */
export function crestSpec(ctx: Ctx, teamId: string | null, foeId: string | null = foeOf(ctx.v)): CrestSpec {
  if (teamId === null) return { shape: 1, primary: '#1c2535', secondary: '#8b95a4', emblem: 'star' };
  if (teamId === ctx.v.me.teamId) return myCrest(ctx.prefs);
  const base = npcCrest(teamName(ctx.v, teamId));
  const foe = teamId === foeId;
  return { ...base, primary: foe ? '#2a1416' : '#1c2535', secondary: foe ? '#ff5d5d' : '#c9d1dc' };
}

export function crest(ctx: Ctx, teamId: string | null, size = 32, foeId: string | null = foeOf(ctx.v)): string {
  return crestSvg(crestSpec(ctx, teamId, foeId), size);
}

/** 圓形隊徽座（.cr） */
export function crestRing(ctx: Ctx, teamId: string | null, box: number, foeId: string | null = foeOf(ctx.v)): string {
  const foe = teamId !== null && teamId === foeId;
  return `<span class="cr ${foe ? 'foe' : ''}" style="width:${box}px;height:${box}px">${crest(ctx, teamId, Math.round(box * 0.64), foeId)}</span>`;
}

/** 頭像：我方染金框白；本週對手框紅；其他人（他隊、自由球員）一律灰（CSS 處理） */
export function avatar(ctx: Ctx, p: KnownPlayer | undefined, size: number, cls = ''): string {
  if (!p) return `<span class="av empty ${cls}" style="width:${size}px;height:${size}px"></span>`;
  const side = p.teamId === ctx.v.me.teamId ? '' : p.teamId !== null && p.teamId === foeOf(ctx.v) ? 'foe' : 'other';
  return `<span class="av tinted ${side} ${cls}" style="width:${size}px;height:${size}px">${avatarSvg(p.id + p.name, '#3a4458', size)}</span>`;
}

/** 流派徽記：原本的圖形，單色（跟著文字顏色） */
export function glyph(lineageId: string, size = 16): string {
  const l = LINEAGE_LOOK[lineageId];
  return l ? `<svg class="lg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" color="currentColor" aria-hidden="true">${l.glyph}</svg>` : '';
}

export function lineage(ctx: Ctx, id: string, size = 14): string {
  return `<span class="ly">${glyph(id, size)}${esc(lineageName(ctx.c, id))}</span>`;
}

const TIER_EN = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'LEGEND'];
export function tierName(version: number): { zh: string; en: string; idx: number } {
  const t = tierOf(version);
  return { zh: t.name, en: TIER_EN[t.idx], idx: t.idx };
}

export interface CardOpts {
  /** 出賽位（0～lineupSize−1） */
  slot?: number;
  sel?: boolean;
  act?: string;
  drag?: boolean;
  /** 右下角的小字（預設週薪） */
  sub?: string;
  /** 貼在卡上的便條（球探情報） */
  note?: string;
}

/** 選手收藏卡：版本只用框的明暗與金的多寡區分 */
export function pcard(ctx: Ctx, p: KnownPlayer, o: CardOpts = {}): string {
  const t = tierName(p.version);
  const foe = p.teamId !== null && p.teamId === foeOf(ctx.v);
  return `<div class="pc t${t.idx + 1} ${o.sel ? 'sel' : ''} ${foe ? 'foe' : ''}" data-act="${o.act ?? 'player'}" data-pid="${p.id}" ${o.drag ? 'draggable="true"' : ''}>
    <div class="top2"><span class="ver">v${p.version}</span><span>${t.zh} · ${t.en}</span></div>
    <div class="por tinted ${p.teamId === ctx.v.me.teamId ? '' : 'grey'}">${avatarSvg(p.id + p.name, '#3a4458', 176)}</div>
    ${o.slot !== undefined && o.slot >= 0 ? `<span class="slot"><i>${esc(slotName(ctx, o.slot))}</i></span>` : ''}
    ${p.upgrading ? '<span class="flag">升版中</span>' : ''}
    ${o.note ? `<div class="note">${o.note}</div>` : ''}
    <div class="nm"><b>${esc(p.name)}</b>${lineage(ctx, p.lineageId, 15)}</div>
    <div class="st"><span class="num">${p.elo}</span><small>RATING</small><span class="wg">${o.sub ?? `<span class="num">${wan(p.weeklySalary)}</span> <small>萬／週</small>`}</span></div></div>`;
}

/** 球探情報便條（沒有情報時空字串） */
export function intelNote(ctx: Ctx, p: KnownPlayer): string {
  const i = ctx.v.intel.find((x) => x.playerId === p.id);
  if (!i) return '';
  const d = i.estPower - p.elo;
  return `球探：真實約 <b>${i.estPower}</b><br>±${i.sd} · ${d >= 0 ? `高 ${d}` : `低 ${-d}`}`;
}

/** 畫面頁首：英文小標＋斜體大字＋一行說明 */
export function head(en: string, title: string, sub: string): string {
  return `<div class="ph in"><span class="en">${en}</span><h1>${title}</h1><div class="sub">${sub}</div></div>`;
}

/** 面板標題列 */
export function pt(no: string, title: string, aux = '', en = ''): string {
  return `<div class="pt"><span class="no">${no}</span><b>${title}</b>${en ? `<span class="en">${en}</span>` : ''}${aux ? `<span class="aux">${aux}</span>` : ''}</div>`;
}

export function btn(label: string, attrs: string, cls = '', en = ''): string {
  return `<button class="btn ${cls}" ${attrs}><b>${label}</b>${en ? `<span>${en}</span>` : ''}</button>`;
}

export function ic(name: IconName, size = 20): string {
  return `<span class="ic">${icon(name, size)}</span>`;
}

export const canAct = (v: KnownView): boolean => v.phase === 'offseason' || v.phase === 'season';

/** 出賽位名稱（內容包的 slotNames；軍團戰暫代包是先鋒、中堅、大將，攻防戰是 1～5 號位） */
export function slotName(ctx: Ctx, i: number): string {
  return ctx.c.slotNames[i] ?? `${i + 1} 號位`;
}

const SLOT_EN_OF: Readonly<Record<string, string>> = { 先鋒: 'VANGUARD', 中堅: 'CENTER', 大將: 'CAPTAIN' };
export function slotEn(ctx: Ctx, i: number): string {
  return SLOT_EN_OF[slotName(ctx, i)] ?? `SLOT 0${i + 1}`;
}

/** 練習賽／研發場數滑桿的級距：容量大（暫代包每週數百場）以 10 場為單位，容量小（真引擎每週十幾場）以 1 場 */
export function runStep(cap: number): number {
  return Math.max(1, Math.round(cap / 20));
}

export function weekLabel(v: KnownView): { short: string; long: string; en: string } {
  if (v.phase === 'ended') return { short: 'END', long: '賽段結束', en: 'SEASON OVER' };
  if (v.phase === 'bankrupt') return { short: 'END', long: '已破產', en: 'BANKRUPT' };
  if (v.phase === 'offseason') return { short: 'PRE', long: '休賽期', en: 'OFFSEASON' };
  if (v.week === 8) return { short: 'W08', long: '季後賽・準決賽', en: 'SEMIFINAL' };
  if (v.week === 9) return { short: 'W09', long: '季後賽・決賽', en: 'FINAL' };
  return { short: `W${String(v.week).padStart(2, '0')}`, long: `例行賽・第 ${v.week} 週`, en: 'REGULAR' };
}
