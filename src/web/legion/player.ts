// 軍團戰玩家指揮：在 Worker 裡代替 AI 的控制器（把畫面送來的指令排隊，決策時交給引擎）與自動布陣。
import type { Deployment, LegionDeclaration, LegionInitData, LegionObservation } from '../../legion/api.ts';
import { TILE, UNITS, walkable, type UnitKind } from '../../legion/config.ts';
import { formationShape } from '../../legion/formation.ts';
import type { CallOutcome, LegionController } from '../../legion/runner.ts';
import type { PlayerArmy } from './protocol.ts';

/** 每次決策最多交幾個指令（同引擎上限） */
const PER_DECISION = 10;

const ok = <T>(value: T): CallOutcome<T> => ({ value, exception: null, killed: false, elapsedMs: 0 });

/** 布陣時每種兵站哪一排（離己方邊緣的格數）：步兵在前、弓兵在後、騎兵與斥候最後 */
const COLUMN: Record<UnitKind, number> = { spear: 16, sword: 16, shield: 15, archer: 11, light: 6, lightCav: 6, heavyCav: 6 };

/** 一團預設陣形的外接圓半徑（同引擎的算法，用來避開「重疊」的布陣限制） */
function radiusOf(kind: UnitKind): number {
  const u = UNITS[kind];
  const depth = Math.max(2, Math.ceil(u.men / u.squareWidth));
  return formationShape(u.formations[0], u.men, u.lineWidth, depth, u.spacingX, u.spacingY).rad;
}

/**
 * 自動布陣：依兵種排成前後幾排，每團從地圖中線往兩側找第一個不重疊、可通行的位置；
 * 那一排擠不下就往後退。座標先用己方視角（0 號在左）算，再依 playerId 鏡像。
 */
export function autoDeploy(army: PlayerArmy, data: LegionInitData): Deployment[] {
  const p = data.playerId;
  const W = data.map.width;
  const H = data.map.height;
  const zone = data.map.deploy[p];
  const depthTiles = zone.x1 - zone.x0;
  const placed: { x: number; y: number; rad: number }[] = [];
  const out: Deployment[] = [];
  const order = [...army.field].sort((a, b) => COLUMN[b] - COLUMN[a]);
  const free = (x: number, y: number, rad: number): boolean => {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (tx < 1 || tx >= depthTiles - 1 || ty < 2 || ty >= H - 2) return false;
    const wx = p === 0 ? tx : W - 1 - tx;
    const wy = p === 0 ? ty : H - 1 - ty;
    if (!walkable(data.map.terrain[wy * W + wx])) return false;
    // 引擎的限制是中心距離 ≥ 兩團半徑和的 55%，多留一點空隙
    return placed.every((q) => (q.x - x) ** 2 + (q.y - y) ** 2 >= ((q.rad + rad) * 0.7) ** 2);
  };
  for (const k of order) {
    const rad = radiusOf(k);
    let spot: { x: number; y: number } | null = null;
    // 先在中線兩側 30 格內找，找不到才放寬到整個布陣區；排先往後退，退到底再往前
    const cols: number[] = [];
    for (let c = COLUMN[k]; c >= 1; c--) cols.push(c);
    for (let c = COLUMN[k] + 1; c < depthTiles - 1; c++) cols.push(c);
    for (const spread of [60, 2 * H]) {
      for (const col of cols) {
        if (spot !== null) break;
        for (let i = 0; i < spread; i++) {
          const dy = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2);
          const x = (col + 0.5) * TILE;
          const y = (Math.floor(H / 2) + dy + 0.5) * TILE;
          if (free(x, y, rad)) {
            spot = { x, y };
            break;
          }
        }
      }
      if (spot !== null) break;
    }
    if (spot === null) continue;
    placed.push({ ...spot, rad });
    out.push({ type: k, x: Math.round(p === 0 ? spot.x : W * TILE - spot.x), y: Math.round(p === 0 ? spot.y : H * TILE - spot.y), facing: p === 0 ? 0 : 180 });
  }
  for (const k of army.reserve) out.push({ type: k, x: 0, y: 0, reserve: true });
  return out;
}

/** 玩家的控制器：deploy 回傳自動布陣；decide 交出排隊中的指令 */
export class PlayerController implements LegionController {
  readonly label = 'player';
  readonly declaration: LegionDeclaration = { name: '玩家', version: '', style: '由你親自指揮', knobs: [] };
  private readonly army: PlayerArmy;
  private queue: unknown[] = [];

  constructor(army: PlayerArmy) {
    this.army = army;
  }

  push(cmds: readonly unknown[]): void {
    this.queue.push(...cmds);
  }

  init(): CallOutcome<null> {
    return ok(null);
  }

  deploy(data: LegionInitData): CallOutcome<unknown> {
    return ok(autoDeploy(this.army, data));
  }

  decide(_obs: LegionObservation): CallOutcome<unknown> {
    return ok(this.queue.splice(0, PER_DECISION));
  }
}
