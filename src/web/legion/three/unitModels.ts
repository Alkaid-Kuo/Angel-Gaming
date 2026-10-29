// 3D 沙盤士兵的微縮模型造型（v2 第五節）：每種兵 × 姿勢拼出「人物」（中性色）與「隊伍色」（白色，實際顏色由 instanceColor 給）兩組幾何。
// 正面朝 +x、右手在 +z；1 格 ＝ 1 單位，腳踩在 y ＝ 0。中景要一眼分出兵種：長槍伸出身體、弧面大盾、弓與箭袋、劍與圓盾、
// 最瘦的輕步兵拿手斧、騎兵有馬。不放底座：隊伍色是上衣（上身與下擺），另外每種兵最多一個固定部位（盾面、馬衣與頸甲、鞍墊）。
// 每個人物（人物＋隊伍色）壓在 150 個三角形以內：看不到的面（底面、被身體蓋住的頂面）不畫。
import * as THREE from 'three';
import type { UnitKind } from '../../../legion/config.ts';
import { Builder, type V3 } from './builder.ts';
import { PAL, col } from './palette.ts';

export type Pose = 'stand' | 'brace' | 'wall';

/** 省略的面（位元）：-x 1、-y 4、+y 8、-z 16、+z 32（+x 2 這裡沒用到） */
const NX = 1;
const NY = 4;
const PY = 8;
const NZ = 16;
const PZ = 32;

/** 袖子與騎手手臂的布色（上衣是隊伍色） */
const CLOTH: Record<UnitKind, number> = {
  spear: 0x8a7a5c,
  sword: 0x7a6448,
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
/** 隊伍色的暗鑲邊（盾緣與盾背、馬衣下緣） */
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

  /** 尖錐（槍頭、劍尖）：底在 a、尖在 b，四面；r 是水平方向的半寬，r2 是另一方向的半厚（預設同 r） */
  spike(a: V3, b: V3, r: number, color: THREE.Color, r2 = r): void {
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
      ring.push([a[0] + (u.x * su * r + v.x * sv * r2), a[1] + (u.y * su * r + v.y * sv * r2), a[2] + (u.z * su * r + v.z * sv * r2)]);
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const out: V3 = [(ring[i][0] + ring[j][0]) / 2 - a[0], (ring[i][1] + ring[j][1]) / 2 - a[1], (ring[i][2] + ring[j][2]) / 2 - a[2]];
      this.b.tri(ring[i], ring[j], b, color, out);
    }
  }

  /** 朝 +x 的圓盤（圓盾）：圓心 c、半徑 r、厚 t；正面 face、側面與背面 rim */
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

  geometry(): THREE.BufferGeometry {
    return this.b.geometry();
  }
}

/** 一個人物的兩組幾何：fig 中性色、team 隊伍色 */
interface Parts {
  fig: THREE.BufferGeometry;
  team: THREE.BufferGeometry;
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

/** 盾兵的大盾：高約身高七成，兩種姿勢同一面 */
const SHIELD_H = 0.42;
const SHIELD_HW = 0.14;

/** 肩膀位置（arm 用）：side ＝ -1 左、1 右 */
function shoulder(b: Body, side: number): V3 {
  return [b.lean, SHOULDER - b.crouch - 0.02, side * (b.sw - 0.015)];
}

/** 步兵的腿、頭（畫在 k）與上衣（下擺、上身，畫在隊伍色 t）；頭盔與手臂另外畫 */
function torso(k: Kit, t: Kit, b: Body): void {
  const hip = 0.25 - b.crouch;
  // 腿：上端在胯下，下端可以前後錯開
  for (const side of [-1, 1]) {
    const z0 = side < 0 ? -0.072 : 0.014;
    const z1 = side < 0 ? -0.014 : 0.072;
    const off = side < 0 ? b.stride : -b.stride;
    k.taper(0, hip, [off - 0.034, z0, off + 0.034, z1], [-0.03, z0, 0.03, z1], C.trousers, NY | PY);
  }
  // 下擺（往下張開）與上身（往上變寬）：中間的腰比較細
  const waist = 0.33 - b.crouch;
  const lx = b.lean * 0.4;
  t.taper(0.2 - b.crouch, waist, [-0.064, -b.sd - 0.012, 0.064, b.sd + 0.012], [lx - 0.05, -b.sd + 0.008, lx + 0.05, b.sd - 0.008], WHITE, NY | PY);
  t.taper(waist, SHOULDER - b.crouch, [lx - 0.05, -b.sd + 0.008, lx + 0.05, b.sd - 0.008], [b.lean - 0.06, -b.sw, b.lean + 0.06, b.sw], WHITE, NY);
  const hx = b.lean * 1.1;
  k.box(hx - 0.043, NECK - b.crouch, -0.042, hx + 0.043, HEAD_TOP - b.crouch, 0.042, C.skin, NY | PY);
}

/** 手臂：肩到手，袖子是布色、手是皮膚色的端面 */
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

/**
 * 盾兵的弧面大盾（畫在隊伍色 t）：三片直立的板，中間朝前、兩邊往後折 bend；正面隊伍色、背面與邊暗。
 * x 是中間那片的正面、y0 是下緣、zc 是左右中心；tilt 是上緣往後仰多少。
 */
function bigShield(t: Kit, x: number, y0: number, zc: number, tilt: number): void {
  const bend = 0.04;
  const thick = 0.02;
  const y1 = y0 + SHIELD_H;
  const edges = [-SHIELD_HW, -SHIELD_HW / 3, SHIELD_HW / 3, SHIELD_HW];
  const front = (e: number): number => (Math.abs(e) > SHIELD_HW / 2 ? x - bend : x);
  for (let s = 0; s < 3; s++) {
    const p: V3[] = [];
    for (let k = 0; k < 2; k++)
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) p.push([front(edges[s + k]) - (i === 0 ? thick : 0) - (j === 1 ? tilt : 0), j === 0 ? y0 : y1, zc + edges[s + k]]);
    // 相接的那幾面不畫：左片留外側的 -z、右片留外側的 +z
    const skip = NY | (s === 0 ? PZ : s === 2 ? NZ : NZ | PZ);
    t.hexa(p, [RIM, WHITE, RIM, RIM, RIM, RIM], skip);
  }
}

/** 步兵 */
function infantry(kind: UnitKind, pose: Pose): Parts {
  const k = new Kit();
  const t = new Kit();
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
  torso(k, t, body);
  const hx = body.lean * 1.1;
  const top = HEAD_TOP - body.crouch;
  const S = SHOULDER - body.crouch;
  switch (kind) {
    case 'spear':
      helm(k, 'iron', hx, top);
      // 鐵肩甲（從上面看得到的兩塊）
      for (const side of [-1, 1]) {
        const z0 = side < 0 ? -0.135 : 0.07;
        const z1 = side < 0 ? -0.07 : 0.135;
        k.taper(SHOULDER - 0.045, SHOULDER + 0.018, [body.lean - 0.068, z0, body.lean + 0.068, z1], [body.lean - 0.05, z0 + 0.012, body.lean + 0.05, z1 - 0.012], C.metal, NY);
      }
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
        k.rod([0.065, 0.01, 0.155], [0.065, 1.7, 0.155], 0.013, 0.013, C.pole);
        k.spike([0.065, 1.7, 0.155], [0.065, 1.84, 0.155], 0.024, C.metalLight);
      }
      break;
    case 'sword': {
      helm(k, 'crest', hx, top);
      // 右手把劍舉在身體右外側、劍尖高過頭（不和身體重疊），劍長約身高一半；左手圓盾直徑約身高四成五（盾面是隊伍色）
      arm(k, body, 1, [0.12, 0.4, 0.19]);
      arm(k, body, -1, [0.11, 0.32, -0.08]);
      k.box(0.1, 0.385, 0.15, 0.14, 0.41, 0.23, C.leather, 0);
      const hilt: V3 = [0.12, 0.4, 0.19];
      const end: V3 = [0.178, 0.664, 0.19];
      k.rod(hilt, end, 0.012, 0.02, C.metalLight);
      k.spike(end, [0.187, 0.703, 0.19], 0.012, C.metalLight, 0.02);
      t.disc([0.14, 0.33, -0.13], 0.14, 0.022, 8, WHITE, RIM);
      break;
    }
    case 'shield':
      helm(k, 'kettle', hx, top);
      if (pose === 'wall') {
        // 盾牆：蹲低前傾，雙手把盾頂在身前正中，盾上緣略往後仰，只露出頭盔
        arm(k, body, 1, [0.17, S - 0.1, 0.08]);
        arm(k, body, -1, [0.17, S - 0.08, -0.08]);
        bigShield(t, 0.25, 0.06, 0, 0.025);
        k.box(0.245, 0.23, -0.04, 0.265, 0.31, 0.04, C.metal, NY | NX);
      } else {
        // 持盾：左手把盾立在身前左側，右手垂下
        arm(k, body, -1, [0.13, 0.3, -0.07]);
        arm(k, body, 1, [0.02, 0.24, 0.13]);
        bigShield(t, 0.21, 0.09, -0.07, 0);
        k.box(0.21, 0.26, -0.11, 0.23, 0.34, -0.03, C.metal, NY | NX);
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
    case 'light': {
      helm(k, 'hood', hx, top);
      // 最瘦、沒穿甲、不拿盾；右手把短柄手斧舉在肩上方、斧頭高過頭（輕裝近戰）
      arm(k, body, 1, [0.08, 0.42, 0.17]);
      arm(k, body, -1, [0.03, 0.25, -0.1]);
      k.rod([0.1, 0.35, 0.17], [0.03, 0.71, 0.17], 0.011, 0.011, C.pole);
      // 斧頭：從柄頂往前伸、刃口比後端寬的楔形
      const p: V3[] = [];
      for (let kk = 0; kk < 2; kk++)
        for (let j = 0; j < 2; j++)
          for (let i = 0; i < 2; i++) p.push([i === 0 ? 0.03 : 0.14, j === 0 ? (i === 0 ? 0.63 : 0.6) : i === 0 ? 0.69 : 0.73, kk === 0 ? 0.162 : 0.178]);
      k.hexa(p, [C.metal, C.metalLight, C.metal, C.metal, C.metal, C.metal], 0);
      break;
    }
    default:
      break;
  }
  return { fig: k.geometry(), team: t.geometry() };
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
    k.rod([hx, 0.33, z], [fx, 0, z], 0.022, 0.024, hc);
  // 頸與頭（重騎的頭戴面甲）
  if (!heavy) {
    k.rod([0.17, 0.4, 0], [0.29, 0.62, 0], 0.042, 0.05, hc);
    k.rod([0.15, 0.47, 0], [0.26, 0.67, 0], 0.016, 0.02, C.mane);
  }
  k.rod([0.27, 0.64, 0], [0.42, 0.53, 0], 0.036, 0.042, heavy ? C.metal : hc, heavy ? C.metal : C.mane);
  k.rod([-0.29, 0.46, 0], [-0.37, 0.24, 0], 0.018, 0.024, C.mane);
}

/** 騎兵：馬＋騎手＋騎槍；騎手上衣、鞍墊（輕騎）或馬衣與頸甲（重騎）是隊伍色 */
function cavalry(kind: UnitKind): Parts {
  const k = new Kit();
  const t = new Kit();
  const heavy = kind === 'heavyCav';
  horse(k, heavy);
  const cloth = col(CLOTH[kind]);
  // 騎手：跨在馬背上（一塊橫跨的腿）、上身、頭
  const seat = 0.49;
  k.box(-0.08, seat - 0.15, -0.115, 0.06, seat + 0.02, 0.115, C.trousers, NY | PY);
  t.taper(seat, seat + 0.2, [-0.075, -0.075, 0.035, 0.075], [-0.05, -0.105, 0.07, 0.105], WHITE, NY);
  const top = seat + 0.31;
  k.box(-0.035, seat + 0.21, -0.042, 0.05, top, 0.042, C.skin, NY | PY);
  helm(k, heavy ? 'great' : 'cone', 0.008, top);
  // 右手夾騎槍（握韁的左手被身體擋住，不畫）
  const len = heavy ? 1.3 : 0.95;
  const a: V3 = [-0.24, seat + 0.13, 0.13];
  const tip: V3 = [-0.24 + len, seat + (heavy ? 0.17 : 0.29), 0.13];
  k.rod([0.0, seat + 0.18, 0.1], [0.05, seat + 0.12, 0.13], 0.022, 0.022, cloth, C.skin);
  k.rod(a, tip, heavy ? 0.016 : 0.013, heavy ? 0.016 : 0.013, C.pole);
  k.spike(tip, [tip[0] + 0.12, tip[1] + (tip[1] - a[1]) * (0.12 / len), tip[2]], heavy ? 0.026 : 0.022, C.metalLight);
  if (heavy) {
    // 圓角馬衣：蓋住馬身兩側到腿上半，下緣暗邊；頸甲
    t.taper(0.21, 0.5, [-0.3, -0.105, 0.25, 0.105], [-0.27, -0.094, 0.22, 0.094], WHITE);
    t.box(-0.305, 0.2, -0.108, 0.255, 0.235, 0.108, RIM, NY | PY);
    t.rod([0.17, 0.42, 0], [0.27, 0.6, 0], 0.05, 0.058, WHITE);
  } else {
    // 馬鞍墊
    t.taper(0.42, 0.5, [-0.13, -0.106, 0.07, 0.106], [-0.12, -0.098, 0.06, 0.098], WHITE);
  }
  const parts = { fig: k.geometry(), team: t.geometry() };
  if (heavy) for (const g of [parts.fig, parts.team]) g.scale(1.1, 1.04, 1.1);
  return parts;
}

function parts(kind: UnitKind, pose: Pose): Parts {
  return kind === 'lightCav' || kind === 'heavyCav' ? cavalry(kind) : infantry(kind, pose);
}

/** 人物（不含隊伍色的部分） */
export function figureGeometry(kind: UnitKind, pose: Pose): THREE.BufferGeometry {
  const p = parts(kind, pose);
  p.team.dispose();
  return p.fig;
}

/** 隊伍色的部分（白色，實際顏色由 instanceColor 給；RIM 是暗鑲邊） */
export function teamGeometry(kind: UnitKind, pose: Pose): THREE.BufferGeometry {
  const p = parts(kind, pose);
  p.fig.dispose();
  return p.team;
}

/** 一組幾何的三角形數 */
export function triangles(g: THREE.BufferGeometry): number {
  return g.getAttribute('position').count / 3;
}
