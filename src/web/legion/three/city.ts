// 3D 沙盤的建物：城牆（垛口、女牆、城磚）、門洞與城門洞（拱券）、城樓角樓敵樓、民房殿堂塔與牌坊、營帳投石機、橋、馬道。
// 城牆跟著格子（牆格的範圍就是牆）；建物的外觀照地圖的 decor，沒有 decor 的地圖由建築格自動排成民房。
import * as THREE from 'three';
import { T } from '../../../legion/config.ts';
import type { LegionMap, MapDecor } from '../../../legion/map.ts';
import { Builder, type V3 } from './builder.ts';
import { Ground, WALL_H, WATER_Y } from './ground.ts';
import { PAL, col, rand, vary } from './palette.ts';
import { brickTexture, roof, roofTexture } from './roofs.ts';

type Rect = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };

/** 門洞拱券：起拱高度、拱高上限 */
const SPRING = 0.85;
const ARCH_RISE = 1.0;
/** 馬道每一級的高度 */
const STEP = 0.2;

interface Stair {
  /** 範圍（格）、沿哪個軸往上、從哪一端（低端座標）到哪一端 */
  readonly r: Rect;
  readonly alongX: boolean;
  readonly y0: number;
  readonly y1: number;
}

export class City {
  readonly group = new THREE.Group();
  private readonly wallMass: Uint8Array;
  private readonly stairs: Stair[] = [];
  private readonly stairAt: Int16Array;
  /** 橋面：每格屬於哪座橋（-1 ＝ 不是橋）與每座橋的橋面高度 */
  private readonly bridgeAt: Int16Array;
  private readonly decks: { readonly alongX: boolean; readonly p0: number; readonly p1: number; readonly yAt: (t: number) => number }[] = [];
  private readonly materials: THREE.Material[] = [];
  /** 城門的位置（門扇由攻城物件那邊畫）：門洞外側那一面 */
  readonly gatePortals: { readonly r: Rect; readonly alongX: boolean; readonly outerAt: number; readonly y: number; readonly top: number }[] = [];

  private readonly map: LegionMap;
  private readonly ground: Ground;
  private readonly team: readonly string[];

  constructor(map: LegionMap, ground: Ground, team: readonly string[]) {
    this.map = map;
    this.ground = ground;
    this.team = team;
    const { width: w, height: h, terrain } = map;
    const arches: Rect[] = [...(map.archways ?? [])];
    this.wallMass = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (terrain[i] === T.Wall || terrain[i] === T.Gatehouse) this.wallMass[i] = 1;
    for (const a of arches) for (let y = a.y0; y < a.y1; y++) for (let x = a.x0; x < a.x1; x++) this.wallMass[y * w + x] = 2;
    for (const g of map.gates) for (let y = g.y0; y < g.y1; y++) for (let x = g.x0; x < g.x1; x++) this.wallMass[y * w + x] = 3;
    this.stairAt = new Int16Array(w * h).fill(-1);
    this.bridgeAt = new Int16Array(w * h).fill(-1);
    const brick = new THREE.MeshStandardMaterial({ map: brickTexture(), vertexColors: true, roughness: 0.92, metalness: 0 });
    const roofMat = new THREE.MeshStandardMaterial({ map: roofTexture(), vertexColors: true, roughness: 0.8, metalness: 0 });
    const plain = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    this.materials.push(brick, roofMat, plain);
    const walls = new Builder();
    const roofs = new Builder();
    const things = new Builder();
    const decor = map.decor ?? [];
    const towerMask = new Uint8Array(w * h);
    for (const d of decor) if (d.kind.endsWith('Tower')) for (let y = d.y0; y < d.y1; y++) for (let x = d.x0; x < d.x1; x++) towerMask[y * w + x] = 1;
    this.buildWalls(walls, things, towerMask);
    for (const a of arches) this.buildArch(walls, a, false);
    for (const g of map.gates) this.buildArch(walls, g, true);
    this.buildStairs(walls);
    this.buildBridges(things);
    this.buildBreaches(things);
    const covered = new Uint8Array(w * h);
    for (const d of decor) {
      if (d.kind === 'road' || d.kind === 'field' || d.kind === 'moat') continue;
      for (let y = d.y0; y < d.y1; y++) for (let x = d.x0; x < d.x1; x++) covered[y * w + x] = 1;
      this.buildDecor(d, walls, roofs, things);
    }
    // 沒有 decor 的建築格：排成一列列民房
    for (const r of rectsOf(w, h, (i) => terrain[i] === T.Building && covered[i] === 0)) this.autoHouses(r, roofs, things);
    for (const [b, m] of [
      [walls, brick],
      [roofs, roofMat],
      [things, plain],
    ] as const) {
      const mesh = b.build(m);
      if (mesh !== null) this.group.add(mesh);
    }
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.materials) {
      (m as THREE.MeshStandardMaterial).map?.dispose();
      m.dispose();
    }
  }

  /** 牆頂高度（格）：地面高度 ＋ 牆高 */
  wallTop(tx: number, ty: number): number {
    return this.ground.level(tx, ty) + WALL_H;
  }

  /** 站在馬道上的高度（不在馬道上回傳 null） */
  stairHeight(x: number, z: number): number | null {
    const tx = Math.floor(x);
    const ty = Math.floor(z);
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) return null;
    const k = this.stairAt[ty * this.map.width + tx];
    if (k < 0) return null;
    const s = this.stairs[k];
    const t = s.alongX ? (x - s.r.x0) / (s.r.x1 - s.r.x0) : (z - s.r.y0) / (s.r.y1 - s.r.y0);
    return s.y0 + (s.y1 - s.y0) * Math.min(1, Math.max(0, t));
  }

  /** 橋面的高度（不在橋上回傳 null） */
  bridgeHeight(x: number, z: number): number | null {
    const tx = Math.floor(x);
    const ty = Math.floor(z);
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) return null;
    const k = this.bridgeAt[ty * this.map.width + tx];
    if (k < 0) return null;
    const d = this.decks[k];
    const t = ((d.alongX ? x : z) - d.p0) / (d.p1 - d.p0);
    return d.yAt(Math.min(1, Math.max(0, t)));
  }

  /** 地面層站的高度：馬道上沿石階、橋上是橋面，其他是地面 */
  surfaceAt(x: number, z: number): number {
    return this.stairHeight(x, z) ?? this.bridgeHeight(x, z) ?? this.ground.heightAt(x, z);
  }

  private mass(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.map.width || y >= this.map.height) return 0;
    return this.wallMass[y * this.map.width + x];
  }

  // ───────── 城牆 ─────────

  /** 每格牆：牆頂、露出來的牆面、牆腳的石台基；外側（離攻方近的一側）是垛口，內側是矮的女牆 */
  private buildWalls(b: Builder, things: Builder, towerMask: Uint8Array): void {
    const { width: w, height: h, terrain } = this.map;
    const dist = this.groundDistance();
    const side = col(PAL.wallSide);
    const top = col(PAL.wallTop);
    const plinth = col(PAL.stone).multiplyScalar(0.85);
    const merlonC = col(PAL.wallSide).multiplyScalar(1.04);
    const DIRS: [number, number][] = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const m = this.mass(x, y);
        if (m === 0) continue;
        const yt = this.wallTop(x, y);
        const yg = this.ground.level(x, y);
        b.quad([x, yt, y], [x + 1, yt, y], [x + 1, yt, y + 1], [x, yt, y + 1], top, [0, 1, 0], [
          [x, y],
          [x + 1, y],
          [x + 1, y + 1],
          [x, y + 1],
        ]);
        for (const [dx, dy] of DIRS) {
          const nx = x + dx;
          const ny = y + dy;
          const nm = this.mass(nx, ny);
          // 這條邊的兩端點（俯視）與朝外的方向
          const ex0 = dx === 1 ? x + 1 : x;
          const ez0 = dy === 1 ? y + 1 : y;
          const ex1 = dx === 0 ? x + 1 : ex0;
          const ez1 = dy === 0 ? y + 1 : ez0;
          const out: V3 = [dx, 0, dy];
          const uvs = (y0: number, y1: number): [number, number][] => {
            const u0 = dx === 0 ? ex0 : ez0;
            const u1 = dx === 0 ? ex1 : ez1;
            return [
              [u0, y1],
              [u1, y1],
              [u1, y0],
              [u0, y0],
            ];
          };
          if (nm !== 0) {
            const nt = this.wallTop(nx, ny);
            if (nt < yt - 1e-3) b.quad([ex0, yt, ez0], [ex1, yt, ez1], [ex1, nt, ez1], [ex0, nt, ez0], side, out, uvs(nt, yt));
            continue;
          }
          // 門洞的兩頭由拱券那邊畫
          if (m >= 2) {
            const passX = this.passAlongX(x, y);
            if ((passX && dx !== 0) || (!passX && dy !== 0)) continue;
          }
          const bottom = Math.min(yg, this.ground.level(nx, ny)) - 0.4;
          b.quad([ex0, yt, ez0], [ex1, yt, ez1], [ex1, bottom, ez1], [ex0, bottom, ez0], side, out, uvs(bottom, yt));
          // 牆腳的石台基（沿邊往兩端多伸一點，轉角接得起來；重疊的面同色同向，看不出來）
          const o = 0.09;
          const gy = this.ground.level(nx, ny);
          const px0 = dx === -1 ? x - o : dx === 1 ? x + 1 : x - o;
          const px1 = dx === -1 ? x : dx === 1 ? x + 1 + o : x + 1 + o;
          const pz0 = dy === -1 ? y - o : dy === 1 ? y + 1 : y - o;
          const pz1 = dy === -1 ? y : dy === 1 ? y + 1 + o : y + 1 + o;
          if (terrain[ny * w + nx] !== T.Stair) things.box(px0, bottom, pz0, px1, Math.max(gy, yg) + 0.28, pz1, plinth);
          // 垛口或女牆（樓閣底下不做；馬道口不做）
          if (towerMask[y * w + x] === 1) continue;
          if (terrain[ny * w + nx] === T.Stair) continue;
          const outer = this.isOuter(x, y, dx, dy, dist);
          const t = 0.2;
          const sx0 = dx === 1 ? x + 1 - t : x;
          const sx1 = dx === -1 ? x + t : x + 1;
          const sz0 = dy === 1 ? y + 1 - t : y;
          const sz1 = dy === -1 ? y + t : y + 1;
          const ph = outer ? 0.22 : 0.2;
          b.box(sx0, yt, sz0, sx1, yt + ph, sz1, side, top);
          if (outer) {
            for (const f of [0.08, 0.58]) {
              const mx0 = dx === 0 ? x + f : sx0;
              const mx1 = dx === 0 ? x + f + 0.32 : sx1;
              const mz0 = dy === 0 ? y + f : sz0;
              const mz1 = dy === 0 ? y + f + 0.32 : sz1;
              b.box(mx0, yt + ph, mz0, mx1, yt + ph + 0.26, mz1, merlonC, top);
            }
            // 每隔一段插一面守方的旗（旗桿立在垛口內側，旗面順著牆）
            if (this.map.defender >= 0 && (x * 7 + y * 13) % 29 === 0) {
              const px = dx === 0 ? x + 0.5 : dx === 1 ? x + 1 - t - 0.06 : x + t + 0.06;
              const pz = dy === 0 ? y + 0.5 : dy === 1 ? y + 1 - t - 0.06 : y + t + 0.06;
              const flag = new THREE.Color(this.team[this.map.defender] ?? '#ef4444');
              things.box(px - 0.03, yt, pz - 0.03, px + 0.03, yt + 1.5, pz + 0.03, col(PAL.woodDark));
              const along: V3 = dx === 0 ? [1, 0, 0] : [0, 0, 1];
              const fx = (k: number): number => px + along[0] * k;
              const fz = (k: number): number => pz + along[2] * k;
              const nrm: V3 = dx === 0 ? [0, 0, 1] : [1, 0, 0];
              for (const s of [1, -1]) things.quad([fx(0.03), yt + 1.48, fz(0.03)], [fx(0.6), yt + 1.42, fz(0.6)], [fx(0.6), yt + 1.0, fz(0.6)], [fx(0.03), yt + 1.04, fz(0.03)], flag, [nrm[0] * s, 0, nrm[2] * s]);
            }
          }
        }
      }
    }
  }

  /** 門洞格的通行方向：兩頭（沿通行方向）是地面 */
  private passAlongX(x: number, y: number): boolean {
    const r = [...(this.map.archways ?? []), ...this.map.gates].find((a) => x >= a.x0 && x < a.x1 && y >= a.y0 && y < a.y1);
    if (r === undefined) return true;
    return this.mass(r.x0 - 1, Math.floor((r.y0 + r.y1) / 2)) === 0 || this.mass(r.x1, Math.floor((r.y0 + r.y1) / 2)) === 0;
  }

  /** 從地圖西緣出發、只繞過牆（門、門洞、缺口可以穿過）的地面距離：用來判斷牆的哪一側是外側 */
  private groundDistance(): Int32Array {
    const { width: w, height: h, terrain } = this.map;
    const d = new Int32Array(w * h).fill(-1);
    const q = new Int32Array(w * h);
    let head = 0;
    let tail = 0;
    for (let y = 0; y < h; y++) {
      if (terrain[y * w] !== T.Wall) {
        d[y * w] = 0;
        q[tail++] = y * w;
      }
    }
    while (head < tail) {
      const i = q[head++];
      const x = i % w;
      const y = (i - x) / w;
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (d[j] >= 0 || terrain[j] === T.Wall) continue;
        d[j] = d[i] + 1;
        q[tail++] = j;
      }
    }
    return d;
  }

  private isOuter(x: number, y: number, dx: number, dy: number, dist: Int32Array): boolean {
    const w = this.map.width;
    const here = dist[(y + dy) * w + (x + dx)];
    // 往反方向穿過牆，找牆另一側的地面
    for (let k = 1; k < 14; k++) {
      const ox = x - dx * k;
      const oy = y - dy * k;
      if (ox < 0 || oy < 0 || ox >= w || oy >= this.map.height) return true;
      if (this.mass(ox, oy) !== 0) continue;
      const there = dist[oy * w + ox];
      if (here < 0) return false;
      if (there < 0) return true;
      return here < there;
    }
    return true;
  }

  /** 門洞（gate＝有城門）：兩頭的拱券牆面、拱頂、拱下的兩側牆 */
  private buildArch(b: Builder, r: Rect, gate: boolean): void {
    const cxm = Math.floor((r.x0 + r.x1) / 2);
    const cym = Math.floor((r.y0 + r.y1) / 2);
    const alongX = this.mass(r.x0 - 1, cym) === 0 || this.mass(r.x1, cym) === 0;
    const yg = this.ground.level(cxm, cym);
    const top = this.wallTop(cxm, cym);
    const side = col(PAL.wallSide);
    const dark = col(PAL.wallSide).multiplyScalar(0.55);
    // 通行方向 p（沿 alongX 軸）、橫向 u
    const p0 = alongX ? r.x0 : r.y0;
    const p1 = alongX ? r.x1 : r.y1;
    const u0 = alongX ? r.y0 : r.x0;
    const u1 = alongX ? r.y1 : r.x1;
    const span = u1 - u0;
    const rise = Math.min(span / 2, ARCH_RISE);
    const spring = yg + SPRING;
    const N = 12;
    const arc: [number, number][] = [];
    for (let k = 0; k <= N; k++) {
      const a = Math.PI - (k / N) * Math.PI;
      arc.push([u0 + span / 2 + (Math.cos(a) * span) / 2, spring + Math.sin(a) * rise]);
    }
    const P = (p: number, y: number, u: number): V3 => (alongX ? [p, y, u] : [u, y, p]);
    // 兩頭的拱券牆面（拱與牆頂之間）
    for (const [pp, sgn] of [
      [p0, -1],
      [p1, 1],
    ] as const) {
      const contour = [new THREE.Vector2(u0, spring), ...arc.slice(1, -1).map(([u, y]) => new THREE.Vector2(u, y)), new THREE.Vector2(u1, spring), new THREE.Vector2(u1, top), new THREE.Vector2(u0, top)];
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      const out: V3 = alongX ? [sgn, 0, 0] : [0, 0, sgn];
      for (const [i, j, k] of tris) {
        const c = [contour[i], contour[j], contour[k]];
        b.tri(P(pp, c[0].y, c[0].x), P(pp, c[1].y, c[1].x), P(pp, c[2].y, c[2].x), side, out, [
          [c[0].x, c[0].y],
          [c[1].x, c[1].y],
          [c[2].x, c[2].y],
        ]);
      }
      // 拱券的一圈磚（略凸出）
      for (let k = 0; k < N; k++) {
        const [ua, ya] = arc[k];
        const [ub, yb] = arc[k + 1];
        const o = 0.18;
        const da = Math.atan2(ya - spring, ua - (u0 + span / 2));
        const db = Math.atan2(yb - spring, ub - (u0 + span / 2));
        b.quad(P(pp + sgn * 0.03, ya, ua), P(pp + sgn * 0.03, yb, ub), P(pp + sgn * 0.03, yb + Math.sin(db) * o, ub + Math.cos(db) * o), P(pp + sgn * 0.03, ya + Math.sin(da) * o, ua + Math.cos(da) * o), col(PAL.wallTop), out);
      }
    }
    // 拱頂（朝下、朝內）
    for (let k = 0; k < N; k++) {
      const [ua, ya] = arc[k];
      const [ub, yb] = arc[k + 1];
      const mu = (ua + ub) / 2;
      const my = (ya + yb) / 2;
      const c = u0 + span / 2;
      b.quad(P(p0, ya, ua), P(p1, ya, ua), P(p1, yb, ub), P(p0, yb, ub), dark, alongX ? [0, spring - my, c - mu] : [c - mu, spring - my, 0]);
    }
    // 拱下兩側的牆
    for (const [uu, sgn] of [
      [u0, 1],
      [u1, -1],
    ] as const) {
      b.quad(P(p0, yg - 0.1, uu), P(p1, yg - 0.1, uu), P(p1, spring, uu), P(p0, spring, uu), dark, alongX ? [0, 0, sgn] : [sgn, 0, 0]);
    }
    if (gate) {
      // 城門在外側那一頭（離地圖西緣近、或朝北的那一頭）
      const outerP = this.mass(alongX ? r.x0 - 1 : cxm, alongX ? cym : r.y0 - 1) === 0 ? p0 : p1;
      this.gatePortals.push({ r, alongX, outerAt: outerP, y: yg, top: spring + rise });
    }
  }

  /** 馬道：沿牆內側的一段石階 */
  private buildStairs(b: Builder): void {
    const { width: w, height: h, terrain } = this.map;
    const runs = rectsOf(w, h, (i) => terrain[i] === T.Stair);
    const stone = col(PAL.stone);
    const top = col(PAL.wallTop);
    for (const r of runs) {
      const alongX = r.x1 - r.x0 >= r.y1 - r.y0;
      const yg = this.ground.level(r.x0, r.y0);
      // 牆頂：旁邊那道牆的高度
      let wallTop = yg + WALL_H;
      for (let y = r.y0 - 1; y <= r.y1; y++) for (let x = r.x0 - 1; x <= r.x1; x++) if (this.mass(x, y) !== 0) wallTop = Math.max(wallTop, this.wallTop(x, y));
      // 往哪一端爬：牆的轉角那一端較高（兩端都一樣就往座標大的一端）
      const n = Math.max(2, Math.round((wallTop - yg) / STEP));
      const len = alongX ? r.x1 - r.x0 : r.y1 - r.y0;
      const k = this.stairs.length;
      this.stairs.push({ r, alongX, y0: yg, y1: wallTop });
      for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) this.stairAt[y * w + x] = k;
      for (let s = 0; s < n; s++) {
        const a0 = (s / n) * len;
        const a1 = ((s + 1) / n) * len;
        const yy = yg + ((s + 1) / n) * (wallTop - yg);
        if (alongX) b.box(r.x0 + a0, yg - 0.2, r.y0 + 0.05, r.x0 + a1, yy, r.y1 - 0.05, stone, top);
        else b.box(r.x0 + 0.05, yg - 0.2, r.y0 + a0, r.x1 - 0.05, yy, r.y0 + a1, stone, top);
      }
    }
  }

  /** 橋：石拱橋（寬）或木橋（窄）；橋面兩端接到岸上，兩側欄杆 */
  private buildBridges(b: Builder): void {
    const { width: w, height: h, terrain } = this.map;
    for (const r of rectsOf(w, h, (i) => terrain[i] === T.Bridge)) {
      const midY = Math.floor((r.y0 + r.y1) / 2);
      const midX = Math.floor((r.x0 + r.x1) / 2);
      const land = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && terrain[y * w + x] !== T.River && terrain[y * w + x] !== T.Bridge;
      const alongX = land(r.x0 - 1, midY) || land(r.x1, midY);
      const p0 = (alongX ? r.x0 : r.y0) - 0.6;
      const p1 = (alongX ? r.x1 : r.y1) + 0.6;
      const u0 = (alongX ? r.y0 : r.x0) + 0.15;
      const u1 = (alongX ? r.y1 : r.x1) - 0.15;
      const yA = alongX ? this.ground.heightAt(r.x0 - 0.5, midY + 0.5) : this.ground.heightAt(midX + 0.5, r.y0 - 0.5);
      const yB = alongX ? this.ground.heightAt(r.x1 + 0.5, midY + 0.5) : this.ground.heightAt(midX + 0.5, r.y1 + 0.5);
      const deck = Math.max(yA, yB, 0.45) + 0.12;
      const stone = u1 - u0 >= 2.5;
      const body = stone ? col(PAL.stone) : col(PAL.wood);
      const dark = stone ? col(PAL.stone).multiplyScalar(0.7) : col(PAL.woodDark);
      const P = (p: number, y: number, u: number): V3 => (alongX ? [p, y, u] : [u, y, p]);
      // 橋面微微拱起
      const N = 8;
      const yAt = (t: number): number => deck + Math.sin(t * Math.PI) * (stone ? 0.22 : 0.08);
      const k = this.decks.length;
      this.decks.push({ alongX, p0, p1, yAt });
      for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) this.bridgeAt[y * w + x] = k;
      for (let k = 0; k < N; k++) {
        const ta = k / N;
        const tb = (k + 1) / N;
        const pa = p0 + (p1 - p0) * ta;
        const pb = p0 + (p1 - p0) * tb;
        b.quad(P(pa, yAt(ta), u0), P(pb, yAt(tb), u0), P(pb, yAt(tb), u1), P(pa, yAt(ta), u1), body, [0, 1, 0]);
        // 欄杆
        for (const [uu, sg] of [
          [u0, -1],
          [u1, 1],
        ] as const) {
          const ui = uu - sg * 0.12;
          b.quad(P(pa, yAt(ta), uu), P(pb, yAt(tb), uu), P(pb, yAt(tb) + 0.3, uu), P(pa, yAt(ta) + 0.3, uu), dark, alongX ? [0, 0, sg] : [sg, 0, 0]);
          b.quad(P(pa, yAt(ta), ui), P(pb, yAt(tb), ui), P(pb, yAt(tb) + 0.3, ui), P(pa, yAt(ta) + 0.3, ui), dark, alongX ? [0, 0, -sg] : [-sg, 0, 0]);
          b.quad(P(pa, yAt(ta) + 0.3, uu), P(pb, yAt(tb) + 0.3, uu), P(pb, yAt(tb) + 0.3, ui), P(pa, yAt(ta) + 0.3, ui), body, [0, 1, 0]);
        }
        // 木橋：橋面下一層薄板
        if (!stone) for (const [uu, sg] of [
          [u0, -1],
          [u1, 1],
        ] as const) b.quad(P(pa, yAt(ta), uu), P(pb, yAt(tb), uu), P(pb, deck - 0.15, uu), P(pa, deck - 0.15, uu), body, alongX ? [0, 0, sg] : [sg, 0, 0]);
      }
      if (stone) {
        // 石拱橋：兩側立面是橋面以下、拱以上的牆；拱從兩岸起拱，下面是水
        const a0 = alongX ? r.x0 : r.y0;
        const a1 = alongX ? r.x1 : r.y1;
        const spring = WATER_Y - 0.2;
        const crown = Math.min(deck - 0.22, spring + (a1 - a0) * 0.5);
        const bot = -0.7;
        const M = 12;
        const arc: [number, number][] = Array.from({ length: M + 1 }, (_, k) => [a0 + ((a1 - a0) * k) / M, spring + (crown - spring) * Math.sin((Math.PI * k) / M)]);
        const top: [number, number][] = Array.from({ length: N + 1 }, (_, k) => [p1 - ((p1 - p0) * k) / N, yAt(1 - k / N)]);
        const contour = [new THREE.Vector2(p0, bot), new THREE.Vector2(a0, bot), ...arc.map(([p, y]) => new THREE.Vector2(p, y)), new THREE.Vector2(a1, bot), new THREE.Vector2(p1, bot), ...top.map(([p, y]) => new THREE.Vector2(p, y))];
        const tris = THREE.ShapeUtils.triangulateShape(contour, []);
        for (const [uu, sg] of [
          [u0, -1],
          [u1, 1],
        ] as const) {
          const out: V3 = alongX ? [0, 0, sg] : [sg, 0, 0];
          for (const [i, j, k] of tris) b.tri(P(contour[i].x, contour[i].y, uu), P(contour[j].x, contour[j].y, uu), P(contour[k].x, contour[k].y, uu), body, out);
        }
        // 拱腹
        for (let k = 0; k < M; k++) {
          const [pa, ya] = arc[k];
          const [pb, yb] = arc[k + 1];
          b.quad(P(pa, ya, u0), P(pb, yb, u0), P(pb, yb, u1), P(pa, ya, u1), dark, [0, -1, 0]);
        }
        // 兩端接到岸上的橋台
        for (const [pe, pi] of [
          [p0, a0],
          [p1, a1],
        ] as const) {
          const [x0, , z0] = P(Math.min(pe, pi), 0, u0);
          const [x1, , z1] = P(Math.max(pe, pi), 0, u1);
          b.box(Math.min(x0, x1), bot, Math.min(z0, z1), Math.max(x0, x1), Math.min(yAt(0), yAt(1)) - 0.02, Math.max(z0, z1), body, undefined, [false, false, true, true, false, false]);
        }
      }
      if (!stone) {
        for (let p = p0 + 0.8; p < p1 - 0.5; p += 1.2) for (const uu of [u0 + 0.2, u1 - 0.3]) {
          const [x, , z] = P(p, 0, uu);
          b.box(x - 0.08, -0.6, z - 0.08, x + 0.08, deck, z + 0.08, dark);
        }
      }
    }
  }

  /** 缺口：塌下來的城磚堆 */
  private buildBreaches(b: Builder): void {
    for (const r of this.map.breaches ?? []) {
      const c = col(PAL.wallSide);
      for (let k = 0; k < 40; k++) {
        const x = r.x0 + rand(k, r.x0, 1) * (r.x1 - r.x0);
        const z = r.y0 + rand(k, r.y0, 2) * (r.y1 - r.y0);
        const s = 0.12 + rand(k, 3, 3) * 0.25;
        const y = this.ground.heightAt(x, z);
        b.box(x - s, y - 0.05, z - s * 0.7, x + s, y + s * 0.9, z + s * 0.7, vary(PAL.wallSide, k, 0.12));
      }
      // 斷牆兩頭的參差
      for (const ex of [r.x0 - 1, r.x1]) {
        for (let k = 0; k < 4; k++) {
          const z = r.y0 + k + 0.5;
          const yt = this.wallTop(ex, Math.floor(z));
          const hgt = 0.2 + rand(ex, k, 4) * 0.5;
          b.box(ex + 0.1, yt - 0.05, z - 0.45, ex + 0.9, yt + hgt, z + 0.45, c);
        }
      }
    }
  }

  // ───────── 建物 ─────────

  private buildDecor(d: MapDecor, walls: Builder, roofs: Builder, things: Builder): void {
    const seed = d.seed ?? d.x0 * 31 + d.y0;
    switch (d.kind) {
      case 'house':
        return this.house(d, roofs, things, seed, d.thatch === true);
      case 'ruin':
        return this.ruin(d, things, seed);
      case 'hall':
        return this.hall(d, roofs, things);
      case 'longhouse':
        return this.longhouse(d, roofs, things);
      case 'silo':
        return this.silo(d, things);
      case 'stall':
        return this.stall(d, things, seed);
      case 'tent':
        return this.tent(d, things, seed);
      case 'shed':
        return this.shed(d, roofs, things);
      case 'trebuchet':
        return this.trebuchet(d, things);
      case 'gateTower':
      case 'cornerTower':
      case 'wallTower':
      case 'arrowTower':
        return this.tower(d, roofs, things);
      case 'drumTower':
        return this.drumTower(d, walls, roofs, things);
      case 'pagoda':
        return this.pagoda(d, roofs, things);
      case 'pailou':
        return this.pailou(d, roofs, things);
      default:
        return;
    }
  }

  private baseOf(r: Rect): number {
    let y = -Infinity;
    for (let ty = r.y0; ty < r.y1; ty++) for (let tx = r.x0; tx < r.x1; tx++) y = Math.max(y, this.ground.level(tx, ty));
    return y;
  }

  /** 正面朝向 face 的房身：牆、角柱、門窗（深色）；回傳屋身頂高 */
  private body(b: Builder, x0: number, z0: number, x1: number, z1: number, y0: number, hgt: number, face: number, wall: THREE.Color, seed: number, windows = true): number {
    const y1 = y0 + hgt;
    b.box(x0, y0 - 0.3, z0, x1, y0 + 0.12, z1, col(PAL.stone).multiplyScalar(0.9));
    b.box(x0 + 0.03, y0 + 0.12, z0 + 0.03, x1 - 0.03, y1, z1 - 0.03, wall, wall, [false, false, true, true, false, false]);
    const wood = col(PAL.column);
    const c = 0.07;
    for (const [px, pz] of [
      [x0, z0],
      [x1 - c, z0],
      [x0, z1 - c],
      [x1 - c, z1 - c],
    ]) b.box(px, y0 + 0.1, pz, px + c, y1, pz + c, wood);
    if (!windows) return y1;
    // 正面的門與窗（略凸出的深色板）
    const dark = col(0x3b2e24);
    const lat = col(0x5a4636);
    const alongX = face === 1 || face === 3;
    const len = alongX ? x1 - x0 : z1 - z0;
    const n = Math.max(1, Math.round(len / 1.3));
    const doorAt = Math.floor(rand(seed, 1) * n);
    for (let k = 0; k < n; k++) {
      const a = (alongX ? x0 : z0) + ((k + 0.5) / n) * len;
      const door = k === doorAt;
      const hw = door ? 0.2 : 0.17;
      const yb = door ? y0 + 0.12 : y0 + hgt * 0.42;
      const yt = door ? y0 + Math.min(0.78, hgt * 0.75) : y0 + hgt * 0.78;
      const cc = door ? dark : lat;
      const o = 0.02;
      if (face === 1) b.box(a - hw, yb, z1 - 0.04, a + hw, yt, z1 + o, cc);
      else if (face === 3) b.box(a - hw, yb, z0 - o, a + hw, yt, z0 + 0.04, cc);
      else if (face === 0) b.box(x1 - 0.04, yb, a - hw, x1 + o, yt, a + hw, cc);
      else b.box(x0 - o, yb, a - hw, x0 + 0.04, yt, a + hw, cc);
    }
    return y1;
  }

  /** 民房：正面朝 face，屋脊和正面平行；兩層樓的有一圈腰簷 */
  private house(d: Rect & { face?: number; storeys?: number }, roofs: Builder, b: Builder, seed: number, thatch: boolean): void {
    const face = d.face ?? 1;
    const storeys = d.storeys ?? 1;
    const ins = 0.12;
    const x0 = d.x0 + ins;
    const x1 = d.x1 - ins;
    const z0 = d.y0 + ins;
    const z1 = d.y1 - ins;
    const y0 = this.baseOf(d);
    const hgt = (storeys === 2 ? 1.75 : 1.0) + rand(seed, 7) * 0.15;
    const wall = rand(seed, 2) < 0.7 ? vary(PAL.plaster, seed, 0.05) : vary(0xa59a85, seed, 0.05);
    const y1 = this.body(b, x0, z0, x1, z1, y0, hgt, face, wall, seed);
    const alongX = face === 1 || face === 3;
    const len = alongX ? x1 - x0 : z1 - z0;
    const dep = alongX ? z1 - z0 : x1 - x0;
    const roofC = thatch ? vary(PAL.roofThatch, seed, 0.08) : vary(rand(seed, 4) < 0.25 ? 0x7a7f86 : 0x8a8f95, seed, 0.06);
    if (storeys === 2) {
      roof(roofs, { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, len: len + 0.45, depth: dep + 0.5, alongX, y0: y0 + 0.85, rise: 0.3, style: 'hip', color: roofC, lift: 0.05, upTo: 0.34 });
    }
    roof(roofs, { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, len: len + 0.05, depth: dep + 0.5, alongX, y0: y1 - 0.02, rise: dep * 0.33, style: 'gable', color: roofC, lift: 0.06, gableColor: wall });
  }

  private autoHouses(r: Rect, roofs: Builder, b: Builder): void {
    const alongX = r.x1 - r.x0 >= r.y1 - r.y0;
    const len = alongX ? r.x1 - r.x0 : r.y1 - r.y0;
    for (let p = 0; p < len; ) {
      let n = 3 + Math.floor(rand(r.x0 + p, r.y0, 11) * 3);
      if (len - p - n < 2) n = len - p;
      const rr = alongX ? { x0: r.x0 + p, y0: r.y0, x1: r.x0 + p + n, y1: r.y1 } : { x0: r.x0, y0: r.y0 + p, x1: r.x1, y1: r.y0 + p + n };
      const face = alongX ? 1 : 0;
      this.house({ ...rr, face, storeys: 1 }, roofs, b, rr.x0 * 13 + rr.y0, this.map.decor === undefined);
      p += n;
    }
  }

  private ruin(d: Rect, b: Builder, seed: number): void {
    const y0 = this.baseOf(d);
    const wall = vary(0x9c907a, seed, 0.06);
    const x0 = d.x0 + 0.15;
    const x1 = d.x1 - 0.15;
    const z0 = d.y0 + 0.15;
    const z1 = d.y1 - 0.15;
    const t = 0.16;
    const hh = (k: number): number => 0.25 + rand(seed, k) * 0.7;
    b.box(x0, y0 - 0.2, z0, x1, y0 + hh(1), z0 + t, wall);
    b.box(x0, y0 - 0.2, z0, x0 + t, y0 + hh(2), z1, wall);
    b.box(x1 - t, y0 - 0.2, z0, x1, y0 + hh(3) * 0.6, (z0 + z1) / 2, wall);
    b.box((x0 + x1) / 2, y0 - 0.2, z1 - t, x1, y0 + hh(4) * 0.5, z1, wall);
    // 倒下的樑
    const wood = col(PAL.woodDark);
    b.box(x0 + 0.3, y0, (z0 + z1) / 2 - 0.05, x1 - 0.2, y0 + 0.1, (z0 + z1) / 2 + 0.05, wood);
    for (let k = 0; k < 6; k++) {
      const x = x0 + rand(seed, k, 9) * (x1 - x0);
      const z = z0 + rand(seed, k, 10) * (z1 - z0);
      const s = 0.08 + rand(seed, k, 11) * 0.12;
      b.box(x - s, y0, z - s, x + s, y0 + s, z + s, vary(0x8b8172, k, 0.1));
    }
  }

  /** 殿堂：石台基、前廊的柱子、歇山頂（兩層的是重簷） */
  private hall(d: MapDecor, roofs: Builder, b: Builder): void {
    const face = d.face ?? 1;
    const storeys = d.storeys ?? 1;
    const y0 = this.baseOf(d) + 0.3;
    const x0 = d.x0 + 0.15;
    const x1 = d.x1 - 0.15;
    const z0 = d.y0 + 0.15;
    const z1 = d.y1 - 0.15;
    // 台基與台階
    b.box(x0 - 0.05, y0 - 0.65, z0 - 0.05, x1 + 0.05, y0, z1 + 0.05, col(PAL.stone), col(0xa8a397));
    // 屋身往後縮，前面留一排柱廊
    const porch = 0.5;
    const bx0 = x0 + 0.25 + (face === 2 ? porch : 0);
    const bx1 = x1 - 0.25 - (face === 0 ? porch : 0);
    const bz0 = z0 + 0.25 + (face === 3 ? porch : 0);
    const bz1 = z1 - 0.25 - (face === 1 ? porch : 0);
    const hgt = 1.25;
    const y1 = this.body(b, bx0, bz0, bx1, bz1, y0, hgt, face, col(0x8a6a52), d.x0 * 7 + d.y0);
    const wood = col(PAL.column);
    const alongX = face === 1 || face === 3;
    const len = alongX ? x1 - x0 : z1 - z0;
    const n = Math.max(2, Math.round(len / 1.1));
    for (let k = 0; k <= n; k++) {
      const a = (alongX ? x0 + 0.3 : z0 + 0.3) + (k / n) * (len - 0.6);
      const c = 0.07;
      const [px, pz] = face === 1 ? [a, z1 - 0.35] : face === 3 ? [a, z0 + 0.35] : face === 0 ? [x1 - 0.35, a] : [x0 + 0.35, a];
      b.box(px - c, y0, pz - c, px + c, y1, pz + c, wood);
    }
    const dep = alongX ? z1 - z0 : x1 - x0;
    const roofC = vary(PAL.roofDark, d.x0, 0.04);
    if (storeys >= 2) roof(roofs, { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, len: len + 0.6, depth: dep + 0.6, alongX, y0: y1 - 0.05, rise: 0.4, style: 'hip', color: roofC, lift: 0.18, upTo: 0.34 });
    const ry = storeys >= 2 ? y1 + 0.75 : y1;
    roof(roofs, { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, len: len + 0.5, depth: dep + 0.55, alongX, y0: ry, rise: dep * 0.4, style: 'xieshan', color: roofC, lift: 0.22, gableColor: col(0x7a5a44) });
  }

  /** 長屋（營房、倉）：低台基、四坡頂 */
  private longhouse(d: MapDecor, roofs: Builder, b: Builder): void {
    const face = d.face ?? 1;
    const x0 = d.x0 + 0.2;
    const x1 = d.x1 - 0.2;
    const z0 = d.y0 + 0.2;
    const z1 = d.y1 - 0.2;
    const y0 = this.baseOf(d) + 0.1;
    const y1 = this.body(b, x0, z0, x1, z1, y0, 1.05, face, vary(0x9a8a70, d.x0, 0.05), d.x0 + d.y0);
    const alongX = x1 - x0 >= z1 - z0;
    const len = alongX ? x1 - x0 : z1 - z0;
    const dep = alongX ? z1 - z0 : x1 - x0;
    roof(roofs, { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, len: len + 0.45, depth: dep + 0.5, alongX, y0: y1 - 0.02, rise: dep * 0.36, style: 'hip', color: vary(PAL.roofSlate, d.x0, 0.05), lift: 0.1 });
  }

  /** 圓倉：圓筒倉身、茅草尖頂 */
  private silo(d: MapDecor, b: Builder): void {
    const cx = (d.x0 + d.x1) / 2;
    const cz = (d.y0 + d.y1) / 2;
    const r = Math.min(d.x1 - d.x0, d.y1 - d.y0) / 2 - 0.2;
    const y0 = this.baseOf(d);
    b.prism(cx, cz, y0 - 0.2, y0 + 0.25, r + 0.08, r + 0.08, 12, col(PAL.stone));
    b.prism(cx, cz, y0 + 0.25, y0 + 1.3, r, r, 12, vary(PAL.plaster, d.x0, 0.04), 0, false);
    b.cone(cx, cz, y0 + 1.2, y0 + 2.2, r + 0.3, 12, vary(PAL.roofThatch, d.x0, 0.06));
  }

  private stall(d: MapDecor, b: Builder, seed: number): void {
    const y0 = this.baseOf(d);
    const x0 = d.x0 + 0.1;
    const x1 = d.x1 - 0.1;
    const z0 = d.y0 + 0.05;
    const z1 = d.y1 - 0.05;
    const wood = col(PAL.woodDark);
    for (const [px, pz] of [
      [x0, z0],
      [x1 - 0.06, z0],
      [x0, z1 - 0.06],
      [x1 - 0.06, z1 - 0.06],
    ]) b.box(px, y0, pz, px + 0.06, y0 + 0.95, pz + 0.06, wood);
    const cloth = [0x6f7d8c, 0x9a7b4f, 0x7c5a4a, 0x8a8f6a, 0xa49470][Math.floor(rand(seed, 5) * 5)];
    b.quad([x0 - 0.1, y0 + 1.05, z0 - 0.15], [x1 + 0.1, y0 + 1.05, z0 - 0.15], [x1 + 0.1, y0 + 0.85, z1 + 0.25], [x0 - 0.1, y0 + 0.85, z1 + 0.25], col(cloth), [0, 1, 0.3]);
    b.quad([x0 - 0.1, y0 + 1.05, z0 - 0.15], [x1 + 0.1, y0 + 1.05, z0 - 0.15], [x1 + 0.1, y0 + 0.85, z1 + 0.25], [x0 - 0.1, y0 + 0.85, z1 + 0.25], col(cloth).multiplyScalar(0.6), [0, -1, -0.3]);
    b.box(x0 + 0.1, y0, z0 + 0.15, x1 - 0.1, y0 + 0.4, z1 - 0.15, col(PAL.wood));
    for (let k = 0; k < 5; k++) {
      const x = x0 + 0.2 + rand(seed, k, 3) * (x1 - x0 - 0.5);
      const s = 0.08 + rand(seed, k, 4) * 0.06;
      b.box(x, y0 + 0.4, (z0 + z1) / 2 - s, x + s * 2, y0 + 0.4 + s * 1.5, (z0 + z1) / 2 + s, vary([0xa38a5c, 0x7d8a5a, 0x9a6a4a][k % 3], k, 0.1));
    }
  }

  /** 營帳：人字形帆布帳，帳頂插一面攻方的小旗 */
  private tent(d: MapDecor, b: Builder, seed: number): void {
    const y0 = this.baseOf(d);
    const x0 = d.x0 + 0.2;
    const x1 = d.x1 - 0.2;
    const z0 = d.y0 + 0.15;
    const z1 = d.y1 - 0.15;
    const alongX = x1 - x0 >= z1 - z0;
    const cv = vary(PAL.canvas, seed, 0.05);
    const top = y0 + 1.15;
    if (alongX) {
      const zm = (z0 + z1) / 2;
      b.quad([x0, y0, z0], [x1, y0, z0], [x1, top, zm], [x0, top, zm], cv, [0, 0.5, -1]);
      b.quad([x0, y0, z1], [x1, y0, z1], [x1, top, zm], [x0, top, zm], cv.clone().multiplyScalar(0.92), [0, 0.5, 1]);
      b.tri([x0, y0, z0], [x0, y0, z1], [x0, top, zm], cv.clone().multiplyScalar(0.85), [-1, 0, 0]);
      b.tri([x1, y0, z0], [x1, y0, z1], [x1, top, zm], cv.clone().multiplyScalar(0.85), [1, 0, 0]);
      b.tri([x1 + 0.01, y0, zm - 0.18], [x1 + 0.01, y0, zm + 0.18], [x1 + 0.01, y0 + 0.65, zm], col(0x5e5444), [1, 0, 0]);
      b.box(x0 + 0.1, top, zm - 0.03, x0 + 0.16, top + 0.7, zm + 0.03, col(PAL.woodDark));
      b.quad([x0 + 0.16, top + 0.7, zm], [x0 + 0.7, top + 0.6, zm], [x0 + 0.7, top + 0.42, zm], [x0 + 0.16, top + 0.46, zm], new THREE.Color(this.team[0] ?? '#3b82f6'), [0, 0, 1]);
      b.quad([x0 + 0.16, top + 0.7, zm], [x0 + 0.7, top + 0.6, zm], [x0 + 0.7, top + 0.42, zm], [x0 + 0.16, top + 0.46, zm], new THREE.Color(this.team[0] ?? '#3b82f6'), [0, 0, -1]);
    } else {
      const xm = (x0 + x1) / 2;
      b.quad([x0, y0, z0], [x0, y0, z1], [xm, top, z1], [xm, top, z0], cv, [-1, 0.5, 0]);
      b.quad([x1, y0, z0], [x1, y0, z1], [xm, top, z1], [xm, top, z0], cv.clone().multiplyScalar(0.92), [1, 0.5, 0]);
      b.tri([x0, y0, z0], [x1, y0, z0], [xm, top, z0], cv.clone().multiplyScalar(0.85), [0, 0, -1]);
      b.tri([x0, y0, z1], [x1, y0, z1], [xm, top, z1], cv.clone().multiplyScalar(0.85), [0, 0, 1]);
    }
  }

  /** 器械工坊：木柱撐起的單坡棚、木料堆 */
  private shed(d: MapDecor, roofs: Builder, b: Builder): void {
    const y0 = this.baseOf(d);
    const x0 = d.x0 + 0.2;
    const x1 = d.x1 - 0.2;
    const z0 = d.y0 + 0.2;
    const z1 = d.y1 - 0.2;
    const wood = col(PAL.woodDark);
    for (let x = x0; x <= x1 + 1e-3; x += (x1 - x0) / 3) for (const z of [z0, z1 - 0.1]) b.box(x - 0.05, y0, z, x + 0.05, y0 + 1.2, z + 0.1, wood);
    roof(roofs, { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, len: x1 - x0 + 0.4, depth: z1 - z0 + 0.5, alongX: true, y0: y0 + 1.15, rise: 0.5, style: 'gable', color: vary(PAL.roofThatch, 3, 0.05), lift: 0.03, gableColor: col(PAL.wood) });
    for (let k = 0; k < 6; k++) b.box(x0 + 0.3 + k * 0.12, y0, z0 + 0.4, x0 + 0.4 + k * 0.12, y0 + 0.1 + (k % 3) * 0.1, z1 - 0.4, col(PAL.wood));
    b.box(x1 - 1.4, y0, z0 + 0.5, x1 - 0.4, y0 + 0.35, z1 - 0.5, col(PAL.wood).multiplyScalar(0.9));
  }

  /** 投石機（只是擺設）：兩副 A 字架、長臂、配重箱 */
  private trebuchet(d: MapDecor, b: Builder): void {
    const y0 = this.baseOf(d);
    const cx = (d.x0 + d.x1) / 2;
    const cz = (d.y0 + d.y1) / 2;
    const wood = col(PAL.wood);
    const dark = col(PAL.woodDark);
    b.box(cx - 1.1, y0, cz - 0.6, cx + 1.1, y0 + 0.15, cz - 0.45, dark);
    b.box(cx - 1.1, y0, cz + 0.45, cx + 1.1, y0 + 0.15, cz + 0.6, dark);
    for (const z of [cz - 0.5, cz + 0.5]) {
      b.quad([cx - 0.7, y0 + 0.1, z - 0.05], [cx - 0.6, y0 + 0.1, z - 0.05], [cx + 0.05, y0 + 1.9, z - 0.05], [cx - 0.05, y0 + 1.9, z - 0.05], wood, [0, 0, -1]);
      b.quad([cx + 0.7, y0 + 0.1, z + 0.05], [cx + 0.6, y0 + 0.1, z + 0.05], [cx - 0.05, y0 + 1.9, z + 0.05], [cx + 0.05, y0 + 1.9, z + 0.05], wood, [0, 0, 1]);
      b.quad([cx - 0.7, y0 + 0.1, z + 0.05], [cx - 0.6, y0 + 0.1, z + 0.05], [cx + 0.05, y0 + 1.9, z + 0.05], [cx - 0.05, y0 + 1.9, z + 0.05], wood, [0, 0, 1]);
      b.quad([cx + 0.7, y0 + 0.1, z - 0.05], [cx + 0.6, y0 + 0.1, z - 0.05], [cx - 0.05, y0 + 1.9, z - 0.05], [cx + 0.05, y0 + 1.9, z - 0.05], wood, [0, 0, -1]);
    }
    b.box(cx - 0.06, y0 + 1.82, cz - 0.6, cx + 0.06, y0 + 1.94, cz + 0.6, dark);
    // 長臂（往西翹起，等著發射）
    const ax0 = cx + 0.9;
    const ay0 = y0 + 1.3;
    const ax1 = cx - 2.0;
    const ay1 = y0 + 3.0;
    b.quad([ax0, ay0, cz - 0.06], [ax1, ay1, cz - 0.06], [ax1, ay1 + 0.1, cz - 0.06], [ax0, ay0 + 0.12, cz - 0.06], wood, [0, 0, -1]);
    b.quad([ax0, ay0, cz + 0.06], [ax1, ay1, cz + 0.06], [ax1, ay1 + 0.1, cz + 0.06], [ax0, ay0 + 0.12, cz + 0.06], wood, [0, 0, 1]);
    b.quad([ax0, ay0 + 0.12, cz - 0.06], [ax1, ay1 + 0.1, cz - 0.06], [ax1, ay1 + 0.1, cz + 0.06], [ax0, ay0 + 0.12, cz + 0.06], wood, [0, 1, 0]);
    b.box(ax0 - 0.25, ay0 - 0.55, cz - 0.3, ax0 + 0.25, ay0 - 0.05, cz + 0.3, dark);
  }

  /** 城樓、角樓、敵樓、箭樓：建在牆頂的樓閣；一樓是柱廊（站在裡面的兵看得到），二樓有牆與窗 */
  private tower(d: MapDecor, roofs: Builder, b: Builder, base?: number): void {
    const storeys = d.storeys ?? 1;
    let y0 = base ?? -Infinity;
    if (base === undefined) for (let ty = d.y0; ty < d.y1; ty++) for (let tx = d.x0; tx < d.x1; tx++) if (this.mass(tx, ty) !== 0) y0 = Math.max(y0, this.wallTop(tx, ty));
    if (!Number.isFinite(y0)) y0 = this.baseOf(d) + WALL_H;
    const ins = d.kind === 'wallTower' ? 0.45 : 0.35;
    const x0 = d.x0 + ins;
    const x1 = d.x1 - ins;
    const z0 = d.y0 + ins;
    const z1 = d.y1 - ins;
    const wood = col(PAL.column);
    const beam = col(0x5c4434);
    const alongX = x1 - x0 >= z1 - z0;
    const len = alongX ? x1 - x0 : z1 - z0;
    const dep = alongX ? z1 - z0 : x1 - x0;
    // 一樓：地板、欄杆、柱子、樑
    const h1 = d.kind === 'wallTower' ? 1.0 : 1.15;
    b.box(x0, y0, z0, x1, y0 + 0.08, z1, col(0x7d6a58));
    const colsAlong = (a0: number, a1: number): number[] => {
      const n = Math.max(1, Math.round((a1 - a0) / 1.0));
      return Array.from({ length: n + 1 }, (_, k) => a0 + ((a1 - a0) * k) / n);
    };
    const c = 0.075;
    for (const x of colsAlong(x0 + 0.1, x1 - 0.1)) for (const z of [z0 + 0.1, z1 - 0.1]) b.box(x - c, y0, z - c, x + c, y0 + h1, z + c, wood);
    for (const z of colsAlong(z0 + 0.1, z1 - 0.1)) for (const x of [x0 + 0.1, x1 - 0.1]) b.box(x - c, y0, z - c, x + c, y0 + h1, z + c, wood);
    b.box(x0, y0 + h1 - 0.14, z0, x1, y0 + h1, z1, beam, beam, [false, false, false, false, false, false]);
    for (const [ax0, az0, ax1, az1] of [
      [x0, z0, x1, z0 + 0.05],
      [x0, z1 - 0.05, x1, z1],
      [x0, z0, x0 + 0.05, z1],
      [x1 - 0.05, z0, x1, z1],
    ]) b.box(ax0, y0 + 0.08, az0, ax1, y0 + 0.3, az1, col(0x6b5444));
    const roofC = vary(PAL.roofDark, d.x0 + d.y0, 0.03);
    const gable = col(0x6e5242);
    if (storeys === 1) {
      roof(roofs, { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, len: len + 0.7, depth: dep + 0.7, alongX, y0: y0 + h1 - 0.02, rise: Math.min(1.6, (dep + 0.7) * 0.42), style: d.kind === 'wallTower' ? 'hip' : 'xieshan', color: roofC, lift: 0.22, gableColor: gable });
      return;
    }
    // 二樓：腰簷、內縮的樓身（四面窗格；箭樓是一排排箭窗）
    roof(roofs, { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, len: len + 0.8, depth: dep + 0.8, alongX, y0: y0 + h1 - 0.05, rise: 0.5, style: 'hip', color: roofC, lift: 0.2, upTo: 0.34 });
    const i2 = 0.45;
    const y2 = y0 + h1 + 0.12;
    const h2 = d.kind === 'arrowTower' ? 1.25 : 0.95;
    const wallC = d.kind === 'arrowTower' ? col(PAL.wallSide) : col(0x7f5f4a);
    b.box(x0 + i2, y2 - 0.15, z0 + i2, x1 - i2, y2 + h2, z1 - i2, wallC, wallC, [false, false, true, true, false, false]);
    const win = col(0x2e241c);
    const rows = d.kind === 'arrowTower' ? 3 : 1;
    for (let r = 0; r < rows; r++) {
      const wy0 = y2 + 0.15 + (r * (h2 - 0.3)) / rows;
      const wy1 = wy0 + (d.kind === 'arrowTower' ? 0.16 : 0.5);
      const step = d.kind === 'arrowTower' ? 0.55 : 0.75;
      for (let x = x0 + i2 + 0.3; x < x1 - i2 - 0.2; x += step) {
        b.box(x, wy0, z0 + i2 - 0.02, x + (d.kind === 'arrowTower' ? 0.16 : 0.42), wy1, z0 + i2 + 0.01, win);
        b.box(x, wy0, z1 - i2 - 0.01, x + (d.kind === 'arrowTower' ? 0.16 : 0.42), wy1, z1 - i2 + 0.02, win);
      }
      for (let z = z0 + i2 + 0.3; z < z1 - i2 - 0.2; z += step) {
        b.box(x0 + i2 - 0.02, wy0, z, x0 + i2 + 0.01, wy1, z + (d.kind === 'arrowTower' ? 0.16 : 0.42), win);
        b.box(x1 - i2 - 0.01, wy0, z, x1 - i2 + 0.02, wy1, z + (d.kind === 'arrowTower' ? 0.16 : 0.42), win);
      }
    }
    const l2 = len - 2 * i2;
    const d2 = dep - 2 * i2;
    roof(roofs, { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, len: l2 + 0.9, depth: d2 + 0.9, alongX, y0: y2 + h2 - 0.02, rise: Math.min(1.7, (d2 + 0.9) * 0.45), style: 'xieshan', color: roofC, lift: 0.28, gableColor: gable });
  }

  /** 鼓樓：城磚墩台（四面拱門）上一座兩層的樓 */
  private drumTower(d: MapDecor, walls: Builder, roofs: Builder, b: Builder): void {
    const y0 = this.baseOf(d);
    const x0 = d.x0 + 0.1;
    const x1 = d.x1 - 0.1;
    const z0 = d.y0 + 0.1;
    const z1 = d.y1 - 0.1;
    const top = y0 + 1.7;
    walls.box(x0, y0 - 0.3, z0, x1, top, z1, col(PAL.wallSide), col(PAL.wallTop));
    // 四面的拱門（深色的拱形）
    const dark = col(0x2b2620);
    const arch = (cx: number, cz: number, alongX: boolean, sgn: number): void => {
      const N = 8;
      const hw = 0.55;
      for (let k = 0; k < N; k++) {
        const a0 = Math.PI - (k / N) * Math.PI;
        const a1 = Math.PI - ((k + 1) / N) * Math.PI;
        const pa = (a: number): V3 => (alongX ? [cx + Math.cos(a) * hw, y0 + 0.75 + Math.sin(a) * 0.45, cz] : [cx, y0 + 0.75 + Math.sin(a) * 0.45, cz + Math.cos(a) * hw]);
        const ba = (a: number): V3 => (alongX ? [cx + Math.cos(a) * hw, y0, cz] : [cx, y0, cz + Math.cos(a) * hw]);
        b.quad(ba(a0), ba(a1), pa(a1), pa(a0), dark, alongX ? [0, 0, sgn] : [sgn, 0, 0]);
      }
    };
    const mx = (x0 + x1) / 2;
    const mz = (z0 + z1) / 2;
    arch(mx, z0 - 0.02, true, -1);
    arch(mx, z1 + 0.02, true, 1);
    arch(x0 - 0.02, mz, false, -1);
    arch(x1 + 0.02, mz, false, 1);
    // 墩台上的女牆
    for (const [ax0, az0, ax1, az1] of [
      [x0, z0, x1, z0 + 0.15],
      [x0, z1 - 0.15, x1, z1],
      [x0, z0, x0 + 0.15, z1],
      [x1 - 0.15, z0, x1, z1],
    ]) walls.box(ax0, top, az0, ax1, top + 0.25, az1, col(PAL.wallSide), col(PAL.wallTop));
    // 樓
    this.tower({ ...d, kind: 'gateTower', x0: d.x0 + 0.6, y0: d.y0 + 0.9, x1: d.x1 - 0.6, y1: d.y1 - 0.9, storeys: 2 }, roofs, b, top);
  }

  /** 八角塔：台基、七層（一層比一層小），每層一圈出簷，頂上塔剎 */
  private pagoda(d: MapDecor, roofs: Builder, b: Builder): void {
    const y0 = this.baseOf(d);
    const cx = (d.x0 + d.x1) / 2;
    const cz = (d.y0 + d.y1) / 2;
    const n = d.storeys ?? 7;
    const rot = Math.PI / 8;
    b.prism(cx, cz, y0 - 0.2, y0 + 0.35, 2.0, 1.95, 8, col(PAL.stone), rot);
    let y = y0 + 0.35;
    const bodyC = col(0xb3a68e);
    const eaveC = vary(PAL.roofDark, 3, 0.02);
    for (let k = 0; k < n; k++) {
      const r = 1.45 - k * 0.12;
      const hgt = k === 0 ? 1.15 : 0.72;
      b.prism(cx, cz, y, y + hgt, r, r * 0.98, 8, bodyC, rot, false);
      // 每面一個深色的窗（隔一面）
      for (let f = 0; f < 8; f += 2) {
        const a = rot + ((f + 0.5) / 8) * Math.PI * 2;
        const wx = cx + Math.cos(a) * (r * 0.93);
        const wz = cz + Math.sin(a) * (r * 0.93);
        b.box(wx - 0.08, y + hgt * 0.3, wz - 0.08, wx + 0.08, y + hgt * 0.75, wz + 0.08, col(0x2e241c));
      }
      y += hgt;
      // 出簷：外緣往上翹的一圈
      const ro = r + 0.5;
      for (let f = 0; f < 8; f++) {
        const a0 = rot + (f / 8) * Math.PI * 2;
        const a1 = rot + ((f + 1) / 8) * Math.PI * 2;
        const out = (a: number, rr: number, yy: number): V3 => [cx + Math.cos(a) * rr, yy, cz + Math.sin(a) * rr];
        const mid = (a0 + a1) / 2;
        roofs.quad(out(a0, ro, y + 0.06), out(a1, ro, y + 0.06), out(a1, r * 0.9, y + 0.32), out(a0, r * 0.9, y + 0.32), eaveC, [Math.cos(mid), 1.2, Math.sin(mid)]);
        roofs.quad(out(a0, ro, y + 0.06), out(a1, ro, y + 0.06), out(a1, r * 0.9, y - 0.02), out(a0, r * 0.9, y - 0.02), eaveC.clone().multiplyScalar(0.6), [Math.cos(mid), -1, Math.sin(mid)]);
        // 翹角
        roofs.tri(out(a0, ro, y + 0.06), out(a0, ro + 0.12, y + 0.2), out(a0, ro - 0.1, y + 0.12), eaveC, [Math.cos(a0), 0.5, Math.sin(a0)]);
      }
      y += 0.18;
    }
    // 塔剎
    b.cone(cx, cz, y, y + 0.7, 0.75, 8, eaveC, rot);
    b.prism(cx, cz, y + 0.5, y + 1.7, 0.06, 0.04, 6, col(0x6a5a3a));
    for (let k = 0; k < 4; k++) b.prism(cx, cz, y + 0.75 + k * 0.18, y + 0.8 + k * 0.18, 0.2 - k * 0.03, 0.2 - k * 0.03, 8, col(0x8a7a50));
  }

  /** 牌坊：柱子、額枋、三座小屋頂（立在街上，不擋路） */
  private pailou(d: MapDecor, roofs: Builder, b: Builder): void {
    const y0 = this.baseOf(d);
    const alongX = d.x1 - d.x0 >= d.y1 - d.y0;
    const a0 = (alongX ? d.x0 : d.y0) + 0.3;
    const a1 = (alongX ? d.x1 : d.y1) - 0.3;
    const c = alongX ? (d.y0 + d.y1) / 2 : (d.x0 + d.x1) / 2;
    const stone = col(0xa9a294);
    const P = (a: number, y: number, cc: number): V3 => (alongX ? [a, y, cc] : [cc, y, a]);
    const span = a1 - a0;
    const posts = [a0, a0 + span * 0.3, a1 - span * 0.3, a1];
    for (const a of posts) {
      const [x, , z] = P(a, 0, c);
      b.box(x - 0.11, y0 - 0.2, z - 0.11, x + 0.11, y0 + 2.2, z + 0.11, stone);
      b.box(x - 0.2, y0, z - 0.25, x + 0.2, y0 + 0.4, z + 0.25, stone.clone().multiplyScalar(0.9));
    }
    const beam = (aa0: number, aa1: number, yy: number, th: number): void => {
      const [x0, , z0] = P(aa0, 0, c - 0.12);
      const [x1, , z1] = P(aa1, 0, c + 0.12);
      b.box(Math.min(x0, x1), yy, Math.min(z0, z1), Math.max(x0, x1), yy + th, Math.max(z0, z1), col(0x7a6a58));
    };
    beam(a0, a1, y0 + 1.75, 0.18);
    beam(posts[1], posts[2], y0 + 2.2, 0.3);
    const roofC = vary(PAL.roofDark, 7, 0.02);
    const mid = (a0 + a1) / 2;
    const at = (a: number): [number, number] => (alongX ? [a, c] : [c, a]);
    const [mcx, mcz] = at(mid);
    roof(roofs, { cx: mcx, cz: mcz, len: posts[2] - posts[1] + 0.8, depth: 0.9, alongX, y0: y0 + 2.5, rise: 0.45, style: 'hip', color: roofC, lift: 0.18 });
    for (const [s0, s1] of [
      [posts[0], posts[1]],
      [posts[2], posts[3]],
    ]) {
      const [sx, sz] = at((s0 + s1) / 2);
      roof(roofs, { cx: sx, cz: sz, len: s1 - s0 + 0.5, depth: 0.75, alongX, y0: y0 + 1.95, rise: 0.35, style: 'hip', color: roofC, lift: 0.14 });
    }
  }
}

/** 把符合條件的格貪婪地切成矩形（含 x0／y0、不含 x1／y1） */
export function rectsOf(w: number, h: number, ok: (i: number) => boolean): Rect[] {
  const used = new Uint8Array(w * h);
  const out: Rect[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (used[i] === 1 || !ok(i)) continue;
      let x1 = x;
      while (x1 < w && used[y * w + x1] === 0 && ok(y * w + x1)) x1++;
      let y1 = y + 1;
      for (; y1 < h; y1++) {
        let full = true;
        for (let xx = x; xx < x1; xx++) if (used[y1 * w + xx] === 1 || !ok(y1 * w + xx)) full = false;
        if (!full) break;
      }
      for (let yy = y; yy < y1; yy++) for (let xx = x; xx < x1; xx++) used[yy * w + xx] = 1;
      out.push({ x0: x, y0: y, x1, y1 });
    }
  }
  return out;
}
