// 3D 沙盤的地面：格子地圖的高度階轉成自然起伏的高度場（城外平滑、加一點起伏；城內與護城河照格子保持平整與石砌的邊），
// 地表顏色畫成一張大貼圖（草地、農田、平滑的道路、石板地），另有半透明水面與沙盤板四邊的土層剖面。
// 座標：一格 ＝ 1 單位；x 向東、z 向南（地圖的 y）、y 向上。
import * as THREE from 'three';
import { T } from '../../../legion/config.ts';
import type { LegionMap, MapDecor } from '../../../legion/map.ts';
import { Builder } from './builder.ts';
import { PAL, col, rand } from './palette.ts';

/** 一階的高度（v2 是 0.30；為了看得出台地加高）；城外的丘陵再誇大一點（NAT_LH），起伏才看得出來 */
export const LH = 0.5;
const NAT_LH = 0.95;
/** 牆頂比所在地面高多少 */
export const WALL_H = 2.4;
export const WATER_Y = 0.12;
const RIVER_BED = -0.75;
const MOAT_BED = -0.6;
const SHALLOW_BED = -0.04;
/** 沙盤板底 */
const BASE_Y = -2.2;
/** 每格幾個頂點間隔 */
const RES = 2;
/** 地表貼圖每格幾個像素 */
const PX = 12;

/** 城內與人造的格：高度照格子、不平滑 */
function builtTile(t: number): boolean {
  return t === T.Paved || t === T.Building || t === T.Wall || t === T.Gatehouse || t === T.Stair;
}

/** 平滑的 2D 數值雜訊（0～1） */
function vnoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = rand(xi, yi, seed);
  const b = rand(xi + 1, yi, seed);
  const c = rand(xi, yi + 1, seed);
  const d = rand(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

export function fbm(x: number, y: number, seed: number): number {
  return vnoise(x, y, seed) * 0.55 + vnoise(x * 2.1, y * 2.1, seed + 7) * 0.3 + vnoise(x * 4.3, y * 4.3, seed + 13) * 0.15;
}

/** 一維高斯模糊（就地，跨 stride） */
function blur1(src: Float32Array, n: number, count: number, stride: number, step: number, kernel: Float32Array): void {
  const r = (kernel.length - 1) / 2;
  const tmp = new Float32Array(n);
  for (let k = 0; k < count; k++) {
    const base = k * stride;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) {
        const q = Math.min(n - 1, Math.max(0, i + j));
        s += src[base + q * step] * kernel[j + r];
      }
      tmp[i] = s;
    }
    for (let i = 0; i < n; i++) src[base + i * step] = tmp[i];
  }
}

export class Ground {
  readonly w: number;
  readonly h: number;
  private readonly vw: number;
  private readonly vh: number;
  /** 頂點的高度 */
  private readonly hf: Float32Array;
  /** 每格照格子的高度（城牆、建物的底） */
  private readonly tileH: Float32Array;
  readonly moat: Uint8Array;
  readonly group = new THREE.Group();
  private readonly water: THREE.Mesh;
  private readonly waterNormal: THREE.Texture;
  readonly texture: THREE.CanvasTexture;
  /** 地形網格（布陣區疊圖共用同一份幾何） */
  readonly terrain: THREE.Mesh;

  readonly map: LegionMap;

  constructor(map: LegionMap) {
    this.map = map;
    const { width: w, height: h, terrain, heights } = map;
    this.w = w;
    this.h = h;
    this.vw = w * RES + 1;
    this.vh = h * RES + 1;
    const decor = map.decor ?? [];
    this.moat = new Uint8Array(w * h);
    for (const d of decor) if (d.kind === 'moat') for (let y = d.y0; y < d.y1; y++) for (let x = d.x0; x < d.x1; x++) this.moat[y * w + x] = 1;
    // 每格的目標高度
    this.tileH = new Float32Array(w * h);
    const built = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const t = terrain[i];
      const wet = t === T.River || t === T.Bridge || t === T.Shallow;
      built[i] = builtTile(t) || this.moat[i] === 1 ? 1 : 0;
      if (wet) this.tileH[i] = t === T.Shallow ? SHALLOW_BED : this.moat[i] === 1 ? MOAT_BED : RIVER_BED;
      else if (built[i] === 1 || heights[i] === 0) this.tileH[i] = heights[i] * LH;
      else this.tileH[i] = LH + (heights[i] - 1) * NAT_LH;
    }
    // 頂點：只用自然格算平均再模糊；碰到城內格就照格子取最高的那格（城牆腳、石砌河岸）
    const { vw, vh } = this;
    const nat = new Float32Array(vw * vh);
    const wgt = new Float32Array(vw * vh);
    const exact = new Float32Array(vw * vh).fill(NaN);
    const amp = new Float32Array(vw * vh);
    const tilesOf = (i: number, n: number): number[] => (i % RES === 0 ? [i / RES - 1, i / RES].filter((t) => t >= 0 && t < n) : [Math.floor(i / RES)]);
    for (let j = 0; j < vh; j++) {
      const tys = tilesOf(j, h);
      for (let i = 0; i < vw; i++) {
        const txs = tilesOf(i, w);
        let s = 0;
        let c = 0;
        let mx = -Infinity;
        let anyBuilt = false;
        let a = 0;
        for (const ty of tys) {
          for (const tx of txs) {
            const k = ty * w + tx;
            mx = Math.max(mx, this.tileH[k]);
            if (built[k] === 1) anyBuilt = true;
            else {
              s += this.tileH[k];
              c += 1;
              const t = terrain[k];
              a = Math.max(a, t === T.Hill ? 0.42 : t === T.Road ? 0.08 : t === T.River ? 0.12 : t === T.Shallow ? 0.02 : t === T.Forest ? 0.26 : 0.2);
            }
          }
        }
        const v = j * vw + i;
        if (c > 0) {
          nat[v] = s / c;
          wgt[v] = 1;
        }
        if (anyBuilt) exact[v] = mx;
        amp[v] = a;
      }
    }
    for (let v = 0; v < vw * vh; v++) nat[v] *= wgt[v];
    const sigma = 0.95 * RES;
    const r = Math.ceil(sigma * 2.5);
    const kernel = new Float32Array(2 * r + 1);
    let ks = 0;
    for (let k = -r; k <= r; k++) {
      kernel[k + r] = Math.exp(-(k * k) / (2 * sigma * sigma));
      ks += kernel[k + r];
    }
    for (let k = 0; k < kernel.length; k++) kernel[k] /= ks;
    for (const arr of [nat, wgt]) {
      blur1(arr, vw, vh, vw, 1, kernel);
      blur1(arr, vh, vw, 1, vw, kernel);
    }
    this.hf = new Float32Array(vw * vh);
    for (let j = 0; j < vh; j++) {
      for (let i = 0; i < vw; i++) {
        const v = j * vw + i;
        if (!Number.isNaN(exact[v])) this.hf[v] = exact[v];
        else {
          const x = i / RES;
          const z = j / RES;
          const base = wgt[v] > 1e-4 ? nat[v] / wgt[v] : 0;
          this.hf[v] = base + (fbm(x / 9, z / 9, 3) - 0.5) * 2 * amp[v] + (vnoise(x / 2.5, z / 2.5, 9) - 0.5) * amp[v] * 0.5;
        }
      }
    }
    this.texture = this.paintTexture(decor);
    this.terrain = this.buildTerrain();
    this.group.add(this.terrain);
    this.waterNormal = waterNormalMap();
    this.water = this.buildWater();
    this.group.add(this.water);
    const skirt = this.buildSkirt();
    if (skirt !== null) this.group.add(skirt);
  }

  /** 地面高度（格座標，雙線性） */
  heightAt(x: number, z: number): number {
    const fx = Math.min(this.vw - 1.001, Math.max(0, x * RES));
    const fz = Math.min(this.vh - 1.001, Math.max(0, z * RES));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const a = this.hf[j * this.vw + i];
    const b = this.hf[j * this.vw + i + 1];
    const c = this.hf[(j + 1) * this.vw + i];
    const d = this.hf[(j + 1) * this.vw + i + 1];
    // 和網格的三角形切法一致（見 buildTerrain），放在地上的東西才不會懸空或陷進去
    if (Math.abs(a - d) < Math.abs(b - c)) return u >= v ? a + (b - a) * u + (d - b) * v : a + (c - a) * v + (d - c) * u;
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }

  /** 一圈範圍內最低的地面（放石頭、樹、灌木：坡上低的那一側也貼地） */
  lowestAround(x: number, z: number, r: number): number {
    let y = this.heightAt(x, z);
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      y = Math.min(y, this.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r));
    }
    return y;
  }

  /** 該格照格子的地面高度（城牆、建物站在這上面） */
  level(tx: number, ty: number): number {
    const x = Math.min(this.w - 1, Math.max(0, Math.floor(tx)));
    const y = Math.min(this.h - 1, Math.max(0, Math.floor(ty)));
    return this.tileH[y * this.w + x];
  }

  /** 水面動一動 */
  update(t: number): void {
    this.waterNormal.offset.set((t * 0.00002) % 1, (t * 0.000013) % 1);
  }

  dispose(): void {
    this.texture.dispose();
    this.waterNormal.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material as THREE.MeshStandardMaterial;
        m.map?.dispose();
        m.normalMap?.dispose();
        m.dispose();
      }
    });
  }

  // ───────── 地表貼圖 ─────────

  private paintTexture(decor: readonly MapDecor[]): THREE.CanvasTexture {
    const { w, h, map } = this;
    const terrain = map.terrain;
    const W = w * PX;
    const H = h * PX;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    const roads = decor.filter((d) => d.kind === 'road');
    const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;
    // 1. 自然地表：每格一點，放大時平滑過渡（邊界自然）
    const natural: Record<number, number> = {
      [T.Plain]: PAL.grass,
      [T.Road]: roads.length > 0 ? PAL.grass : PAL.road,
      [T.Forest]: PAL.forestFloor,
      [T.Hill]: PAL.grassDry,
      [T.Shallow]: PAL.sand,
      [T.River]: PAL.riverbed,
      [T.Bridge]: PAL.riverbed,
      [T.Rubble]: PAL.rubble,
    };
    const small = (pick: (i: number) => number | null): HTMLCanvasElement => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d')!;
      const img = g.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        const v = pick(i);
        if (v === null) continue;
        img.data[i * 4] = (v >> 16) & 255;
        img.data[i * 4 + 1] = (v >> 8) & 255;
        img.data[i * 4 + 2] = v & 255;
        img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return c;
    };
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = hex(PAL.grass);
    ctx.fillRect(0, 0, W, H);
    ctx.filter = `blur(${Math.round(PX * 0.45)}px)`;
    ctx.drawImage(
      small((i) => natural[terrain[i]] ?? PAL.grass),
      0,
      0,
      W,
      H,
    );
    ctx.filter = 'none';
    // 2. 農田：一塊塊田，田裡一畦畦作物（只畫在平地上）
    const fields = decor.filter((d) => d.kind === 'field');
    if (fields.length > 0) {
      const fc = document.createElement('canvas');
      fc.width = W;
      fc.height = H;
      const g = fc.getContext('2d')!;
      const crops = [0x8f9a5c, 0x9d9a62, 0x7d8b55, 0xa39a6a, 0x86915a, 0x8a7c5a];
      for (const f of fields) {
        let seed = f.seed ?? 1;
        // 切成幾塊田（大小不一）
        const plots: [number, number, number, number][] = [[f.x0, f.y0, f.x1, f.y1]];
        for (let k = 0; k < 6; k++) {
          const p = plots.shift()!;
          const [x0, y0, x1, y1] = p;
          const vertical = x1 - x0 > y1 - y0;
          const t = 0.35 + rand(seed++, k) * 0.3;
          if (vertical) {
            const m = Math.round(x0 + (x1 - x0) * t);
            plots.push([x0, y0, m, y1], [m, y0, x1, y1]);
          } else {
            const m = Math.round(y0 + (y1 - y0) * t);
            plots.push([x0, y0, x1, m], [x0, m, x1, y1]);
          }
        }
        for (const [x0, y0, x1, y1] of plots) {
          const c = crops[Math.floor(rand(seed++, 3) * crops.length)];
          g.fillStyle = hex(c);
          g.fillRect(x0 * PX + 2, y0 * PX + 2, (x1 - x0) * PX - 4, (y1 - y0) * PX - 4);
          // 畦：沿長邊一條條細線
          g.strokeStyle = 'rgba(70,60,40,0.22)';
          g.lineWidth = 1.5;
          const alongX = x1 - x0 > y1 - y0;
          g.beginPath();
          if (alongX) for (let y = y0 * PX + 6; y < y1 * PX - 3; y += 5) {
            g.moveTo(x0 * PX + 3, y);
            g.lineTo(x1 * PX - 3, y);
          }
          else for (let x = x0 * PX + 6; x < x1 * PX - 3; x += 5) {
            g.moveTo(x, y0 * PX + 3);
            g.lineTo(x, y1 * PX - 3);
          }
          g.stroke();
        }
      }
      // 只留在平地上（邊緣柔和）
      g.globalCompositeOperation = 'destination-in';
      g.imageSmoothingEnabled = true;
      g.drawImage(
        small((i) => (terrain[i] === T.Plain ? 0xffffff : null)),
        0,
        0,
        W,
        H,
      );
      ctx.globalAlpha = 0.85;
      ctx.drawImage(fc, 0, 0);
      ctx.globalAlpha = 1;
    }
    // 3. 道路：平滑的折線（路邊深一點）
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pass of [0, 1]) {
      for (const r of roads) {
        if (r.pts === undefined) continue;
        ctx.strokeStyle = hex(pass === 0 ? PAL.roadEdge : PAL.road);
        ctx.lineWidth = ((r.width ?? 2) + (pass === 0 ? 0.7 : 0)) * PX;
        ctx.beginPath();
        r.pts.forEach(([x, y], k) => (k === 0 ? ctx.moveTo((x + 0.5) * PX, (y + 0.5) * PX) : ctx.lineTo((x + 0.5) * PX, (y + 0.5) * PX)));
        ctx.stroke();
      }
    }
    // 4. 城內：石板地（邊緣照格子，筆直）與院子
    const stone = small((i) => (builtTile(terrain[i]) ? (terrain[i] === T.Building ? 0x857f74 : PAL.paving) : null));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(stone, 0, 0, W, H);
    ctx.fillStyle = hex(PAL.court);
    for (const d of decor) if (d.kind === 'court') ctx.fillRect(d.x0 * PX, d.y0 * PX, (d.x1 - d.x0) * PX, (d.y1 - d.y0) * PX);
    // 石板縫：每格切成兩三塊大小不一的石板
    ctx.strokeStyle = 'rgba(40,36,30,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = terrain[y * w + x];
        if (t !== T.Paved && t !== T.Stair && t !== T.Gatehouse) continue;
        const px = x * PX;
        const py = y * PX;
        const sx = Math.round(PX * (0.3 + rand(x, y, 5) * 0.4));
        const off = (y % 2) * Math.round(PX / 2);
        ctx.moveTo(px, py + 0.5);
        ctx.lineTo(px + PX, py + 0.5);
        ctx.moveTo(px + ((sx + off) % PX) + 0.5, py);
        ctx.lineTo(px + ((sx + off) % PX) + 0.5, py + PX / 2);
        ctx.moveTo(px + ((sx * 2 + off) % PX) + 0.5, py + PX / 2);
        ctx.lineTo(px + ((sx * 2 + off) % PX) + 0.5, py + PX);
        ctx.moveTo(px, py + PX / 2 + 0.5);
        ctx.lineTo(px + PX, py + PX / 2 + 0.5);
      }
    }
    ctx.stroke();
    // 5. 每個像素：低頻色斑（±4%）與植絨細點
    const img = ctx.getImageData(0, 0, W, H);
    const data = img.data;
    for (let y = 0; y < H; y++) {
      const ty = Math.floor(y / PX);
      for (let x = 0; x < W; x++) {
        const tx = Math.floor(x / PX);
        const t = terrain[ty * w + tx];
        const city = builtTile(t);
        const low = city ? 0 : (vnoise(x / (PX * 9), y / (PX * 9), 21) - 0.5) * 0.09 + (vnoise(x / (PX * 2.5), y / (PX * 2.5), 22) - 0.5) * 0.05;
        const speck = (rand(x, y, 31) - 0.5) * (city ? 0.05 : t === T.Forest ? 0.16 : 0.09);
        const k = 1 + low + speck;
        const o = (y * W + x) * 4;
        data[o] = Math.min(255, data[o] * k);
        data[o + 1] = Math.min(255, data[o + 1] * k);
        data[o + 2] = Math.min(255, data[o + 2] * k);
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  // ───────── 網格 ─────────

  private buildTerrain(): THREE.Mesh {
    const { vw, vh, hf, w, h } = this;
    const n = vw * vh;
    const pos = new Float32Array(n * 3);
    const nor = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    const cliff = new Float32Array(n * 4);
    const stone = col(PAL.stone);
    const earth = col(PAL.cliff);
    for (let j = 0; j < vh; j++) {
      for (let i = 0; i < vw; i++) {
        const v = j * vw + i;
        const x = i / RES;
        const z = j / RES;
        pos[v * 3] = x;
        pos[v * 3 + 1] = hf[v];
        pos[v * 3 + 2] = z;
        uv[v * 2] = x / w;
        uv[v * 2 + 1] = 1 - z / h;
        const hl = hf[j * vw + Math.max(0, i - 1)];
        const hr = hf[j * vw + Math.min(vw - 1, i + 1)];
        const hu = hf[Math.max(0, j - 1) * vw + i];
        const hd = hf[Math.min(vh - 1, j + 1) * vw + i];
        const nx = (hl - hr) * RES * 0.5;
        const nz = (hu - hd) * RES * 0.5;
        const len = Math.hypot(nx, 1, nz);
        nor[v * 3] = nx / len;
        nor[v * 3 + 1] = 1 / len;
        nor[v * 3 + 2] = nz / len;
        // 陡坡：城內與護城河是石砌、城外是土層
        const steep = 1 - 1 / len;
        const wgt = Math.min(1, Math.max(0, (steep - 0.18) / 0.25));
        const tx = Math.min(w - 1, Math.floor(x));
        const tz = Math.min(h - 1, Math.floor(z));
        const k = tz * w + tx;
        const c = builtTile(this.map.terrain[k]) || this.moat[k] === 1 ? stone : earth;
        cliff[v * 4] = c.r;
        cliff[v * 4 + 1] = c.g;
        cliff[v * 4 + 2] = c.b;
        cliff[v * 4 + 3] = wgt;
      }
    }
    const idx = new Uint32Array((vw - 1) * (vh - 1) * 6);
    let q = 0;
    for (let j = 0; j < vh - 1; j++) {
      for (let i = 0; i < vw - 1; i++) {
        const a = j * vw + i;
        const b = a + 1;
        const c = a + vw;
        const d = c + 1;
        // 對角線順著高低差較小的方向切，台地的邊比較整齊
        if (Math.abs(hf[a] - hf[d]) < Math.abs(hf[b] - hf[c])) {
          idx[q++] = a;
          idx[q++] = c;
          idx[q++] = d;
          idx[q++] = a;
          idx[q++] = d;
          idx[q++] = b;
        } else {
          idx[q++] = a;
          idx[q++] = c;
          idx[q++] = b;
          idx[q++] = b;
          idx[q++] = c;
          idx[q++] = d;
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('cliff', new THREE.BufferAttribute(cliff, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const mat = new THREE.MeshStandardMaterial({ map: this.texture, roughness: 0.95, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 cliff;\nvarying vec4 vCliff;\nvarying float vWY;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCliff = cliff;\nvWY = (modelMatrix * vec4(transformed, 1.0)).y;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vCliff;\nvarying float vWY;')
        .replace('#include <map_fragment>', '#include <map_fragment>\nfloat strata = 0.9 + 0.1 * step(0.5, fract(vWY * 5.0));\ndiffuseColor.rgb = mix(diffuseColor.rgb, vCliff.rgb * strata, vCliff.a);');
    };
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    return mesh;
  }

  private buildWater(): THREE.Mesh {
    const { w, h } = this;
    const g = new THREE.PlaneGeometry(w, h, 1, 1);
    g.rotateX(-Math.PI / 2);
    g.translate(w / 2, WATER_Y, h / 2);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 6), uv.getY(i) * (h / 6));
    const mat = new THREE.MeshStandardMaterial({ color: PAL.water, transparent: true, opacity: 0.68, roughness: 0.48, metalness: 0, normalMap: this.waterNormal, normalScale: new THREE.Vector2(0.12, 0.12), depthWrite: false });
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    m.renderOrder = 1;
    return m;
  }

  /** 沙盤板四邊的剖面：土層往下到板底；河流切過邊緣的地方是水的切面 */
  private buildSkirt(): THREE.Mesh | null {
    const b = new Builder();
    const { w, h } = this;
    const bands = [col(PAL.cliff), col(PAL.cliffDark), col(0x4d4732), col(0x3e3a2a)];
    const waterC = col(PAL.waterDeep);
    const edge = (pts: [number, number][], out: [number, number, number]): void => {
      for (let k = 0; k + 1 < pts.length; k++) {
        const [x0, z0] = pts[k];
        const [x1, z1] = pts[k + 1];
        const h0 = this.heightAt(x0, z0);
        const h1 = this.heightAt(x1, z1);
        // 由上往下四層土
        const levels = [Math.min(h0, h1), -0.3, -0.9, -1.5, BASE_Y];
        b.quad([x0, h0, z0], [x1, h1, z1], [x1, levels[0], z1], [x0, levels[0], z0], bands[0], out);
        for (let L = 0; L < 4; L++) {
          const top = Math.min(levels[L], levels[0]);
          const bot = levels[L + 1];
          if (bot >= top) continue;
          b.quad([x0, top, z0], [x1, top, z1], [x1, bot, z1], [x0, bot, z0], bands[L], out);
        }
        if (Math.max(h0, h1) < WATER_Y) b.quad([x0, WATER_Y, z0], [x1, WATER_Y, z1], [x1, Math.max(h0, h1), z1], [x0, Math.max(h0, h1), z0], waterC, out);
      }
    };
    const step = 1 / RES;
    const line = (n: number, f: (t: number) => [number, number]): [number, number][] => Array.from({ length: Math.round(n / step) + 1 }, (_, k) => f(k * step));
    edge(line(w, (t) => [t, 0]), [0, 0, -1]);
    edge(line(w, (t) => [t, h]), [0, 0, 1]);
    edge(line(h, (t) => [0, t]), [-1, 0, 0]);
    edge(line(h, (t) => [w, t]), [1, 0, 0]);
    b.quad([0, BASE_Y, 0], [w, BASE_Y, 0], [w, BASE_Y, h], [0, BASE_Y, h], col(0x1a1712), [0, -1, 0]);
    const m = b.build(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }), false);
    return m;
  }
}

/** 水面的細波紋法線圖（程式產生、可平鋪） */
function waterNormalMap(): THREE.Texture {
  const S = 128;
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    // 可平鋪：在環面上取雜訊
    const a = (x / S) * Math.PI * 2;
    const b = (y / S) * Math.PI * 2;
    hgt[y * S + x] = Math.sin(a * 3 + Math.sin(b * 2) * 1.5) * 0.5 + Math.sin(b * 5 + Math.cos(a * 2)) * 0.35 + Math.sin((a + b) * 7) * 0.15;
  }
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = hgt[y * S + ((x + 1) % S)] - hgt[y * S + ((x + S - 1) % S)];
    const dy = hgt[((y + 1) % S) * S + x] - hgt[((y + S - 1) % S) * S + x];
    const nx = -dx;
    const ny = -dy;
    const len = Math.hypot(nx, ny, 1);
    const o = (y * S + x) * 4;
    data[o] = ((nx / len) * 0.5 + 0.5) * 255;
    data[o + 1] = ((ny / len) * 0.5 + 0.5) * 255;
    data[o + 2] = ((1 / len) * 0.5 + 0.5) * 255;
    data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  return t;
}
