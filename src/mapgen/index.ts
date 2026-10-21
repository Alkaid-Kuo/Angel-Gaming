// 程序生成地圖：只為第 0 號扇區產生物件，再旋轉複製到其他扇區；物件聯集對旋轉不變，因此對稱自動成立。
// 全程整數運算（角度用查表），確保 Node 與各瀏覽器產生同一張地圖。
import { MAP_MODES, MAPGEN, RULES, TERRAIN, TILE_SIZE, type MatchMode, type TerrainCode } from '../config/index.ts';
import { hashInts } from '../shared/hash.ts';
import { idiv, isqrt } from '../shared/intmath.ts';
import { Prng } from '../shared/prng.ts';
import { angleOf, icos, isin, TRIG_SCALE } from '../shared/trig.ts';

export type AreaKind = 'main' | 'expansion' | 'rich';

export interface MapNodeDef {
  readonly tileX: number;
  readonly tileY: number;
  readonly rich: boolean;
  readonly areaId: number;
  readonly reserve: number;
}

export interface MapAreaDef {
  readonly areaId: number;
  readonly kind: AreaKind;
  /** 所屬起點槽位；中立礦區為 null */
  readonly slot: number | null;
}

export interface StartSlotDef {
  readonly slot: number;
  /** 主堡左上角格 */
  readonly tileX: number;
  readonly tileY: number;
}

export interface GeneratedMap {
  readonly mode: MatchMode;
  readonly seed: number;
  /** 成功時的嘗試序號（0 起算） */
  readonly attempt: number;
  readonly width: number;
  readonly height: number;
  readonly tiles: Uint8Array;
  readonly nodes: readonly MapNodeDef[];
  readonly areas: readonly MapAreaDef[];
  readonly slots: readonly StartSlotDef[];
  /** 瞭望塔位置（單位座標） */
  readonly watchtowers: readonly { readonly x: number; readonly y: number }[];
}

export class MapGenError extends Error {}

interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Sector0Objects {
  base: TileRect;
  mainNodes: number[][];
  expansions: { nodes: number[][]; area: TileRect }[];
  richNodes: number[][];
}

const BASE_SIZE = 3;

/** 依 seed 生成地圖；驗證失敗時以 hash(seed, 嘗試次數) 重來，最多 MAPGEN.maxAttempts 次 */
export function generateMap(mode: MatchMode, seed: number): GeneratedMap {
  const reasons: string[] = [];
  for (let attempt = 0; attempt < MAPGEN.maxAttempts; attempt++) {
    const result = tryGenerate(mode, seed, attempt);
    if (typeof result === 'string') {
      reasons.push(result);
      continue;
    }
    return result;
  }
  throw new MapGenError(`地圖生成失敗（mode=${mode} seed=${seed}）：${reasons.join('；')}`);
}

class SymmetricBuilder {
  readonly n: number;
  readonly sectors: number;
  readonly terrain: Uint8Array;
  /** 物件佔用（含間距），物件之間不可重疊 */
  readonly reserved: Uint8Array;
  /** 不可放障礙 */
  readonly protect: Uint8Array;

  constructor(n: number, sectors: number) {
    this.n = n;
    this.sectors = sectors;
    this.terrain = new Uint8Array(n * n);
    this.reserved = new Uint8Array(n * n);
    this.protect = new Uint8Array(n * n);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.n && y < this.n;
  }

  /** 第 k 個扇區的對稱變換（格座標）；8 扇區時 k ≥ 4 先沿對角線鏡射再旋轉 */
  rot(k: number, x: number, y: number): [number, number] {
    const n1 = this.n - 1;
    if (this.sectors === 2) return k % 2 === 0 ? [x, y] : [n1 - x, n1 - y];
    let rx = this.sectors === 8 && k >= 4 ? y : x;
    let ry = this.sectors === 8 && k >= 4 ? x : y;
    for (let i = 0; i < k % 4; i++) {
      const nx = n1 - ry;
      const ny = rx;
      rx = nx;
      ry = ny;
    }
    return [rx, ry];
  }

  rotRect(k: number, r: TileRect): TileRect {
    const [ax, ay] = this.rot(k, r.x0, r.y0);
    const [bx, by] = this.rot(k, r.x1, r.y1);
    return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
  }

  /** 檢查一組格（及其所有旋轉）是否都在界內且未被佔用；margin 為額外間距 */
  canReserve(tiles: readonly number[][], margin: number): boolean {
    for (let k = 0; k < this.sectors; k++) {
      for (const [x, y] of tiles) {
        const [rx, ry] = this.rot(k, x, y);
        for (let dy = -margin; dy <= margin; dy++) {
          for (let dx = -margin; dx <= margin; dx++) {
            const tx = rx + dx;
            const ty = ry + dy;
            if (!this.inBounds(tx, ty)) {
              if (dx === 0 && dy === 0) return false;
              continue;
            }
            if (this.reserved[ty * this.n + tx] !== 0) return false;
          }
        }
      }
    }
    // 同一物件的不同旋轉之間也不可重疊
    if (this.sectors > 1) {
      const seen = new Set<number>();
      for (let k = 0; k < this.sectors; k++) {
        for (const [x, y] of tiles) {
          const [rx, ry] = this.rot(k, x, y);
          const key = ry * this.n + rx;
          if (seen.has(key)) return false;
          seen.add(key);
        }
      }
    }
    return true;
  }

  reserve(tiles: readonly number[][], margin: number): void {
    for (let k = 0; k < this.sectors; k++) {
      for (const [x, y] of tiles) {
        const [rx, ry] = this.rot(k, x, y);
        for (let dy = -margin; dy <= margin; dy++) {
          for (let dx = -margin; dx <= margin; dx++) {
            const tx = rx + dx;
            const ty = ry + dy;
            if (this.inBounds(tx, ty)) this.reserved[ty * this.n + tx] = 1;
          }
        }
      }
    }
  }

  protectTiles(tiles: readonly number[][], margin: number): void {
    for (let k = 0; k < this.sectors; k++) {
      for (const [x, y] of tiles) {
        const [rx, ry] = this.rot(k, x, y);
        for (let dy = -margin; dy <= margin; dy++) {
          for (let dx = -margin; dx <= margin; dx++) {
            const tx = rx + dx;
            const ty = ry + dy;
            if (this.inBounds(tx, ty)) this.protect[ty * this.n + tx] = 1;
          }
        }
      }
    }
  }

  /** 設定地形（所有旋轉）；阻擋優先於樹林優先於平地 */
  paint(tiles: readonly number[][], code: TerrainCode): void {
    for (let k = 0; k < this.sectors; k++) {
      for (const [x, y] of tiles) {
        const [rx, ry] = this.rot(k, x, y);
        if (!this.inBounds(rx, ry)) continue;
        const i = ry * this.n + rx;
        const cur = this.terrain[i];
        if (cur === TERRAIN.blocked) continue;
        if (cur === TERRAIN.forest && code === TERRAIN.plain) continue;
        this.terrain[i] = code;
      }
    }
  }

  /** 強制清為平地（隘口）；只用於第 0 扇區的環 */
  clear(tiles: readonly number[][]): void {
    for (let k = 0; k < this.sectors; k++) {
      for (const [x, y] of tiles) {
        const [rx, ry] = this.rot(k, x, y);
        if (this.inBounds(rx, ry)) this.terrain[ry * this.n + rx] = TERRAIN.plain;
      }
    }
  }
}

/** 該格或其 8 鄰格是否為阻擋地形（礦點不貼著懸崖） */
function nearBlocked(b: SymmetricBuilder, x: number, y: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (b.inBounds(tx, ty) && b.terrain[ty * b.n + tx] !== TERRAIN.plain) return true;
    }
  }
  return false;
}

function rectTiles(r: TileRect): number[][] {
  const out: number[][] = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out.push([x, y]);
  return out;
}

function diskTiles(cx: number, cy: number, r: number): number[][] {
  const out: number[][] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) out.push([cx + dx, cy + dy]);
    }
  }
  return out;
}

/** 單位座標 → 格座標 */
function toTile(u: number): number {
  return idiv(u, TILE_SIZE);
}

/** 沿方位角 deg 移動 dist 單位後的點 */
function polar(cx: number, cy: number, deg: number, dist: number): [number, number] {
  return [cx + idiv(dist * icos(deg), TRIG_SCALE), cy + idiv(dist * isin(deg), TRIG_SCALE)];
}

/** 弧形排列的礦點（格座標）；節點之間至少隔 1 格（切比雪夫距離 ≥ 2） */
function arcNodes(cx: number, cy: number, centerDeg: number, radius: number, count: number, stepDeg: number): number[][] | null {
  const out: number[][] = [];
  for (let i = 0; i < count; i++) {
    // 對稱展開：偏移 = (2i - (count-1)) × step / 2
    const off = idiv((2 * i - (count - 1)) * stepDeg, 2);
    const [x, y] = polar(cx, cy, centerDeg + off, radius);
    const t = [toTile(x), toTile(y)];
    for (const o of out) {
      if (Math.max(Math.abs(o[0] - t[0]), Math.abs(o[1] - t[1])) < 2) return null;
    }
    out.push(t);
  }
  return out;
}

function tryGenerate(mode: MatchMode, seed: number, attempt: number): GeneratedMap | string {
  const cfg = MAP_MODES[mode];
  const n = cfg.size;
  const rng = Prng.fromInts(hashInts([seed, attempt]));
  const b = new SymmetricBuilder(n, cfg.sectors);
  const mapCenter = n * (TILE_SIZE >> 1);
  const obj: Sector0Objects = { base: { x0: 0, y0: 0, x1: 0, y1: 0 }, mainNodes: [], expansions: [], richNodes: [] };

  // 1. 起點（主堡 3×3）
  const bx = idiv(n * cfg.basePercent[0], 100) - 1 + rng.range(-MAPGEN.baseJitterTiles, MAPGEN.baseJitterTiles);
  const by = idiv(n * cfg.basePercent[1], 100) - 1 + rng.range(-MAPGEN.baseJitterTiles, MAPGEN.baseJitterTiles);
  obj.base = { x0: bx, y0: by, x1: bx + BASE_SIZE - 1, y1: by + BASE_SIZE - 1 };
  const bcx = bx * TILE_SIZE + idiv(BASE_SIZE * TILE_SIZE, 2);
  const bcy = by * TILE_SIZE + idiv(BASE_SIZE * TILE_SIZE, 2);
  const toCenter = angleOf(mapCenter - bcx, mapCenter - bcy);
  const away = toCenter + 180;
  const baseTiles = rectTiles(obj.base);
  if (!b.canReserve(baseTiles, 1)) return '起點重疊';
  b.reserve(baseTiles, 1);

  // 2. 主礦區：背向地圖中心的弧形
  let main: number[][] | null = null;
  for (let t = 0; t < MAPGEN.placementTries && main === null; t++) {
    const radius = rng.range(MAPGEN.mainMine.minDistTiles * TILE_SIZE, MAPGEN.mainMine.maxDistTiles * TILE_SIZE);
    const cand = arcNodes(bcx, bcy, away, radius, MAPGEN.mainMine.nodes, MAPGEN.mainMine.stepDegrees);
    if (cand !== null && cand.every(([x, y]) => x >= 1 && y >= 1 && x < n - 1 && y < n - 1) && b.canReserve(cand, 1)) main = cand;
  }
  if (main === null) return '主礦區無法放置';
  obj.mainNodes = main;
  b.reserve(main, 1);

  // 3. 基地平台：阻擋環＋朝向地圖中心 ±45° 的隘口
  const ringR = rng.range(MAPGEN.ring.minRadiusTiles, MAPGEN.ring.maxRadiusTiles);
  const rIn = ringR * TILE_SIZE;
  const rOut = (ringR + MAPGEN.ring.widthTiles) * TILE_SIZE;
  const chokeDeg = toCenter + rng.range(-MAPGEN.ring.chokeAngleJitter, MAPGEN.ring.chokeAngleJitter);
  const chokeW = rng.range(MAPGEN.ring.chokeMinWidth, MAPGEN.ring.chokeMaxWidth);
  const dirX = icos(chokeDeg);
  const dirY = isin(chokeDeg);
  const ring: number[][] = [];
  const choke: number[][] = [];
  const interior: number[][] = [];
  const corridor: number[][] = [];
  const corridorLen = rOut + MAPGEN.protect.chokeExtraTiles * TILE_SIZE;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const vx = x * TILE_SIZE + 500 - bcx;
      const vy = y * TILE_SIZE + 500 - bcy;
      const d2 = vx * vx + vy * vy;
      const along = idiv(vx * dirX + vy * dirY, TRIG_SCALE);
      const perp = Math.abs(idiv(vx * dirY - vy * dirX, TRIG_SCALE));
      const inChoke = along > 0 && perp * 2 <= chokeW * TILE_SIZE;
      if (d2 < rOut * rOut) interior.push([x, y]);
      if (d2 >= rIn * rIn && d2 < rOut * rOut) {
        if (inChoke) choke.push([x, y]);
        else ring.push([x, y]);
      }
      if (along > 0 && along <= corridorLen && perp * 2 <= (chokeW + 2) * TILE_SIZE) corridor.push([x, y]);
    }
  }
  if (choke.length === 0) return '隘口為空';
  for (const t of ring) {
    if (b.reserved[t[1] * n + t[0]] !== 0) return '環與物件重疊';
  }
  b.paint(ring, TERRAIN.blocked);
  b.protectTiles(interior, 0);
  b.protectTiles(corridor, 0);
  b.protectTiles(main, MAPGEN.protect.nodeMarginTiles);

  // 4. 分礦區 2 處：環外、距主堡中心 16～22 格，分別偏向兩側
  const half = idiv(n, 2);
  for (const [minAng, maxAng] of cfg.expansionAngles) {
    let placed: { nodes: number[][]; area: TileRect } | null = null;
    for (let t = 0; t < MAPGEN.placementTries && placed === null; t++) {
      const ang = toCenter + rng.range(minAng, maxAng);
      const dist = rng.range(MAPGEN.expansion.minDistTiles * TILE_SIZE, MAPGEN.expansion.maxDistTiles * TILE_SIZE);
      const [ecx, ecy] = polar(bcx, bcy, ang, dist);
      const halfArea = idiv(MAPGEN.expansion.buildAreaTiles, 2);
      const ax = toTile(ecx) - halfArea;
      const ay = toTile(ecy) - halfArea;
      const area: TileRect = { x0: ax, y0: ay, x1: ax + MAPGEN.expansion.buildAreaTiles - 1, y1: ay + MAPGEN.expansion.buildAreaTiles - 1 };
      const areaTiles = rectTiles(area);
      if (!areaTiles.every(([x, y]) => b.inBounds(x, y) && b.terrain[y * n + x] === TERRAIN.plain)) continue;
      if (areaTiles.some(([x, y]) => b.protect[y * n + x] !== 0)) continue;
      const areaCx = ax * TILE_SIZE + idiv(MAPGEN.expansion.buildAreaTiles * TILE_SIZE, 2);
      const areaCy = ay * TILE_SIZE + idiv(MAPGEN.expansion.buildAreaTiles * TILE_SIZE, 2);
      const awayE = angleOf(areaCx - mapCenter, areaCy - mapCenter);
      let nodes: number[][] | null = null;
      for (const off of [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
        const cand = arcNodes(areaCx, areaCy, awayE + off, MAPGEN.expansion.nodeDistTiles * TILE_SIZE + 500, MAPGEN.expansion.nodes, MAPGEN.expansion.nodeStepDegrees);
        if (cand === null) continue;
        if (!cand.every(([x, y]) => x >= 1 && y >= 1 && x < n - 1 && y < n - 1)) continue;
        if (cand.some(([x, y]) => x >= area.x0 && x <= area.x1 && y >= area.y0 && y <= area.y1)) continue;
        if (cand.some(([x, y]) => b.protect[y * n + x] !== 0 || nearBlocked(b, x, y))) continue;
        nodes = cand;
        break;
      }
      if (nodes === null) continue;
      const all = areaTiles.concat(nodes);
      if (cfg.sectors === 4 && !all.every(([x, y]) => x < half && y < half)) continue;
      if (!b.canReserve(all, 1)) continue;
      placed = { nodes, area };
    }
    if (placed === null) return '分礦區無法放置';
    obj.expansions.push(placed);
    const areaTiles = rectTiles(placed.area);
    b.reserve(areaTiles.concat(placed.nodes), 1);
    b.protectTiles(areaTiles, 0);
    b.protectTiles(placed.nodes, MAPGEN.protect.nodeMarginTiles);
  }

  // 5. 富礦區：地圖邊緣中段、相鄰兩起點之間
  const m = MAPGEN.rich.edgeMarginTiles;
  let rich: number[][];
  if (cfg.richPercent !== null) {
    const rx = idiv(n * cfg.richPercent[0], 100);
    const ry = idiv(n * cfg.richPercent[1], 100);
    rich = [[rx, ry], [rx + 2, ry - 1]];
  } else {
    rich = cfg.sectors === 4 ? [[half - 2, m], [half + 1, m]] : [[n - 1 - m - 2, m], [n - 1 - m, m + 2]];
  }
  if (!b.canReserve(rich, 1)) return '富礦區無法放置';
  obj.richNodes = rich;
  b.reserve(rich, 1);
  b.protectTiles(rich, MAPGEN.protect.nodeMarginTiles);

  // 6. 瞭望塔：地圖正中心的點
  const towerTile = toTile(mapCenter);
  b.protectTiles(diskTiles(towerTile, towerTile, MAPGEN.protect.watchtowerRadiusTiles + 1), 0);

  // 7. 障礙：阻擋與樹林斑塊，另加較大樹林
  const inSector0 = (x: number, y: number): boolean => (cfg.sectors === 8 ? y < x && x < half : cfg.sectors === 4 ? x < half && y < half : x + y < n - 1);
  const placeBlob = (r: number, code: TerrainCode): void => {
    for (let t = 0; t < MAPGEN.placementTries; t++) {
      const cx = rng.nextInt(n);
      const cy = rng.nextInt(n);
      if (!inSector0(cx, cy)) continue;
      const tiles = diskTiles(cx, cy, r).filter(([x, y]) => b.inBounds(x, y));
      let ok = true;
      for (let k = 0; k < b.sectors && ok; k++) {
        for (const [x, y] of tiles) {
          const [rx, ry] = b.rot(k, x, y);
          const i = ry * n + rx;
          if (b.protect[i] !== 0 || b.reserved[i] !== 0) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      b.paint(tiles, code);
      return;
    }
  };
  for (let i = 0; i < cfg.obstacleBlobs; i++) {
    const r = rng.range(MAPGEN.obstacles.minRadius, MAPGEN.obstacles.maxRadius);
    const code: TerrainCode = rng.chance(MAPGEN.obstacles.blockedPercent) ? TERRAIN.blocked : TERRAIN.forest;
    placeBlob(r, code);
  }
  const largeForests = rng.range(MAPGEN.obstacles.largeForestMin, MAPGEN.obstacles.largeForestMax);
  for (let i = 0; i < largeForests; i++) {
    placeBlob(rng.range(MAPGEN.obstacles.largeForestMinRadius, MAPGEN.obstacles.largeForestMaxRadius), TERRAIN.forest);
  }

  // 8. 組合全部扇區的物件
  const slots: StartSlotDef[] = [];
  const areas: MapAreaDef[] = [];
  const nodes: MapNodeDef[] = [];
  const eco = RULES.economy;
  for (let k = 0; k < b.sectors; k++) {
    const br = b.rotRect(k, obj.base);
    slots.push({ slot: k, tileX: br.x0, tileY: br.y0 });
    const addArea = (kind: AreaKind, tiles: number[][], richArea: boolean, slot: number | null): void => {
      const areaId = areas.length;
      areas.push({ areaId, kind, slot });
      for (const [x, y] of tiles) {
        const [rx, ry] = b.rot(k, x, y);
        nodes.push({ tileX: rx, tileY: ry, rich: richArea, areaId, reserve: richArea ? eco.richNodeReserve : eco.nodeReserve });
      }
    };
    addArea('main', obj.mainNodes, false, k);
    for (const e of obj.expansions) addArea('expansion', e.nodes, false, k);
    addArea('rich', obj.richNodes, true, null);
  }

  const map: GeneratedMap = {
    mode,
    seed,
    attempt,
    width: n,
    height: n,
    tiles: b.terrain,
    nodes,
    areas,
    slots,
    watchtowers: [{ x: mapCenter, y: mapCenter }],
  };
  const err = validateMap(map, obj.expansions.flatMap((e) => Array.from({ length: b.sectors }, (_, k) => b.rotRect(k, e.area))));
  return err ?? map;
}

/** 驗證地圖；通過回傳 null，否則回傳原因 */
export function validateMap(map: GeneratedMap, expansionAreas: readonly TileRect[] = []): string | null {
  const n = map.width;
  const sectors = MAP_MODES[map.mode].sectors;
  const b = new SymmetricBuilder(n, sectors);
  // 對稱：每格與其旋轉（8 人局另加鏡射）對應格相同
  const generators = sectors === 8 ? [1, 4] : [1];
  for (const k of generators) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const [rx, ry] = b.rot(k, x, y);
        if (map.tiles[y * n + x] !== map.tiles[ry * n + rx]) return `地形不對稱 (${x},${y})`;
      }
    }
  }
  const nodeSet = new Set(map.nodes.map((nd) => nd.tileY * n + nd.tileX));
  for (const nd of map.nodes) {
    for (const k of generators) {
      const [rx, ry] = b.rot(k, nd.tileX, nd.tileY);
      if (!nodeSet.has(ry * n + rx)) return '礦點不對稱';
    }
    if (map.tiles[nd.tileY * n + nd.tileX] !== TERRAIN.plain) return '礦點不在平地';
  }
  // 通行格網：地形阻擋、礦點、主堡皆不可通行
  const walk = new Uint8Array(n * n);
  for (let i = 0; i < n * n; i++) walk[i] = map.tiles[i] === TERRAIN.blocked ? 0 : 1;
  for (const i of nodeSet) walk[i] = 0;
  for (const s of map.slots) {
    for (let y = s.tileY; y < s.tileY + BASE_SIZE; y++) {
      for (let x = s.tileX; x < s.tileX + BASE_SIZE; x++) {
        if (x < 0 || y < 0 || x >= n || y >= n) return '起點超出地圖';
        const i = y * n + x;
        if (map.tiles[i] !== TERRAIN.plain || nodeSet.has(i)) return '起點不在平地';
        walk[i] = 0;
      }
    }
  }
  for (const a of expansionAreas) {
    for (let y = a.y0; y <= a.y1; y++) {
      for (let x = a.x0; x <= a.x1; x++) {
        if (walk[y * n + x] !== 1 || map.tiles[y * n + x] !== TERRAIN.plain) return '分礦建築空地被佔用';
      }
    }
  }
  // 洪水填充（8 方向，禁止斜穿兩阻擋格縫隙）
  const reached = new Uint8Array(n * n);
  const start = firstAdjacentWalkable(walk, n, map.slots[0].tileX, map.slots[0].tileY, BASE_SIZE);
  if (start < 0) return '起點被封住';
  const queue: number[] = [start];
  reached[start] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    const cx = cur % n;
    const cy = (cur - cx) / n;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const ni = ny * n + nx;
        if (reached[ni] !== 0 || walk[ni] === 0) continue;
        if (dx !== 0 && dy !== 0 && walk[cy * n + nx] === 0 && walk[ny * n + cx] === 0) continue;
        reached[ni] = 1;
        queue.push(ni);
      }
    }
  }
  for (const s of map.slots) {
    if (!anyAdjacentReached(reached, n, s.tileX, s.tileY, BASE_SIZE)) return `起點 ${s.slot} 不連通`;
  }
  for (const nd of map.nodes) {
    if (!anyAdjacentReached(reached, n, nd.tileX, nd.tileY, 1)) return `礦點 (${nd.tileX},${nd.tileY}) 不連通`;
  }
  for (const wt of map.watchtowers) {
    const tx = toTile(wt.x);
    const ty = toTile(wt.y);
    if (reached[ty * n + tx] === 0) return '瞭望塔不連通';
  }
  // 基地環開口：起點必須能走到環外（距主堡中心超過環外徑的格）
  const sx = map.slots[0].tileX * TILE_SIZE + 1500;
  const sy = map.slots[0].tileY * TILE_SIZE + 1500;
  const limit = (MAPGEN.ring.maxRadiusTiles + MAPGEN.ring.widthTiles + 1) * TILE_SIZE;
  let outside = false;
  for (let i = 0; i < n * n && !outside; i++) {
    if (reached[i] === 0) continue;
    const x = i % n;
    const y = (i - x) / n;
    const d = isqrt((x * TILE_SIZE + 500 - sx) ** 2 + (y * TILE_SIZE + 500 - sy) ** 2);
    if (d > limit) outside = true;
  }
  if (!outside) return '基地環沒有開口';
  return null;
}

function firstAdjacentWalkable(walk: Uint8Array, n: number, x0: number, y0: number, size: number): number {
  for (let y = y0 - 1; y <= y0 + size; y++) {
    for (let x = x0 - 1; x <= x0 + size; x++) {
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      if (x >= x0 && x < x0 + size && y >= y0 && y < y0 + size) continue;
      if (walk[y * n + x] !== 0) return y * n + x;
    }
  }
  return -1;
}

function anyAdjacentReached(reached: Uint8Array, n: number, x0: number, y0: number, size: number): boolean {
  for (let y = y0 - 1; y <= y0 + size; y++) {
    for (let x = x0 - 1; x <= x0 + size; x++) {
      if (x < 0 || y < 0 || x >= n || y >= n) continue;
      if (reached[y * n + x] !== 0) return true;
    }
  }
  return false;
}

/** ASCII 地圖：. 平地  # 阻擋  f 樹林  m 礦點  R 富礦點  0-3 起點主堡  W 瞭望塔 */
export function renderAscii(map: GeneratedMap): string {
  const n = map.width;
  const chars: string[] = [];
  for (let i = 0; i < n * n; i++) {
    const t = map.tiles[i];
    chars.push(t === TERRAIN.blocked ? '#' : t === TERRAIN.forest ? 'f' : '.');
  }
  for (const nd of map.nodes) chars[nd.tileY * n + nd.tileX] = nd.rich ? 'R' : 'm';
  for (const s of map.slots) {
    for (let y = s.tileY; y < s.tileY + BASE_SIZE; y++) {
      for (let x = s.tileX; x < s.tileX + BASE_SIZE; x++) chars[y * n + x] = String(s.slot);
    }
  }
  for (const wt of map.watchtowers) chars[toTile(wt.y) * n + toTile(wt.x)] = 'W';
  const lines: string[] = [];
  for (let y = 0; y < n; y++) lines.push(chars.slice(y * n, (y + 1) * n).join(''));
  return lines.join('\n');
}
