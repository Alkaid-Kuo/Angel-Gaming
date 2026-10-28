// 3D 沙盤的士兵（先求看得懂，造型之後再換）：每種兵一個「人物」InstancedMesh（中性色）與一個「隊伍色」InstancedMesh（底座、盾面、馬衣），
// 兩者共用同一組矩陣。槍林（長槍放平）、盾牆（盾舉高並排）各有一個姿勢；倒地的人側躺；潰散整團調灰、不畫底座。
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { UnitKind } from '../../../legion/config.ts';
import { Builder } from './builder.ts';
import { PAL, col } from './palette.ts';

export type Pose = 'stand' | 'brace' | 'wall';

const CLOTH: Record<UnitKind, number> = {
  spear: 0x8a7a5c,
  sword: 0x8f9398,
  shield: 0x7d6b52,
  archer: 0x6f5d40,
  light: 0x8c7a58,
  lightCav: 0x7f7058,
  heavyCav: 0x8f9398,
};

const METAL = 0xa7adb4;
const POLE = 0x6a5134;

/** 一個零件：基本形狀擺好位置、塗上顏色（頂點色），之後合併成一個人 */
function part(g: THREE.BufferGeometry, color: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.BufferGeometry {
  const ng = g.index !== null ? g.toNonIndexed() : g;
  g.dispose();
  ng.deleteAttribute('uv');
  ng.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz)));
  const c = col(color);
  const n = ng.getAttribute('position').count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return ng;
}

const cyl = (r0: number, r1: number, hgt: number, n = 6): THREE.BufferGeometry => new THREE.CylinderGeometry(r1, r0, hgt, n, 1, false);
const ball = (r: number): THREE.BufferGeometry => new THREE.SphereGeometry(r, 7, 5);

/** 步兵的人：雙腿、上身、腰帶、雙臂、頭、盔（弓兵、輕步兵是皮帽）；正面朝 +x；y 是腳底高度 */
function person(parts: THREE.BufferGeometry[], kind: UnitKind, y = 0, riding = false): void {
  const cloth = CLOTH[kind];
  if (!riding) for (const s of [-1, 1]) parts.push(part(cyl(0.03, 0.026, 0.26, 5), 0x5c4b3b, 0, y + 0.13, s * 0.045));
  else for (const s of [-1, 1]) parts.push(part(cyl(0.028, 0.024, 0.2, 5), 0x5c4b3b, 0.02, y + 0.2, s * 0.1, s * 0.5, 0, 0));
  parts.push(part(cyl(0.1, 0.082, 0.22, 7), cloth, 0, y + 0.37, 0));
  parts.push(part(cyl(0.102, 0.102, 0.03, 7), 0x4a3a2a, 0, y + 0.28, 0));
  for (const s of [-1, 1]) parts.push(part(cyl(0.026, 0.022, 0.2, 5), cloth, 0.03, y + 0.37, s * 0.11, 0, 0, 0.35));
  parts.push(part(ball(0.06), PAL.skin, 0, y + 0.53, 0));
  if (kind === 'archer' || kind === 'light') parts.push(part(cyl(0.066, 0.02, 0.09, 7), 0x6b5538, 0, y + 0.585, 0));
  else {
    parts.push(part(new THREE.SphereGeometry(0.066, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), METAL, 0, y + 0.545, 0));
    parts.push(part(cyl(0.075, 0.075, 0.012, 8), METAL, 0, y + 0.545, 0));
  }
}

/** 馬：身體、胸、脖子、頭、四條腿、尾巴；正面朝 +x */
function horse(parts: THREE.BufferGeometry[], s: number, color: number): void {
  parts.push(part(cyl(0.1, 0.11, 0.5, 8), color, 0, 0.42, 0, 0, 0, Math.PI / 2, s, s, s));
  parts.push(part(ball(0.105), color, 0.24 * s, 0.43, 0, 0, 0, 0, s, s * 1.05, s * 0.95));
  parts.push(part(cyl(0.07, 0.05, 0.3, 6), color, 0.3 * s, 0.56, 0, 0, 0, -0.6, s, s, s));
  parts.push(part(new THREE.BoxGeometry(0.2, 0.08, 0.075), color, 0.42 * s, 0.66, 0, 0, 0, -0.5, s, s, s));
  parts.push(part(new THREE.BoxGeometry(0.06, 0.06, 0.02), 0x3f2b1b, 0.33 * s, 0.73, 0, 0, 0, -0.4, s, s, s));
  for (const [lx, lz] of [
    [-0.19, -0.06],
    [-0.19, 0.06],
    [0.2, -0.06],
    [0.2, 0.06],
  ]) parts.push(part(cyl(0.028, 0.022, 0.36, 5), color, lx * s, 0.18, lz * s));
  parts.push(part(cyl(0.03, 0.012, 0.26, 5), 0x3f2b1b, -0.3 * s, 0.36, 0, 0, 0, -0.55, s, s, s));
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  g.computeBoundingSphere();
  return g;
}

/** 人物（不含隊伍色的部分） */
function figure(kind: UnitKind, pose: Pose): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (kind === 'lightCav' || kind === 'heavyCav') {
    const s = kind === 'heavyCav' ? 1.1 : 1;
    horse(parts, s, kind === 'heavyCav' ? 0x5a4632 : 0x6b4a2f);
    person(parts, kind, 0.4, true);
    const len = kind === 'heavyCav' ? 1.3 : 0.95;
    parts.push(part(cyl(0.012, 0.012, len, 5), POLE, len / 2 - 0.15, 0.74, 0.13, 0, 0, Math.PI / 2 - 0.08));
    parts.push(part(new THREE.ConeGeometry(0.022, 0.1, 5), METAL, len - 0.12, 0.78, 0.13, 0, 0, -Math.PI / 2 + 0.08));
    return merged(parts);
  }
  person(parts, kind);
  switch (kind) {
    case 'spear':
      if (pose === 'brace') {
        parts.push(part(cyl(0.012, 0.012, 1.8, 5), POLE, 0.55, 0.4, 0.13, 0, 0, Math.PI / 2));
        parts.push(part(new THREE.ConeGeometry(0.024, 0.14, 5), METAL, 1.5, 0.4, 0.13, 0, 0, -Math.PI / 2));
      } else {
        parts.push(part(cyl(0.012, 0.012, 1.8, 5), POLE, 0.06, 0.9, 0.13));
        parts.push(part(new THREE.ConeGeometry(0.024, 0.14, 5), METAL, 0.06, 1.86, 0.13));
      }
      break;
    case 'sword':
      parts.push(part(new THREE.BoxGeometry(0.02, 0.34, 0.04), METAL, 0.12, 0.42, 0.13, 0, 0, -0.5));
      break;
    case 'archer':
      parts.push(part(new THREE.TorusGeometry(0.28, 0.012, 4, 10, Math.PI * 0.8), POLE, 0.1, 0.45, -0.14, Math.PI / 2, 0, Math.PI * 0.6));
      parts.push(part(cyl(0.035, 0.035, 0.3, 6), 0x4a3a2a, -0.1, 0.42, 0.04, 0.3, 0, 0));
      break;
    case 'light':
      for (const dz of [0.12, 0.15]) parts.push(part(cyl(0.01, 0.01, 0.8, 4), POLE, 0.02, 0.55, dz, 0, 0, 0.1));
      break;
    default:
      break;
  }
  return merged(parts);
}

/** 隊伍色的部分（白色，實際顏色由 instanceColor 給）：底座、盾面、馬衣 */
function teamParts(kind: UnitKind, pose: Pose): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const W = 0xffffff;
  const RIM = 0x737373;
  if (kind === 'lightCav' || kind === 'heavyCav') {
    const s = kind === 'heavyCav' ? 1.1 : 1;
    parts.push(part(new THREE.BoxGeometry(0.78 * s, 0.03, 0.44 * s), RIM, 0, 0.015, 0));
    parts.push(part(new THREE.BoxGeometry(0.74 * s, 0.012, 0.4 * s), W, 0, 0.036, 0));
    if (kind === 'heavyCav') parts.push(part(cyl(0.125, 0.125, 0.44, 8), W, 0, 0.37, 0, 0, 0, Math.PI / 2, s, s * 1.1, s));
    else parts.push(part(new THREE.BoxGeometry(0.2, 0.025, 0.24), W, 0, 0.53, 0));
    return merged(parts);
  }
  if (kind === 'archer' || kind === 'light') {
    const r = kind === 'archer' ? 0.2 : 0.17;
    parts.push(part(cyl(r, r, 0.035, 10), RIM, 0, 0.0175, 0));
    parts.push(part(cyl(r - 0.03, r - 0.03, 0.01, 10), W, 0, 0.04, 0));
  } else {
    parts.push(part(new THREE.BoxGeometry(0.4, 0.035, 0.4), RIM, 0, 0.0175, 0));
    parts.push(part(new THREE.BoxGeometry(0.365, 0.01, 0.365), W, 0, 0.04, 0));
  }
  if (kind === 'shield') {
    if (pose === 'wall') parts.push(part(new THREE.BoxGeometry(0.04, 0.66, 0.52), W, 0.15, 0.38, 0));
    else parts.push(part(new THREE.BoxGeometry(0.035, 0.46, 0.32), W, 0.14, 0.33, 0));
  } else if (kind === 'sword') parts.push(part(cyl(0.09, 0.09, 0.02, 10), W, 0.11, 0.36, -0.13, 0, 0, Math.PI / 2));
  return merged(parts);
}

interface Layer {
  readonly fig: THREE.InstancedMesh;
  readonly team: THREE.InstancedMesh;
  n: number;
}

export interface SoldierDraw {
  x: number;
  y: number;
  z: number;
  /** 朝向（弧度，三維的 y 軸旋轉） */
  rot: number;
  /** 倒地：側躺 */
  down: boolean;
  /** 人物顏色倍率（潰散調灰、陣亡調暗） */
  shade: number;
  team: THREE.Color | null;
}

/** 一種兵、一種姿勢的士兵層 */
export class Soldiers {
  readonly group = new THREE.Group();
  private readonly layers = new Map<string, Layer>();
  private readonly figMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 });
  private readonly teamMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0 });
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly c = new THREE.Color();

  constructor(capacity: Partial<Record<UnitKind, number>>) {
    for (const [kind, n] of Object.entries(capacity) as [UnitKind, number][]) {
      if (n <= 0) continue;
      const poses: Pose[] = kind === 'spear' ? ['stand', 'brace'] : kind === 'shield' ? ['stand', 'wall'] : ['stand'];
      for (const pose of poses) {
        const fig = new THREE.InstancedMesh(figure(kind, pose), this.figMat, n);
        const team = new THREE.InstancedMesh(teamParts(kind, pose), this.teamMat, n);
        for (const im of [fig, team]) {
          im.castShadow = true;
          im.receiveShadow = true;
          im.frustumCulled = false;
          im.count = 0;
          im.setColorAt(0, new THREE.Color(1, 1, 1));
          this.group.add(im);
        }
        this.layers.set(`${kind}:${pose}`, { fig, team, n: 0 });
      }
    }
  }

  begin(): void {
    for (const l of this.layers.values()) l.n = 0;
  }

  add(kind: UnitKind, pose: Pose, s: SoldierDraw): void {
    const l = this.layers.get(`${kind}:${pose}`) ?? this.layers.get(`${kind}:stand`);
    if (l === undefined || l.n >= l.fig.instanceMatrix.count) return;
    if (s.down) this.e.set(Math.PI / 2, s.rot, 0, 'YXZ');
    else this.e.set(0, s.rot, 0);
    this.q.setFromEuler(this.e);
    this.v.set(s.x, s.y + (s.down ? 0.08 : 0), s.z);
    this.m.compose(this.v, this.q, this.one);
    l.fig.setMatrixAt(l.n, this.m);
    l.fig.setColorAt(l.n, this.c.setScalar(s.shade));
    if (s.team !== null) l.team.setMatrixAt(l.n, this.m);
    else {
      // 不畫隊伍色（潰散）：縮成零
      this.m.makeScale(0, 0, 0);
      l.team.setMatrixAt(l.n, this.m);
    }
    l.team.setColorAt(l.n, s.team ?? this.c.setScalar(0));
    l.n++;
  }

  end(): void {
    for (const l of this.layers.values()) {
      for (const im of [l.fig, l.team]) {
        im.count = l.n;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor !== null) im.instanceColor.needsUpdate = true;
      }
    }
  }

  dispose(): void {
    for (const l of this.layers.values()) {
      l.fig.geometry.dispose();
      l.team.geometry.dispose();
      l.fig.dispose();
      l.team.dispose();
    }
    this.figMat.dispose();
    this.teamMat.dispose();
  }
}

/** 飛行中的箭（細桿加箭羽） */
export class Arrows {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly from = new THREE.Vector3(1, 0, 0);
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);

  constructor(capacity: number) {
    const b = new Builder();
    b.box(-0.25, -0.012, -0.012, 0.25, 0.012, 0.012, col(0xd9ccaa));
    b.box(-0.25, -0.03, -0.004, -0.16, 0.03, 0.004, col(0xe8e2d0));
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
    this.mesh = new THREE.InstancedMesh(b.geometry(), mat, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
  }

  begin(): void {
    this.n = 0;
  }

  /** 位置 p、方向 dir（會被正規化） */
  add(p: THREE.Vector3, dir: THREE.Vector3): void {
    if (this.n >= this.mesh.instanceMatrix.count) return;
    this.q.setFromUnitVectors(this.from, this.v.copy(dir).normalize());
    this.m.compose(p, this.q, this.one);
    this.mesh.setMatrixAt(this.n++, this.m);
  }

  end(): void {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

/**
 * 地面上的貼地多邊形（托盤、旗圈）：每格重建一次的動態網格，頂點跟著地面高低；
 * 半透明、不寫深度、畫在地面之上模型之下。
 */
export class GroundDecals {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly colr: Float32Array;
  private n = 0;
  private readonly cap: number;

  constructor(capVerts = 60000) {
    this.cap = capVerts;
    this.pos = new Float32Array(capVerts * 3);
    this.colr = new Float32Array(capVerts * 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.colr, 4).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  begin(): void {
    this.n = 0;
  }

  /** 一個三角形（頂點已含高度） */
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, alpha: number): void {
    if (this.n + 3 > this.cap) return;
    for (const p of [a, b, c]) {
      const i = this.n++;
      this.pos[i * 3] = p.x;
      this.pos[i * 3 + 1] = p.y;
      this.pos[i * 3 + 2] = p.z;
      this.colr[i * 4] = color.r;
      this.colr[i * 4 + 1] = color.g;
      this.colr[i * 4 + 2] = color.b;
      this.colr[i * 4 + 3] = alpha;
    }
  }

  end(): void {
    const g = this.mesh.geometry;
    g.setDrawRange(0, this.n);
    (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
