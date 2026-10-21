// 選手輔助工具：pathDistance、canPlace、terrainAt、random。
// 只使用選手自己知道的資訊（開局資料＋每次觀察），正式模式（獨立 Worker）與批次模式共用同一份實作。
import type { BuildingType, Helpers, InitData, Observation } from '../api/types.ts';
import { BUILDING_STATS, TERRAIN } from '../config/index.ts';
import { PathFinder, pathLength, WALK_BLOCKED, WALK_FOREST, WALK_PLAIN } from '../path/index.ts';
import { Prng } from '../shared/prng.ts';

interface KnownBuilding {
  readonly tileX: number;
  readonly tileY: number;
  readonly size: number;
}

export class BotHelpers implements Helpers {
  private readonly width: number;
  private readonly height: number;
  private readonly tiles: Uint8Array;
  private readonly nodeAt: Uint8Array;
  private readonly explored: Uint8Array;
  private readonly walk: Uint8Array;
  private known: KnownBuilding[] = [];
  private dirty = true;
  private readonly finder: PathFinder;
  private readonly rng: Prng;

  constructor(data: InitData) {
    this.width = data.width;
    this.height = data.height;
    this.tiles = Uint8Array.from(data.tiles);
    this.nodeAt = new Uint8Array(data.width * data.height);
    for (const n of data.mineNodes) this.nodeAt[n.tileY * data.width + n.tileX] = 1;
    this.explored = new Uint8Array(data.width * data.height);
    this.walk = new Uint8Array(data.width * data.height);
    this.finder = new PathFinder(data.width, data.height);
    this.rng = Prng.fromInts(data.matchSeed, data.me);
  }

  /** 每次決策前由沙盒呼叫：更新已知建築與已探索格 */
  update(obs: Observation, exploredDelta: readonly number[]): void {
    for (const i of exploredDelta) this.explored[i] = 1;
    const known: KnownBuilding[] = [];
    for (const b of obs.myBuildings) known.push({ tileX: b.tileX, tileY: b.tileY, size: BUILDING_STATS[b.type].size });
    for (const b of obs.enemyBuildings) known.push({ tileX: b.tileX, tileY: b.tileY, size: BUILDING_STATS[b.type].size });
    for (const b of obs.rememberedBuildings) known.push({ tileX: b.tileX, tileY: b.tileY, size: BUILDING_STATS[b.type].size });
    this.known = known;
    this.dirty = true;
  }

  private inBounds(x: number, y: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  private rebuildWalk(): void {
    if (!this.dirty) return;
    const w = this.width;
    for (let i = 0; i < this.walk.length; i++) {
      const t = this.tiles[i];
      this.walk[i] = t === TERRAIN.blocked || this.nodeAt[i] !== 0 ? WALK_BLOCKED : t === TERRAIN.forest ? WALK_FOREST : WALK_PLAIN;
    }
    for (const b of this.known) {
      for (let y = b.tileY; y < b.tileY + b.size; y++) {
        for (let x = b.tileX; x < b.tileX + b.size; x++) this.walk[y * w + x] = WALK_BLOCKED;
      }
    }
    this.dirty = false;
  }

  pathDistance(fromTileX: number, fromTileY: number, toTileX: number, toTileY: number): number {
    if (!this.inBounds(fromTileX, fromTileY) || !this.inBounds(toTileX, toTileY)) return -1;
    const w = this.width;
    if (this.tiles[fromTileY * w + fromTileX] === TERRAIN.blocked || this.tiles[toTileY * w + toTileX] === TERRAIN.blocked) return -1;
    this.rebuildWalk();
    const start = fromTileY * w + fromTileX;
    if (fromTileX === toTileX && fromTileY === toTileY) return 0;
    // 起點或終點位於已知建築內時，暫時把該建築視為可通行（例如從自己的主堡出發）
    const opened: number[] = [];
    for (const b of this.known) {
      const hasStart = fromTileX >= b.tileX && fromTileX < b.tileX + b.size && fromTileY >= b.tileY && fromTileY < b.tileY + b.size;
      const hasGoal = toTileX >= b.tileX && toTileX < b.tileX + b.size && toTileY >= b.tileY && toTileY < b.tileY + b.size;
      if (!hasStart && !hasGoal) continue;
      for (let y = b.tileY; y < b.tileY + b.size; y++) {
        for (let x = b.tileX; x < b.tileX + b.size; x++) {
          const i = y * w + x;
          if (this.walk[i] === WALK_BLOCKED && this.nodeAt[i] === 0) {
            this.walk[i] = this.tiles[i] === TERRAIN.forest ? WALK_FOREST : WALK_PLAIN;
            opened.push(i);
          }
        }
      }
    }
    const res = this.finder.findPath({ width: w, height: this.height, walk: this.walk }, start, { x0: toTileX, y0: toTileY, x1: toTileX, y1: toTileY }, { allowBlockedGoal: true });
    for (const i of opened) this.walk[i] = WALK_BLOCKED;
    if (!res.reached) return -1;
    return pathLength(w, start, res.tiles);
  }

  canPlace(building: BuildingType, tileX: number, tileY: number): boolean {
    const st = BUILDING_STATS[building];
    if (st === undefined || !this.inBounds(tileX, tileY)) return false;
    const size = st.size;
    if (tileX + size > this.width || tileY + size > this.height) return false;
    const w = this.width;
    for (let y = tileY; y < tileY + size; y++) {
      for (let x = tileX; x < tileX + size; x++) {
        const i = y * w + x;
        if (this.tiles[i] !== TERRAIN.plain || this.nodeAt[i] !== 0 || this.explored[i] === 0) return false;
      }
    }
    for (const b of this.known) {
      if (tileX < b.tileX + b.size && tileX + size > b.tileX && tileY < b.tileY + b.size && tileY + size > b.tileY) return false;
    }
    return true;
  }

  terrainAt(tileX: number, tileY: number): number {
    if (!this.inBounds(tileX, tileY)) return TERRAIN.blocked;
    return this.tiles[tileY * this.width + tileX];
  }

  random(): number {
    return this.rng.nextFloat();
  }

  /** 交給選手的物件：只暴露四個方法 */
  toPublic(): Helpers {
    return Object.freeze({
      pathDistance: (a: number, b: number, c: number, d: number) => this.pathDistance(a, b, c, d),
      canPlace: (t: BuildingType, x: number, y: number) => this.canPlace(t, x, y),
      terrainAt: (x: number, y: number) => this.terrainAt(x, y),
      random: () => this.random(),
    });
  }
}
