// 地圖檢查：前半是 test/shooter-map.test.ts 的硬條件，後半是設計提示；另外提供路程與視線計算。
import { TEAM_SIZE, UNIT, VISION } from '../../shooter/config.ts';
import { blocksMove, cellOf, inRect, isSolidCell, reachable, regionsAt, type ShooterMap } from '../../shooter/map.ts';
import { lineOfSight } from '../../shooter/vision.ts';
import type { EditDoc, MRect } from './doc.ts';

/** AK／M4 跑步速度（格／秒）；路程換算秒數用 */
export const RUN_CELLS_PER_SEC = 215 / 52.5;

export interface Check {
  readonly level: 'ok' | 'fail' | 'warn' | 'info';
  readonly label: string;
  readonly detail: string;
  /** 點這一列時要在圖上標出來的格 */
  readonly cells?: readonly number[];
}

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;

/** 從一格到全圖的走路距離（格）；八方向，斜走不切牆角 */
export function pathField(map: ShooterMap, sx: number, sy: number): Float64Array {
  const W = map.width;
  const H = map.height;
  const d = new Float64Array(W * H).fill(Infinity);
  if (blocksMove(map, sx, sy)) return d;
  d[sy * W + sx] = 0;
  for (let changed = true; changed; ) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < W * H; i++) {
        const k = pass === 0 ? i : W * H - 1 - i;
        const x = k % W;
        const y = (k - x) / W;
        if (blocksMove(map, x, y)) continue;
        let best = d[k];
        for (const [dx, dy] of NEIGHBOURS) {
          const nx = x + dx;
          const ny = y + dy;
          if (blocksMove(map, nx, ny)) continue;
          if (dx !== 0 && dy !== 0 && (blocksMove(map, x + dx, y) || blocksMove(map, x, y + dy))) continue;
          const v = d[ny * W + nx] + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1);
          if (v < best) best = v;
        }
        if (best < d[k]) {
          d[k] = best;
          changed = true;
        }
      }
    }
  }
  return d;
}

/** 沿距離場走回起點，回傳路徑的格 */
export function tracePath(map: ShooterMap, field: Float64Array, fx: number, fy: number): [number, number][] {
  const W = map.width;
  if (!Number.isFinite(field[fy * W + fx])) return [];
  const out: [number, number][] = [[fx, fy]];
  let x = fx;
  let y = fy;
  while (field[y * W + x] > 0) {
    let bx = x;
    let by = y;
    let best = field[y * W + x];
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (blocksMove(map, nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (blocksMove(map, x + dx, y) || blocksMove(map, x, y + dy))) continue;
      const v = field[ny * W + nx];
      if (v < best) {
        best = v;
        bx = nx;
        by = ny;
      }
    }
    if (bx === x && by === y) break;
    x = bx;
    y = by;
    out.push([x, y]);
  }
  return out;
}

/** 從一格看得到的格（1 ＝ 看得到）；用引擎的視線判定 */
export function visibleCells(map: ShooterMap, cx: number, cy: number, crouch: boolean): Uint8Array {
  const W = map.width;
  const out = new Uint8Array(W * map.height);
  const ax = cx * UNIT + UNIT / 2;
  const ay = cy * UNIT + UNIT / 2;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < W; x++) {
      if (isSolidCell(map, x, y)) continue;
      if (lineOfSight(map, ax, ay, x * UNIT + UNIT / 2, y * UNIT + UNIT / 2, [], crouch, false)) out[y * W + x] = 1;
    }
  }
  return out;
}

/** 區域之間的連接圖：反覆剝掉只接一個鄰居的區域，剝得掉的都在死路上。出生區算終點，不剝 */
export function deadEnds(doc: EditDoc, map: ShooterMap): number[] {
  const W = map.width;
  const owner = new Int32Array(W * map.height).fill(-1);
  doc.areas.forEach((a, i) => {
    for (let y = Math.max(0, a.y0); y < Math.min(map.height, a.y1); y++) {
      for (let x = Math.max(0, a.x0); x < Math.min(W, a.x1); x++) {
        if (!blocksMove(map, x, y) && owner[y * W + x] < 0) owner[y * W + x] = i;
      }
    }
  });
  const links = new Map<number, Set<number>>();
  const link = (a: number, b: number): void => {
    if (!links.has(a)) links.set(a, new Set());
    links.get(a)!.add(b);
  };
  for (let y = 0; y < map.height - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const a = owner[y * W + x];
      if (a < 0) continue;
      for (const b of [owner[y * W + x + 1], owner[(y + 1) * W + x]]) {
        if (b < 0 || b === a) continue;
        link(a, b);
        link(b, a);
      }
    }
  }
  const anchored = (i: number): boolean => {
    const a = doc.areas[i];
    return (['T', 'CT'] as const).some((t) => doc.spawns[t].some((s) => inRect(a, cellOf(s.x), cellOf(s.y))));
  };
  const out: number[] = [];
  for (let again = true; again; ) {
    again = false;
    for (const [i, ns] of links) {
      if (ns.size > 1 || anchored(i)) continue;
      out.push(i);
      for (const n of ns) links.get(n)?.delete(i);
      links.delete(i);
      again = true;
    }
  }
  return out;
}

function rectCells(map: ShooterMap, r: MRect): number[] {
  const out: number[] = [];
  for (let y = Math.max(0, r.y0); y < Math.min(map.height, r.y1); y++) {
    for (let x = Math.max(0, r.x0); x < Math.min(map.width, r.x1); x++) out.push(y * map.width + x);
  }
  return out;
}

/** 包點房間外一圈的連續開口段數（同測試算法） */
function entrances(map: ShooterMap, r: MRect): number {
  const ring: [number, number][] = [];
  for (let x = r.x0 - 1; x <= r.x1; x++) ring.push([x, r.y0 - 1]);
  for (let y = r.y0; y <= r.y1; y++) ring.push([r.x1, y]);
  for (let x = r.x1 - 1; x >= r.x0 - 1; x--) ring.push([x, r.y1]);
  for (let y = r.y1 - 1; y >= r.y0; y--) ring.push([r.x0 - 1, y]);
  let segs = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x, y] = ring[i];
    const [px, py] = ring[(i + ring.length - 1) % ring.length];
    if (!blocksMove(map, x, y) && blocksMove(map, px, py)) segs += 1;
  }
  return segs;
}

function checkSpawns(map: ShooterMap): Check {
  const problems: string[] = [];
  const cells: number[] = [];
  const all: { x: number; y: number }[] = [];
  for (const t of ['T', 'CT'] as const) {
    if (map.spawns[t].length < TEAM_SIZE) problems.push(`${t} 不足 ${TEAM_SIZE} 個`);
    for (const s of map.spawns[t]) {
      const cx = cellOf(s.x);
      const cy = cellOf(s.y);
      all.push(s);
      const r = VISION.bodyRadius;
      const cramped = [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([ox, oy]) => blocksMove(map, cellOf(s.x + ox * r), cellOf(s.y + oy * r)));
      if (blocksMove(map, cx, cy) || cramped || !inRect(map.spawnZones[t], cx, cy)) {
        problems.push(`${t} (${cx},${cy}) 位置不合格`);
        cells.push(cy * map.width + cx);
      }
    }
  }
  const gap = 2 * VISION.bodyRadius;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if ((all[i].x - all[j].x) ** 2 + (all[i].y - all[j].y) ** 2 < gap * gap) problems.push('有出生點貼太近');
    }
  }
  return { level: problems.length === 0 ? 'ok' : 'fail', label: '出生點', detail: problems.length === 0 ? '數量、位置、間距都合格' : [...new Set(problems)].join('；'), cells };
}

function checkConnected(map: ShooterMap): Check {
  const s = map.spawns.T[0];
  const seen = reachable(map, cellOf(s.x), cellOf(s.y));
  const lost: number[] = [];
  for (let i = 0; i < map.solid.length; i++) if (map.solid[i] === 0 && seen[i] !== 1) lost.push(i);
  const c = map.spawns.CT[0];
  const toCt = seen[cellOf(c.y) * map.width + cellOf(c.x)] === 1;
  const ok = lost.length === 0 && toCt;
  return { level: ok ? 'ok' : 'fail', label: '連通', detail: ok ? '所有可走格都連通' : `${lost.length} 格走不到${toCt ? '' : '，T 到不了 CT'}`, cells: lost };
}

function checkSpawnSight(map: ShooterMap): Check {
  const cells = (z: MRect): number[] => rectCells(map, z).filter((k) => map.solid[k] === 0);
  const point = (k: number): [number, number] => {
    const x = k % map.width;
    return [x * UNIT + UNIT / 2, ((k - x) / map.width) * UNIT + UNIT / 2];
  };
  const ts = cells(map.spawnZones.T);
  const cts = cells(map.spawnZones.CT);
  if (ts.length <= 100 || cts.length <= 100) return { level: 'fail', label: '出生區視線', detail: '出生區可走格要超過 100 格' };
  for (const a of ts) {
    const [ax, ay] = point(a);
    for (const b of cts) {
      const [bx, by] = point(b);
      if (lineOfSight(map, ax, ay, bx, by)) return { level: 'fail', label: '出生區視線', detail: '兩邊出生區看得到彼此', cells: [a, b] };
    }
  }
  return { level: 'ok', label: '出生區視線', detail: '沒有直線視線' };
}

function checkSites(doc: EditDoc, map: ShooterMap): Check[] {
  return map.sites.map((site) => {
    const room = doc.areas.find((a) => a.id === (site.id === 'A' ? 'aSite' : 'bSite')) ?? site;
    const inner = rectCells(map, site);
    const open = inner.filter((k) => map.solid[k] === 0).length;
    const low = inner.filter((k) => map.solid[k] === 2).length;
    const doors = entrances(map, room);
    const problems: string[] = [];
    if (open <= 50) problems.push('可下包面積太小');
    if (low === 0) problems.push('沒有矮掩體');
    if (doors < 3) problems.push('入口少於 3 個');
    return { level: problems.length === 0 ? 'ok' : 'fail', label: `${site.id} 包點`, detail: problems.length === 0 ? `入口 ${doors} 個，可下包 ${site.x1 - site.x0}×${site.y1 - site.y0}` : problems.join('；'), cells: rectCells(map, room) } as Check;
  });
}

function checkRegions(map: ShooterMap): Check {
  const s = map.spawns.T[0];
  const a = map.sites[0];
  const ok = regionsAt(map, s.x, s.y).includes('tSpawn') && a !== undefined && regionsAt(map, ((a.x0 + a.x1) / 2) * UNIT, ((a.y0 + a.y1) / 2) * UNIT).includes('aSite');
  return { level: ok ? 'ok' : 'fail', label: '區域代號', detail: ok ? 'tSpawn、aSite 都在正確位置' : 'T 出生點要在 tSpawn，A 點中心要在 aSite' };
}

/** 一格寬窄縫與一格厚細牆 */
function checkSlivers(map: ShooterMap): Check[] {
  const W = map.width;
  const slots: number[] = [];
  const thin: number[] = [];
  for (let y = 2; y < map.height - 2; y++) {
    for (let x = 2; x < W - 2; x++) {
      const k = y * W + x;
      if (!blocksMove(map, x, y)) {
        if ((blocksMove(map, x - 1, y) && blocksMove(map, x + 1, y)) || (blocksMove(map, x, y - 1) && blocksMove(map, x, y + 1))) slots.push(k);
      } else if (isSolidCell(map, x, y)) {
        if ((!blocksMove(map, x - 1, y) && !blocksMove(map, x + 1, y)) || (!blocksMove(map, x, y - 1) && !blocksMove(map, x, y + 1))) thin.push(k);
      }
    }
  }
  return [
    { level: slots.length === 0 ? 'ok' : 'warn', label: '一格寬窄縫', detail: slots.length === 0 ? '無' : `${slots.length} 格`, cells: slots },
    { level: thin.length === 0 ? 'ok' : 'warn', label: '一格厚細牆', detail: thin.length === 0 ? '無' : `${thin.length} 格`, cells: thin },
  ];
}

function checkLongLines(map: ShooterMap): Check {
  const W = map.width;
  let bestH: number[] = [];
  let bestV: number[] = [];
  for (let y = 0; y < map.height; y++) {
    let run: number[] = [];
    for (let x = 0; x < W; x++) {
      if (blocksMove(map, x, y)) run = [];
      else run.push(y * W + x);
      if (run.length > bestH.length) bestH = [...run];
    }
  }
  for (let x = 0; x < W; x++) {
    let run: number[] = [];
    for (let y = 0; y < map.height; y++) {
      if (blocksMove(map, x, y)) run = [];
      else run.push(y * W + x);
      if (run.length > bestV.length) bestV = [...run];
    }
  }
  return { level: Math.max(bestH.length, bestV.length) > 70 ? 'warn' : 'info', label: '最長直線', detail: `東西 ${bestH.length} 格、南北 ${bestV.length} 格`, cells: [...bestH, ...bestV] };
}

function checkTravel(map: ShooterMap): Check[] {
  const fieldOf = (t: 'T' | 'CT'): Float64Array => {
    const s = map.spawns[t][Math.min(2, map.spawns[t].length - 1)];
    return pathField(map, cellOf(s.x), cellOf(s.y));
  };
  const near = (f: Float64Array, s: MRect): number => Math.min(...rectCells(map, s).map((k) => f[k]));
  const secs = (d: number): string => (Number.isFinite(d) ? `${(d / RUN_CELLS_PER_SEC).toFixed(1)} 秒` : '走不到');
  return (['T', 'CT'] as const).map((t) => {
    const f = fieldOf(t);
    return { level: 'info', label: `${t} 到包點`, detail: map.sites.map((s) => `${s.id} ${secs(near(f, s))}`).join('、') };
  });
}

/** 硬條件在前（fail 代表引擎測試會掛），設計提示在後 */
export function analyze(doc: EditDoc, map: ShooterMap): Check[] {
  const open = map.solid.filter((v) => v === 0).length;
  const pct = (open / map.solid.length) * 100;
  const dead = deadEnds(doc, map);
  const ids = doc.areas.map((a) => a.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  const unnamed: number[] = [];
  for (let k = 0; k < map.solid.length; k++) {
    const x = k % map.width;
    const y = (k - x) / map.width;
    if (map.solid[k] === 0 && !doc.areas.some((a) => inRect(a, x, y))) unnamed.push(k);
  }
  return [
    checkSpawns(map),
    checkConnected(map),
    checkSpawnSight(map),
    ...checkSites(doc, map),
    checkRegions(map),
    { level: pct > 40 && pct < 55 ? 'ok' : 'fail', label: '可走面積', detail: `${pct.toFixed(1)}%（規格 40%～55%）` },
    { level: dup.length === 0 ? 'ok' : 'fail', label: '區域代號重複', detail: dup.length === 0 ? '無' : [...new Set(dup)].join('、') },
    { level: dead.length === 0 ? 'ok' : 'warn', label: '死路', detail: dead.length === 0 ? '無' : dead.map((i) => doc.areas[i].name).join('、'), cells: dead.flatMap((i) => rectCells(map, doc.areas[i])) },
    ...checkSlivers(map),
    checkLongLines(map),
    ...checkTravel(map),
    { level: 'info', label: '矮掩體', detail: `${doc.low.length} 組` },
    { level: unnamed.length === 0 ? 'ok' : 'warn', label: '沒有區域名的可走格', detail: unnamed.length === 0 ? '無' : `${unnamed.length} 格`, cells: unnamed },
  ];
}
