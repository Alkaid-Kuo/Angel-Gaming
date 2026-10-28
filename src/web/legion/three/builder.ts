// 合併幾何：把一大堆方塊、三角面、屋頂收成一個網格（頂點色、每個面自己的法線），整座城只要幾次繪製。
import * as THREE from 'three';

export type V3 = readonly [number, number, number];

export class Builder {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly uv: number[] = [];

  get empty(): boolean {
    return this.pos.length === 0;
  }

  /** 三角形；out 給了就把正面翻向 out 那一側 */
  tri(a: V3, b: V3, c: V3, color: THREE.Color, out?: V3, uvs?: readonly [number, number][]): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    let p: readonly V3[] = [a, b, c];
    let t = uvs;
    if (out !== undefined && nx * out[0] + ny * out[1] + nz * out[2] < 0) {
      p = [a, c, b];
      if (t !== undefined) t = [t[0], t[2], t[1]];
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    for (let i = 0; i < 3; i++) {
      this.pos.push(p[i][0], p[i][1], p[i][2]);
      this.nor.push(nx / len, ny / len, nz / len);
      this.col.push(color.r, color.g, color.b);
      if (t !== undefined) this.uv.push(t[i][0], t[i][1]);
      else this.uv.push(p[i][0] + p[i][2], p[i][1]);
    }
  }

  /** 每個頂點各自的法線與顏色（平滑曲面，例如樹冠）；正面朝法線那一側 */
  triSmooth(a: V3, b: V3, c: V3, na: V3, nb: V3, nc: V3, ca: THREE.Color, cb: THREE.Color, cc: THREE.Color): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const fx = uy * vz - uz * vy;
    const fy = uz * vx - ux * vz;
    const fz = ux * vy - uy * vx;
    const flip = fx * (na[0] + nb[0] + nc[0]) + fy * (na[1] + nb[1] + nc[1]) + fz * (na[2] + nb[2] + nc[2]) < 0;
    const pts: [V3, V3, THREE.Color][] = flip ? [[a, na, ca], [c, nc, cc], [b, nb, cb]] : [[a, na, ca], [b, nb, cb], [c, nc, cc]];
    for (const [p, n, col] of pts) {
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(n[0], n[1], n[2]);
      this.col.push(col.r, col.g, col.b);
      this.uv.push(p[0] + p[2], p[1]);
    }
  }

  /** 四邊形 a b c d（依序繞一圈） */
  quad(a: V3, b: V3, c: V3, d: V3, color: THREE.Color, out?: V3, uvs?: readonly [number, number][]): void {
    this.tri(a, b, c, color, out, uvs === undefined ? undefined : [uvs[0], uvs[1], uvs[2]]);
    this.tri(a, c, d, color, out, uvs === undefined ? undefined : [uvs[0], uvs[2], uvs[3]]);
  }

  /** 軸對齊的方塊；skip 依序是 [-x, +x, -y, +y, -z, +z] 要不要省略（看不到的面） */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: THREE.Color, top?: THREE.Color, skip: readonly boolean[] = [false, false, true, false, false, false]): void {
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const cz = (z0 + z1) / 2;
    const uvW = (a: number, b: number): [number, number][] => [
      [a, y0],
      [b, y0],
      [b, y1],
      [a, y1],
    ];
    if (!skip[0]) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], color, [x0 - cx - 1, 0, 0], uvW(z0, z1));
    if (!skip[1]) this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], color, [x1 - cx + 1, 0, 0], uvW(z0, z1));
    if (!skip[2]) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], color, [0, y0 - cy - 1, 0]);
    if (!skip[3]) this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], top ?? color, [0, y1 - cy + 1, 0], [
      [x0, z0],
      [x1, z0],
      [x1, z1],
      [x0, z1],
    ]);
    if (!skip[4]) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], color, [0, 0, z0 - cz - 1], uvW(x0, x1));
    if (!skip[5]) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], color, [0, 0, z1 - cz + 1], uvW(x0, x1));
  }

  /** 正多邊形柱（塔身、柱子）：n 邊、底半徑 r0、頂半徑 r1 */
  prism(cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, n: number, color: THREE.Color, rot = 0, capTop = true): void {
    for (let i = 0; i < n; i++) {
      const a0 = rot + (i / n) * Math.PI * 2;
      const a1 = rot + ((i + 1) / n) * Math.PI * 2;
      const p = (a: number, r: number, y: number): V3 => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      const mid = (a0 + a1) / 2;
      this.quad(p(a0, r0, y0), p(a1, r0, y0), p(a1, r1, y1), p(a0, r1, y1), color, [Math.cos(mid), 0, Math.sin(mid)]);
      if (capTop) this.tri(p(a0, r1, y1), p(a1, r1, y1), [cx, y1, cz], color, [0, 1, 0]);
    }
  }

  /** 角錐（頂點在 apex） */
  cone(cx: number, cz: number, y0: number, apex: number, r: number, n: number, color: THREE.Color, rot = 0): void {
    for (let i = 0; i < n; i++) {
      const a0 = rot + (i / n) * Math.PI * 2;
      const a1 = rot + ((i + 1) / n) * Math.PI * 2;
      const mid = (a0 + a1) / 2;
      this.tri([cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r], [cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r], [cx, apex, cz], color, [Math.cos(mid), 0.6, Math.sin(mid)]);
    }
  }

  /** 收成網格（沒有任何面就回傳 null） */
  build(material: THREE.Material, shadows = true): THREE.Mesh | null {
    if (this.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, material);
    m.castShadow = shadows;
    m.receiveShadow = true;
    return m;
  }

  /** 收成幾何（給 InstancedMesh 用） */
  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }
}
