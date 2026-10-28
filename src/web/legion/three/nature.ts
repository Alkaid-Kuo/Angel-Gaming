// 3D 沙盤的樹與石頭：樹林格撒樹（位置、大小、顏色都有變化，不排成格子），地圖 decor 的單棵樹與柳樹；
// 碎石坡撒石塊、平地零星的灌木。全部用 InstancedMesh（一種造型一次繪製）。
import * as THREE from 'three';
import { T } from '../../../legion/config.ts';
import type { LegionMap } from '../../../legion/map.ts';
import { Builder, type V3 } from './builder.ts';
import { WATER_Y, type Ground } from './ground.ts';
import { PAL, col, rand } from './palette.ts';

/** 凹凸不平的球（苔蘚球樹冠、灌木、石塊）：二十面體細分後依位置擾動 */
function lumpy(b: Builder, cx: number, cy: number, cz: number, r: number, sy: number, color: THREE.Color, detail: number, seed: number, droop = 0): void {
  const g = new THREE.IcosahedronGeometry(1, detail).toNonIndexed();
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const at = (i: number): V3 => {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + (rand(Math.round(x * 1000), Math.round(y * 1000), Math.round(z * 1000) + seed) - 0.5) * 0.28;
    // 柳樹：下半部往下垂
    const dy = y < 0 ? y * droop : 0;
    return [cx + x * r * k, cy + (y * sy + dy) * r * k, cz + z * r * k];
  };
  for (let i = 0; i < p.count; i += 3) {
    const a = at(i);
    const bb = at(i + 1);
    const c = at(i + 2);
    const m: V3 = [(a[0] + bb[0] + c[0]) / 3 - cx, (a[1] + bb[1] + c[1]) / 3 - cy, (a[2] + bb[2] + c[2]) / 3 - cz];
    const shade = 0.88 + 0.12 * Math.max(0, m[1] / (r * sy));
    b.tri(a, bb, c, color.clone().multiplyScalar(shade), m);
  }
  g.dispose();
}

function trunk(b: Builder, h: number, r: number): void {
  b.prism(0, 0, -0.1, h, r, r * 0.75, 6, col(PAL.woodDark));
}

/** 闊葉樹（三團苔蘚球） */
function broadleaf(): THREE.BufferGeometry {
  const b = new Builder();
  trunk(b, 0.75, 0.08);
  lumpy(b, 0, 1.05, 0, 0.55, 0.9, col(PAL.crownMid), 1, 1);
  lumpy(b, 0.3, 0.8, 0.18, 0.38, 0.85, col(PAL.crownDark), 1, 2);
  lumpy(b, -0.25, 0.85, -0.2, 0.36, 0.85, col(PAL.crownLight), 1, 3);
  return b.geometry();
}

/** 松（三層錐） */
function pine(): THREE.BufferGeometry {
  const b = new Builder();
  trunk(b, 0.5, 0.07);
  const c = col(PAL.crownDark);
  b.cone(0, 0, 0.35, 1.1, 0.55, 7, c);
  b.cone(0, 0, 0.75, 1.45, 0.42, 7, c.clone().multiplyScalar(1.08), 0.4);
  b.cone(0, 0, 1.1, 1.8, 0.28, 7, c.clone().multiplyScalar(1.15), 0.8);
  return b.geometry();
}

/** 柳（高瘦、下垂、黃綠） */
function willow(): THREE.BufferGeometry {
  const b = new Builder();
  trunk(b, 0.9, 0.09);
  lumpy(b, 0, 1.25, 0, 0.6, 1.05, col(PAL.willow), 1, 4, 0.6);
  lumpy(b, 0.15, 1.6, 0.05, 0.35, 0.8, col(PAL.willow).multiplyScalar(1.08), 0, 5);
  return b.geometry();
}

function bush(): THREE.BufferGeometry {
  const b = new Builder();
  lumpy(b, 0, 0.18, 0, 0.3, 0.6, col(PAL.crownMid), 0, 6);
  lumpy(b, 0.22, 0.12, 0.1, 0.2, 0.6, col(PAL.crownDark), 0, 7);
  return b.geometry();
}

function rock(): THREE.BufferGeometry {
  const b = new Builder();
  lumpy(b, 0, 0.05, 0, 0.3, 0.55, col(0x8d877b), 0, 8);
  return b.geometry();
}

interface Placement {
  x: number;
  z: number;
  s: number;
  rot: number;
  tint: number;
}

export class Nature {
  readonly group = new THREE.Group();
  private readonly geos: THREE.BufferGeometry[] = [];
  private readonly mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  /** 每棵樹的位置（隱蔽的軍團附近樹冠變淡用） */
  readonly trees: { mesh: THREE.InstancedMesh; spots: Placement[] }[] = [];

  constructor(map: LegionMap, ground: Ground) {
    const { width: w, height: h, terrain } = map;
    const broad: Placement[] = [];
    const pines: Placement[] = [];
    const willows: Placement[] = [];
    const bushes: Placement[] = [];
    const rocks: Placement[] = [];
    const add = (list: Placement[], x: number, z: number, s: number, k: number): void => {
      list.push({ x, z, s, rot: rand(k, 1, 91) * Math.PI * 2, tint: 0.85 + rand(k, 2, 92) * 0.3 });
    };
    let k = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = terrain[y * w + x];
        k++;
        if (t === T.Forest) {
          // 每格 0～2 棵，位置隨機（樹林邊緣稀一點）
          const n = rand(x, y, 1) < 0.55 ? 1 : rand(x, y, 2) < 0.6 ? 2 : 0;
          for (let j = 0; j < n; j++) {
            const px = x + 0.15 + rand(x, y, 10 + j) * 0.7;
            const pz = y + 0.15 + rand(x, y, 20 + j) * 0.7;
            const s = 0.75 + rand(x, y, 30 + j) * 0.55;
            add(rand(x, y, 40 + j) < 0.3 ? pines : broad, px, pz, s, k * 3 + j);
          }
        } else if (t === T.Rubble) {
          if (rand(x, y, 3) < 0.7) add(rocks, x + rand(x, y, 4), y + rand(x, y, 5), 0.5 + rand(x, y, 6) * 0.9, k);
        } else if (t === T.Hill) {
          if (rand(x, y, 7) < 0.04) add(rocks, x + rand(x, y, 8), y + rand(x, y, 9), 0.8 + rand(x, y, 10) * 1.2, k);
          else if (rand(x, y, 11) < 0.04) add(bushes, x + rand(x, y, 12), y + rand(x, y, 13), 0.8 + rand(x, y, 14) * 0.6, k);
        } else if (t === T.Plain) {
          if (rand(x, y, 15) < 0.012) add(bushes, x + rand(x, y, 16), y + rand(x, y, 17), 0.7 + rand(x, y, 18) * 0.7, k);
        }
      }
    }
    for (const d of map.decor ?? []) {
      if (d.kind !== 'tree' && d.kind !== 'willow') continue;
      const s = 0.95 + rand(d.seed ?? d.x0, d.y0, 3) * 0.4;
      add(d.kind === 'willow' ? willows : broad, d.x0 + 0.5, d.y0 + 0.5, s, d.x0 * 977 + d.y0);
    }
    this.place(broadleaf(), broad, ground);
    this.place(pine(), pines, ground);
    this.place(willow(), willows, ground);
    this.place(bush(), bushes, ground, false);
    this.place(rock(), rocks, ground, false);
  }

  private place(geo: THREE.BufferGeometry, spots: Placement[], ground: Ground, tree = true): void {
    this.geos.push(geo);
    if (spots.length === 0) return;
    const mesh = new THREE.InstancedMesh(geo, this.mat, spots.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    spots.forEach((p, i) => {
      const y = Math.max(ground.heightAt(p.x, p.z), WATER_Y - 0.05);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.rot);
      m.compose(new THREE.Vector3(p.x, y, p.z), q, new THREE.Vector3(p.s, p.s * (0.9 + (p.tint - 0.85) * 0.5), p.s));
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.setScalar(p.tint));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    if (tree) this.trees.push({ mesh, spots });
  }

  dispose(): void {
    for (const g of this.geos) g.dispose();
    this.mat.dispose();
    for (const t of this.trees) t.mesh.dispose();
  }
}
