// 俯視模型兵：底座＋肩膀＋手臂與槍＋頭。隊色在底座環與肩膀；明暗永遠跟著世界的西北光，不跟著身體轉。
// 畫在格座標（1 單位＝1 格），原點是單位中心；模型比碰撞大（底座半徑 0.68 格），命中判定不變。
import type { WeaponId } from '../../shooter/api.ts';
import { PAL, rng } from './materials.ts';

/** 世界裡的隊色：我方金、對手藍；別隊的比賽（我方不在場）主隊用白，金只給我方 */
export type Side = 'us' | 'them' | 'home';
export type Pose = 'stand' | 'crouch' | 'work';

/** 模型放大倍率：碰撞半徑 0.3 格在畫面上才 8 px，放大到肩寬約 1 格才讀得出姿態 */
const BODY = 1.36;
const SUN = { x: 0.62, y: 0.78 };

interface Tone {
  readonly main: string;
  readonly dark: string;
  readonly light: string;
  readonly cloth: string;
  readonly shade: string;
  readonly helmet: string;
  readonly helmetDark: string;
}

const TONE: Readonly<Record<Side, Tone>> = {
  us: { main: PAL.gold, dark: PAL.goldDark, light: PAL.goldLight, cloth: '#6d4c22', shade: '#c98f33', helmet: '#fff3d9', helmetDark: '#d3b98c' },
  them: { main: PAL.blue, dark: PAL.blueDark, light: PAL.blueLight, cloth: '#0f3050', shade: '#2271b8', helmet: '#e3f1fb', helmetDark: '#9fc0d8' },
  home: { main: '#eef2f6', dark: '#7b8494', light: '#ffffff', cloth: '#3a4252', shade: '#c2c9d3', helmet: '#ffffff', helmetDark: '#c2c9d3' },
};

export const sideColor = (s: Side): string => TONE[s].main;

/** 武器模型（身體座標：+x 朝前，1 單位＝BODY 格）；grip 是兩隻手的位置，tip 是槍口 */
interface GunModel {
  readonly dark: Path2D;
  readonly mid: Path2D | null;
  readonly light: Path2D | null;
  readonly wood: Path2D | null;
  readonly grip: readonly [readonly [number, number], readonly [number, number]];
  readonly tip: number;
}

function box(p: Path2D, x0: number, x1: number, y: number, h: number): void {
  p.rect(x0, y - h / 2, x1 - x0, h);
}

function buildGun(id: WeaponId): GunModel {
  const dark = new Path2D();
  const mid = new Path2D();
  const light = new Path2D();
  const wood = new Path2D();
  const y = 0.06;
  switch (id) {
    case 'pistol':
      box(dark, 0.3, 0.68, y, 0.11);
      box(light, 0.34, 0.6, y - 0.012, 0.03);
      return { dark, mid: null, light, wood: null, grip: [[0.31, y + 0.05], [0.31, y - 0.05]], tip: 0.68 };
    case 'deagle':
      box(dark, 0.3, 0.8, y, 0.15);
      box(dark, 0.8, 0.86, y, 0.18);
      box(light, 0.34, 0.78, y - 0.02, 0.05);
      return { dark, mid: null, light, wood: null, grip: [[0.31, y + 0.07], [0.31, y - 0.07]], tip: 0.86 };
    case 'smg':
      box(dark, 0.08, 0.6, y, 0.18);
      box(dark, 0.6, 0.84, y, 0.085);
      box(mid, 0.34, 0.46, y + 0.13, 0.13);
      box(light, 0.14, 0.54, y - 0.03, 0.03);
      return { dark, mid, light, wood: null, grip: [[0.2, y + 0.05], [0.5, y - 0.03]], tip: 0.84 };
    case 'shotgun':
      box(dark, 0.08, 1.14, y, 0.1);
      box(dark, 0.08, 0.4, y, 0.16);
      box(mid, 0.6, 0.84, y, 0.16);
      box(wood, -0.1, 0.1, y, 0.12);
      box(light, 0.12, 1.1, y - 0.025, 0.022);
      return { dark, mid, light, wood, grip: [[0.2, y + 0.05], [0.68, y]], tip: 1.14 };
    case 'ak':
      box(dark, 0.08, 0.56, y, 0.17);
      box(dark, 0.56, 1.2, y, 0.08);
      box(wood, 0.5, 0.8, y, 0.15);
      box(wood, -0.12, 0.08, y, 0.11);
      box(mid, 0.36, 0.47, y + 0.11, 0.11);
      box(mid, 0.47, 0.53, y + 0.17, 0.08);
      box(light, 0.12, 0.5, y - 0.03, 0.03);
      return { dark, mid, light, wood, grip: [[0.2, y + 0.05], [0.62, y - 0.02]], tip: 1.2 };
    case 'm4':
      box(dark, 0.08, 0.6, y, 0.17);
      box(mid, 0.5, 0.88, y, 0.15);
      box(dark, 0.88, 1.08, y, 0.075);
      box(dark, 1.08, 1.15, y, 0.115);
      box(dark, -0.14, 0.08, y, 0.09);
      box(mid, 0.34, 0.45, y + 0.12, 0.12);
      box(light, 0.12, 0.86, y - 0.05, 0.03);
      return { dark, mid, light, wood: null, grip: [[0.2, y + 0.05], [0.64, y - 0.02]], tip: 1.15 };
    case 'awp':
      box(dark, -0.16, 0.5, y, 0.17);
      box(dark, 0.5, 1.62, y, 0.075);
      box(dark, 1.62, 1.72, y, 0.125);
      box(mid, 0.22, 0.72, y - 0.09, 0.09);
      box(mid, 0.14, 0.22, y - 0.09, 0.125);
      box(mid, 0.72, 0.82, y - 0.09, 0.15);
      box(light, 0.24, 0.7, y - 0.105, 0.025);
      return { dark, mid, light, wood: null, grip: [[0.14, y + 0.05], [0.58, y]], tip: 1.72 };
    case 'knife': {
      dark.rect(0.3, 0.14, 0.13, 0.055);
      light.moveTo(0.43, 0.105);
      light.lineTo(0.8, 0.155);
      light.lineTo(0.43, 0.215);
      light.closePath();
      return { dark, mid: null, light, wood: null, grip: [[0.34, 0.165], [0.08, -0.26]], tip: 0.8 };
    }
  }
}

let guns: Map<WeaponId, GunModel> | null = null;
function gunOf(id: WeaponId): GunModel {
  guns ??= new Map();
  let g = guns.get(id);
  if (g === undefined) {
    g = buildGun(id);
    guns.set(id, g);
  }
  return g;
}

/** 槍口離單位中心的距離（格） */
export const muzzleReach = (w: WeaponId): number => gunOf(w).tip * BODY;

function paintGun(g: CanvasRenderingContext2D, m: GunModel): void {
  // 亮邊：深色槍身壓在深色地板上也看得到剪影
  g.strokeStyle = 'rgba(255, 246, 228, 0.55)';
  g.lineWidth = 0.05;
  g.lineJoin = 'round';
  g.stroke(m.dark);
  g.fillStyle = '#25222a';
  g.fill(m.dark);
  if (m.wood !== null) {
    g.fillStyle = '#7a5233';
    g.fill(m.wood);
  }
  if (m.mid !== null) {
    g.fillStyle = '#46424e';
    g.fill(m.mid);
  }
  if (m.light !== null) {
    g.fillStyle = m === guns?.get('knife') ? '#d9dde3' : '#6d6875';
    g.fill(m.light);
  }
}

/** 地上的槍：跟手上同一個剪影，縮小躺著 */
export function paintDroppedGun(g: CanvasRenderingContext2D, id: WeaponId, deg: number): void {
  g.save();
  g.rotate((deg * Math.PI) / 180);
  g.scale(1.1, 1.1);
  const m = gunOf(id);
  g.fillStyle = 'rgba(255, 250, 240, 0.42)';
  g.beginPath();
  g.ellipse(0, 0, m.tip * 0.62, 0.3, 0, 0, Math.PI * 2);
  g.fill();
  g.translate(-m.tip / 2, -0.06);
  g.fillStyle = 'rgba(58, 38, 62, 0.4)';
  g.save();
  g.translate(0.05, 0.07);
  g.fill(m.dark);
  g.restore();
  paintGun(g, m);
  g.restore();
}

let shadowSprite: HTMLCanvasElement | null = null;
/** 接觸陰影：只算一次，之後每幀貼圖 */
function contactShadow(): HTMLCanvasElement {
  if (shadowSprite !== null) return shadowSprite;
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 96;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const r = g.createRadialGradient(48, 48, 6, 48, 48, 48);
  r.addColorStop(0, 'rgba(58, 38, 62, 0.6)');
  r.addColorStop(0.65, 'rgba(58, 38, 62, 0.34)');
  r.addColorStop(1, 'rgba(58, 38, 62, 0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 96, 96);
  shadowSprite = c;
  return c;
}

export interface SoldierArgs {
  readonly facing: number;
  readonly side: Side;
  readonly weapon: WeaponId;
  readonly pose: Pose;
  readonly bomb: boolean;
  /** 剛開火：往後座 0～1 */
  readonly recoil?: number;
  /** 走路相位（弧度）；null＝站著不動 */
  readonly walk?: number | null;
}

function disc(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fill();
}

/** 底座：比身體大一圈的深色圓盤，隊色環，側面一圈暗色當厚度 */
function paintBase(g: CanvasRenderingContext2D, t: Tone, k: number): void {
  const sr = 0.98 * k;
  g.drawImage(contactShadow(), 0.18 - sr, 0.24 - sr, sr * 2, sr * 2);
  g.fillStyle = t.cloth;
  disc(g, 0, 0.08, 0.68 * k);
  g.fillStyle = t.dark;
  disc(g, 0, 0, 0.68 * k);
  g.strokeStyle = t.main;
  g.lineWidth = 0.09;
  g.beginPath();
  g.arc(0, 0, 0.64 * k, 0, Math.PI * 2);
  g.stroke();
}

/** 模型兵（原點＝單位中心）；lod 為真時只畫底座與肩，遠看讀得出朝向就好 */
export function paintSoldier(g: CanvasRenderingContext2D, u: SoldierArgs, lod: boolean): void {
  const t = TONE[u.side];
  const a = (u.facing * Math.PI) / 180;
  const crouch = u.pose === 'crouch';
  const work = u.pose === 'work';
  const k = crouch || work ? 0.88 : 1;
  paintBase(g, t, k);
  g.save();
  g.rotate(a);
  g.scale(BODY * k, BODY * k);
  if (lod) {
    g.fillStyle = t.main;
    g.beginPath();
    g.roundRect(-0.17, -0.41, 0.34, 0.82, 0.16);
    g.fill();
    g.fillStyle = t.helmet;
    disc(g, 0.08, 0, 0.17);
    g.restore();
    return;
  }
  // 世界光轉到身體座標
  const lx = -SUN.x * Math.cos(-a) + SUN.y * Math.sin(-a);
  const ly = -SUN.x * Math.sin(-a) - SUN.y * Math.cos(-a);
  const shade = (path: Path2D, color: string): void => {
    // 背光的一半壓暗：用一條跟世界光垂直的直線切開
    g.save();
    g.clip(path);
    g.fillStyle = color;
    g.beginPath();
    g.rect(-1.5, -1.5, 3, 3);
    g.rect(-1.5 + lx * 1.55, -1.5 + ly * 1.55, 3, 3);
    g.fill('evenodd');
    g.restore();
  };
  // 走路：肩膀跟著步伐前後擺；蹲與下包不擺
  const sway = u.walk !== undefined && u.walk !== null && !crouch && !work ? Math.sin(u.walk) * 0.1 : 0;
  // 背包；炸彈揹在背上
  const pack = new Path2D();
  pack.roundRect(-0.36, -0.2, 0.26, 0.4, 0.07);
  g.fillStyle = u.bomb ? PAL.warn : t.cloth;
  g.fill(pack);
  if (u.bomb) {
    g.fillStyle = '#ffd98a';
    g.fillRect(-0.3, -0.03, 0.12, 0.06);
  }
  if (crouch) {
    // 蹲：膝蓋頂在身前，身體壓低
    g.fillStyle = t.dark;
    g.beginPath();
    g.ellipse(0.3, -0.24, 0.17, 0.1, 0.2, 0, Math.PI * 2);
    g.ellipse(-0.02, 0.32, 0.15, 0.1, -0.5, 0, Math.PI * 2);
    g.fill();
  }
  if (work) {
    // 下包、拆包：槍甩到背後，雙手往前按著地上的東西
    const m = gunOf(u.weapon === 'knife' ? 'pistol' : u.weapon);
    g.save();
    g.translate(-0.26, 0.04);
    g.rotate(2.35);
    g.scale(0.72, 0.72);
    g.translate(-0.4, -0.05);
    paintGun(g, m);
    g.restore();
    g.fillStyle = '#25222a';
    g.fillRect(0.46, -0.13, 0.3, 0.26);
    g.fillStyle = PAL.warn;
    g.fillRect(0.5, -0.04, 0.12, 0.08);
    g.lineCap = 'round';
    g.strokeStyle = t.shade;
    g.lineWidth = 0.15;
    g.beginPath();
    g.moveTo(0, -0.33);
    g.lineTo(0.46, -0.13);
    g.moveTo(0, 0.33);
    g.lineTo(0.46, 0.13);
    g.stroke();
    g.fillStyle = t.helmetDark;
    disc(g, 0.48, -0.13, 0.085);
    disc(g, 0.48, 0.13, 0.085);
  } else {
    const m = gunOf(u.weapon);
    const back = (u.recoil ?? 0) * 0.09;
    g.save();
    g.translate(-back, 0);
    paintGun(g, m);
    g.restore();
    // 手臂與手
    const [h0, h1] = m.grip;
    g.lineCap = 'round';
    g.strokeStyle = t.shade;
    g.lineWidth = 0.15;
    g.beginPath();
    g.moveTo(sway, 0.33);
    g.lineTo(h0[0] - back, h0[1]);
    g.moveTo(-sway, -0.33);
    g.lineTo(h1[0] - back, h1[1]);
    g.stroke();
    g.fillStyle = t.helmetDark;
    disc(g, h0[0] - back, h0[1], 0.085);
    disc(g, h1[0] - back, h1[1], 0.085);
  }
  // 肩膀兩階明暗
  g.save();
  if (sway !== 0) g.transform(1, sway * 0.5, 0, 1, 0, 0);
  const body = new Path2D();
  body.roundRect(-0.17, -0.41, 0.34, 0.82, 0.16);
  g.fillStyle = t.main;
  g.fill(body);
  shade(body, t.shade);
  g.strokeStyle = t.light;
  g.lineWidth = 0.035;
  g.stroke(body);
  g.restore();
  // 頭：淺色頭盔，和深色身體分開，朝向一眼看得出
  const hx = crouch ? 0.11 : work ? 0.16 : 0.05;
  const head = new Path2D();
  head.ellipse(hx, 0, 0.215, 0.195, 0, 0, Math.PI * 2);
  g.fillStyle = t.helmet;
  g.fill(head);
  shade(head, t.helmetDark);
  g.fillStyle = 'rgba(255, 255, 255, 0.8)';
  disc(g, hx + lx * 0.1, ly * 0.1, 0.05);
  g.restore();
}

/** 屍體：躺平的模型兵，去掉底座環改成褪色的隊色；姿勢由 id 固定雜湊，不會每幀亂動 */
export function paintCorpse(g: CanvasRenderingContext2D, side: Side, seed: number, lod: boolean): void {
  const t = TONE[side];
  const rand = rng(seed * 2971 + 13);
  const a = rand() * Math.PI * 2;
  const flip = rand() < 0.5 ? -1 : 1;
  g.save();
  g.rotate(a);
  g.scale(BODY, BODY * flip);
  g.fillStyle = 'rgba(58, 38, 62, 0.32)';
  g.beginPath();
  g.ellipse(0.06, 0.09, 0.66, 0.42, 0, 0, Math.PI * 2);
  g.fill();
  g.globalAlpha = 0.88;
  if (!lod) {
    g.strokeStyle = t.dark;
    g.lineCap = 'round';
    g.lineWidth = 0.15;
    g.beginPath();
    g.moveTo(-0.08, -0.28);
    g.lineTo(0.3, -0.5);
    g.moveTo(0.1, 0.26);
    g.lineTo(0.5, 0.32);
    g.moveTo(-0.34, -0.12);
    g.lineTo(-0.72, -0.2);
    g.moveTo(-0.34, 0.12);
    g.lineTo(-0.66, 0.28);
    g.stroke();
  }
  const body = new Path2D();
  body.roundRect(-0.4, -0.27, 0.72, 0.54, 0.16);
  g.fillStyle = t.dark;
  g.fill(body);
  g.fillStyle = t.cloth;
  g.fillRect(-0.3, -0.05, 0.5, 0.1);
  g.fillStyle = t.helmetDark;
  disc(g, 0.44, 0.04, 0.17);
  g.restore();
}
