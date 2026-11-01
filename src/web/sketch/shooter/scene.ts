// 三個方向畫同一個場景：下半場第一回合，我方 T 從地窖兩個出口推 B，CT 兩人在視錐內、其餘在迷霧外（資料裡就沒有）。
// 鏡頭比照可玩版：跟隨自己、往滑鼠方向偏一半（鏡頭中心＝自己與準心的中點），比例 27 px／格（縮放 1.2）。
import { visionPolygon, type Pt, type SmokeCircle } from './world.ts';

export interface Cam {
  /** 畫面中心（格） */
  readonly cx: number;
  readonly cy: number;
  /** px／格 */
  readonly ppc: number;
  readonly w: number;
  readonly h: number;
}

export type Side = 'T' | 'CT';

export interface Unit {
  readonly name: string;
  readonly team: Side;
  readonly x: number;
  readonly y: number;
  readonly facing: number;
  /** 槍身長度（格），剪影區分武器 */
  readonly gun: number;
  readonly hp: number;
  readonly self?: boolean;
  readonly bomb?: boolean;
  readonly firing?: boolean;
}

const ME = { x: 28, y: 40 };
const AIM = { x: 32, y: 22 };
const FACING = (Math.atan2(AIM.y - ME.y, AIM.x - ME.x) * 180) / Math.PI;

export const SMOKE: SmokeCircle = { x: 37.5, y: 27, r: 3 };

export const UNITS: readonly Unit[] = [
  { name: '夜鴉', team: 'T', x: 21.5, y: 46.5, facing: -55, gun: 0.95, hp: 100, bomb: true },
  { name: '阿澤', team: 'T', x: 13.5, y: 45.2, facing: -60, gun: 1.25, hp: 76 },
  { name: '小隼', team: 'T', x: 14.5, y: 40.5, facing: -70, gun: 0.95, hp: 100 },
  { name: '白鯨', team: 'T', x: 30, y: 44.5, facing: -82, gun: 0.7, hp: 100 },
  { name: '你', team: 'T', x: ME.x, y: ME.y, facing: FACING, gun: 0.95, hp: 84, self: true, firing: true },
  { name: '霜刃', team: 'CT', x: 20, y: 24.5, facing: 62, gun: 1.25, hp: 100 },
  { name: '鐵壁', team: 'CT', x: AIM.x, y: AIM.y, facing: 100, gun: 0.95, hp: 73, firing: true },
];

export const SCENE = {
  cam: { cx: (ME.x + AIM.x) / 2, cy: (ME.y + AIM.y) / 2, ppc: 27, w: 1920, h: 1080 } as Cam,
  me: { x: ME.x, y: ME.y, facing: FACING },
  aim: AIM,
  smoke: SMOKE,
  /** 剛落地、引信還在跑的手雷 */
  grenade: { x: 24.5, y: 31.2 },
  /** 正在飛的一發：從自己的槍口飛向鐵壁，head 是彈頭位置（0～1） */
  tracer: { x0: ME.x, y0: ME.y, x1: AIM.x, y1: AIM.y, head: 0.72 },
  /** 打中鐵壁的傷害數字 */
  pop: { x: AIM.x, y: AIM.y, amount: 27 },
  vision: visionPolygon(ME.x, ME.y, FACING, 100, 30, [SMOKE]) as readonly Pt[],
} as const;

/** 畫面上標的區域名（挑鏡頭內夠大的區塊；座標＝文字中心） */
export const CALLOUTS: readonly { readonly name: string; readonly x: number; readonly y: number }[] = [
  { name: '地窖西口', x: 12.4, y: 37.2 },
  { name: '地窖東口', x: 24.6, y: 37.2 },
  { name: '地窖大廳', x: 22, y: 50.5 },
  { name: 'B 西門', x: 41, y: 25.4 },
  { name: '北街', x: 56, y: 28 },
  { name: '拱門', x: 57, y: 39 },
  { name: '中央大道', x: 60, y: 47 },
];

/** 世界座標轉畫面 */
export const toScreen = (c: Cam, x: number, y: number): [number, number] => [(x - c.cx) * c.ppc + c.w / 2, (y - c.cy) * c.ppc + c.h / 2];

/** 把 ctx 設成格座標（1 單位＝1 格） */
export function worldTransform(g: CanvasRenderingContext2D, c: Cam): void {
  g.setTransform(c.ppc, 0, 0, c.ppc, c.w / 2 - c.cx * c.ppc, c.h / 2 - c.cy * c.ppc);
}

/** 鏡頭看得到的格子範圍 */
export const camRect = (c: Cam): { x0: number; y0: number; x1: number; y1: number } => ({ x0: Math.floor(c.cx - c.w / 2 / c.ppc) - 1, y0: Math.floor(c.cy - c.h / 2 / c.ppc) - 1, x1: Math.ceil(c.cx + c.w / 2 / c.ppc) + 1, y1: Math.ceil(c.cy + c.h / 2 / c.ppc) + 1 });

export function makeCanvas(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d') as CanvasRenderingContext2D };
}

export const HUD = {
  us: '天使',
  them: '黑潮',
  scoreUs: 7,
  scoreThem: 5,
  aliveUs: 5,
  aliveThem: 4,
  clock: '1:12',
  round: '第 13 回合・下半場',
  hp: 84,
  armor: 100,
  money: 2350,
  ammo: 23,
  reserve: 90,
  weapon: 'AK-47',
  zone: '地窖東口',
  slots: [
    { key: 1, name: 'AK-47', on: true, has: true },
    { key: 2, name: '格洛克', on: false, has: true },
    { key: 3, name: '刀', on: false, has: true },
    { key: 4, name: '閃光彈', on: false, has: true },
    { key: 5, name: '炸彈', on: false, has: false },
  ],
  feed: [{ killer: '小隼', weapon: 'AK-47', victim: '零度' }],
  hint: '夜鴉帶著炸彈・地窖大廳',
} as const;

export interface BoardLine {
  readonly name: string;
  readonly role: string;
  readonly k: number;
  readonly d: number;
  readonly a: number;
  readonly money: number;
  readonly alive: boolean;
  readonly me?: boolean;
}

export const BOARD_US: readonly BoardLine[] = [
  { name: '小隼', role: '突破手', k: 11, d: 7, a: 3, money: 3150, alive: true },
  { name: '你', role: '自由人', k: 9, d: 8, a: 4, money: 2350, alive: true, me: true },
  { name: '阿澤', role: '狙擊手', k: 8, d: 6, a: 1, money: 1200, alive: true },
  { name: '夜鴉', role: '支援', k: 5, d: 8, a: 7, money: 4100, alive: true },
  { name: '白鯨', role: '指揮', k: 4, d: 9, a: 5, money: 1850, alive: true },
];

export const BOARD_THEM: readonly BoardLine[] = [
  { name: '鐵壁', role: '突破手', k: 10, d: 7, a: 2, money: 0, alive: true },
  { name: '霜刃', role: '狙擊手', k: 9, d: 8, a: 1, money: 0, alive: true },
  { name: '渡鴉', role: '自由人', k: 8, d: 8, a: 4, money: 0, alive: true },
  { name: '北辰', role: '指揮', k: 6, d: 8, a: 6, money: 0, alive: true },
  { name: '零度', role: '支援', k: 3, d: 9, a: 3, money: 0, alive: false },
];
