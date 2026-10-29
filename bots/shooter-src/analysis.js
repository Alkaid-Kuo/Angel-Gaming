// @ts-check
// 地圖分析（init 一次做完，只讀 init 的 map 資料）：區域歸屬、距離場、區域交界（窄口）、暴露度、
// 包點入口、守點位、下包位、窄口的掩體點、T／CT 到兩個包點的路線集。全部由地圖資料算出，不寫死任何座標或區域代號。
import { DIR8, P, UNIT, dijkstra, dist, inRect, rectCells } from './base.js';

/**
 * 區域交界：兩個區域之間相連的一段邊界。a < b；cells 是 a 側的邊界格
 * @typedef {{ id: number, a: number, b: number, cells: number[], width: number, x: number, y: number, ax: number, ay: number, bx: number, by: number, choke: boolean, covers: Spot[] }} Portal
 */
/** @typedef {{ x: number, y: number, cell: number, fx: number, fy: number, score: number, entrance: number }} Spot */
/** 包點入口（包點區域與外面的交界） @typedef {{ portal: number, x: number, y: number, ix: number, iy: number, ox: number, oy: number, tDist: number, ctDist: number }} Entrance */
/** @typedef {{ id: 'A' | 'B', rect: import('./base.js').Rect, cx: number, cy: number, regions: Set<number>, entrances: Entrance[], holds: Spot[], plants: Spot[] }} SiteIntel */
/** 路線：依序經過的區域與交界，points 是交界中點（最後一點是包點中心）；length 為格 @typedef {{ site: 'A' | 'B', team: 'T' | 'CT', regions: number[], regionSet: Set<number>, portals: number[], points: import('./base.js').Pt[], length: number }} Route */

export class MapIntel {
  /**
   * @param {import('./base.js').MapInfo} map
   * @param {import('./base.js').Grid} g
   */
  constructor(map, g) {
    this.g = g;
    this.map = map;
    const N = g.N;
    const W = g.W;
    // ── 區域歸屬：包含該格的最小區域（同引擎 regionsAt 的排序）；不在任何區域的可走格歸最近的區域 ──
    this.regionCount = map.regions.length;
    /** @type {string[]} */
    this.regionNames = map.regions.map((r) => r.name);
    this.region = new Int16Array(N).fill(-1);
    const order = map.regions.map((r, i) => ({ i, area: (r.x1 - r.x0) * (r.y1 - r.y0) })).sort((a, b) => a.area - b.area || a.i - b.i);
    /** @type {number[]} */
    const queue = [];
    for (let i = 0; i < N; i++) {
      if (g.block[i] === 1) continue;
      const cx = i % W;
      const cy = (i - cx) / W;
      for (const o of order) {
        if (inRect(map.regions[o.i], cx, cy)) {
          this.region[i] = o.i;
          queue.push(i);
          break;
        }
      }
    }
    for (let h = 0; h < queue.length; h++) {
      const i = queue[h];
      const cx = i % W;
      const cy = (i - cx) / W;
      for (let k = 0; k < 4; k++) {
        const j = (cy + DIR8[k][1]) * W + cx + DIR8[k][0];
        if (!g.walkable(j) || this.region[j] >= 0) continue;
        this.region[j] = this.region[i];
        queue.push(j);
      }
    }

    // ── 距離場（×10）──
    this.distSite = { A: dijkstra(g, rectCells(g, this.siteRect('A'))), B: dijkstra(g, rectCells(g, this.siteRect('B'))) };
    this.distSpawn = { T: dijkstra(g, rectCells(g, map.spawnZones.T)), CT: dijkstra(g, rectCells(g, map.spawnZones.CT)) };

    // ── 暴露度（8 方向有幾個方向能看出去 P.exposeRay 格）與旁邊的掩護（1 = 貼牆、2 = 貼矮牆）──
    this.exposure = new Uint8Array(N);
    this.cover = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (g.block[i] === 1) continue;
      const cx = i % W;
      const cy = (i - cx) / W;
      let open = 0;
      let cov = 0;
      for (const [dx, dy] of DIR8) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (g.isWall(nx, ny)) cov |= 1;
        else if (g.low[ny * W + nx] === 1) cov |= 2;
        let k = 1;
        while (k <= P.exposeRay && !g.isWall(cx + dx * k, cy + dy * k)) k++;
        if (k > P.exposeRay) open++;
      }
      this.exposure[i] = open;
      this.cover[i] = cov;
    }

    // ── 區域交界 ──
    /** @type {Portal[]} */
    this.portals = [];
    /** 邊界格（兩側）→ 交界編號 */
    this.portalAt = new Int16Array(N).fill(-1);
    this.findPortals();
    /** 窄口：寬度 ≤ P.chokeWidth 的交界 */
    this.chokes = this.portals.filter((p) => p.choke);
    for (const c of this.chokes) c.covers = this.chokeCovers(c);

    // ── 包點 ──
    /** @type {Record<'A' | 'B', SiteIntel>} */
    this.sites = { A: this.siteIntel('A'), B: this.siteIntel('B') };

    // ── 路線集 ──
    /** @type {Record<'T' | 'CT', Record<'A' | 'B', Route[]>>} */
    this.routes = {
      T: { A: this.routeSet('T', 'A'), B: this.routeSet('T', 'B') },
      CT: { A: this.routeSet('CT', 'A'), B: this.routeSet('CT', 'B') },
    };
  }

  /** @param {'A' | 'B'} id */
  siteRect(id) {
    const s = this.map.sites.find((x) => x.id === id);
    if (s === undefined) throw new Error(`地圖沒有 ${id} 點`);
    return s;
  }

  /** 離 (x, y) 最近的可走格（格座標） @param {number} cx @param {number} cy */
  nearestOpen(cx, cy) {
    const g = this.g;
    for (let r = 0; r < 20; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (!g.isBlock(x, y)) return y * g.W + x;
        }
      }
    }
    return -1;
  }

  /** 區域名稱（只給喊話與報告） @param {number} r */
  regionName(r) {
    return r >= 0 && r < this.regionNames.length ? this.regionNames[r] : '?';
  }

  findPortals() {
    const g = this.g;
    const W = g.W;
    /** @type {Map<number, number[]>} */
    const byPair = new Map();
    const mark = new Int32Array(g.N).fill(-1);
    for (let i = 0; i < g.N; i++) {
      const a = this.region[i];
      if (a < 0) continue;
      const cx = i % W;
      const cy = (i - cx) / W;
      for (let k = 0; k < 4; k++) {
        const nx = cx + DIR8[k][0];
        const ny = cy + DIR8[k][1];
        if (g.isBlock(nx, ny)) continue;
        const b = this.region[ny * W + nx];
        if (b <= a) continue;
        const key = a * 4096 + b;
        if (mark[i] === key) continue;
        mark[i] = key;
        let list = byPair.get(key);
        if (list === undefined) byPair.set(key, (list = []));
        list.push(i);
      }
    }
    const keys = [...byPair.keys()].sort((x, y) => x - y);
    const comp = new Int32Array(g.N).fill(-1);
    for (const key of keys) {
      const a = Math.floor(key / 4096);
      const b = key % 4096;
      const cells = /** @type {number[]} */ (byPair.get(key));
      const inSet = new Set(cells);
      for (const start of cells) {
        if (comp[start] === key) continue;
        // 8 連通的一段邊界
        /** @type {number[]} */
        const part = [start];
        comp[start] = key;
        for (let h = 0; h < part.length; h++) {
          const i = part[h];
          const cx = i % W;
          const cy = (i - cx) / W;
          for (const [dx, dy] of DIR8) {
            const j = (cy + dy) * W + cx + dx;
            if (!inSet.has(j) || comp[j] === key) continue;
            comp[j] = key;
            part.push(j);
          }
        }
        // a 側中心、b 側中心（a 側邊界格相鄰的 b 區域格）
        let sax = 0;
        let say = 0;
        let sbx = 0;
        let sby = 0;
        let nb = 0;
        /** @type {Set<number>} */
        const bSide = new Set();
        for (const i of part) {
          const cx = i % W;
          const cy = (i - cx) / W;
          sax += cx;
          say += cy;
          for (let k = 0; k < 4; k++) {
            const nx = cx + DIR8[k][0];
            const ny = cy + DIR8[k][1];
            const j = ny * W + nx;
            if (g.isBlock(nx, ny) || this.region[j] !== b || bSide.has(j)) continue;
            bSide.add(j);
            sbx += nx;
            sby += ny;
            nb++;
          }
        }
        const id = this.portals.length;
        const ax = ((sax / part.length) + 0.5) * UNIT;
        const ay = ((say / part.length) + 0.5) * UNIT;
        const bx = ((sbx / Math.max(1, nb)) + 0.5) * UNIT;
        const by = ((sby / Math.max(1, nb)) + 0.5) * UNIT;
        const width = part.length;
        this.portals.push({ id, a, b, cells: part, width, x: Math.round((ax + bx) / 2), y: Math.round((ay + by) / 2), ax: Math.round(ax), ay: Math.round(ay), bx: Math.round(bx), by: Math.round(by), choke: width <= P.chokeWidth, covers: [] });
        for (const i of part) this.portalAt[i] = id;
        for (const j of bSide) if (this.portalAt[j] < 0) this.portalAt[j] = id;
      }
    }
  }

  /**
   * 窄口的掩體點：貼牆或矮牆、看得到窄口、暴露度低，離窄口 5～16 格；窄口兩側各取一個
   * @param {Portal} c
   * @returns {Spot[]}
   */
  chokeCovers(c) {
    const g = this.g;
    const cx = Math.floor(c.x / UNIT);
    const cy = Math.floor(c.y / UNIT);
    /** @type {(Spot | null)[]} */
    const best = [null, null];
    for (let y = cy - 16; y <= cy + 16; y++) {
      for (let x = cx - 16; x <= cx + 16; x++) {
        if (g.isBlock(x, y)) continue;
        const i = y * g.W + x;
        if (this.cover[i] === 0) continue;
        const p = g.center(i);
        const d = dist(p.x, p.y, c.x, c.y) / UNIT;
        if (d < 5 || d > 16 || !g.los(p.x, p.y, c.x, c.y)) continue;
        const side = dist(p.x, p.y, c.ax, c.ay) <= dist(p.x, p.y, c.bx, c.by) ? 0 : 1;
        const score = 10 - 8 * this.exposure[i] + ((this.cover[i] & 2) !== 0 ? 6 : 0) - Math.abs(d - 9);
        const cur = best[side];
        if (cur === null || score > cur.score) best[side] = { x: p.x, y: p.y, cell: i, fx: c.x, fy: c.y, score, entrance: -1 };
      }
    }
    return /** @type {Spot[]} */ (best.filter((s) => s !== null));
  }

  /** @param {'A' | 'B'} id @returns {SiteIntel} */
  siteIntel(id) {
    const g = this.g;
    const rect = this.siteRect(id);
    const center = this.nearestOpen(Math.floor((rect.x0 + rect.x1) / 2), Math.floor((rect.y0 + rect.y1) / 2));
    const cp = g.center(center);
    // 包點所屬區域：含中心格的區域，以及一半以上的格在包點內的區域
    /** @type {Set<number>} */
    const regions = new Set([this.region[center]]);
    const total = new Int32Array(this.regionCount);
    const inside = new Int32Array(this.regionCount);
    for (let i = 0; i < g.N; i++) {
      const r = this.region[i];
      if (r < 0) continue;
      total[r]++;
      if (inRect(rect, i % g.W, Math.floor(i / g.W))) inside[r]++;
    }
    for (let r = 0; r < this.regionCount; r++) if (total[r] > 0 && inside[r] * 2 >= total[r]) regions.add(r);
    // 入口：包點區域與外面的交界
    /** @type {Entrance[]} */
    const entrances = [];
    for (const p of this.portals) {
      const ia = regions.has(p.a);
      const ib = regions.has(p.b);
      if (ia === ib) continue;
      const ix = ia ? p.ax : p.bx;
      const iy = ia ? p.ay : p.by;
      const ox = ia ? p.bx : p.ax;
      const oy = ia ? p.by : p.ay;
      const oc = g.cellOf(ox, oy);
      const tDist = oc < 0 ? Infinity : this.distSpawn.T[oc] / 10;
      const ctDist = oc < 0 ? Infinity : this.distSpawn.CT[oc] / 10;
      entrances.push({ portal: p.id, x: p.x, y: p.y, ix, iy, ox, oy, tDist, ctDist });
    }
    // T 最可能來的入口排前面
    entrances.sort((a, b) => a.tDist - b.tDist);
    const site = { id, rect, cx: cp.x, cy: cp.y, regions, entrances, holds: /** @type {Spot[]} */ ([]), plants: /** @type {Spot[]} */ ([]) };
    site.holds = this.holdSpots(site);
    site.plants = this.plantSpots(site);
    return site;
  }

  /**
   * 守點位：每個入口挑一～兩個點：看得到入口、離入口 P.holdMin～P.holdMax 格、
   * 看得到的其他入口越少越好、暴露度低、貼牆或矮牆；候選限包點附近（路徑距離 ≤ P.holdSiteRadius 格）
   * @param {SiteIntel} site
   * @returns {Spot[]}
   */
  holdSpots(site) {
    const g = this.g;
    const field = this.distSite[site.id];
    /** @type {number[]} */
    const cand = [];
    for (let i = 0; i < g.N; i++) if (field[i] <= P.holdSiteRadius * 10 && g.block[i] === 0) cand.push(i);
    // 每個候選看得到哪些入口
    const sees = cand.map((i) => {
      const p = g.center(i);
      return site.entrances.map((e) => dist(p.x, p.y, e.x, e.y) <= 30 * UNIT && g.los(p.x, p.y, e.x, e.y));
    });
    /** @type {Spot[]} */
    const out = [];
    site.entrances.forEach((e, ei) => {
      /** @type {Spot[]} */
      const ranked = [];
      cand.forEach((i, k) => {
        if (!sees[k][ei]) return;
        const p = g.center(i);
        const d = dist(p.x, p.y, e.x, e.y) / UNIT;
        if (d < P.holdMin || d > P.holdMax) return;
        let others = 0;
        for (let j = 0; j < site.entrances.length; j++) if (j !== ei && sees[k][j]) others++;
        const inSite = site.regions.has(this.region[i]) ? 4 : 0;
        const score = 100 - 25 * others - 6 * this.exposure[i] + ((this.cover[i] & 1) !== 0 ? 8 : 0) + ((this.cover[i] & 2) !== 0 ? 6 : 0) - Math.abs(d - 13) + inSite;
        ranked.push({ x: p.x, y: p.y, cell: i, fx: e.x, fy: e.y, score, entrance: ei });
      });
      ranked.sort((a, b) => b.score - a.score || a.cell - b.cell);
      const first = ranked[0];
      if (first === undefined) return;
      out.push(first);
      const second = ranked.find((s) => s.score >= first.score - 15 && dist(s.x, s.y, first.x, first.y) >= 5 * UNIT);
      if (second !== undefined) out.push(second);
    });
    // 入口已依 T 的距離排序，每個入口的兩個點排在一起：分配守位時 T 最可能來的入口先有兩個人（實測比每個入口各一人好，見 6-1 報告）；同一點只留一次
    /** @type {Spot[]} */
    const uniq = [];
    for (const s of out) if (!uniq.some((u) => u.cell === s.cell)) uniq.push(s);
    return uniq;
  }

  /**
   * 下包位：包點內、四鄰都可走、能直視的入口越少越好、貼掩護；取 3 個彼此相距 ≥ 4 格
   * @param {SiteIntel} site
   * @returns {Spot[]}
   */
  plantSpots(site) {
    const g = this.g;
    /** @type {Spot[]} */
    const ranked = [];
    const r = site.rect;
    for (let y = r.y0 + 1; y < r.y1 - 1; y++) {
      for (let x = r.x0 + 1; x < r.x1 - 1; x++) {
        if (g.isBlock(x, y) || g.isBlock(x + 1, y) || g.isBlock(x - 1, y) || g.isBlock(x, y + 1) || g.isBlock(x, y - 1)) continue;
        const i = y * g.W + x;
        const p = g.center(i);
        let seen = 0;
        for (const e of site.entrances) if (dist(p.x, p.y, e.x, e.y) <= 30 * UNIT && g.los(p.x, p.y, e.x, e.y)) seen++;
        const score = -20 * seen - 3 * this.exposure[i] + (this.cover[i] !== 0 ? 6 : 0) - (0.3 * dist(p.x, p.y, site.cx, site.cy)) / UNIT;
        ranked.push({ x: p.x, y: p.y, cell: i, fx: site.cx, fy: site.cy, score, entrance: -1 });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.cell - b.cell);
    /** @type {Spot[]} */
    const out = [];
    for (const s of ranked) {
      if (out.length >= 3) break;
      if (out.every((o) => dist(o.x, o.y, s.x, s.y) >= 4 * UNIT)) out.push(s);
    }
    if (out.length === 0) out.push({ x: site.cx, y: site.cy, cell: g.cellOf(site.cx, site.cy), fx: site.cx, fy: site.cy, score: 0, entrance: -1 });
    return out;
  }

  /**
   * 路線集：在區域鄰接圖上列舉從出生區到包點區域的簡單路徑（長度 ≤ 最短 × P.routeSlack），
   * 取經過區域差異夠大的最多 P.routeMax 條（至少 2 條，地圖只有一條路時例外）
   * @param {'T' | 'CT'} team @param {'A' | 'B'} id
   * @returns {Route[]}
   */
  routeSet(team, id) {
    const g = this.g;
    const zone = this.map.spawnZones[team];
    const startCell = this.nearestOpen(Math.floor((zone.x0 + zone.x1) / 2), Math.floor((zone.y0 + zone.y1) / 2));
    const start = g.center(startCell);
    const site = this.sites[id];
    const startRegion = this.region[startCell];
    const shortest = this.distSite[id][startCell] / 10;
    if (!Number.isFinite(shortest)) return [];
    const bound = shortest * P.routeSlack * UNIT;
    /** @type {{ portals: number[], regions: number[], points: import('./base.js').Pt[], length: number }[]} */
    const found = [];
    /** 區域 → 交界清單 */
    /** @type {Portal[][]} */
    const adj = Array.from({ length: this.regionCount }, () => []);
    for (const p of this.portals) {
      adj[p.a].push(p);
      adj[p.b].push(p);
    }
    const visited = new Uint8Array(this.regionCount);
    /** @type {number[]} */
    const portals = [];
    /** @type {number[]} */
    const regs = [startRegion];
    /** @type {import('./base.js').Pt[]} */
    const pts = [];
    let budget = 20000;
    /** @param {number} r @param {number} x @param {number} y @param {number} len */
    const dfs = (r, x, y, len) => {
      if (--budget < 0) return;
      if (site.regions.has(r)) {
        const total = len + dist(x, y, site.cx, site.cy);
        if (total <= bound) found.push({ portals: portals.slice(), regions: regs.slice(), points: [...pts, { x: site.cx, y: site.cy }], length: total / UNIT });
        return;
      }
      visited[r] = 1;
      for (const p of adj[r]) {
        const nr = p.a === r ? p.b : p.a;
        if (visited[nr] === 1) continue;
        const nl = len + dist(x, y, p.x, p.y);
        if (nl + dist(p.x, p.y, site.cx, site.cy) > bound) continue;
        portals.push(p.id);
        regs.push(nr);
        pts.push({ x: p.x, y: p.y });
        dfs(nr, p.x, p.y, nl);
        portals.pop();
        regs.pop();
        pts.pop();
      }
      visited[r] = 0;
    };
    dfs(startRegion, start.x, start.y, 0);
    found.sort((a, b) => a.length - b.length);
    /** @type {Route[]} */
    const out = [];
    /** @param {number[]} a @param {number[]} b */
    const overlap = (a, b) => {
      const sa = new Set(a.filter((r) => r !== startRegion && !site.regions.has(r)));
      const sb = new Set(b.filter((r) => r !== startRegion && !site.regions.has(r)));
      let inter = 0;
      for (const r of sa) if (sb.has(r)) inter++;
      const uni = sa.size + sb.size - inter;
      return uni === 0 ? 1 : inter / uni;
    };
    for (const f of found) {
      if (out.length >= P.routeMax) break;
      if (out.every((o) => overlap(o.regions, f.regions) < 0.6)) out.push({ site: id, team, regions: f.regions, regionSet: new Set(f.regions), portals: f.portals, points: f.points, length: Math.round(f.length) });
    }
    if (out.length === 1 && found.length > 1) {
      // 只找到一條差異夠大的：補上差異最大的那條
      const first = out[0];
      let pick = found[1];
      for (const f of found) if (overlap(first.regions, f.regions) < overlap(first.regions, pick.regions)) pick = f;
      out.push({ site: id, team, regions: pick.regions, regionSet: new Set(pick.regions), portals: pick.portals, points: pick.points, length: Math.round(pick.length) });
    }
    return out;
  }
}
