// 3D 沙盤的士兵：每種兵 × 姿勢一個「人物」InstancedMesh（中性色）與一個「隊伍色」InstancedMesh（上衣、盾面、馬衣、鞍墊），
// 兩者共用同一組矩陣；造型在 unitModels.ts。槍林（長槍放平）、盾牆（蹲低、盾頂在身前）各有一個姿勢；倒地的人側躺。
// 透牆輪廓（ghost）：被牆、建物、地形擋住的士兵，用隊伍色低透明度的剪影畫出來——再畫一次同樣的 InstancedMesh（共用矩陣與隊伍色），
// 只在「比擋住它的東西還深」的像素畫（深度測試反過來）；看得到的士兵寫模板 1，剪影只畫在模板 0 的像素並加一，同一格不疊兩層。
import * as THREE from 'three';
import type { UnitKind } from '../../../legion/config.ts';
import { Builder } from './builder.ts';
import { col } from './palette.ts';
import { figureGeometry, teamGeometry, type Pose } from './unitModels.ts';

export type { Pose } from './unitModels.ts';

/** 沒給隊伍色（team ＝ null）時隊伍色那層改用的中性布色：上衣也在這層，不能整層不畫 */
const NEUTRAL = col(0x857a66);

interface Layer {
  readonly fig: THREE.InstancedMesh;
  readonly team: THREE.InstancedMesh;
  /** 透牆輪廓（人物、隊伍色兩層各一個）；沒開輪廓時是空的 */
  readonly ghosts: THREE.InstancedMesh[];
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
  /** 人物顏色倍率（陣亡調暗） */
  shade: number;
  team: THREE.Color | null;
}

/** 看得到的士兵寫模板 1（透牆輪廓不畫在這些像素上） */
const STENCIL_SOLID = { stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp } as const;

/** 一種兵、一種姿勢的士兵層 */
export class Soldiers {
  readonly group = new THREE.Group();
  private readonly layers = new Map<string, Layer>();
  private readonly figMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0, ...STENCIL_SOLID });
  private readonly teamMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, ...STENCIL_SOLID });
  private readonly ghostMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,
    stencilWrite: true,
    stencilRef: 0,
    stencilFunc: THREE.EqualStencilFunc,
    stencilZPass: THREE.IncrementStencilOp,
  });
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly v = new THREE.Vector3();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly c = new THREE.Color();

  /** ghost：要不要畫透牆輪廓（陣亡的人不畫） */
  constructor(capacity: Partial<Record<UnitKind, number>>, ghost = false) {
    // 剪影往鏡頭推近 0.35 格再比深度：腳踩進地面、斜坡上的小遮擋不算被擋住，只有牆、屋這種真正擋在前面的才畫
    this.ghostMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\nmvPosition.z += 0.35;\ngl_Position = projectionMatrix * mvPosition;');
    };
    for (const [kind, n] of Object.entries(capacity) as [UnitKind, number][]) {
      if (n <= 0) continue;
      const poses: Pose[] = kind === 'spear' ? ['stand', 'brace'] : kind === 'shield' ? ['stand', 'wall'] : ['stand'];
      for (const pose of poses) {
        const fig = new THREE.InstancedMesh(figureGeometry(kind, pose), this.figMat, n);
        const team = new THREE.InstancedMesh(teamGeometry(kind, pose), this.teamMat, n);
        for (const im of [fig, team]) {
          im.castShadow = true;
          im.receiveShadow = true;
          im.frustumCulled = false;
          im.count = 0;
          im.setColorAt(0, new THREE.Color(1, 1, 1));
          // 畫在建物之後（模板才不會被後畫的牆蓋掉還留著 1）
          im.renderOrder = 1;
          this.group.add(im);
        }
        const ghosts: THREE.InstancedMesh[] = [];
        if (ghost) {
          for (const src of [fig, team]) {
            const g = new THREE.InstancedMesh(src.geometry, this.ghostMat, n);
            g.instanceMatrix = src.instanceMatrix;
            g.instanceColor = team.instanceColor;
            g.frustumCulled = false;
            g.count = 0;
            g.renderOrder = 1;
            ghosts.push(g);
            this.group.add(g);
          }
        }
        this.layers.set(`${kind}:${pose}`, { fig, team, ghosts, n: 0 });
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
    l.team.setMatrixAt(l.n, this.m);
    l.team.setColorAt(l.n, s.team ?? this.c.copy(NEUTRAL).multiplyScalar(s.shade));
    l.n++;
  }

  end(): void {
    for (const l of this.layers.values()) {
      for (const im of [l.fig, l.team]) {
        im.count = l.n;
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor !== null) im.instanceColor.needsUpdate = true;
      }
      for (const g of l.ghosts) g.count = l.n;
    }
  }

  /** 開關透牆輪廓 */
  setGhosts(on: boolean): void {
    for (const l of this.layers.values()) for (const g of l.ghosts) g.visible = on;
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
    this.ghostMat.dispose();
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
