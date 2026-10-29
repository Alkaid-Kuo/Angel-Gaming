// CS 射擊基準 Bot 情境測試（步驟 6）：「懂不懂」的測試，不是強度測試。
// 受測 Bot 坐某幾個座位，其他座位用腳本控制（ScriptController），每個情境固定 5 個種子都要過；test/shooter-ai.test.ts 檢查。
// 位置一律由地圖資料（出生區、包點、牆、矮牆、區域）算出，不寫死座標；預設跑赤岩鎮，換地圖也要能找到位置。
// 情境只用引擎的公開狀態判定（位置、朝向、血量、子彈、姿勢），受測 Bot 只拿得到它自己的觀察資料。
// 用法：runAiScenarios(compileBot(...), 'baseline')；腳本 scripts/shooter-ai-scenarios.ts 印出結果。
import { resolveKnobs } from '../sandbox/controller.ts';
import type { CompiledBot } from '../sandbox/compile.ts';
import { angleDiff, iatan2, offset } from '../shared/geom.ts';
import type { ShooterCommand, ShooterObservation, Team } from './api.ts';
import { GRENADES, ROUND, TEAM_SIZE, TPS, UNIT, WEAPONS, ticks, type WeaponId } from './config.ts';
import { MAPS, blocksMove, inRect, isLowCell, regionsAt, type Rect, type ShooterMap } from './map.ts';
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
  readonly run: (bot: CompiledBot, seed: number) => AiScenarioResult;
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
}

function driver(bot: CompiledBot, s: Setup): ShooterDriver {
  const map = MAPS[MAP_ID]();
  const controllers = Array.from({ length: PLAYER_COUNT }, (_, pid) => (s.seats.includes(pid) ? new ShooterBatchController(bot, 'baseline', s.seed, pid, map) : new ScriptController(`script-${pid}`, s.scripts?.[pid] ?? idle)));
  const knobs = controllers.map((c) => resolveKnobs(c.declaration, undefined, c.label));
  const d = new ShooterDriver({ seed: s.seed, mapId: MAP_ID, ...s.opts, controllers, knobs, record: false });
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

export const AI_SCENARIOS: readonly AiScenario[] = [
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
    expect: 'CT 往守位走 4 秒後被閃 2 秒：1.5 秒內往來的方向退開至少 1 格，被閃期間有蹲下',
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

/** 跑一組情境（每個 5 個種子）；filter 只跑指定的情境 */
export function runAiScenarios(bot: CompiledBot, filter?: (id: string) => boolean): { id: string; name: string; pass: boolean; detail: string }[] {
  const out: { id: string; name: string; pass: boolean; detail: string }[] = [];
  for (const s of AI_SCENARIOS) {
    if (filter !== undefined && !filter(s.id)) continue;
    const res = AI_SCENARIO_SEEDS.map((seed) => {
      try {
        return s.run(bot, seed);
      } catch (e) {
        return { pass: false, detail: `例外：${(e as Error).message}` };
      }
    });
    out.push({ id: s.id, name: s.name, pass: res.every((r) => r.pass), detail: res.map((r, k) => `[${AI_SCENARIO_SEEDS[k]}]${r.pass ? '○' : '×'} ${r.detail}`).join('｜') });
  }
  return out;
}
