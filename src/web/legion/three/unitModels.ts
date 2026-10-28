// 3D 沙盤士兵的微縮模型造型（v2 第五節）：每種兵 × 姿勢拼出「人物」（中性色）與「隊伍色」（白色，實際顏色由 instanceColor 給）兩組幾何。
// 正面朝 +x、右手在 +z；1 格 ＝ 1 單位，人站在底座頂面（y ＝ BASE）。中景要一眼分出兵種：長槍伸出身體、方盾、弓與箭袋、短劍小圓盾、
// 最瘦的輕步兵拿兩支投槍、騎兵有馬。隊伍色只放底座、盾面、馬衣（含頸甲、鞍墊）與長槍兵的肩甲。
// 每個人物（人物＋隊伍色）壓在 150 個三角形以內：看不到的面（底面、被身體蓋住的頂面）不畫。
import * as THREE from 'three';
import type { UnitKind } from '../../../legion/config.ts';
import { Builder, type V3 } from './builder.ts';
import { PAL, col } from './palette.ts';

export type Pose = 'stand' | 'brace' | 'wall';

/** 省略的面（位元）：-x 1、-y 4、+y 8（+x 2、-z 16、+z 32 這裡沒用到） */
const NX = 1;
const NY = 4;
const PY = 8;

/** 底座頂面高度（人物的腳踩在這裡） */
const BASE = 0.035;

const CLOTH: Record<UnitKind, number> = {
  spear: 0x8a7a5c,
  sword: 0x8f9398,
  shield: 0x7d6b52,
  archer: 0x6f5d40,
  light: 0x8c7a58,
  lightCav: 0x7f7058,
  heavyCav: 0x8f9398,
};

const C = {
  trousers: col(0x5c4b3b),
  leather: col(0x4a3a2a),
  leatherLight: col(0x6b5538),
  metal: col(0xa7adb4),
  metalLight: col(0xc9ced4),
  pole: col(0x6a5134),
  bow: col(0x5e4630),
  string: col(0xd9ccaa),
  fletch: col(0xe8e2d0),
  skin: col(PAL.skin),
  horse: col(0x6b4a2f),
  horseHeavy: col(0x5a4632),
  mane: col(0x3f2b1b),
  hood: col(0x6b5a3e),
} as const;

const WHITE = new THREE.Color(1, 1, 1);
/** 隊伍色的暗鑲邊（底座側面、盾緣、馬衣下緣） */
const RIM = new THREE.Color(0.45, 0.45, 0.45);

/** 拼幾何的小工具：八頂點的六面體、桿子（任意方向）、尖錐、圓盤，都透過 Builder 收成同一份幾何 */
class Kit {
  readonly b = new Builder();

  /**
   * 六面體：八個角 p[i + 2j + 4k]（i、j、k 分別是 x、y、z 的低／高端），面的顏色依序 -x、+x、-y、+y、-z、+z；
   * 正面朝向由面心相對整體中心決定，只適用凸的形狀。
   */
  hexa(p: readonly V3[], colors: readonly THREE.Color[], skip: number): void {
    const cx = p.reduce((s, v) => s + v[0], 0) / 8;
    const cy = p.reduce((s, v) => s + v[1], 0) / 8;
    const cz = p.reduce((s, v) => s + v[2], 0) / 8;
    const faces: [number, number, number, number][] = [
      [0, 4, 6, 2],
      [1, 5, 7, 3],
      [0, 1, 5, 4],
      [2, 3, 7, 6],
      [0, 1, 3, 2],
      [4, 5, 7, 6],
    ];
    faces.forEach((f, i) => {
      if ((skip >> i) & 1) return;
      const q = f.map((k) => p[k]);
      const out: V3 = [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4 - cx, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4 - cy, (q[0][2] + q[1][2] + q[2][2] + q[3][2]) / 4 - cz];
      this.b.quad(q[0], q[1], q[2], q[3], colors[i], out);
    });
  }

  /** 軸對齊方塊 */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: THREE.Color, skip = NY, front?: THREE.Color): void {
    this.taper(y0, y1, [x0, z0, x1, z1], [x0, z0, x1, z1], color, skip, front);
  }

  /** 上下兩個長方形接成的台體（身體、頭盔、馬身）：bot、top 是 [x0, z0, x1, z1]；front 給了就是 +x 那面的顏色 */
  taper(y0: number, y1: number, bot: readonly number[], top: readonly number[], color: THREE.Color, skip = NY, front?: THREE.Color): void {
    const p: V3[] = [];
    for (let k = 0; k < 2; k++)
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) {
          const r = j === 0 ? bot : top;
          p.push([r[i * 2], j === 0 ? y0 : y1, r[1 + k * 2]]);
        }
    const f = front ?? color;
    this.hexa(p, [color, f, color, color, color, color], skip);
  }

  /** 朝上的水平四邊形（底座頂面） */
  plate(x0: number, z0: number, x1: number, z1: number, y: number, color: THREE.Color): void {
    this.b.quad([x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1], color, [0, 1, 0]);
  }

  /** 從 a 到 b 的四方桿：寬 w（水平方向）、厚 h；cap 給了就封住 b 端（顏色可不同） */
  rod(a: V3, b: V3, w: number, h: number, color: THREE.Color, cap?: THREE.Color): void {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    const u = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0));
    if (u.lengthSq() < 1e-6) u.set(0, 0, 1);
    u.normalize();
    const v = new THREE.Vector3().crossVectors(u, d).normalize();
    const corner = (o: V3, su: number, sv: number): V3 => [o[0] + u.x * su * w + v.x * sv * h, o[1] + u.y * su * w + v.y * sv * h, o[2] + u.z * su * w + v.z * sv * h];
    const ring = (o: V3): V3[] => [corner(o, -1, -1), corner(o, 1, -1), corner(o, 1, 1), corner(o, -1, 1)];
    const ra = ring(a);
    const rb = ring(b);
    const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const out: V3 = [(ra[i][0] + ra[j][0]) / 2 - a[0], (ra[i][1] + ra[j][1]) / 2 - a[1], (ra[i][2] + ra[j][2]) / 2 - a[2]];
      this.b.quad(ra[i], ra[j], rb[j], rb[i], color, out);
    }
    if (cap !== undefined) this.b.quad(rb[0], rb[1], rb[2], rb[3], cap, [b[0] - mid[0], b[1] - mid[1], b[2] - mid[2]]);
  }

  /** 尖錐（槍頭、箭頭）：底在 a、尖在 b，四面 */
  spike(a: V3, b: V3, r: number, color: THREE.Color): void {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).normalize();
    const u = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 1, 0));
    if (u.lengthSq() < 1e-6) u.set(0, 0, 1);
    u.normalize();
    const v = new THREE.Vector3().crossVectors(u, d).normalize();
    const ring: V3[] = [];
    for (const [su, sv] of [
      [-1, 0],
      [0, -1],
      [1, 0],
      [0, 1],
    ])
      ring.push([a[0] + (u.x * su + v.x * sv) * r, a[1] + (u.y * su + v.y * sv) * r, a[2] + (u.z * su + v.z * sv) * r]);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const out: V3 = [(ring[i][0] + ring[j][0]) / 2 - a[0], (ring[i][1] + ring[j][1]) / 2 - a[1], (ring[i][2] + ring[j][2]) / 2 - a[2]];
      this.b.tri(ring[i], ring[j], b, color, out);
    }
  }

  /** 朝 +x 的圓盤（小圓盾）：圓心 c、半徑 r、厚 t；正面 face、側面與背面 rim */
  disc(c: V3, r: number, t: number, n: number, face: THREE.Color, rim: THREE.Color): void {
    const p = (a: number, x: number): V3 => [x, c[1] + Math.sin(a) * r, c[2] + Math.cos(a) * r];
    const x0 = c[0] - t / 2;
    const x1 = c[0] + t / 2;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const m = (a0 + a1) / 2;
      this.b.quad(p(a0, x0), p(a1, x0), p(a1, x1), p(a0, x1), rim, [0, Math.sin(m), Math.cos(m)]);
      this.b.tri(p(a0, x1), p(a1, x1), [x1, c[1], c[2]], face, [1, 0, 0]);
      this.b.tri(p(a0, x0), p(a1, x0), [x0, c[1], c[2]], rim, [-1, 0, 0]);
    }
  }

  /** 水平圓底（弓兵、輕步兵）：側面鑲邊、頂面主色 */
  roundBase(r: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const m = (a0 + a1) / 2;
      const p = (a: number, y: number): V3 => [Math.cos(a) * r, y, Math.sin(a) * r];
      this.b.quad(p(a0, 0), p(a1, 0), p(a1, BASE), p(a0, BASE), RIM, [Math.cos(m), 0, Math.sin(m)]);
      this.b.tri(p(a0, BASE), p(a1, BASE), [0, BASE, 0], WHITE, [0, 1, 0]);
    }
  }

  geometry(): THREE.BufferGeometry {
    return this.b.geometry();
  }
}

/** 步兵身形參數 */
interface Body {
  cloth: THREE.Color;
  /** 肩寬一半、胸厚一半 */
  sw: number;
  sd: number;
  /** 整個人往下蹲多少（盾牆） */
  crouch: number;
  /** 上身往前傾多少（架槍、盾牆） */
  lean: number;
  /** 前後跨步（左腳往前、右腳往後） */
  stride: number;
}

const SHOULDER = 0.45;
const NECK = 0.47;
const HEAD_TOP = 0.565;

/** 肩膀位置（arm 用）：side ＝ -1 左、1 右 */
function shoulder(b: Body, side: number): V3 {
  return [b.lean, SHOULDER - b.crouch - 0.02, side * (b.sw - 0.015)];
}

/** 步兵的腿、下擺、上身、頭（頭盔與手臂另外畫） */
function torso(k: Kit, b: Body): void {
  const hip = 0.25 - b.crouch;
  // 腿：上端在胯下，下端可以前後錯開
  for (const side of [-1, 1]) {
    const z0 = side < 0 ? -0.072 : 0.014;
    const z1 = side < 0 ? -0.014 : 0.072;
    const off = side < 0 ? b.stride : -b.stride;
    k.taper(BASE, hip, [off - 0.034, z0, off + 0.034, z1], [-0.03, z0, 0.03, z1], C.trousers, NY | PY);
  }
  // 下擺（往下張開）與上身（往上變寬）：中間的腰比較細
  const waist = 0.33 - b.crouch;
  const lx = b.lean * 0.4;
  k.taper(0.2 - b.crouch, waist, [-0.064, -b.sd - 0.012, 0.064, b.sd + 0.012], [lx - 0.05, -b.sd + 0.008, lx + 0.05, b.sd - 0.008], b.cloth, NY | PY);
  k.taper(waist, SHOULDER - b.crouch, [lx - 0.05, -b.sd + 0.008, lx + 0.05, b.sd - 0.008], [b.lean - 0.06, -b.sw, b.lean + 0.06, b.sw], b.cloth, NY);
  const hx = b.lean * 1.1;
  k.box(hx - 0.043, NECK - b.crouch, -0.042, hx + 0.043, HEAD_TOP - b.crouch, 0.042, C.skin, NY | PY);
}

/** 手臂：肩到手，手是皮膚色的端面 */
function arm(k: Kit, b: Body, side: number, hand: V3): void {
  k.rod(shoulder(b, side), hand, 0.022, 0.022, b.cloth, C.skin);
}

type Helm = 'iron' | 'crest' | 'kettle' | 'cap' | 'hood' | 'cone' | 'great';

/** 頭盔／帽子：頭頂中心在 (hx, top) */
function helm(k: Kit, kind: Helm, hx: number, top: number): void {
  const y = top - 0.04;
  switch (kind) {
    case 'iron':
      // 圓頂鐵盔
      k.taper(y, top + 0.035, [hx - 0.052, -0.052, hx + 0.052, 0.052], [hx - 0.03, -0.03, hx + 0.03, 0.03], C.metal);
      break;
    case 'crest':
      // 鐵盔加一道前後向的盔脊（劍士）
      k.taper(y, top + 0.03, [hx - 0.052, -0.05, hx + 0.052, 0.05], [hx - 0.035, -0.03, hx + 0.035, 0.03], C.metal);
      k.box(hx - 0.05, top + 0.02, -0.011, hx + 0.04, top + 0.075, 0.011, C.metalLight);
      break;
    case 'kettle':
      // 寬簷鐵盔（盾兵）
      k.box(hx - 0.075, y + 0.005, -0.075, hx + 0.075, y + 0.02, 0.075, C.metal, 0);
      k.taper(y + 0.02, top + 0.035, [hx - 0.048, -0.048, hx + 0.048, 0.048], [hx - 0.034, -0.034, hx + 0.034, 0.034], C.metalLight);
      break;
    case 'cap':
      // 低圓皮帽（弓兵）
      k.taper(y + 0.01, top + 0.022, [hx - 0.05, -0.05, hx + 0.05, 0.05], [hx - 0.036, -0.036, hx + 0.036, 0.036], C.leatherLight);
      break;
    case 'hood': {
      // 兜帽（輕步兵）：蓋住頭頂與後腦，尖角垂在背後
      k.taper(y - 0.035, top + 0.03, [hx - 0.054, -0.054, hx + 0.03, 0.054], [hx - 0.04, -0.034, hx + 0.02, 0.034], C.hood);
      k.spike([hx - 0.045, top, 0], [hx - 0.12, top - 0.08, 0], 0.03, C.hood);
      break;
    }
    case 'cone':
      // 尖頂布帽（輕騎）
      k.spike([hx, y + 0.01, 0], [hx - 0.01, top + 0.08, 0], 0.062, C.leatherLight);
      break;
    case 'great':
      // 高頂鐵盔加盔纓（重騎）
      k.taper(y - 0.01, top + 0.05, [hx - 0.052, -0.052, hx + 0.052, 0.052], [hx - 0.04, -0.04, hx + 0.04, 0.04], C.metal);
      k.spike([hx - 0.01, top + 0.05, 0], [hx - 0.06, top + 0.14, 0], 0.024, C.mane);
      break;
  }
}

/** 步兵（不含隊伍色） */
function infantry(kind: UnitKind, pose: Pose): THREE.BufferGeometry {
  const k = new Kit();
  const cloth = col(CLOTH[kind]);
  const body: Body = { cloth, sw: 0.11, sd: 0.08, crouch: 0, lean: 0, stride: 0 };
  if (kind === 'light') {
    body.sw = 0.092;
    body.sd = 0.066;
  } else if (kind === 'archer') body.sw = 0.102;
  if (kind === 'spear' && pose === 'brace') {
    body.lean = 0.04;
    body.stride = 0.07;
  }
  if (kind === 'shield' && pose === 'wall') {
    body.crouch = 0.05;
    body.lean = 0.035;
    body.stride = 0.06;
  }
  if (kind === 'sword') body.stride = 0.04;
  torso(k, body);
  const hx = body.lean * 1.1;
  const top = HEAD_TOP - body.crouch;
  const S = SHOULDER - body.crouch;
  switch (kind) {
    case 'spear':
      helm(k, 'iron', hx, top);
      if (pose === 'brace') {
        // 架槍：雙手握在腰間，槍放平、略朝上，伸出陣前約 1.4 格
        const a: V3 = [-0.36, 0.33, 0.07];
        const tip: V3 = [1.4, 0.43, 0.05];
        arm(k, body, 1, [0.02, 0.35, 0.07]);
        arm(k, body, -1, [0.2, 0.36, 0.06]);
        k.rod(a, tip, 0.013, 0.013, C.pole);
        k.spike(tip, [1.54, 0.44, 0.05], 0.024, C.metalLight);
      } else {
        // 行軍：槍豎在右手邊，總長 1.8
        arm(k, body, 1, [0.06, 0.3, 0.15]);
        arm(k, body, -1, [0.01, 0.24, -0.12]);
        k.rod([0.065, BASE + 0.01, 0.155], [0.065, 1.7, 0.155], 0.013, 0.013, C.pole);
        k.spike([0.065, 1.7, 0.155], [0.065, 1.84, 0.155], 0.024, C.metalLight);
      }
      break;
    case 'sword':
      helm(k, 'crest', hx, top);
      // 右手短劍斜舉向前，左手小圓盾（盾在隊伍色那一層）
      arm(k, body, 1, [0.13, 0.36, 0.15]);
      arm(k, body, -1, [0.11, 0.32, -0.08]);
      k.box(0.11, 0.335, 0.115, 0.15, 0.36, 0.185, C.leather, 0);
      k.rod([0.135, 0.36, 0.15], [0.24, 0.6, 0.15], 0.018, 0.006, C.metalLight, C.metalLight);
      break;
    case 'shield':
      helm(k, 'kettle', hx, top);
      if (pose === 'wall') {
        // 盾牆：蹲低，雙手頂在盾後
        arm(k, body, 1, [0.15, S - 0.08, 0.09]);
        arm(k, body, -1, [0.15, S - 0.06, -0.08]);
        k.box(0.215, 0.3, -0.045, 0.235, 0.39, 0.045, C.metal, NY | NX);
      } else {
        // 持盾：左手大方盾立在身前左側，右手垂下
        arm(k, body, -1, [0.12, 0.3, -0.06]);
        arm(k, body, 1, [0.02, 0.24, 0.13]);
        k.box(0.175, 0.27, -0.065, 0.195, 0.35, 0.015, C.metal, NY | NX);
      }
      break;
    case 'archer': {
      helm(k, 'cap', hx, top);
      // 左手前伸握弓（弓在 x-y 平面，弓背朝前），右手搭在弦上；背上斜背箭袋
      arm(k, body, -1, [0.15, 0.39, -0.115]);
      arm(k, body, 1, [0.08, 0.38, 0.02]);
      const z = -0.12;
      const pts: V3[] = [
        [0.11, 0.12, z],
        [0.17, 0.27, z],
        [0.17, 0.51, z],
        [0.11, 0.66, z],
      ];
      for (let i = 0; i < 3; i++) k.rod(pts[i], pts[i + 1], 0.012, i === 1 ? 0.016 : 0.011, C.bow);
      k.rod(pts[0], pts[3], 0.004, 0.004, C.string);
      k.rod([-0.085, 0.2, 0.07], [-0.12, 0.5, 0.025], 0.032, 0.03, C.leather, C.leather);
      k.rod([-0.12, 0.5, 0.025], [-0.13, 0.57, 0.02], 0.026, 0.024, C.fletch, C.fletch);
      break;
    }
    case 'light':
      helm(k, 'hood', hx, top);
      // 最瘦、沒穿甲；右手握兩支投槍，往前斜舉（和弓兵的弓、長槍的直桿分得開）
      arm(k, body, 1, [0.07, 0.32, 0.135]);
      arm(k, body, -1, [0.04, 0.26, -0.1]);
      for (const [dz, dx] of [
        [0, 0],
        [0.035, -0.06],
      ]) {
        const a: V3 = [-0.16 + dx, 0.13, 0.14 + dz];
        const t: V3 = [0.3 + dx, 0.8, 0.14 + dz * 2];
        k.rod(a, t, 0.009, 0.009, C.pole);
        k.spike(t, [t[0] + 0.046, t[1] + 0.067, t[2]], 0.017, C.metalLight);
      }
      break;
    default:
      break;
  }
  return k.geometry();
}

/** 馬：身、頸、頭、鬃、尾、四腿（腿前後跨開，看起來在跑）；重騎的身與頸被馬衣、頸甲蓋住，不畫 */
function horse(k: Kit, heavy: boolean): void {
  const hc = heavy ? C.horseHeavy : C.horse;
  // 身體：背比肚子寬一點的台體，前後兩端收窄
  if (!heavy) k.taper(0.29, 0.48, [-0.26, -0.068, 0.22, 0.068], [-0.29, -0.088, 0.24, 0.088], hc);
  for (const [hx, fx, z] of [
    [0.16, 0.24, -0.048],
    [0.16, 0.1, 0.048],
    [-0.2, -0.13, -0.048],
    [-0.2, -0.27, 0.048],
  ])
    k.rod([hx, 0.33, z], [fx, BASE, z], 0.022, 0.024, hc);
  // 頸與頭（重騎的頭戴面甲）
  if (!heavy) {
    k.rod([0.17, 0.4, 0], [0.29, 0.62, 0], 0.042, 0.05, hc);
    k.rod([0.15, 0.47, 0], [0.26, 0.67, 0], 0.016, 0.02, C.mane);
  }
  k.rod([0.27, 0.64, 0], [0.42, 0.53, 0], 0.036, 0.042, heavy ? C.metal : hc, heavy ? C.metal : C.mane);
  k.rod([-0.29, 0.46, 0], [-0.37, 0.24, 0], 0.018, 0.024, C.mane);
}

/** 騎兵（不含隊伍色）：馬＋騎手＋騎槍 */
function cavalry(kind: UnitKind): THREE.BufferGeometry {
  const k = new Kit();
  const heavy = kind === 'heavyCav';
  horse(k, heavy);
  const cloth = col(CLOTH[kind]);
  // 騎手：跨在馬背上（一塊橫跨的腿）、上身、頭
  const seat = 0.49;
  k.box(-0.08, seat - 0.15, -0.115, 0.06, seat + 0.02, 0.115, C.trousers, NY | PY);
  k.taper(seat, seat + 0.2, [-0.075, -0.075, 0.035, 0.075], [-0.05, -0.105, 0.07, 0.105], cloth, NY);
  const top = seat + 0.31;
  k.box(-0.035, seat + 0.21, -0.042, 0.05, top, 0.042, C.skin, NY | PY);
  helm(k, heavy ? 'great' : 'cone', 0.008, top);
  // 右手夾騎槍（握韁的左手被身體擋住，不畫）
  const len = heavy ? 1.3 : 0.95;
  const a: V3 = [-0.24, seat + 0.13, 0.13];
  const t: V3 = [-0.24 + len, seat + (heavy ? 0.17 : 0.29), 0.13];
  k.rod([0.0, seat + 0.18, 0.1], [0.05, seat + 0.12, 0.13], 0.022, 0.022, cloth, C.skin);
  k.rod(a, t, heavy ? 0.016 : 0.013, heavy ? 0.016 : 0.013, C.pole);
  k.spike(t, [t[0] + 0.12, t[1] + (t[1] - a[1]) * (0.12 / len), t[2]], heavy ? 0.026 : 0.022, C.metalLight);
  const g = k.geometry();
  if (heavy) g.scale(1.1, 1.04, 1.1);
  return g;
}

/** 人物（不含隊伍色的部分） */
export function figureGeometry(kind: UnitKind, pose: Pose): THREE.BufferGeometry {
  return kind === 'lightCav' || kind === 'heavyCav' ? cavalry(kind) : infantry(kind, pose);
}

/** 隊伍色的部分（白色，實際顏色由 instanceColor 給；RIM 是暗鑲邊） */
export function teamGeometry(kind: UnitKind, pose: Pose): THREE.BufferGeometry {
  const k = new Kit();
  switch (kind) {
    case 'lightCav':
    case 'heavyCav': {
      const heavy = kind === 'heavyCav';
      k.box(-0.39, 0, -0.22, 0.39, BASE, 0.22, RIM, NY | PY);
      k.plate(-0.39, -0.22, 0.39, 0.22, BASE, WHITE);
      if (heavy) {
        // 圓角馬衣：蓋住馬身兩側到腿上半，下緣暗邊；頸甲
        k.taper(0.21, 0.5, [-0.3, -0.105, 0.25, 0.105], [-0.27, -0.094, 0.22, 0.094], WHITE);
        k.box(-0.305, 0.2, -0.108, 0.255, 0.235, 0.108, RIM, NY | PY);
        k.rod([0.17, 0.42, 0], [0.27, 0.6, 0], 0.05, 0.058, WHITE);
      } else {
        // 馬鞍墊
        k.taper(0.42, 0.5, [-0.13, -0.106, 0.07, 0.106], [-0.12, -0.098, 0.06, 0.098], WHITE);
      }
      const g = k.geometry();
      if (heavy) g.scale(1.1, 1.04, 1.1);
      return g;
    }
    case 'archer':
      k.roundBase(0.2, 8);
      break;
    case 'light':
      k.roundBase(0.17, 8);
      break;
    default:
      // 方底：側面暗、頂面主色
      k.box(-0.2, 0, -0.2, 0.2, BASE, 0.2, RIM, NY | PY);
      k.plate(-0.2, -0.2, 0.2, 0.2, BASE, WHITE);
      break;
  }
  switch (kind) {
    case 'spear': {
      // 肩甲（從上面看得到的兩塊）
      const lx = pose === 'brace' ? 0.04 : 0;
      for (const side of [-1, 1]) {
        const z0 = side < 0 ? -0.135 : 0.07;
        const z1 = side < 0 ? -0.07 : 0.135;
        k.taper(SHOULDER - 0.045, SHOULDER + 0.018, [lx - 0.068, z0, lx + 0.068, z1], [lx - 0.05, z0 + 0.012, lx + 0.05, z1 - 0.012], WHITE, NY);
      }
      break;
    }
    case 'sword':
      k.disc([0.135, 0.33, -0.12], 0.105, 0.022, 8, WHITE, RIM);
      break;
    case 'shield':
      if (pose === 'wall') {
        // 盾牆：加寬加高、略往後仰，左右幾乎相接
        k.taper(0.04, 0.7, [0.18, -0.34, 0.215, 0.34], [0.155, -0.33, 0.19, 0.33], RIM, NY, WHITE);
      } else {
        k.taper(0.08, 0.6, [0.155, -0.2, 0.185, 0.1], [0.145, -0.2, 0.175, 0.1], RIM, NY, WHITE);
      }
      break;
    default:
      break;
  }
  return k.geometry();
}

/** 一組幾何的三角形數 */
export function triangles(g: THREE.BufferGeometry): number {
  return g.getAttribute('position').count / 3;
}

