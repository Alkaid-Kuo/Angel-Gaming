// CS 射擊基準 Bot 情境測試（步驟 6）：「懂不懂」的測試，不是強度測試。
// 受測 Bot 坐某幾個座位，其他座位用腳本控制（ScriptController），每個情境固定 5 個種子都要過；test/shooter-ai.test.ts 檢查。
// 位置一律由地圖資料（出生區、包點、牆、矮牆、區域）算出，不寫死座標；預設跑赤岩鎮，換地圖也要能找到位置。
// 情境只用引擎的公開狀態判定（位置、朝向、血量、子彈、姿勢），受測 Bot 只拿得到它自己的觀察資料。
// 用法：runAiScenarios(compileBot(...), 篩選, 對手)；腳本 scripts/shooter-ai-scenarios.ts 印出結果。
import { resolveKnobs } from '../sandbox/controller.ts';
import type { CompiledBot } from '../sandbox/compile.ts';
import { angleDiff, iatan2, offset } from '../shared/geom.ts';
import type { ShooterCommand, ShooterObservation, Team } from './api.ts';
import { GRENADES, ROUND, TEAM_SIZE, TPS, UNIT, WEAPONS, ticks, type WeaponId } from './config.ts';
import { MAPS, blocksMove, inRect, isLowCell, isSolidCell, regionsAt, type Rect, type ShooterMap } from './map.ts';
import { ScriptController, ShooterBatchController, ShooterDriver } from './runner.ts';
import { PLAYER_COUNT, burnCells, type ShooterMatch, type ShooterMatchOptions } from './sim.ts';
import { lineOfSight } from './vision.ts';

export interface AiScenarioResult {
  readonly pass: boolean;
  readonly detail: string;
}

export interface AiScenario {
  readonly id: string;
  readonly name: string;
  readonly expect: string;
  /** opponent：對手選手（T9 用陪練 Bot 補樣本；沒給就只跑鏡像） */
  readonly run: (bot: CompiledBot, seed: number, opponent?: CompiledBot) => AiScenarioResult;
}

/** 每個情境固定跑這 5 個種子，全過才算過 */
export const AI_SCENARIO_SEEDS: readonly number[] = [1, 2, 3, 4, 5];
const MAP_ID = 'redrock';

type Script = (obs: ShooterObservation) => readonly ShooterCommand[];
const idle: Script = () => [];

// ───────── 幾何（只用地圖資料） ─────────

type Pt = readonly [number, number];

const cellIdx = (m: ShooterMap, cx: number, cy: number): number => cy * m.width + cx;
const centerOf = (m: ShooterMap, i: number): Pt => [(i % m.width) * UNIT + UNIT / 2, Math.floor(i / m.width) * UNIT + UNIT / 2];
const cellAt = (m: ShooterMap, p: Pt): number => cellIdx(m, Math.floor(p[0] / UNIT), Math.floor(p[1] / UNIT));
const walkable = (m: ShooterMap, i: number): boolean => i >= 0 && i < m.width * m.height && !blocksMove(m, i % m.width, Math.floor(i / m.width));
const d2 = (a: Pt, b: Pt): number => Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
const ang = (a: Pt, b: Pt): number => iatan2(Math.round(b[1] - a[1]), Math.round(b[0] - a[0]));
const along = (p: Pt, deg: number, cells: number): Pt => {
  const [ox, oy] = offset(((deg % 360) + 360) % 360, Math.round(cells * UNIT));
  return [p[0] + ox, p[1] + oy];
};
const snap = (m: ShooterMap, p: Pt): Pt => centerOf(m, cellAt(m, p));
const see = (m: ShooterMap, a: Pt, b: Pt): boolean => lineOfSight(m, Math.round(a[0]), Math.round(a[1]), Math.round(b[0]), Math.round(b[1]));
const facingDeg = (match: ShooterMatch, pid: number): number => Math.round(match.players[pid].facing / 100) % 360;

const clearCache = new Map<string, Int16Array>();
/** 每格到最近擋路格的距離（8 方向步數） */
function clearance(m: ShooterMap): Int16Array {
  const hit = clearCache.get(m.id);
  if (hit !== undefined) return hit;
  const n = m.width * m.height;
  const c = new Int16Array(n).fill(-1);
  const q: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!walkable(m, i)) {
      c[i] = 0;
      q.push(i);
    }
  }
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const x = i % m.width;
    const y = Math.floor(i / m.width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= m.width || ny >= m.height) continue;
        const j = cellIdx(m, nx, ny);
        if (c[j] >= 0) continue;
        c[j] = c[i] + 1;
        q.push(j);
      }
    }
  }
  clearCache.set(m.id, c);
  return c;
}

/** 矩形內離中心最近、周圍空曠（到牆 ≥ minClear 格）的格中心 */
function openSpot(m: ShooterMap, r: Rect, minClear: number): Pt {
  const cl = clearance(m);
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  let best = -1;
  let bestD = Infinity;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const i = cellIdx(m, x, y);
      if (cl[i] < minClear) continue;
      const d = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
  }
  if (best < 0) throw new Error(`${m.id}：矩形內找不到空曠的格`);
  return centerOf(m, best);
}

/** 從 from 找一個 cells 格外、站得住（到牆 ≥ minClear）、看得到的點；方向從 pref 開始左右交替找 */
function pointAt(m: ShooterMap, from: Pt, cells: number, pref: number, minClear = 1, maxOff = 180): { p: Pt; deg: number } | null {
  const cl = clearance(m);
  for (let k = 0; k <= maxOff; k += 5) {
    for (const s of k === 0 ? [0] : [k, -k]) {
      const deg = pref + s;
      const p = snap(m, along(from, deg, cells));
      const i = cellAt(m, p);
      if (!walkable(m, i) || cl[i] < minClear || !see(m, from, p)) continue;
      return { p, deg: ang(from, p) };
    }
  }
  return null;
}

/** 格子 BFS 最短路徑（8 方向、不斜穿牆角）；blocked 為額外不可走的格 */
function bfsPath(m: ShooterMap, from: number, to: number, blocked?: (i: number) => boolean): number[] | null {
  const n = m.width * m.height;
  const prev = new Int32Array(n).fill(-2);
  const q = [from];
  prev[from] = -1;
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    if (i === to) break;
    const x = i % m.width;
    const y = Math.floor(i / m.width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (blocksMove(m, nx, ny)) continue;
        if (dx !== 0 && dy !== 0 && (blocksMove(m, x + dx, y) || blocksMove(m, x, y + dy))) continue;
        const j = cellIdx(m, nx, ny);
        if (prev[j] !== -2 || (blocked !== undefined && j !== to && blocked(j))) continue;
        prev[j] = i;
        q.push(j);
      }
    }
  }
  if (prev[to] === -2) return null;
  const out: number[] = [];
  for (let i = to; i >= 0; i = prev[i]) out.push(i);
  return out.reverse();
}

const siteRect = (m: ShooterMap, id: 'A' | 'B'): Rect => m.sites.find((s) => s.id === id)!;
const rectCenterCell = (m: ShooterMap, r: Rect): number => cellAt(m, openSpot(m, r, 1));

/** 最小的區域（同引擎 regionsAt） */
const regionOf = (m: ShooterMap, i: number): string => regionsAt(m, centerOf(m, i)[0], centerOf(m, i)[1])[0] ?? '';

/** 兩區域之間、含格 i 的那一段邊界的寬度（i 側的邊界格數，8 連通） */
function boundaryWidth(m: ShooterMap, i: number, other: string): number {
  const mine = regionOf(m, i);
  const isEdge = (j: number): boolean => {
    if (!walkable(m, j) || regionOf(m, j) !== mine) return false;
    const x = j % m.width;
    const y = Math.floor(j / m.width);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = cellIdx(m, x + dx, y + dy);
      if (walkable(m, k) && regionOf(m, k) === other) return true;
    }
    return false;
  };
  if (!isEdge(i)) return Infinity;
  const seen = new Set([i]);
  const q = [i];
  for (let h = 0; h < q.length; h++) {
    const x = q[h] % m.width;
    const y = Math.floor(q[h] / m.width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const k = cellIdx(m, x + dx, y + dy);
        if (seen.has(k) || !isEdge(k)) continue;
        seen.add(k);
        q.push(k);
      }
    }
  }
  return seen.size;
}

// ───────── 比賽驅動 ─────────

interface Setup {
  readonly seed: number;
  readonly seats: readonly number[];
  /** 只留這些人活著：其他人在第一個 tick 之前移除（Bot 從沒看過他們活著，不會當成隊友陣亡） */
  readonly alive?: readonly number[];
  readonly scripts?: Partial<Record<number, Script>>;
  readonly opts?: Partial<ShooterMatchOptions>;
  /** 地圖（預設赤岩鎮；6-2 的情境兩張圖都跑） */
  readonly map?: string;
  /** 受測座位的旋鈕 */
  readonly knobs?: Readonly<Record<string, number>>;
  /** 個別受測座位另外的旋鈕（蓋過 knobs；角色情境用） */
  readonly seatKnobs?: Partial<Record<number, Readonly<Record<string, number>>>>;
  /** 收集受測座位的喊話 */
  readonly log?: Said[];
  /** 對手選手坐的座位（其他非受測座位照舊是腳本） */
  readonly opp?: { readonly bot: CompiledBot; readonly seats: readonly number[] };
}

/** 受測 Bot 的一句喊話 */
interface Said {
  readonly tick: number;
  readonly from: number;
  readonly text: string;
}

/** 受測 Bot 的控制器：另外記下喊話（情境判定用；Bot 看不到） */
class SpyController extends ShooterBatchController {
  private readonly who: number;
  private readonly log: Said[] | undefined;
  private readonly now: () => number;

  constructor(bot: CompiledBot, seed: number, pid: number, map: ShooterMap, log: Said[] | undefined, now: () => number) {
    super(bot, 'baseline', seed, pid, map);
    this.who = pid;
    this.log = log;
    this.now = now;
  }

  override decide(obs: ShooterObservation): ReturnType<ShooterBatchController['decide']> {
    const out = super.decide(obs);
    if (this.log !== undefined && Array.isArray(out.value)) for (const c of out.value as ShooterCommand[]) if (c.type === 'say') this.log.push({ tick: this.now(), from: this.who, text: c.text });
    return out;
  }
}

function driver(bot: CompiledBot, s: Setup): ShooterDriver {
  const mapId = s.map ?? MAP_ID;
  const map = MAPS[mapId]();
  let d: ShooterDriver | null = null;
  const now = (): number => d?.match.tick ?? 0;
  const controllers = Array.from({ length: PLAYER_COUNT }, (_, pid) => (s.seats.includes(pid) ? new SpyController(bot, s.seed, pid, map, s.log, now) : s.opp?.seats.includes(pid) === true ? new ShooterBatchController(s.opp.bot, 'opponent', s.seed, pid, map) : new ScriptController(`script-${pid}`, s.scripts?.[pid] ?? idle)));
  const knobs = controllers.map((c, pid) => resolveKnobs(c.declaration, c instanceof SpyController ? { ...s.knobs, ...s.seatKnobs?.[pid] } : undefined, c.label));
  d = new ShooterDriver({ seed: s.seed, mapId, ...s.opts, controllers, knobs, record: false });
  if (s.alive !== undefined) killExcept(d.match, s.alive);
  return d;
}

function toLive(d: ShooterDriver): void {
  for (let i = 0; i < ROUND.freezeTicks + 5 && d.match.phase !== 'live'; i++) d.step();
}

/** 跑 n 個 tick，每個 tick 之後呼叫 each（回傳 true 就停） */
function run(d: ShooterDriver, n: number, each?: (m: ShooterMatch) => unknown): void {
  for (let i = 0; i < n && !d.match.over && d.match.phase !== 'over'; i++) {
    d.step();
    if (each?.(d.match) === true) return;
  }
}

/** 殺掉 keep 以外的人 */
function killExcept(m: ShooterMatch, keep: readonly number[]): void {
  for (let pid = 0; pid < PLAYER_COUNT; pid++) if (!keep.includes(pid)) m.kill(pid);
}

/** 主武器加副武器的子彈總數（判斷有沒有開槍） */
const ammo = (m: ShooterMatch, pid: number): number => (m.players[pid].primary?.mag ?? 0) + (m.players[pid].secondary?.mag ?? 0);

/** CT 出生區中心，與「前方」（朝兩個包點的平均位置）方向 */
function ctBase(m: ShooterMap): { s: Pt; front: number } {
  const s = openSpot(m, m.spawnZones.CT, 2);
  const mid: Pt = [(m.sites[0].x0 + m.sites[0].x1 + m.sites[1].x0 + m.sites[1].x1) * (UNIT / 4), (m.sites[0].y0 + m.sites[0].y1 + m.sites[1].y0 + m.sites[1].y1) * (UNIT / 4)];
  return { s, front: ang(s, mid) };
}

/** 交戰情境的起點：A 包點中心附近的空地，加上 cells 格外看得到的敵人位置 */
function duel(m: ShooterMap, cells: number): { s: Pt; e: Pt; deg: number } {
  const s = openSpot(m, siteRect(m, 'A'), 3);
  for (const pref of [0, 90, 180, 270]) {
    const hit = pointAt(m, s, cells, pref, 1, 40);
    if (hit !== null) return { s, e: hit.p, deg: hit.deg };
  }
  throw new Error(`${m.id}：找不到 ${cells} 格的對槍位置`);
}

const T0 = 0;
const T1 = 1;
const CT0 = TEAM_SIZE;
const CT1 = TEAM_SIZE + 1;

/** 情境起手：開打後瞬移受測 CT（5 號）與一個 T（0 號），其餘殺掉（保留 keep） */
function duelSetup(bot: CompiledBot, seed: number, cells: number, loadout?: Partial<Record<Team, WeaponId>>, keep: readonly number[] = []): { d: ShooterDriver; s: Pt; e: Pt } {
  const d = driver(bot, { seed, seats: [CT0], alive: [CT0, T0, ...keep], opts: loadout !== undefined ? { defaultLoadout: loadout } : {} });
  toLive(d);
  const m = d.match;
  const { s, e, deg } = duel(m.map, cells);
  m.teleport(CT0, s[0], s[1], deg);
  m.teleport(T0, e[0], e[1], (deg + 180) % 360);
  return { d, s, e };
}

// ───────── 情境 ─────────

const SOLO_SCENARIOS: readonly AiScenario[] = [
  {
    id: 'P0',
    name: '背後的敵人不會被瞄準',
    expect: 'CT 在出生區中央面向前方，敵人靜止在背後 3 格；3 秒內 Bot 的朝向與「敵人放在遠處」的對照組逐 tick 相同，而且一直看不到、沒開槍',
    run: (bot, seed) => {
      const trace = (behind: boolean): { facing: number[]; saw: number; shots: number } => {
        const d = driver(bot, { seed, seats: [CT0], alive: [CT0, T0] });
        toLive(d);
        const m = d.match;
        const { s, front } = ctBase(m.map);
        m.teleport(CT0, s[0], s[1], front);
        const back = pointAt(m.map, s, 3, front + 180, 0, 60);
        if (back === null) throw new Error('背後放不下敵人');
        const far = openSpot(m.map, m.map.spawnZones.T, 1);
        const e = behind ? back.p : far;
        m.teleport(T0, e[0], e[1], front);
        const facing: number[] = [];
        let saw = -1;
        const a0 = ammo(m, CT0);
        run(d, 3 * TPS, (mm) => {
          facing.push(mm.players[CT0].facing);
          if (saw < 0 && mm.canSee(CT0, T0)) saw = facing.length;
        });
        return { facing, saw, shots: a0 - ammo(m, CT0) };
      };
      const a = trace(true);
      const b = trace(false);
      let diff = -1;
      for (let i = 0; i < a.facing.length; i++) {
        if (a.facing[i] !== b.facing[i]) {
          diff = i;
          break;
        }
      }
      const pass = diff < 0 && a.saw < 0 && a.shots === 0;
      return { pass, detail: `朝向第一個不同的 tick ${diff}；第一次看到 ${a.saw}；開槍 ${a.shots}` };
    },
  },
  {
    id: 'P1',
    name: '看到敵人開火並命中',
    expect: '面前 10 格站著不動的敵人：3 秒內開火並打中（敵人掉血或陣亡）',
    run: (bot, seed) => {
      const { d } = duelSetup(bot, seed, 10);
      const m = d.match;
      const a0 = ammo(m, CT0);
      let first = -1;
      run(d, 3 * TPS, (mm) => {
        if (first < 0 && mm.players[T0].hp < 100) first = mm.tick;
        return !mm.players[T0].alive;
      });
      const shots = a0 - ammo(m, CT0);
      return { pass: shots > 0 && m.players[T0].hp < 100, detail: `開槍 ${shots}、敵人血量 ${Math.max(0, m.players[T0].hp)}、存活 ${m.players[T0].alive}` };
    },
  },
  {
    id: 'P2',
    name: '射程外不開火、會接近',
    expect: '拿霰彈槍（射程 8 格）、敵人在 15 格外不動：在射程外一發都不開，4 秒內接近到 12 格以內',
    run: (bot, seed) => {
      const { d } = duelSetup(bot, seed, 15, { CT: 'shotgun' });
      const m = d.match;
      const range = WEAPONS.shotgun.range * UNIT + 500;
      let outShots = 0;
      let minD = Infinity;
      let prev = ammo(m, CT0);
      run(d, 4 * TPS, (mm) => {
        const p = mm.players[CT0];
        const e = mm.players[T0];
        const dd = d2([p.x, p.y], [e.x, e.y]);
        const now = ammo(mm, CT0);
        if (now < prev && dd > range) outShots += prev - now;
        prev = now;
        minD = Math.min(minD, dd);
      });
      return { pass: outShots === 0 && minD <= 12 * UNIT, detail: `射程外開槍 ${outShots}；最近 ${(minD / UNIT).toFixed(1)} 格` };
    },
  },
  {
    id: 'P3',
    name: '隊友擋線不開槍',
    expect: '敵人在 10 格外，隊友站在正中間：隊友在彈道上（離線段 < 0.8 格）時一發都不開，隊友沒受傷',
    run: (bot, seed) => {
      const { d, s, e } = duelSetup(bot, seed, 10, undefined, [CT1]);
      const m = d.match;
      const mid = snap(m.map, [(s[0] + e[0]) / 2, (s[1] + e[1]) / 2]);
      m.teleport(CT1, mid[0], mid[1], ang(mid, e));
      let bad = 0;
      let shots = 0;
      let prev = ammo(m, CT0);
      run(d, 2 * TPS, (mm) => {
        const p = mm.players[CT0];
        const q = mm.players[CT1];
        const now = ammo(mm, CT0);
        if (now < prev) {
          shots += prev - now;
          // 隊友到「自己→敵人」線段的距離
          const ex = mm.players[T0].x;
          const ey = mm.players[T0].y;
          const len = d2([p.x, p.y], [ex, ey]);
          const tt = ((q.x - p.x) * (ex - p.x) + (q.y - p.y) * (ey - p.y)) / (len * len);
          const off = Math.abs((q.x - p.x) * (ey - p.y) - (q.y - p.y) * (ex - p.x)) / len;
          if (tt > 0 && tt < 1 && off < 800) bad += prev - now;
        }
        prev = now;
      });
      return { pass: bad === 0 && m.players[CT1].hp === 100, detail: `擋線時開槍 ${bad}（總共 ${shots}）；隊友血量 ${m.players[CT1].hp}` };
    },
  },
  {
    id: 'P4',
    name: '彈匣空了近距離切手槍',
    expect: '步槍彈匣是空的、敵人在 6 格：1 秒內切到手槍（不先換彈），2 秒內用手槍開火',
    run: (bot, seed) => {
      const { d } = duelSetup(bot, seed, 6, { CT: 'm4' });
      const m = d.match;
      m.players[CT0].primary!.mag = 0;
      let switched = -1;
      let pistolShots = 0;
      let reloadFirst = false;
      let prev = m.players[CT0].secondary?.mag ?? 0;
      const t0 = m.tick;
      run(d, 2 * TPS, (mm) => {
        const p = mm.players[CT0];
        if (switched < 0 && p.active === 'secondary') switched = mm.tick - t0;
        if (switched < 0 && p.reloadLeft > 0) reloadFirst = true;
        const now = p.secondary?.mag ?? 0;
        if (now < prev) pistolShots += prev - now;
        prev = now;
      });
      return { pass: switched >= 0 && switched <= TPS && !reloadFirst && pistolShots > 0, detail: `切手槍於 ${switched} tick；先換彈 ${reloadFirst}；手槍開槍 ${pistolShots}` };
    },
  },
  {
    id: 'P5',
    name: '狙擊先開鏡再開火',
    expect: '拿狙擊槍、沒開鏡、敵人在 20 格：4 秒內開火，而且每一發都是開鏡狀態',
    run: (bot, seed) => {
      const { d } = duelSetup(bot, seed, 20, { CT: 'awp' });
      const m = d.match;
      let shots = 0;
      let unscoped = 0;
      let prev = m.players[CT0].primary?.mag ?? 0;
      let scopedPrev = m.players[CT0].scoped;
      run(d, 4 * TPS, (mm) => {
        const p = mm.players[CT0];
        const now = p.primary?.mag ?? 0;
        if (now < prev) {
          shots += 1;
          if (!scopedPrev) unscoped += 1;
        }
        prev = now;
        scopedPrev = p.scoped;
      });
      return { pass: shots > 0 && unscoped === 0, detail: `開槍 ${shots}、沒開鏡開的 ${unscoped}` };
    },
  },
  {
    id: 'P6',
    name: '被閃後退開',
    expect: 'CT 往守位走 4 秒後被閃 2 秒：致盲結束時已往來的方向退開至少 1 格，被閃期間有蹲下',
    run: (bot, seed) => {
      const d = driver(bot, { seed, seats: [CT0], alive: [CT0, T0] });
      toLive(d);
      const m = d.match;
      run(d, 4 * TPS);
      const p = m.players[CT0];
      // 被閃前 0.5 秒的移動方向
      const before: Pt = [p.x, p.y];
      run(d, 15);
      const at: Pt = [p.x, p.y];
      const vx = at[0] - before[0];
      const vy = at[1] - before[1];
      p.blindTicks = 2 * TPS;
      let crouched = false;
      run(d, 2 * TPS, (mm) => {
        if (mm.players[CT0].crouching) crouched = true;
        return mm.players[CT0].blindTicks === 0;
      });
      const after: Pt = [p.x, p.y];
      const dx = after[0] - at[0];
      const dy = after[1] - at[1];
      const moved = Math.sqrt(dx * dx + dy * dy);
      const back = vx * dx + vy * dy < 0;
      return { pass: moved >= UNIT && back && crouched, detail: `被閃前在動 ${Math.round(Math.sqrt(vx * vx + vy * vy))}；退開 ${(moved / UNIT).toFixed(1)} 格、往回 ${back}、蹲過 ${crouched}` };
    },
  },
  {
    id: 'P7',
    name: '火裡會離開',
    expect: '腳下突然著火（敵方燃燒瓶）：1 秒內走出火區，3 秒內不再回到火裡',
    run: (bot, seed) => {
      const d = driver(bot, { seed, seats: [CT0], alive: [CT0, T0] });
      toLive(d);
      const m = d.match;
      const s = openSpot(m.map, siteRect(m.map, 'A'), 4);
      m.teleport(CT0, s[0], s[1], 90);
      run(d, 6);
      const g = GRENADES.molotov;
      const cells = burnCells(m.map, s[0], s[1], g.radius);
      m.fires.push({ x: s[0], y: s[1], owner: T0, kind: 'molotov', startTick: m.tick, endTick: m.tick + g.durationTicks, cells });
      const inFire = new Set(cells);
      let ticksIn = 0;
      let lastIn = -1;
      let k = 0;
      run(d, 3 * TPS, (mm) => {
        k++;
        const p = mm.players[CT0];
        if (inFire.has(cellAt(mm.map, [p.x, p.y]))) {
          ticksIn++;
          lastIn = k;
        }
      });
      return { pass: lastIn <= TPS && m.players[CT0].alive, detail: `在火裡 ${ticksIn} tick、最後一次在第 ${lastIn} tick、血量 ${m.players[CT0].hp}` };
    },
  },
  {
    id: 'P8',
    name: '窄口前先停再探',
    expect: 'T 依指揮計畫走向包點，前方是窄口（區域交界寬 ≤ 6 格）、沒清過、敵人可能已到：過窄口前先在 1～4 格外停下 ≥ 0.3 秒並朝向窄口，15 秒內通過',
    run: (bot, seed) => {
      for (const site of ['B', 'A'] as const) {
        const r = chokeRun(bot, seed, site);
        if (r !== null) return r;
      }
      return { pass: false, detail: '兩個包點的路上都找不到窄口' };
    },
  },
  {
    id: 'P9',
    name: '走低危險路徑',
    expect: '隊友看到（雷達）一個 CT 守在最短路線上；Bot 去包點的路完全不進入那個 CT 的視線（另一條路存在），30 秒內到包點',
    run: (bot, seed) => dangerRun(bot, seed),
  },
  {
    id: 'P10',
    name: '被人擋住會重算路徑',
    expect: '兩個不動的隊友並排擋在路上（旁邊還有空間）：Bot 6 秒內繞過去（越過擋路的人 2 格以上）',
    run: (bot, seed) => blockRun(bot, seed),
  },
  {
    id: 'P11',
    name: '血低 1 對 2 撤退到掩體',
    expect: '血量 25、10～12 格外看到兩個敵人、附近沒有隊友：3 秒內退到兩個敵人都看不到的掩體',
    run: (bot, seed) => {
      const d = driver(bot, { seed, seats: [CT0], alive: [CT0, T0, T1] });
      toLive(d);
      const m = d.match;
      const spot = coverDuel(m.map);
      m.teleport(CT0, spot.s[0], spot.s[1], ang(spot.s, spot.e1));
      m.teleport(T0, spot.e1[0], spot.e1[1], ang(spot.e1, spot.s));
      m.teleport(T1, spot.e2[0], spot.e2[1], ang(spot.e2, spot.s));
      m.players[CT0].hp = 25;
      let covered = -1;
      run(d, 3 * TPS, (mm) => {
        const p = mm.players[CT0];
        const me: Pt = [p.x, p.y];
        const hidden = [T0, T1].every((e) => !mm.players[e].alive || !see(mm.map, me, [mm.players[e].x, mm.players[e].y]));
        if (hidden && covered < 0) covered = mm.tick;
        return hidden;
      });
      return { pass: covered >= 0 && m.players[CT0].alive, detail: `退到掩體 ${covered >= 0}、血量 ${m.players[CT0].hp}` };
    },
  },
  {
    id: 'P12',
    name: '聽到槍聲轉向正確方向扇形',
    expect: 'CT 走路時，背後（朝向反方向 ±60°）10～14 格外的敵人往別處開一槍：1.2 秒內轉到與真實方向相差 ≤ 30°',
    run: (bot, seed) => {
      let fireAt = -1;
      const shooter: Script = (obs) => {
        if (fireAt < 0 || obs.tick < fireAt) return [];
        fireAt = Infinity;
        return [{ type: 'fire', on: true }];
      };
      const d = driver(bot, { seed, seats: [CT0], alive: [CT0, T0], scripts: { [T0]: shooter } });
      toLive(d);
      const m = d.match;
      run(d, 2 * TPS);
      const p = m.players[CT0];
      const me: Pt = [p.x, p.y];
      const f = facingDeg(m, CT0);
      let e: Pt | null = null;
      for (const cells of [12, 10, 14, 11, 13]) {
        const hit = pointAt(m.map, me, cells, f + 180, 1, 60) ?? findCell(m.map, me, cells, f + 180, 60);
        if (hit !== null) {
          e = hit.p;
          break;
        }
      }
      if (e === null) return { pass: false, detail: '背後找不到放敵人的位置' };
      // 敵人往遠離 Bot 的方向開槍
      m.teleport(T0, e[0], e[1], ang(me, e));
      fireAt = m.tick + 3;
      let turned = -1;
      let start = -1;
      run(d, ticks(1.2) + 8, (mm) => {
        if (start < 0 && fireAt === Infinity) start = mm.tick;
        if (start < 0) return false;
        const q = mm.players[CT0];
        const truth = ang([q.x, q.y], [mm.players[T0].x, mm.players[T0].y]);
        if (Math.abs(angleDiff(facingDeg(mm, CT0), truth)) <= 30) {
          turned = mm.tick - start;
          return true;
        }
        return mm.tick - start > ticks(1.2);
      });
      return { pass: turned >= 0, detail: `開槍時朝向差 ${Math.abs(angleDiff(f, ang(me, e)))}°；轉過去花 ${turned} tick` };
    },
  },
  {
    id: 'P13',
    name: '矮牆後對線會蹲',
    expect: '站在矮牆後 1～2 格、對面 10 格外有敵人（線越過矮牆）：2 秒內蹲下（躲在矮牆後）',
    run: (bot, seed) => {
      const d = driver(bot, { seed, seats: [CT0], alive: [CT0, T0] });
      toLive(d);
      const m = d.match;
      const spot = lowWallDuel(m.map);
      m.teleport(CT0, spot.s[0], spot.s[1], ang(spot.s, spot.e));
      m.teleport(T0, spot.e[0], spot.e[1], ang(spot.e, spot.s));
      let crouched = -1;
      const t0 = m.tick;
      run(d, 2 * TPS, (mm) => {
        if (mm.players[CT0].crouching) {
          crouched = mm.tick - t0;
          return true;
        }
        return false;
      });
      return { pass: crouched >= 0, detail: `蹲下於 ${crouched} tick` };
    },
  },
];

/** pointAt 的寬鬆版：不要求看得到（聲音情境用） */
function findCell(m: ShooterMap, from: Pt, cells: number, pref: number, maxOff: number): { p: Pt; deg: number } | null {
  const cl = clearance(m);
  for (let k = 0; k <= maxOff; k += 5) {
    for (const s of k === 0 ? [0] : [k, -k]) {
      const p = snap(m, along(from, pref + s, cells));
      const i = cellAt(m, p);
      if (walkable(m, i) && cl[i] >= 1) return { p, deg: ang(from, p) };
    }
  }
  return null;
}

/** 指揮腳本：開打後喊計畫；plan(tick) 回傳要喊的字串（同一個字串只喊一次） */
function commander(plan: () => string): Script {
  let said = '';
  return () => {
    const p = plan();
    if (p === said) return [];
    said = p;
    return [{ type: 'say', text: p }];
  };
}

/** P8：T 出生區到包點的最短路上第一個窄口；Bot 放在窄口前 10 格 */
function chokeRun(bot: CompiledBot, seed: number, site: 'A' | 'B'): AiScenarioResult | null {
  const map = MAPS[MAP_ID]();
  const start = cellAt(map, openSpot(map, map.spawnZones.T, 1));
  const goal = rectCenterCell(map, siteRect(map, site));
  const path = bfsPath(map, start, goal);
  if (path === null) return null;
  let cross = -1;
  for (let i = 12; i < path.length - 1; i++) {
    const a = regionOf(map, path[i]);
    const b = regionOf(map, path[i + 1]);
    if (a === b) continue;
    if (Math.min(boundaryWidth(map, path[i], b), boundaryWidth(map, path[i + 1], a)) <= 6) {
      cross = i;
      break;
    }
  }
  if (cross < 12) return null;
  const other = site === 'A' ? 'B' : 'A';
  // 指揮先喊另一個點，15 秒後（敵人可能已經到窄口）改喊這個點
  let plan = `P:go ${other} 0`;
  const d = driver(bot, { seed, seats: [T1], scripts: { [T0]: commander(() => plan) } });
  toLive(d);
  const m = d.match;
  run(d, 15 * TPS);
  plan = `P:go ${site} 0`;
  const s = centerOf(map, path[cross - 10]);
  const c = centerOf(map, path[cross]);
  const c2 = centerOf(map, path[cross + 1]);
  const crossPt: Pt = [(c[0] + c2[0]) / 2, (c[1] + c2[1]) / 2];
  m.teleport(T1, s[0], s[1], ang(s, crossPt));
  run(d, 6);
  const fromSide = regionOf(map, path[cross]);
  const toSide = regionOf(map, path[cross + 1]);
  let still = 0;
  let paused = false;
  let crossed = -1;
  const t0 = m.tick;
  run(d, 15 * TPS, (mm) => {
    const p = mm.players[T1];
    const me: Pt = [p.x, p.y];
    const dd = d2(me, crossPt);
    const facing = Math.abs(angleDiff(facingDeg(mm, T1), ang(me, crossPt))) <= 45;
    if (p.vx === 0 && p.vy === 0 && dd >= UNIT && dd <= 4 * UNIT && facing) {
      still++;
      if (still >= 9) paused = true;
    } else still = 0;
    const r = regionOf(mm.map, cellAt(mm.map, me));
    if (r === toSide && d2(me, crossPt) > 1500) {
      crossed = mm.tick - t0;
      return true;
    }
    return !p.alive;
  });
  return { pass: paused && crossed >= 0, detail: `${site} 路線窄口 ${fromSide}→${toSide}；停下探頭 ${paused}；通過於 ${crossed} tick` };
}

/** P9：最短路線中段找一個看得到路線的位置放 CT，另一條避開它視線的路要存在；隊友站在看得到 CT 的地方提供雷達 */
function dangerRun(bot: CompiledBot, seed: number): AiScenarioResult {
  const map = MAPS[MAP_ID]();
  const cl = clearance(map);
  const startPt = openSpot(map, map.spawnZones.T, 1);
  const start = cellAt(map, startPt);
  for (const site of ['A', 'B'] as const) {
    const goal = rectCenterCell(map, siteRect(map, site));
    const path = bfsPath(map, start, goal);
    if (path === null) continue;
    for (let k = Math.floor(path.length * 0.35); k < Math.floor(path.length * 0.65); k += 3) {
      const w = path[k];
      if (cl[w] < 2) continue;
      const wp = centerOf(map, w);
      const vis = (i: number): boolean => d2(centerOf(map, i), wp) <= 30 * UNIT && see(map, centerOf(map, i), wp);
      if (vis(start) || vis(goal)) continue;
      const alt = bfsPath(map, start, goal, vis);
      if (alt === null) continue;
      // 雷達隊友：看得到 W、離 W 8～15 格、離起點最遠
      let radar = -1;
      let best = -1;
      for (let i = 0; i < map.width * map.height; i++) {
        if (!walkable(map, i) || cl[i] < 1) continue;
        const dd = d2(centerOf(map, i), wp);
        if (dd < 8 * UNIT || dd > 15 * UNIT || !see(map, centerOf(map, i), wp)) continue;
        const score = d2(centerOf(map, i), startPt) - (alt.includes(i) ? 1e9 : 0);
        if (score > best) {
          best = score;
          radar = i;
        }
      }
      if (radar < 0) continue;
      const rp = centerOf(map, radar);
      const watcher: Script = () => [{ type: 'aim', x: wp[0], y: wp[1] }];
      const d = driver(bot, { seed, seats: [T1], alive: [T0, T1, 2, CT0], scripts: { [T0]: commander(() => `P:go ${site} 0`), [2]: watcher } });
      toLive(d);
      const m = d.match;
      m.teleport(T1, startPt[0], startPt[1], ang(startPt, wp));
      m.teleport(2, rp[0], rp[1], ang(rp, wp));
      m.teleport(CT0, wp[0], wp[1], ang(wp, rp));
      let exposed = 0;
      let arrived = -1;
      const sr = siteRect(map, site);
      const t0 = m.tick;
      run(d, 30 * TPS, (mm) => {
        const p = mm.players[T1];
        const me: Pt = [p.x, p.y];
        if (d2(me, wp) <= 30 * UNIT && see(mm.map, me, wp)) exposed++;
        if (inRect(sr, Math.floor(p.x / UNIT), Math.floor(p.y / UNIT))) {
          arrived = mm.tick - t0;
          return true;
        }
        return !p.alive;
      });
      return { pass: exposed === 0 && arrived >= 0, detail: `去 ${site}：守在 ${regionOf(map, w)}（最短路 ${path.length} 格、避開的路 ${alt.length} 格）；進入視線 ${exposed} tick；到達 ${arrived} tick` };
    }
  }
  return { pass: false, detail: '找不到合適的佈置' };
}

/** P10：最短路上找一段左右至少各 2 格空間的直路，兩個隊友並排擋在路中央 */
function blockRun(bot: CompiledBot, seed: number): AiScenarioResult {
  const map = MAPS[MAP_ID]();
  const cl = clearance(map);
  const startPt = openSpot(map, map.spawnZones.T, 1);
  const start = cellAt(map, startPt);
  for (const site of ['B', 'A'] as const) {
    const goal = rectCenterCell(map, siteRect(map, site));
    const path = bfsPath(map, start, goal);
    if (path === null) continue;
    for (let k = 20; k < path.length - 10; k++) {
      const b = path[k];
      if (cl[b] < 3) continue;
      const bp = centerOf(map, b);
      const prev = centerOf(map, path[k - 3]);
      const dir = ang(prev, bp);
      const s = centerOf(map, path[k - 6]);
      const p1 = along(bp, dir + 90, 0.35);
      const p2 = along(bp, dir - 90, 0.35);
      const d = driver(bot, { seed, seats: [T1], alive: [T0, T1, 2, 3, CT0], scripts: { [T0]: commander(() => `P:go ${site} 0`) } });
      toLive(d);
      const m = d.match;
      m.teleport(T1, s[0], s[1], dir);
      m.teleport(2, Math.round(p1[0]), Math.round(p1[1]), dir);
      m.teleport(3, Math.round(p2[0]), Math.round(p2[1]), dir);
      m.teleport(CT0, ...centerOf(map, rectCenterCell(map, map.spawnZones.CT)));
      let passed = -1;
      const t0 = m.tick;
      run(d, 6 * TPS, (mm) => {
        const p = mm.players[T1];
        const me: Pt = [p.x, p.y];
        // 沿前進方向超過擋路的人 2 格
        const [ux, uy] = offset(dir, 1000);
        const proj = ((me[0] - bp[0]) * ux + (me[1] - bp[1]) * uy) / 1000;
        if (proj > 2 * UNIT) {
          passed = mm.tick - t0;
          return true;
        }
        return false;
      });
      return { pass: passed >= 0, detail: `去 ${site}：擋在 ${regionOf(map, b)}（${(bp[0] / UNIT).toFixed(1)}, ${(bp[1] / UNIT).toFixed(1)}）；繞過於 ${passed} tick` };
    }
  }
  return { pass: false, detail: '找不到合適的佈置' };
}

/** P11：看得到兩個敵人（10～12 格），5 格內有兩個敵人都看不到的格 */
function coverDuel(m: ShooterMap): { s: Pt; e1: Pt; e2: Pt } {
  const cl = clearance(m);
  for (const site of ['A', 'B'] as const) {
    const r = siteRect(m, site);
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        const i = cellIdx(m, x, y);
        if (cl[i] < 2) continue;
        const s = centerOf(m, i);
        for (let deg = 0; deg < 360; deg += 30) {
          const e1 = snap(m, along(s, deg, 11));
          const e2 = snap(m, along(e1, deg + 90, 1.5));
          if (!walkable(m, cellAt(m, e1)) || !walkable(m, cellAt(m, e2)) || !see(m, s, e1) || !see(m, s, e2)) continue;
          // 5 格內有沒有掩體
          let ok = false;
          for (let dy = -4; dy <= 4 && !ok; dy++) {
            for (let dx = -4; dx <= 4 && !ok; dx++) {
              const j = cellIdx(m, x + dx, y + dy);
              if (!walkable(m, j)) continue;
              const c = centerOf(m, j);
              if (!see(m, c, e1) && !see(m, c, e2) && bfsPath(m, i, j)!.length <= 6) ok = true;
            }
          }
          if (ok) return { s, e1, e2 };
        }
      }
    }
  }
  throw new Error(`${m.id}：找不到撤退情境的位置`);
}

/** P13：矮牆一側 1.5 格站人，另一側 10 格外放敵人，線越過矮牆 */
function lowWallDuel(m: ShooterMap): { s: Pt; e: Pt } {
  const cl = clearance(m);
  for (let i = 0; i < m.width * m.height; i++) {
    const x = i % m.width;
    const y = Math.floor(i / m.width);
    if (!isLowCell(m, x, y)) continue;
    const l = centerOf(m, i);
    for (let deg = 0; deg < 360; deg += 45) {
      const s = snap(m, along(l, deg, 1.5));
      const e = snap(m, along(l, deg + 180, 10));
      const si = cellAt(m, s);
      const ei = cellAt(m, e);
      if (!walkable(m, si) || !walkable(m, ei) || cl[ei] < 1 || !see(m, s, e)) continue;
      // 線要從自己這側 2 格內經過矮牆
      let low = false;
      for (let k = 1; k <= 8; k++) {
        const p = along(s, ang(s, e), k * 0.25);
        if (isLowCell(m, Math.floor(p[0] / UNIT), Math.floor(p[1] / UNIT))) low = true;
      }
      if (low) return { s, e };
    }
  }
  throw new Error(`${m.id}：找不到矮牆`);
}

// ───────── 6-2 團隊情境（T1～T15）：每個情境赤岩鎮與沙城都跑，兩張圖都過才算過 ─────────

const TEAM_MAPS = ['redrock', 'dust'] as const;
const CTS = [5, 6, 7, 8, 9] as const;
const TS = [0, 1, 2, 3, 4] as const;

/** 兩張圖各跑一次 */
function onBoth(f: (mapId: string) => AiScenarioResult): AiScenarioResult {
  const res = TEAM_MAPS.map((id) => {
    try {
      return { id, r: f(id) };
    } catch (e) {
      return { id, r: { pass: false, detail: `例外：${(e as Error).message}` } };
    }
  });
  return { pass: res.every((x) => x.r.pass), detail: res.map((x) => `${x.id}：${x.r.detail}`).join('；') };
}

const stepCache = new Map<string, Int32Array>();
/** 每格到包點矩形的步數（8 方向、不斜穿牆角）；走不到 −1 */
function siteSteps(m: ShooterMap, id: 'A' | 'B'): Int32Array {
  const key = `${m.id}${id}`;
  const hit = stepCache.get(key);
  if (hit !== undefined) return hit;
  const n = m.width * m.height;
  const out = new Int32Array(n).fill(-1);
  const r = siteRect(m, id);
  const q: number[] = [];
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const i = cellIdx(m, x, y);
      if (!walkable(m, i)) continue;
      out[i] = 0;
      q.push(i);
    }
  }
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const x = i % m.width;
    const y = Math.floor(i / m.width);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dy === 0) || blocksMove(m, x + dx, y + dy)) continue;
        if (dx !== 0 && dy !== 0 && (blocksMove(m, x + dx, y) || blocksMove(m, x, y + dy))) continue;
        const j = cellIdx(m, x + dx, y + dy);
        if (out[j] >= 0) continue;
        out[j] = out[i] + 1;
        q.push(j);
      }
    }
  }
  stepCache.set(key, out);
  return out;
}

const stepsAt = (m: ShooterMap, id: 'A' | 'B', x: number, y: number): number => siteSteps(m, id)[cellAt(m, [x, y])] ?? -1;
const inSiteRect = (m: ShooterMap, id: 'A' | 'B', x: number, y: number): boolean => inRect(siteRect(m, id), Math.floor(x / UNIT), Math.floor(y / UNIT));
const inAnySite = (m: ShooterMap, x: number, y: number): boolean => inSiteRect(m, 'A', x, y) || inSiteRect(m, 'B', x, y);

/** 離兩個包點與 T 出生區都最遠的空地（放不參與的人，免得被看到） */
function farSpot(m: ShooterMap): Pt {
  const key = `${m.id}far`;
  let spawn = stepCache.get(key);
  if (spawn === undefined) {
    // T 出生區的步數距離（同 siteSteps，起點換成出生區）
    const z = m.spawnZones.T;
    spawn = new Int32Array(m.width * m.height).fill(-1);
    const q: number[] = [];
    for (let y = z.y0; y < z.y1; y++) for (let x = z.x0; x < z.x1; x++) if (walkable(m, cellIdx(m, x, y))) q.push(cellIdx(m, x, y));
    for (const i of q) spawn[i] = 0;
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = (i % m.width) + dx;
          const y = Math.floor(i / m.width) + dy;
          if (blocksMove(m, x, y) || spawn[cellIdx(m, x, y)] >= 0) continue;
          spawn[cellIdx(m, x, y)] = spawn[i] + 1;
          q.push(cellIdx(m, x, y));
        }
      }
    }
    stepCache.set(key, spawn);
  }
  const cl = clearance(m);
  const a = siteSteps(m, 'A');
  const b = siteSteps(m, 'B');
  let best = -1;
  let bestS = -1;
  for (let i = 0; i < m.width * m.height; i++) {
    if (cl[i] < 2 || a[i] < 0 || b[i] < 0 || spawn[i] < 0) continue;
    const sc = Math.min(a[i], b[i], spawn[i]);
    if (sc > bestS) {
      bestS = sc;
      best = i;
    }
  }
  return centerOf(m, best);
}

/** 把不參與的人（讓回合不會因殲滅結束）放進地圖角落的牆格：誰都看不到、走不到；血加厚以防萬一 */
function park(m: ShooterMatch, pid: number): void {
  m.teleport(pid, UNIT / 2, UNIT / 2, 0);
  m.players[pid].hp = 100000;
}

/** 包點中央附近 k 個彼此隔 2 格的空地 */
function siteSpots(m: ShooterMap, id: 'A' | 'B', k: number): Pt[] {
  const r = siteRect(m, id);
  const c = openSpot(m, r, 1);
  const cl = clearance(m);
  const cand: number[] = [];
  for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) if (cl[cellIdx(m, x, y)] >= 1) cand.push(cellIdx(m, x, y));
  cand.sort((i, j) => d2(centerOf(m, i), c) - d2(centerOf(m, j), c) || i - j);
  const out: Pt[] = [];
  for (const i of cand) {
    const p = centerOf(m, i);
    if (out.every((q) => d2(q, p) >= 2 * UNIT)) out.push(p);
    if (out.length >= k) break;
  }
  return out;
}

/** 包點外、離 p 在 [lo, hi] 格、看得到 p 的第一個空地 */
function outsideView(m: ShooterMap, site: 'A' | 'B', p: Pt, lo: number, hi: number): Pt | null {
  const cl = clearance(m);
  for (let k = 0; k < m.width * m.height; k++) {
    const q = centerOf(m, k);
    if (!walkable(m, k) || cl[k] < 1 || inSiteRect(m, site, q[0], q[1])) continue;
    const dd = d2(q, p);
    if (dd >= lo * UNIT && dd <= hi * UNIT && see(m, q, p) && stepsAt(m, site, q[0], q[1]) > 3) return q;
  }
  return null;
}

/** 包點裡從包點外最看不到的空地（包點外 25 格內、每 2 格取樣，看得到它的格最少） */
function hiddenSpot(m: ShooterMap, site: 'A' | 'B'): Pt {
  const r = siteRect(m, site);
  const cl = clearance(m);
  let best: Pt = openSpot(m, r, 1);
  let bestN = Infinity;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      if (cl[cellIdx(m, x, y)] < 1) continue;
      const p = centerOf(m, cellIdx(m, x, y));
      let n = 0;
      for (let yy = r.y0 - 25; yy < r.y1 + 25; yy += 2) {
        for (let xx = r.x0 - 25; xx < r.x1 + 25; xx += 2) {
          if (xx < 0 || yy < 0 || xx >= m.width || yy >= m.height || inRect(r, xx, yy) || !walkable(m, cellIdx(m, xx, yy))) continue;
          const q = centerOf(m, cellIdx(m, xx, yy));
          if (d2(p, q) <= 25 * UNIT && see(m, p, q)) n++;
        }
      }
      if (n < bestN) {
        bestN = n;
        best = p;
      }
    }
  }
  return best;
}

/** 離 p 最近的牆格中心 */
function nearestWall(m: ShooterMap, p: Pt): Pt {
  for (let r = 1; r < 10; r++) {
    for (let deg = 0; deg < 360; deg += 15) {
      const q = along(p, deg, r);
      if (isSolidCell(m, Math.floor(q[0] / UNIT), Math.floor(q[1] / UNIT))) return q;
    }
  }
  return along(p, 0, 5);
}

/** 情境用：直接在包點中央下包（同 teleport／kill，是情境的內部操作） */
function forcePlant(m: ShooterMatch, site: 'A' | 'B'): Pt {
  const p = openSpot(m.map, siteRect(m.map, site), 1);
  for (const q of m.players) q.hasBomb = false;
  Object.assign(m.bomb, { state: 'planted', carrier: -1, x: p[0], y: p[1], site, explodeTick: m.tick + ROUND.bombTicks, planter: T0 });
  m.phase = 'planted';
  m.phaseEnd = m.bomb.explodeTick;
  return p;
}

/** 情境用：炸彈換到受測的 1 號身上（腳本指揮不會下包） */
function bombTo(m: ShooterMatch, pid: number): void {
  if (!m.players[T0].hasBomb) return;
  m.players[T0].hasBomb = false;
  m.players[pid].hasBomb = true;
  Object.assign(m.bomb, { state: 'carried', carrier: pid });
}

/** 腳本：站著朝某點開槍（at 回傳 null 時不動） */
function shooter(at: () => Pt | null): Script {
  return () => {
    const p = at();
    return p === null ? [] : [{ type: 'aim', x: Math.round(p[0]), y: Math.round(p[1]) }, { type: 'fire', on: true }];
  };
}

interface Retake {
  readonly m: ShooterMatch;
  readonly bomb: Pt;
  /** 回防的人（B 的守方陣亡後還活著的 CT）與下包時離炸彈的距離 */
  readonly rot: readonly number[];
  readonly start: ReadonlyMap<number, number>;
  /** 回防的人第一次進包點的 tick */
  readonly enter: ReadonlyMap<number, number>;
  /** 有人在拆的 tick 數、其中有人掩護的 tick 數 */
  readonly defuseTicks: number;
  readonly covered: number;
  readonly kitHolder: number;
  readonly closest: number;
}

/** T3／T10／T14：CT 守好位置後在 B 下包、B 的守方陣亡，剩下的人回防 */
function retakeRun(bot: CompiledBot, seed: number, mapId: string, kitSecond: boolean): Retake {
  const d = driver(bot, { seed, map: mapId, seats: CTS, alive: [...CTS, T0] });
  toLive(d);
  const m = d.match;
  park(m, T0);
  run(d, 22 * TPS);
  const bomb = forcePlant(m, 'B');
  for (const pid of CTS) if (stepsAt(m.map, 'B', m.players[pid].x, m.players[pid].y) <= 10) m.kill(pid);
  const rot = CTS.filter((pid) => m.players[pid].alive);
  const start = new Map(rot.map((pid) => [pid, d2([m.players[pid].x, m.players[pid].y], bomb)]));
  const byDist = [...rot].sort((a, b) => (start.get(a) ?? 0) - (start.get(b) ?? 0));
  const closest = byDist[0] ?? -1;
  let kitHolder = -1;
  for (const pid of CTS) m.players[pid].kit = false;
  if (kitSecond && byDist.length >= 2) {
    // 拆彈器給第二近的人，並把他放到最近的人旁邊 2 格（距離差在「優先給拆彈器」的範圍內）
    kitHolder = byDist[1];
    const p0: Pt = [m.players[closest].x, m.players[closest].y];
    const near = findCell(m.map, p0, 2, ang(p0, bomb) + 90, 180);
    if (near !== null) m.teleport(kitHolder, near.p[0], near.p[1], ang(near.p, bomb));
    m.players[kitHolder].kit = true;
  }
  const enter = new Map<number, number>();
  let covered = 0;
  let defuseTicks = 0;
  run(d, ROUND.bombTicks + 10, (mm) => {
    for (const pid of rot) {
      const p = mm.players[pid];
      if (p.alive && !enter.has(pid) && inSiteRect(mm.map, 'B', p.x, p.y)) enter.set(pid, mm.tick);
    }
    const def = CTS.find((pid) => mm.players[pid].alive && mm.players[pid].defuseTicks > 0);
    if (def === undefined) return;
    defuseTicks++;
    // 掩護：另一個活著的 CT 在炸彈 12 格內、沒在拆、面向不是炸彈（看入口）
    const cover = CTS.some((pid) => {
      const p = mm.players[pid];
      if (pid === def || !p.alive || d2([p.x, p.y], bomb) > 12 * UNIT) return false;
      return Math.abs(angleDiff(facingDeg(mm, pid), ang([p.x, p.y], bomb))) > 60;
    });
    if (cover) covered++;
  });
  return { m, bomb, rot, start, enter, defuseTicks, covered, kitHolder, closest };
}

/** 從 p 朝 deg 看出去到牆的距離（格） */
function sightLen(m: ShooterMap, p: Pt, deg: number): number {
  for (let k = 1; k <= 120; k++) {
    const q = along(p, deg, k * 0.5);
    if (isSolidCell(m, Math.floor(q[0] / UNIT), Math.floor(q[1] / UNIT))) return k * 0.5;
  }
  return 60;
}

/** 受測的 T 有人在包點裡 */
const tInSite = (m: ShooterMatch, ids: readonly number[]): boolean => ids.some((pid) => m.players[pid].alive && inAnySite(m.map, m.players[pid].x, m.players[pid].y));

const TEAM_SCENARIOS: readonly AiScenario[] = [
  {
    id: 'T1',
    name: 'CT 開局分點',
    expect: '五個 CT（手槍局）開打 25 秒後：A 點附近（9 步內）至少 1 人、B 點附近至少 1 人、兩點都離 9 步以上的中路至少 1 人',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const d = driver(bot, { seed, map: mapId, seats: CTS, alive: [...CTS, T0] });
        toLive(d);
        const m = d.match;
        park(m, T0);
        run(d, 25 * TPS);
        const pos = CTS.map((pid) => ({ a: stepsAt(m.map, 'A', m.players[pid].x, m.players[pid].y), b: stepsAt(m.map, 'B', m.players[pid].x, m.players[pid].y) }));
        const a = pos.filter((q) => q.a <= 9).length;
        const b = pos.filter((q) => q.b <= 9).length;
        const mid = pos.filter((q) => q.a > 9 && q.b > 9).length;
        return { pass: a >= 1 && b >= 1 && mid >= 1, detail: `A ${a}、B ${b}、中路 ${mid}` };
      }),
  },
  {
    id: 'T2',
    name: 'CT 聽 B 槍聲 A 留一人其餘輪轉',
    expect: 'CT 守好後，三個 T 出現在 B 點朝外開槍：10 秒內原本不在 B 的 CT 至少 2 人往 B 移動 ≥ 8 步（或本來就在 B 外 9～15 步而且朝 B 開火；步驟 7 加），A 點附近仍留至少 1 人',
    run: (bot, seed) =>
      onBoth((mapId) => {
        let target: Pt | null = null;
        const ts = [T0, T1, 2];
        const d = driver(bot, { seed, map: mapId, seats: CTS, alive: [...CTS, ...ts], scripts: Object.fromEntries(ts.map((pid) => [pid, shooter(() => target)])) });
        toLive(d);
        const m = d.match;
        const far = farSpot(m.map);
        for (const pid of ts) m.teleport(pid, far[0], far[1], 0);
        run(d, 22 * TPS);
        const b0 = new Map(CTS.map((pid) => [pid, stepsAt(m.map, 'B', m.players[pid].x, m.players[pid].y)]));
        const spots = siteSpots(m.map, 'B', 3);
        const tSpawn = openSpot(m.map, m.map.spawnZones.T, 1);
        spots.forEach((p, k) => m.teleport(ts[k], p[0], p[1], ang(p, tSpawn)));
        for (const pid of ts) m.players[pid].hp = 1000;
        target = tSpawn;
        const best = new Map(b0);
        const shot = new Set<number>();
        const ammo0 = new Map(CTS.map((pid) => [pid, ammo(m, pid)]));
        run(d, 10 * TPS, (mm) => {
          for (const pid of CTS) if (mm.players[pid].alive) best.set(pid, Math.min(best.get(pid) ?? 0, stepsAt(mm.map, 'B', mm.players[pid].x, mm.players[pid].y)));
          for (const pid of CTS) if (ammo(mm, pid) < (ammo0.get(pid) ?? 0)) shot.add(pid);
        });
        // 往 B 移動 ≥ 8 步；或本來就在 B 點外 9～15 步（沙城的中路位）而且朝 B 的 T 開火（已經在支援 B）
        const helps = CTS.filter((pid) => {
          const b = b0.get(pid) ?? 0;
          return b > 9 && (b - (best.get(pid) ?? 0) >= 8 || (b <= 15 && shot.has(pid)));
        });
        const stayA = CTS.filter((pid) => m.players[pid].alive && stepsAt(m.map, 'A', m.players[pid].x, m.players[pid].y) <= 9).length;
        return { pass: helps.length >= 2 && stayA >= 1, detail: `支援 B ${helps.length} 人（${helps.join(',')}）、A 留 ${stayA} 人（${CTS.map((pid) => `${pid}:${b0.get(pid)}→${best.get(pid)}${shot.has(pid) ? '開火' : ''}`).join(' ')}）` };
      }),
  },
  {
    id: 'T3',
    name: '炸彈下 B 全員回防且一起進',
    expect: 'CT 守好後在 B 下包、B 的守方陣亡：剩下的人都往 B 回防，第一個與第二個進包點的時間差 ≤ 4 秒（集結後一起進），而且拆除成功',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const r = retakeRun(bot, seed, mapId, false);
        const ent = [...r.enter.values()].sort((a, b) => a - b);
        const gap = ent.length >= 2 ? (ent[1] - ent[0]) / TPS : Infinity;
        const closer = r.rot.filter((pid) => d2([r.m.players[pid].x, r.m.players[pid].y], r.bomb) < (r.start.get(pid) ?? 0) - 5 * UNIT).length;
        const defused = r.m.rounds.at(-1)?.reason === 'defuse';
        return { pass: r.rot.length >= 2 && closer === r.rot.length && gap <= 4 && defused, detail: `回防 ${r.rot.length} 人、靠近 ${closer} 人、進點間隔 ${gap.toFixed(1)} 秒、拆除 ${defused}` };
      }),
  },
  {
    id: 'T4',
    name: 'T 執行前先煙再閃再進',
    expect: 'T 全買、計畫 split（指揮自己選點與兩條路線、兩組都到待命點才執行）；兩個包點各有一個 CT 躲在外面最看不到的角落、每秒朝牆開一槍（T 只聽得到）：先丟煙、再丟閃、然後才有人進包點',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const map = MAPS[mapId]();
        const hide = { [CT0]: hiddenSpot(map, 'A'), [CT1]: hiddenSpot(map, 'B') } as Record<number, Pt>;
        let k = 0;
        // CT：每 10 次決策朝自己旁邊的牆開一槍（製造聲音，不打人）
        const noisy = (pid: number): Script => {
          const wall = nearestWall(map, hide[pid]);
          return () => [{ type: 'aim', x: wall[0], y: wall[1] }, { type: 'fire', on: ++k % 10 === 0 }];
        };
        const d = driver(bot, { seed, map: mapId, seats: TS, alive: [...TS, CT0, CT1], scripts: { [CT0]: noisy(CT0), [CT1]: noisy(CT1) }, knobs: { plan: 3 }, opts: { roundMoney: [16000, null] } });
        toLive(d);
        const m = d.match;
        for (const pid of [CT0, CT1]) {
          m.teleport(pid, hide[pid][0], hide[pid][1], 0);
          m.players[pid].hp = 100000;
        }
        let smoke = -1;
        let flash = -1;
        let enter = -1;
        const seen = new Set<object>();
        run(d, 70 * TPS, (mm) => {
          for (const g of mm.projectiles) {
            if (seen.has(g) || g.owner >= TEAM_SIZE) continue;
            seen.add(g);
            if (g.kind === 'smoke' && smoke < 0) smoke = mm.tick;
            if (g.kind === 'flash' && flash < 0) flash = mm.tick;
          }
          if (enter < 0 && tInSite(mm, TS)) enter = mm.tick;
          return enter >= 0;
        });
        return { pass: smoke >= 0 && flash > smoke && enter > flash, detail: `煙 ${smoke}、閃 ${flash}、進點 ${enter}` };
      }),
  },
  {
    id: 'T5',
    name: '下包後守點不衝出',
    expect: 'T 在 B 下包後，一個 CT 在包點外 16～22 格露臉 1.5 秒再跑走：20 秒內沒有 T 離炸彈超過 16 格',
    run: (bot, seed) =>
      onBoth((mapId) => {
        let away: Pt | null = null;
        const d = driver(bot, { seed, map: mapId, seats: TS, alive: [...TS, CT0, CT1], scripts: { [CT0]: () => (away === null ? [] : [{ type: 'move', x: away[0], y: away[1] }]) } });
        toLive(d);
        const m = d.match;
        park(m, CT1);
        run(d, 2 * TPS);
        const spots = siteSpots(m.map, 'B', 5);
        TS.forEach((pid, k) => m.teleport(pid, spots[k % spots.length][0], spots[k % spots.length][1], 0));
        const bomb = forcePlant(m, 'B');
        const bait = outsideView(m.map, 'B', bomb, 16, 22);
        if (bait === null) return { pass: false, detail: '找不到誘餌位置' };
        m.teleport(CT0, bait[0], bait[1], ang(bait, bomb));
        m.players[CT0].hp = 100000;
        let maxD = 0;
        let t = 0;
        run(d, 20 * TPS, (mm) => {
          if (++t === Math.round(1.5 * TPS)) away = farSpot(mm.map);
          for (const pid of TS) if (mm.players[pid].alive) maxD = Math.max(maxD, d2([mm.players[pid].x, mm.players[pid].y], bomb));
        });
        const alive = TS.filter((pid) => m.players[pid].alive).length;
        return { pass: maxD <= 16 * UNIT && alive >= 3, detail: `離炸彈最遠 ${(maxD / UNIT).toFixed(1)} 格、活著 ${alive}` };
      }),
  },
  {
    id: 'T6',
    name: '1 對 2 不硬衝',
    expect: 'CT 只剩一人守好位置後，兩個 T 在 19 格外露臉 1 秒後消失：之後 8 秒 CT 沒有往他們消失的地方靠近超過 3 格',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const d = driver(bot, { seed, map: mapId, seats: [CT0], alive: [CT0, T0, T1] });
        toLive(d);
        const m = d.match;
        const far = farSpot(m.map);
        for (const pid of [T0, T1]) m.teleport(pid, far[0], far[1], 0);
        run(d, 20 * TPS);
        const me: Pt = [m.players[CT0].x, m.players[CT0].y];
        const hit = pointAt(m.map, me, 19, facingDeg(m, CT0), 1, 50);
        if (hit === null) return { pass: false, detail: '找不到露臉位置' };
        const e2 = findCell(m.map, hit.p, 1.5, hit.deg + 90, 90);
        m.teleport(T0, hit.p[0], hit.p[1], (hit.deg + 180) % 360);
        if (e2 !== null) m.teleport(T1, e2.p[0], e2.p[1], (hit.deg + 180) % 360);
        for (const pid of [T0, T1]) m.players[pid].hp = 1000;
        run(d, TPS);
        for (const pid of [T0, T1]) m.teleport(pid, far[0], far[1], 0);
        const d0 = d2([m.players[CT0].x, m.players[CT0].y], hit.p);
        let minD = d0;
        run(d, 8 * TPS, (mm) => {
          minD = Math.min(minD, d2([mm.players[CT0].x, mm.players[CT0].y], hit.p));
        });
        return { pass: d0 - minD <= 3 * UNIT, detail: `消失時距離 ${(d0 / UNIT).toFixed(1)} 格、之後最近 ${(minD / UNIT).toFixed(1)} 格` };
      }),
  },
  {
    id: 'T7',
    name: 'eco 局不買步槍、下回合能 full',
    expect: 'CT 每人 3000（買不起全買、輸一場就買得起）：指揮喊 B:eco、沒人買主武器；這回合輸掉後下回合指揮喊 B:full、至少 4 人拿步槍',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const log: Said[] = [];
        const d = driver(bot, { seed, map: mapId, seats: CTS, log, opts: { roundsPerHalf: 3, winRounds: 4, overtime: false } });
        const m = d.match;
        for (const pid of CTS) m.players[pid].money = 3000;
        toLive(d);
        run(d, TPS);
        const r1 = CTS.filter((pid) => m.players[pid].primary !== null).length;
        const call1 = log.find((l) => l.text.startsWith('B:'))?.text ?? '';
        for (const pid of CTS) m.kill(pid);
        run(d, ROUND.roundEndTicks + 5);
        log.length = 0;
        toLive(d);
        run(d, TPS);
        const r2 = CTS.filter((pid) => m.players[pid].primary?.id === 'm4' || m.players[pid].primary?.id === 'awp').length;
        const call2 = log.find((l) => l.text.startsWith('B:'))?.text ?? '';
        return { pass: r1 === 0 && call1 === 'B:eco' && r2 >= 4 && call2 === 'B:full', detail: `第 1 回合 ${call1} 主武器 ${r1}；第 2 回合 ${call2} 步槍 ${r2}` };
      }),
  },
  {
    id: 'T8',
    name: '五人不走同一條縫、不卡在一起',
    expect: 'rush：從開打到下包，沒有人在包點 6 步外連續 2 秒原地不動；split：五人從至少兩個不同的區域進包點',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const d = driver(bot, { seed, map: mapId, seats: TS, alive: [...TS, CT0], knobs: { plan: 2 } });
        toLive(d);
        const m = d.match;
        park(m, CT0);
        const still = new Map<number, number>();
        let worst = 0;
        let where = '';
        run(d, 60 * TPS, (mm) => {
          for (const pid of TS) {
            const p = mm.players[pid];
            // 包點 6 步內（進點後的守位）不算卡住
            const near = stepsAt(mm.map, 'A', p.x, p.y) <= 6 || stepsAt(mm.map, 'B', p.x, p.y) <= 6;
            if (!p.alive || near || p.plantTicks > 0) {
              still.set(pid, 0);
              continue;
            }
            const n = p.vx === 0 && p.vy === 0 ? (still.get(pid) ?? 0) + 1 : 0;
            still.set(pid, n);
            if (n > worst) where = `${pid} 號在 ${regionsAt(mm.map, p.x, p.y)[0] ?? '?'}`;
            worst = Math.max(worst, n);
          }
          return mm.bomb.state === 'planted';
        });
        const planted = m.bomb.state === 'planted';
        const ds = driver(bot, { seed, map: mapId, seats: TS, alive: [...TS, CT0], knobs: { plan: 3 } });
        toLive(ds);
        park(ds.match, CT0);
        // 進點區域：進包點矩形前最後經過的、不屬於包點的區域
        const siteRegions = new Set<string>();
        for (const id of ['A', 'B'] as const) {
          const r = siteRect(ds.match.map, id);
          for (let y = r.y0; y < r.y1; y++) for (let x = r.x0; x < r.x1; x++) for (const g of regionsAt(ds.match.map, x * UNIT + UNIT / 2, y * UNIT + UNIT / 2)) siteRegions.add(g);
        }
        const last = new Map<number, string>();
        const entry = new Map<number, string>();
        run(ds, 80 * TPS, (mm) => {
          for (const pid of TS) {
            const p = mm.players[pid];
            if (!p.alive || entry.has(pid)) continue;
            const g = regionsAt(mm.map, p.x, p.y)[0] ?? '?';
            if (inAnySite(mm.map, p.x, p.y)) entry.set(pid, last.get(pid) ?? '?');
            else if (!siteRegions.has(g)) last.set(pid, g);
          }
          return entry.size >= 5;
        });
        const ways = [...new Set(entry.values())];
        return { pass: worst < 2 * TPS && planted && ways.length >= 2, detail: `rush 最長原地不動 ${(worst / TPS).toFixed(1)} 秒（${where}）、下包 ${planted}；split 進點區域 ${ways.join('、')}` };
      }),
  },
  {
    id: 'T9',
    name: '閃光不閃到隊友',
    expect: '兩張圖各跑短賽（每半場 6 回合）：基準對基準一場（兩邊都算），有給對手時再加對手雙邊各一場（只算基準）；自己隊的閃光讓自己隊致盲的總 tick < 讓敵方致盲的 20%（40 場的統計見報告）',
    run: (bot, seed, opponent) => {
      let team = 0;
      let enemy = 0;
      const opts = { roundsPerHalf: 6, winRounds: 7, overtime: false as const };
      for (const mapId of TEAM_MAPS) {
        const games: { setup: Setup; groups: number[] }[] = [{ setup: { seed, map: mapId, seats: [...TS, ...CTS], opts }, groups: [0, 1] }];
        if (opponent !== undefined) {
          games.push({ setup: { seed, map: mapId, seats: TS, opp: { bot: opponent, seats: CTS }, opts }, groups: [0] });
          games.push({ setup: { seed, map: mapId, seats: CTS, opp: { bot: opponent, seats: TS }, opts }, groups: [1] });
        }
        for (const gm of games) {
          const d = driver(bot, gm.setup);
          while (!d.match.over) d.step();
          for (const r of d.match.rounds) {
            for (const g of gm.groups) {
              team += r.flashTeamTicks[g];
              enemy += r.flashEnemyTicks[g];
            }
          }
        }
      }
      return { pass: team < enemy * 0.2 || (team === 0 && enemy === 0), detail: `隊友致盲 ${(team / TPS).toFixed(1)} 秒、敵方 ${(enemy / TPS).toFixed(1)} 秒（${enemy === 0 ? '-' : ((team / enemy) * 100).toFixed(1)}%）` };
    },
  },
  {
    id: 'T10',
    name: 'CT 拆包時有人掩護',
    expect: '同 T3 的回防：有人在拆的時間裡，至少一半的 tick 有另一個 CT 在炸彈 12 格內、面向不是炸彈（看入口）',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const r = retakeRun(bot, seed, mapId, false);
        return { pass: r.defuseTicks > 0 && r.covered >= r.defuseTicks / 2, detail: `拆包 ${r.defuseTicks} tick、有人掩護 ${r.covered} tick` };
      }),
  },
  {
    id: 'T11',
    name: '指揮死了計畫接續',
    expect: 'T 計畫 split，開打 8 秒後指揮（0 號）陣亡：1.5 秒內 1 號重喊同一個計畫，之後有人照計畫進那個點',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const log: Said[] = [];
        const d = driver(bot, { seed, map: mapId, seats: TS, alive: [...TS, CT0], knobs: { plan: 3 }, log });
        toLive(d);
        const m = d.match;
        park(m, CT0);
        run(d, 8 * TPS);
        const plan0 = [...log].reverse().find((l) => l.from === T0 && l.text.startsWith('P:'))?.text ?? '';
        m.kill(T0);
        const t0 = m.tick;
        run(d, 1.5 * TPS);
        const again = log.some((l) => l.from === T1 && l.tick >= t0 && l.text === plan0);
        const site = /^P:split([AB])/.exec(plan0)?.[1] as 'A' | 'B' | undefined;
        let entered = false;
        run(d, 70 * TPS, (mm) => {
          entered = site !== undefined && TS.some((pid) => mm.players[pid].alive && inSiteRect(mm.map, site, mm.players[pid].x, mm.players[pid].y));
          return entered;
        });
        return { pass: plan0 !== '' && again && entered, detail: `原計畫 ${plan0}、1 號重喊 ${again}、進 ${site ?? '?'} ${entered}` };
      }),
  },
  {
    id: 'T12',
    name: '剩 35 秒強行執行',
    expect: '腳本指揮喊 default 後一直不喊執行：剩 36 秒以前沒人進包點；之後有人進點並在回合結束前下包',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const bots = [1, 2, 3, 4];
        const d = driver(bot, { seed, map: mapId, seats: bots, alive: [...TS, CT0], scripts: { [T0]: commander(() => 'P:default A 0 0') } });
        const m = d.match;
        toLive(d);
        park(m, CT0);
        bombTo(m, T1);
        let early = false;
        let enterLeft = -1;
        run(d, ROUND.roundTicks, (mm) => {
          const left = (mm.phaseEnd - mm.tick) / TPS;
          if (mm.phase === 'live' && tInSite(mm, bots)) {
            if (left > 36) early = true;
            else if (enterLeft < 0) enterLeft = left;
          }
          return mm.bomb.state === 'planted';
        });
        const planted = m.bomb.state === 'planted';
        return { pass: !early && enterLeft > 0 && planted, detail: `提早進點 ${early}；剩 ${enterLeft.toFixed(1)} 秒進點；下包 ${planted}` };
      }),
  },
  {
    id: 'T13',
    name: '對方 eco 時我方 full 且不過度保守',
    expect: 'T 連贏兩回合（對方連敗）後第 3 回合：指揮喊 B:full、至少 4 人拿步槍，開打 50 秒內有人進包點或已經殲滅對手',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const log: Said[] = [];
        const d = driver(bot, { seed, map: mapId, seats: TS, log, opts: { roundsPerHalf: 6, winRounds: 7, overtime: false } });
        const m = d.match;
        for (let r = 0; r < 2; r++) {
          toLive(d);
          for (const pid of CTS) m.kill(pid);
          run(d, ROUND.roundEndTicks + 5);
        }
        log.length = 0;
        toLive(d);
        run(d, TPS);
        const call = log.find((l) => l.text.startsWith('B:'))?.text ?? '';
        const rifles = TS.filter((pid) => m.players[pid].primary?.id === 'ak' || m.players[pid].primary?.id === 'awp').length;
        const r3 = m.roundNumber;
        let entered = -1;
        const t0 = m.tick;
        run(d, 50 * TPS, (mm) => {
          if (mm.roundNumber !== r3 || mm.phase === 'over') return true;
          if (tInSite(mm, TS)) {
            entered = mm.tick - t0;
            return true;
          }
          return false;
        });
        const won = m.rounds.find((x) => x.number === r3)?.winner === 'T';
        return { pass: call === 'B:full' && rifles >= 4 && (entered >= 0 || won), detail: `${call}、步槍 ${rifles}、進點 ${entered >= 0 ? `${(entered / TPS).toFixed(1)} 秒` : '沒有'}、殲滅 ${won}` };
      }),
  },
  {
    id: 'T14',
    name: '拆彈器優先給拆的人',
    expect: '同 T3 的回防，拆彈器在第二近的人身上（放在最近的人旁邊 2 格）：由拿拆彈器的人拆完',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const r = retakeRun(bot, seed, mapId, true);
        const defuser = r.m.bomb.defuser;
        return { pass: r.kitHolder >= 0 && defuser === r.kitHolder && r.m.rounds.at(-1)?.reason === 'defuse', detail: `拆彈器 ${r.kitHolder}、最近 ${r.closest}、拆的人 ${defuser}` };
      }),
  },
  {
    id: 'T15',
    name: '狙擊手守長對線開鏡',
    expect: 'CT 全買（隊內序號 4 買狙擊槍）：開打 25 秒內狙擊手在一個朝向看出去 ≥ 16 格的位置站定開鏡 ≥ 2 秒',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const d = driver(bot, { seed, map: mapId, seats: CTS, alive: [...CTS, T0], opts: { roundMoney: [null, 16000] } });
        toLive(d);
        const m = d.match;
        park(m, T0);
        const awper = CTS.find((pid) => m.players[pid].primary?.id === 'awp') ?? -1;
        if (awper < 0) return { pass: false, detail: '沒有人買狙擊槍' };
        let streak = 0;
        let best = 0;
        let len = 0;
        run(d, 25 * TPS, (mm) => {
          const p = mm.players[awper];
          const l = sightLen(mm.map, [p.x, p.y], facingDeg(mm, awper));
          if (p.scoped && p.vx === 0 && p.vy === 0 && l >= 16) {
            streak++;
            if (streak > best) {
              best = streak;
              len = l;
            }
          } else streak = 0;
        });
        return { pass: best >= 2 * TPS, detail: `狙擊手 ${awper}：開鏡站定最長 ${(best / TPS).toFixed(1)} 秒、看出去 ${len.toFixed(1)} 格` };
      }),
  },
];

// ───────── 步驟 7 角色情境（R1～R6）：旋鈕 role（1 突破、2 支援、3 錨點、4 狙擊、5 游擊），每條兩張圖都跑 ─────────

const ENTRY = 1;
const SUPPORT = 2;
const ANCHOR = 3;
const AWP = 4;
const LURK = 5;
/** 均衡陣容的角色依種子輪轉座位（角色不跟隊內序號綁在一起，才分辨得出旋鈕真的生效） */
const rolesFor = (seed: number): number[] => TS.map((_, i) => [ENTRY, SUPPORT, ANCHOR, LURK, AWP][(i + seed) % 5]);
const roleKnobs = (seats: readonly number[], roles: readonly number[], extra: Readonly<Record<string, number>> = {}): Partial<Record<number, Record<string, number>>> =>
  Object.fromEntries(seats.map((pid, i) => [pid, { ...extra, role: roles[i] }]));

interface ExecTrace {
  /** 進包點矩形的順序（playerId） */
  readonly order: number[];
  /** 第一顆煙的主人（−1 沒有） */
  readonly smokeBy: number;
  /** 第一個人進點前，狙擊手開鏡站定的 tick 數（累計） */
  readonly scoped: number;
  readonly awps: number;
  readonly rifles: number;
  readonly m: ShooterMatch;
}

/** T 全買照計畫執行（CT 放進牆角）：記進點順序、第一顆煙、狙擊手執行前開鏡；roles 依座位 0～4 */
function execTrace(bot: CompiledBot, seed: number, mapId: string, plan: number, roles: readonly number[]): ExecTrace {
  const d = driver(bot, { seed, map: mapId, seats: TS, alive: [...TS, CT0], seatKnobs: roleKnobs(TS, roles, { plan }), opts: { roundMoney: [16000, null] } });
  toLive(d);
  const m = d.match;
  park(m, CT0);
  const awper = TS.find((pid) => m.players[pid].primary?.id === 'awp') ?? -1;
  const awps = TS.filter((pid) => m.players[pid].primary?.id === 'awp').length;
  const rifles = TS.filter((pid) => m.players[pid].primary?.id === 'ak').length;
  const order: number[] = [];
  let smokeBy = -1;
  let scoped = 0;
  const seen = new Set<object>();
  run(d, 80 * TPS, (mm) => {
    for (const g of mm.projectiles) {
      if (seen.has(g) || g.owner >= TEAM_SIZE) continue;
      seen.add(g);
      if (g.kind === 'smoke' && smokeBy < 0 && order.length === 0) smokeBy = g.owner;
    }
    if (order.length === 0 && awper >= 0) {
      const p = mm.players[awper];
      if (p.alive && p.scoped && p.vx === 0 && p.vy === 0) scoped++;
    }
    for (const pid of TS) if (mm.players[pid].alive && !order.includes(pid) && inAnySite(mm.map, mm.players[pid].x, mm.players[pid].y)) order.push(pid);
    return order.length >= TS.filter((pid) => mm.players[pid].alive).length;
  });
  return { order, smokeBy, scoped, awps, rifles, m };
}

const roleOf = (roles: readonly number[], pid: number): number => roles[TS.indexOf(pid as (typeof TS)[number])] ?? 0;
const ROLE_LABEL = ['無', '突破', '支援', '錨點', '狙擊', '游擊'];

const ROLE_SCENARIOS: readonly AiScenario[] = [
  {
    id: 'R1',
    name: '突破手第一個進點',
    expect: '均衡陣容（角色依種子輪轉座位）T 全買，split 與 rush 各一回合、兩張圖：第一個進包點的人是突破手（4 回合至少 3 回合）',
    run: (bot, seed) => {
      const roles = rolesFor(seed);
      const res = TEAM_MAPS.flatMap((mapId) =>
        [3, 2].map((plan) => {
          const tr = execTrace(bot, seed, mapId, plan, roles);
          const first = tr.order[0] ?? -1;
          return { ok: first >= 0 && roleOf(roles, first) === ENTRY, txt: `${mapId}${plan === 3 ? ' split' : ' rush'} 第一個 ${first}（${ROLE_LABEL[roleOf(roles, first)] ?? '?'}）` };
        }),
      );
      return { pass: res.filter((r) => r.ok).length >= 3, detail: res.map((r) => r.txt).join('；') };
    },
  },
  {
    id: 'R2',
    name: '狙擊手不第一個進、架長線',
    expect: '同 R1 的 split：狙擊手進點順序 ≥ 3（或到最後都沒進）、第一個人進點前開鏡站定累計 ≥ 2 秒；兩張圖',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const roles = rolesFor(seed);
        const tr = execTrace(bot, seed, mapId, 3, roles);
        const awp = TS.find((pid) => roleOf(roles, pid) === AWP) ?? -1;
        const at = tr.order.indexOf(awp);
        const late = at < 0 ? tr.order.length >= 2 : at >= 2;
        return { pass: tr.awps === 1 && late && tr.scoped >= 2 * TPS, detail: `狙擊手 ${awp} 第 ${at < 0 ? '－' : at + 1} 個進點（${tr.order.join(',')}）、執行前開鏡 ${(tr.scoped / TPS).toFixed(1)} 秒` };
      }),
  },
  {
    id: 'R3',
    name: '支援丟煙',
    expect: '同 R1 的 split：第一個人進點前的第一顆煙由支援丟；兩張圖',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const roles = rolesFor(seed);
        const tr = execTrace(bot, seed, mapId, 3, roles);
        return { pass: tr.smokeBy >= 0 && roleOf(roles, tr.smokeBy) === SUPPORT, detail: `煙 ${tr.smokeBy}（${ROLE_LABEL[roleOf(roles, tr.smokeBy)] ?? '沒丟'}）` };
      }),
  },
  {
    id: 'R4',
    name: '錨點不輪轉',
    expect: '同 T2（手槍局、CT 守好後三個 T 在 B 點朝外開槍）：10 秒後 A 的錨點仍在 A 點 9 步內；開局在 A 的非錨點有人往 B 移動 ≥ 8 步；兩張圖',
    run: (bot, seed) =>
      onBoth((mapId) => {
        let target: Pt | null = null;
        const ts = [T0, T1, 2];
        const roles = rolesFor(seed);
        const d = driver(bot, { seed, map: mapId, seats: CTS, alive: [...CTS, ...ts], seatKnobs: roleKnobs(CTS, roles), scripts: Object.fromEntries(ts.map((pid) => [pid, shooter(() => target)])) });
        toLive(d);
        const m = d.match;
        const far = farSpot(m.map);
        for (const pid of ts) m.teleport(pid, far[0], far[1], 0);
        run(d, 22 * TPS);
        const anchor = CTS[roles.indexOf(ANCHOR)];
        const atA = CTS.filter((pid) => stepsAt(m.map, 'A', m.players[pid].x, m.players[pid].y) <= 9);
        const b0 = new Map(CTS.map((pid) => [pid, stepsAt(m.map, 'B', m.players[pid].x, m.players[pid].y)]));
        const spots = siteSpots(m.map, 'B', 3);
        const tSpawn = openSpot(m.map, m.map.spawnZones.T, 1);
        spots.forEach((p, k) => m.teleport(ts[k], p[0], p[1], ang(p, tSpawn)));
        for (const pid of ts) m.players[pid].hp = 1000;
        target = tSpawn;
        const best = new Map(b0);
        run(d, 10 * TPS, (mm) => {
          for (const pid of CTS) if (mm.players[pid].alive) best.set(pid, Math.min(best.get(pid) ?? 0, stepsAt(mm.map, 'B', mm.players[pid].x, mm.players[pid].y)));
        });
        const stay = atA.includes(anchor) && m.players[anchor].alive && stepsAt(m.map, 'A', m.players[anchor].x, m.players[anchor].y) <= 9;
        const movers = atA.filter((pid) => pid !== anchor && (b0.get(pid) ?? 0) - (best.get(pid) ?? 0) >= 8);
        return { pass: stay && movers.length >= 1, detail: `開局在 A：${atA.join(',')}；錨點 ${anchor} 留守 ${stay}；往 B ${movers.join(',') || '無'}` };
      }),
  },
  {
    id: 'R5',
    name: '游擊走第二組／中路',
    expect: 'T default（全買）：指揮喊執行以前，游擊到過另一點 30 步內、而且那時離另一點比離主力的點近；CT（手槍局）開打 25 秒後游擊在兩點 9 步外（中路）；兩張圖',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const roles = rolesFor(seed);
        const log: Said[] = [];
        const d = driver(bot, { seed, map: mapId, seats: TS, alive: [...TS, CT0], seatKnobs: roleKnobs(TS, roles, { plan: 1 }), log, opts: { roundMoney: [16000, null] } });
        toLive(d);
        park(d.match, CT0);
        // 炸彈給突破手（持彈者一定在主力組；這裡看游擊有沒有走第二組）
        const entry = TS[roles.indexOf(ENTRY)];
        for (const pid of TS) d.match.players[pid].hasBomb = pid === entry;
        Object.assign(d.match.bomb, { state: 'carried', carrier: entry });
        const lurk = TS[roles.indexOf(LURK)];
        let plan = '';
        let dAway = Infinity;
        let dMain = Infinity;
        // 佈置期間（指揮喊執行以前）游擊離另一點最近的時候
        run(d, 60 * TPS, (mm) => {
          plan = [...log].reverse().find((l) => l.text.startsWith('P:default'))?.text ?? plan;
          if (plan === '' || plan.includes('>')) return plan !== '';
          const site = (/^P:default ([AB])/.exec(plan)?.[1] ?? 'A') as 'A' | 'B';
          const p = mm.players[lurk];
          const a = stepsAt(mm.map, site === 'A' ? 'B' : 'A', p.x, p.y);
          if (p.alive && a < dAway) {
            dAway = a;
            dMain = stepsAt(mm.map, site, p.x, p.y);
          }
          return false;
        });
        const site = (/^P:default ([AB])/.exec(plan)?.[1] ?? 'A') as 'A' | 'B';
        const away = site === 'A' ? 'B' : 'A';
        const tOk = dAway < dMain && dAway <= 30;
        const dc = driver(bot, { seed, map: mapId, seats: CTS, alive: [...CTS, T0], seatKnobs: roleKnobs(CTS, roles) });
        toLive(dc);
        park(dc.match, T0);
        run(dc, 25 * TPS);
        const cl = CTS[roles.indexOf(LURK)];
        const q = dc.match.players[cl];
        const ctOk = stepsAt(dc.match.map, 'A', q.x, q.y) > 9 && stepsAt(dc.match.map, 'B', q.x, q.y) > 9;
        return { pass: plan !== '' && tOk && ctOk, detail: `${plan}：T 游擊 ${lurk} 離 ${away} ${dAway} 步、離 ${site} ${dMain} 步；CT 游擊 ${cl} 中路 ${ctOk}` };
      }),
  },
  {
    id: 'R6',
    name: '五狙退化',
    expect: '五個 role = 狙擊的 T 全買：只有一把狙擊槍、其餘四人買步槍，計畫照常執行（80 秒內有人進包點）；兩張圖',
    run: (bot, seed) =>
      onBoth((mapId) => {
        const tr = execTrace(bot, seed, mapId, 0, [AWP, AWP, AWP, AWP, AWP]);
        return { pass: tr.awps === 1 && tr.rifles === 4 && tr.order.length >= 1, detail: `狙擊槍 ${tr.awps}、步槍 ${tr.rifles}、進點 ${tr.order.length} 人` };
      }),
  },
];

export const AI_SCENARIOS: readonly AiScenario[] = [...SOLO_SCENARIOS, ...TEAM_SCENARIOS, ...ROLE_SCENARIOS];

/** 跑一組情境（每個 5 個種子）；filter 只跑指定的情境 */
export function runAiScenarios(bot: CompiledBot, filter?: (id: string) => boolean, opponent?: CompiledBot): { id: string; name: string; pass: boolean; detail: string }[] {
  const out: { id: string; name: string; pass: boolean; detail: string }[] = [];
  for (const s of AI_SCENARIOS) {
    if (filter !== undefined && !filter(s.id)) continue;
    const res = AI_SCENARIO_SEEDS.map((seed) => {
      try {
        return s.run(bot, seed, opponent);
      } catch (e) {
        return { pass: false, detail: `例外：${(e as Error).message}` };
      }
    });
    out.push({ id: s.id, name: s.name, pass: res.every((r) => r.pass), detail: res.map((r, k) => `[${AI_SCENARIO_SEEDS[k]}]${r.pass ? '○' : '×'} ${r.detail}`).join('｜') });
  }
  return out;
}
