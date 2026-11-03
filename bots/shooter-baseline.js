// @ts-check
// CS 射擊基準 Bot（步驟 6）：四層架構。
//   感知 memory.js（每次決策）：敵情記憶、已清空格、危險格成本（每秒）
//   導航 analysis.js（init 一次：可走格、距離場、區域交界與窄口、掩體點、守點位、下包位、路線集）＋ nav.js（A*、路徑點、被擋重算、探頭）
//   戰鬥 combat.js（每次決策）：目標、預判瞄準、點放、停步、蹲、換彈、狙擊、撤退、被閃、道具自保、沒事時看哪裡
//   戰術 tactics.js（回合開始＋每次決策）：隊內計畫與事件（say）、T 五種計畫與守包、CT 配置／輪轉／回防／保槍、殘局、換血
//        economy.js（指揮統一買法 B:）、utility.js（道具彈道與投擲）、roles.js（2.1：五個角色的分工，隊內喊 R:）
// 公平：只讀 init 資料與觀察資料；不寫死任何地圖座標、區域代號或地圖 id。
// 屬性包（attributes，0～100）接到行為：aim 瞄準誤差與收斂（狙擊手拿其他槍時打折）；reaction 開火前額外等待與對聲音的反應；
// awareness 雷達與聲音採信、隊內事件的反應延遲、預瞄（目標出現在正看著的方向時初始瞄準誤差小）、餘光察覺（視野邊緣的敵人多快注意到）；
// aggression 探頭等待與方式、架槍時間、T 計畫（rush 比例、default 執行時機）、殘局找人、保槍（撤退門檻步驟 7 起固定）；
// discipline 隊友擋線的安全距離、守位中不追出射程外的目標、經濟服從（eco 不偷買）、不追殘血、殘局保槍；
// movement 停步乾淨度、肩探（太低只會寬探）、附近有敵人時靜步、佈置時靜步。旋鈕是外部粗調（侵略偏移、經濟、狙擊手、CT 分點、T 計畫、角色）。
// 本檔由 scripts/build-shooter-bots.ts 從 bots/shooter-src/ 產生：請修改原始碼後重新產生，不要直接改這個檔案。

/** @typedef {import('../src/shooter/api.ts').ShooterInitData} InitData */
/** @typedef {import('../src/shooter/api.ts').ShooterHelpers} Helpers */
/** @typedef {import('../src/shooter/api.ts').ShooterObservation} Observation */
/** @typedef {import('../src/shooter/api.ts').ShooterCommand} Command */
/** @typedef {import('../src/shooter/api.ts').ShooterDeclaration} Declaration */
/** @typedef {import('../src/shooter/api.ts').EnemyInfo} Enemy */
/** @typedef {import('../src/shooter/api.ts').WeaponInfo} WeaponInfo */
/** @typedef {import('../src/shooter/api.ts').MapInfo} MapInfo */
/** @typedef {import('../src/shooter/api.ts').Team} Team */
/** @typedef {import('../src/shooter/api.ts').BuyItem} BuyItem */
/** @typedef {import('../src/shooter/api.ts').WeaponId} WeaponId */
/** @typedef {import('../src/shooter/api.ts').AttributeKey} AttributeKey */
/** @typedef {import('../src/shooter/api.ts').GrenadeId} GrenadeId */
/** @typedef {{ x: number, y: number }} Pt */
/** @typedef {{ x0: number, y0: number, x1: number, y1: number }} Rect */
const UNIT = 1000;
const P = {
chokeWidth: 6,
holdMin: 8,
holdMax: 20,
holdSiteRadius: 8,
exposeRay: 6,
routeSlack: 1.6,
routeMax: 3,
confSee: 100,
confRadar: 80,
confTracer: 70,
confHurt: 60,
confSound: 40,
confDeath: 50,
decay0: 25,
decay100: 25,
unconfirmed: 30,
clearTtl0: 7.5,
clearTtl100: 7.5,
sectorHalfDeg: 15,
bandNear: [0, 12],
bandMid: [12, 30],
bandFar: [30, 60],
trust0: 0.7,
trust100: 1,
scanEvery: 9,
mateScanEvery: 2,
dangerCoef: 0.6,
sectorCoef: 0.3,
dangerRange: 30,
wallHug: 4,
lowBonus: 3,
offRoute: 12,
routeSwitchNear: 35,
routeSwitchRisk: 15,
replanTicks: 30,
stuckDecisions: 10,
waypointReach: 1200,
maxSegment: 6,
peekStop: 2,
peekHold0: 10,
peekHold100: 1,
shoulderBelow: 60,
shoulderMove: 40,
silentMove: 60,
enemySpeed: 4.6,
aimErr0: 1.0,
aimErr100: 0.15,
aimConv0: 0.8,
aimConv100: 0.4,
leadExtra: 2,
react0: 3,
react100: 0,
reactAggr0: 0.6,
reactAggr100: -0.6,
preAimErr: 0.6,
preAimDeg: 20,
periphDeg: 25,
notice0: 0.35,
notice100: 1,
fireSpreadK: 2.6,
awpErr: 0.22,
awpClose: 8,
pistolSwitch: 12,
reloadBelow: 0.4,
friendClear0: 700,
friendClear100: 1200,
holdFirm: 50,
retreatHp0: 30,
retreatHp100: 30,
outnumber0: 3,
outnumber100: 3,
mateNear: 10,
coverRadius: 8,
holdAngle0: 2.6,
holdAngle100: 0.4,
crouchFireMin: 8,
sloppyStop0: 0.5,
sloppyStop100: 0,
nadeAvoid: 4,
ctSplitA: 2,
ctB: 2,
plantRequireClear: true,
stageBack: 9,
stageRetreatSteps: 5,
stageRetreat: 4,
entryZone: 9,
entryGap: 2.6,
entryWaitMax: 2.5,
routeSpeed: 3.9,
flashLead: 10,
flashEdge: 1.5,
flashTurn: 0.8,
postMin: 5,
postGap: 6,
friendSpread: 0.05,
friendBehind: 20,
friendBehindClear: 0.7,
stageGap: 1.6,
splitWait: 32,
fakeDelay: 4,
defaultExec0: 56,
defaultExec100: 26,
forceExecLeft: 35,
contactEvery: 1.5,
contactTtl: 12,
eventDelay0: 4,
eventDelay100: 0,
rotateHeat: 2,
retakeGather: 3.5,
saveMargin: 2,
saveDist: 22,
huntAggr: 0.65,
tradeRange: 8,
tradeHold: 1.5,
chaseHp: 40,
chaseRange: 15,
chaseTime: 3,
flashMateClear: 4,
smokeOff: 4.5,
smokeGap: 6,
flankNear: 12,
flankWait: 18,
lineMemo: 5,
lineZone: 8,
lineHold: 2,
awpMemo: 20,
awpAvoid: 0.7,
pressNear: 16,
nadeCluster: 3.5,
molotovNear: 16,
afterPistol: 'force',
yieldNear: 6,
yieldMax: 3,
yieldMaxSplit: 7,
stageLead: 5,
spawnLead: 10,
spawnLeadMax: 4,
spawnStop: 1.5,
awpOffAim: 0.35,
retakeLead: 1.2,
};
const COS = new Float64Array(360);
const SIN = new Float64Array(360);
/** @type {Helpers | null} */
let HELP = null;
/** @param {Helpers} h */
function initTrig(h) {
HELP = h;
for (let d = 0; d < 360; d++) {
const [x, y] = h.offset(0, 0, d, 1000000);
COS[d] = x / 1000000;
SIN[d] = y / 1000000;
}
}
/** @param {number} d */
function normDeg(d) {
const r = Math.round(d) % 360;
return r < 0 ? r + 360 : r;
}
/** @param {number} d */
function cosd(d) {
return COS[normDeg(d)];
}
/** @param {number} d */
function sind(d) {
return SIN[normDeg(d)];
}
/** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
function angleTo(ax, ay, bx, by) {
if (HELP === null || (ax === bx && ay === by)) return 0;
return normDeg(HELP.angleTo(ax, ay, bx, by));
}
/** @param {number} a @param {number} b */
function adiff(a, b) {
let d = (a - b) % 360;
if (d > 180) d -= 360;
if (d <= -180) d += 360;
return d;
}
/** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
function dist(ax, ay, bx, by) {
return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
}
/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
return v < lo ? lo : v > hi ? hi : v;
}
/** @param {number} a @param {number} b @param {number} t */
function lerp(a, b, t) {
return a + (b - a) * t;
}
/** @param {number} px @param {number} py @param {number} ax @param {number} ay @param {number} bx @param {number} by */
function segDist(px, py, ax, ay, bx, by) {
const dx = bx - ax;
const dy = by - ay;
const len2 = dx * dx + dy * dy;
const t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
const c = clamp(t, 0, 1);
return { d: dist(px, py, ax + dx * c, ay + dy * c), t };
}
/** @param {Rect} r @param {number} cx @param {number} cy */
function inRect(r, cx, cy) {
return cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1;
}
const DIR8 = [
[1, 0, 10],
[-1, 0, 10],
[0, 1, 10],
[0, -1, 10],
[1, 1, 14],
[1, -1, 14],
[-1, 1, 14],
[-1, -1, 14],
];
class Grid {
/** @param {MapInfo} map */
constructor(map) {
this.W = map.width;
this.H = map.height;
this.N = this.W * this.H;
this.wall = new Uint8Array(this.N);
this.block = new Uint8Array(this.N);
this.low = new Uint8Array(this.N);
this.slope = new Int8Array(this.N);
for (let i = 0; i < this.N; i++) {
const v = map.solid[i];
this.wall[i] = v === 1 || (v >= 3 && v <= 6) ? 1 : 0;
this.block[i] = v !== 0 ? 1 : 0;
this.low[i] = v === 2 || v >= 7 ? 1 : 0;
this.slope[i] = v >= 3 ? (v - 3) % 4 : -1;
}
}
/** @param {number} i @param {number} x @param {number} y @returns {[number, number]} */
slopeLocal(i, x, y) {
const c = this.slope[i];
const cx = (i % this.W) * UNIT;
const cy = Math.floor(i / this.W) * UNIT;
return [c === 0 || c === 3 ? x - cx : cx + UNIT - x, c === 0 || c === 1 ? y - cy : cy + UNIT - y];
}
/** @param {number} i 格索引 @param {number} x @param {number} y */
filled(i, x, y) {
if (this.slope[i] < 0) return true;
const [u, v] = this.slopeLocal(i, x, y);
return u + v <= UNIT;
}
/** @param {number} i 格索引 @param {number} x @param {number} y */
wallAt(i, x, y) {
return this.wall[i] === 1 && this.filled(i, x, y);
}
/** @param {number} i @param {number} x @param {number} y */
slopeDistSq(i, x, y) {
const [u, v] = this.slopeLocal(i, x, y);
if (u >= 0 && v >= 0 && u + v <= UNIT) return 0;
const cu = Math.max(0, Math.min(UNIT, u));
const cv = Math.max(0, Math.min(UNIT, v));
const s = Math.max(-UNIT, Math.min(UNIT, u - v));
const du = u - (UNIT + s) / 2;
const dv = v - (UNIT - s) / 2;
return Math.min((u - cu) * (u - cu) + v * v, u * u + (v - cv) * (v - cv), du * du + dv * dv);
}
/** @param {number} i @param {number} ax @param {number} ay @param {number} bx @param {number} by */
cutsSlope(i, ax, ay, bx, by) {
const [ua, va] = this.slopeLocal(i, ax, ay);
const [ub, vb] = this.slopeLocal(i, bx, by);
let t0 = 0;
let t1 = 1;
for (const [g, d] of [[-ua, ua - ub], [-va, va - vb], [ua + va - UNIT, ub - ua + vb - va]]) {
if (d === 0) {
if (g > 0) return false;
} else if (d < 0) t0 = Math.max(t0, g / -d);
else t1 = Math.min(t1, -g / d);
}
return t0 <= t1;
}
/** @param {number} cx @param {number} cy @param {number} ax @param {number} ay @param {number} bx @param {number} by */
sideWall(cx, cy, ax, ay, bx, by) {
if (!this.isWall(cx, cy)) return false;
if (cx < 0 || cy < 0 || cx >= this.W || cy >= this.H) return true;
const i = cy * this.W + cx;
return this.slope[i] < 0 || this.cutsSlope(i, ax, ay, bx, by);
}
/** @param {number} x @param {number} y */
cellOf(x, y) {
const cx = Math.floor(x / UNIT);
const cy = Math.floor(y / UNIT);
if (cx < 0 || cy < 0 || cx >= this.W || cy >= this.H) return -1;
return cy * this.W + cx;
}
/** @param {number} i @returns {Pt} */
center(i) {
return { x: (i % this.W) * UNIT + UNIT / 2, y: Math.floor(i / this.W) * UNIT + UNIT / 2 };
}
/** @param {number} cx @param {number} cy */
isWall(cx, cy) {
if (cx < 0 || cy < 0 || cx >= this.W || cy >= this.H) return true;
return this.wall[cy * this.W + cx] === 1;
}
/** @param {number} cx @param {number} cy */
isBlock(cx, cy) {
if (cx < 0 || cy < 0 || cx >= this.W || cy >= this.H) return true;
return this.block[cy * this.W + cx] === 1;
}
/** @param {number} i */
walkable(i) {
return i >= 0 && i < this.N && this.block[i] === 0;
}
/**
* @param {number} ax @param {number} ay @param {number} bx @param {number} by
*/
los(ax, ay, bx, by) {
const start = this.cellOf(ax, ay);
if (start >= 0 && this.slope[start] >= 0 && this.wall[start] === 1 && this.cutsSlope(start, ax, ay, bx, by)) return false;
const x0 = ax / UNIT;
const y0 = ay / UNIT;
const x1 = bx / UNIT;
const y1 = by / UNIT;
let cx = Math.floor(x0);
let cy = Math.floor(y0);
const ex = Math.floor(x1);
const ey = Math.floor(y1);
const dx = x1 - x0;
const dy = y1 - y0;
const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
const tdx = sx !== 0 ? Math.abs(1 / dx) : Infinity;
const tdy = sy !== 0 ? Math.abs(1 / dy) : Infinity;
let tmx = sx > 0 ? (cx + 1 - x0) * tdx : sx < 0 ? (x0 - cx) * tdx : Infinity;
let tmy = sy > 0 ? (cy + 1 - y0) * tdy : sy < 0 ? (y0 - cy) * tdy : Infinity;
let n = Math.abs(ex - cx) + Math.abs(ey - cy);
while (n > 0) {
if (Math.abs(tmx - tmy) < 1e-9) {
if (this.sideWall(cx + sx, cy, ax, ay, bx, by) && this.sideWall(cx, cy + sy, ax, ay, bx, by)) return false;
cx += sx;
cy += sy;
tmx += tdx;
tmy += tdy;
n -= 2;
} else if (tmx < tmy) {
cx += sx;
tmx += tdx;
n -= 1;
} else {
cy += sy;
tmy += tdy;
n -= 1;
}
const i = cx >= 0 && cy >= 0 && cx < this.W && cy < this.H ? cy * this.W + cx : -1;
if (i >= 0 && this.slope[i] >= 0) {
if (this.sideWall(cx, cy, ax, ay, bx, by)) return false;
if (cx === ex && cy === ey) return true;
continue;
}
if (cx === ex && cy === ey) return true;
if (this.isWall(cx, cy)) return false;
}
return true;
}
/**
* @param {number} x @param {number} y @param {number} deg @param {number} maxCells
* @param {(i: number, d: number) => boolean | void} visit
*/
ray(x, y, deg, maxCells, visit) {
const c = cosd(deg) * (UNIT / 2);
const s = sind(deg) * (UNIT / 2);
let last = -1;
for (let k = 1; k <= maxCells * 2; k++) {
const i = this.cellOf(x + c * k, y + s * k);
if (i < 0 || this.wallAt(i, x + c * k, y + s * k)) return;
if (i === last) continue;
last = i;
if (visit(i, k / 2) === false) return;
}
}
/**
* @param {number} ax @param {number} ay @param {number} bx @param {number} by
*/
walkLine(ax, ay, bx, by) {
const len = dist(ax, ay, bx, by);
if (len < 1) return true;
const ux = (bx - ax) / len;
const uy = (by - ay) / len;
const px = -uy * 400;
const py = ux * 400;
const steps = Math.ceil(len / 250);
for (let k = 0; k <= steps; k++) {
const x = ax + ((bx - ax) * k) / steps;
const y = ay + ((by - ay) * k) / steps;
for (const o of [0, 1, -1]) {
const i = this.cellOf(x + px * o, y + py * o);
if (i < 0 || this.block[i] === 1) return false;
}
}
return true;
}
}
class Heap {
constructor(cap = 4096) {
this.node = new Int32Array(cap);
this.key = new Float64Array(cap);
this.size = 0;
this.lastKey = 0;
}
clear() {
this.size = 0;
}
/** @param {number} n @param {number} k */
push(n, k) {
if (this.size === this.node.length) {
const node = new Int32Array(this.size * 2);
const key = new Float64Array(this.size * 2);
node.set(this.node);
key.set(this.key);
this.node = node;
this.key = key;
}
const node = this.node;
const key = this.key;
let i = this.size++;
while (i > 0) {
const p = (i - 1) >> 1;
if (key[p] <= k) break;
node[i] = node[p];
key[i] = key[p];
i = p;
}
node[i] = n;
key[i] = k;
}
pop() {
const node = this.node;
const key = this.key;
const top = node[0];
this.lastKey = key[0];
const len = --this.size;
if (len > 0) {
const n = node[len];
const k = key[len];
let i = 0;
for (;;) {
const l = 2 * i + 1;
if (l >= len) break;
const r = l + 1;
const c = r < len && key[r] < key[l] ? r : l;
if (key[c] >= k) break;
node[i] = node[c];
key[i] = key[c];
i = c;
}
node[i] = n;
key[i] = k;
}
return top;
}
}
/**
* @param {Grid} g @param {readonly number[]} sources @param {number} [limit]
*/
function dijkstra(g, sources, limit = Infinity) {
const d = new Float64Array(g.N).fill(Infinity);
const heap = new Heap();
for (const s of sources) {
if (!g.walkable(s)) continue;
d[s] = 0;
heap.push(s, 0);
}
const W = g.W;
while (heap.size > 0) {
const i = heap.pop();
const di = heap.lastKey;
if (di > d[i]) continue;
const x = i % W;
const y = (i - x) / W;
for (const [dx, dy, c] of DIR8) {
const nx = x + dx;
const ny = y + dy;
if (g.isBlock(nx, ny)) continue;
if (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy))) continue;
const j = ny * W + nx;
const nd = di + c;
if (nd <= limit && nd < d[j]) {
d[j] = nd;
heap.push(j, nd);
}
}
}
return d;
}
/** @param {Grid} g @param {Rect} r */
function rectCells(g, r) {
/** @type {number[]} */
const out = [];
for (let y = Math.max(0, r.y0); y < Math.min(g.H, r.y1); y++) {
for (let x = Math.max(0, r.x0); x < Math.min(g.W, r.x1); x++) {
const i = y * g.W + x;
if (g.block[i] === 0) out.push(i);
}
}
return out;
}
/**
* @typedef {{ id: number, a: number, b: number, cells: number[], width: number, x: number, y: number, ax: number, ay: number, bx: number, by: number, choke: boolean, covers: Spot[] }} Portal
*/
/** @typedef {{ x: number, y: number, cell: number, fx: number, fy: number, score: number, entrance: number }} Spot */
/** @typedef {{ portal: number, x: number, y: number, ix: number, iy: number, ox: number, oy: number, tDist: number, ctDist: number }} Entrance */
/** @typedef {{ id: 'A' | 'B', rect: Rect, cx: number, cy: number, regions: Set<number>, entrances: Entrance[], holds: Spot[], plants: Spot[] }} SiteIntel */
/** @typedef {{ site: 'A' | 'B', team: 'T' | 'CT', regions: number[], regionSet: Set<number>, portals: number[], points: Pt[], length: number }} Route */
class MapIntel {
/**
* @param {MapInfo} map
* @param {Grid} g
*/
constructor(map, g) {
this.g = g;
this.map = map;
const N = g.N;
const W = g.W;
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
this.distSite = { A: dijkstra(g, rectCells(g, this.siteRect('A'))), B: dijkstra(g, rectCells(g, this.siteRect('B'))) };
this.distSpawn = { T: dijkstra(g, rectCells(g, map.spawnZones.T)), CT: dijkstra(g, rectCells(g, map.spawnZones.CT)) };
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
/** @type {Portal[]} */
this.portals = [];
this.portalAt = new Int16Array(N).fill(-1);
this.findPortals();
this.chokes = this.portals.filter((p) => p.choke);
for (const c of this.chokes) c.covers = this.chokeCovers(c);
/** @type {Record<'A' | 'B', SiteIntel>} */
this.sites = { A: this.siteIntel('A'), B: this.siteIntel('B') };
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
/** @param {number} cx @param {number} cy */
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
/** @param {number} r */
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
entrances.sort((a, b) => a.tDist - b.tDist);
const site = { id, rect, cx: cp.x, cy: cp.y, regions, entrances, holds: /** @type {Spot[]} */ ([]), plants: /** @type {Spot[]} */ ([]) };
site.holds = this.holdSpots(site);
site.plants = this.plantSpots(site);
return site;
}
/**
* @param {SiteIntel} site
* @returns {Spot[]}
*/
holdSpots(site) {
const g = this.g;
const field = this.distSite[site.id];
/** @type {number[]} */
const cand = [];
for (let i = 0; i < g.N; i++) if (field[i] <= P.holdSiteRadius * 10 && g.block[i] === 0) cand.push(i);
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
/** @type {Spot[]} */
const uniq = [];
for (const s of out) if (!uniq.some((u) => u.cell === s.cell)) uniq.push(s);
return uniq;
}
/**
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
/** @type {{ portals: number[], regions: number[], points: Pt[], length: number }[]} */
const found = [];
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
/** @type {Pt[]} */
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
const first = out[0];
let pick = found[1];
for (const f of found) if (overlap(first.regions, f.regions) < overlap(first.regions, pick.regions)) pick = f;
out.push({ site: id, team, regions: pick.regions, regionSet: new Set(pick.regions), portals: pick.portals, points: pick.points, length: Math.round(pick.length) });
}
if (team === 'T') {
const kept = new Set(out.map((r) => r.portals[r.portals.length - 1]));
for (const f of found) {
const last = f.portals[f.portals.length - 1];
if (kept.has(last)) continue;
kept.add(last);
out.push({ site: id, team, regions: f.regions, regionSet: new Set(f.regions), portals: f.portals, points: f.points, length: Math.round(f.length) });
}
}
return out;
}
}
/** @typedef {{ id: number, x: number, y: number, tick: number, conf: number, field: Float64Array | null, cells: Set<number> }} Hypothesis */
class Belief {
/** @param {Grid} g @param {MapIntel} intel @param {InitData} data */
constructor(g, intel, data) {
this.g = g;
this.intel = intel;
this.tps = data.rules.ticksPerSecond;
/** @type {Map<number, Hypothesis>} */
this.tracks = new Map();
/** @type {{ x: number, y: number, cell: number, id: number, conf: number }[]} */
this.points = [];
this.risk = new Float32Array(g.N);
this.regions = new Float32Array(intel.regionCount);
this.next = -1;
}
reset() {
this.tracks.clear();
this.points = [];
this.risk.fill(0);
this.regions.fill(0);
this.next = -1;
}
/** @param {Observation} obs @param {Perception} perc */
update(obs, perc) {
const t = obs.tick;
if (obs.enemiesAlive === 0) { this.reset(); return; }
for (const k of perc.known.values()) {
if (k.tick !== t) continue;
const old = this.tracks.get(k.id);
this.points = this.points.filter((p) => p.id !== k.id);
this.tracks.set(k.id, { id: k.id, x: k.x, y: k.y, tick: t, conf: k.conf, field: old !== undefined && this.g.cellOf(k.x, k.y) === this.g.cellOf(old.x, old.y) ? old.field : null, cells: new Set() });
}
for (const [id, k] of this.tracks) if (t - k.tick > 6 * this.tps) this.tracks.delete(id);
if (this.tracks.size > obs.enemiesAlive) {
const stale = [...this.tracks.values()].filter((k) => k.tick !== t).sort((a, b) => a.tick - b.tick || a.id - b.id);
while (this.tracks.size > obs.enemiesAlive && stale.length > 0) this.tracks.delete(/** @type {Hypothesis} */ (stale.shift()).id);
}
if (t < this.next) return;
this.next = t + Math.max(1, Math.round(this.tps / 2));
this.points = [];
this.risk.fill(0);
this.regions.fill(0);
const g = this.g;
for (const k of this.tracks.values()) {
const age = (t - k.tick) / this.tps;
k.cells.clear();
if (age <= 0) continue;
if (k.field === null) k.field = dijkstra(g, [g.cellOf(k.x, k.y)], 6 * P.enemySpeed * 10 + 14);
const reach = age * P.enemySpeed * 10 + 7;
const conf = k.conf * Math.max(0, 1 - age / 6);
const mass = new Float64Array(this.regions.length);
let sum = 0;
/** @type {Map<number, { x: number, y: number, cell: number, score: number }>} */
const representatives = new Map();
for (let i = 0; i < g.N; i++) {
const d = k.field[i];
if (d > reach || !Number.isFinite(d)) continue;
if (perc.seenTick[i] > k.tick && t - perc.seenTick[i] <= this.tps / 3) continue;
k.cells.add(i);
const r = this.intel.region[i];
const w = 1 / (1 + d / 50);
if (r >= 0) mass[r] += w;
sum += w;
this.risk[i] = Math.max(this.risk[i], conf / (1 + age));
const p = g.center(i);
const score = (this.intel.cover[i] > 0 ? 2 : 0) - dist(obs.me.x, obs.me.y, p.x, p.y) / (30 * UNIT) - d / 200;
if (r >= 0 && score > (representatives.get(r)?.score ?? -Infinity)) representatives.set(r, { ...p, cell: i, score });
}
for (let r = 0; r < mass.length; r++) this.regions[r] += sum > 0 ? mass[r] / sum * conf / 100 : 0;
for (const p of representatives.values()) this.points.push({ x: p.x, y: p.y, cell: p.cell, id: k.id, conf: conf / (1 + age / 2) });
}
this.points.sort((a, b) => b.conf - a.conf || a.id - b.id || a.cell - b.cell);
}
}
/** @typedef {{ id: number, x: number, y: number, vx: number, vy: number, facing: number, weapon: string, tick: number, seenTick: number, conf: number, src: 'see' | 'radar' | 'tracer' }} Known */
/** @typedef {{ x: number, y: number, tick: number, conf: number, src: 'tracer' | 'death' }} Anon */
/** @typedef {{ ox: number, oy: number, dir: number, r0: number, r1: number, tick: number, conf: number, kind: string }} Sector */
/** @typedef {{ x: number, y: number, conf: number, src: string, id: number }} Threat */
const BANDS = { near: P.bandNear, mid: P.bandMid, far: P.bandFar };
const ENEMY_SOUNDS = new Set(['footstep', 'shot', 'reload', 'plant', 'defuse']);
class Perception {
/**
* @param {Grid} g
* @param {MapIntel} intel
* @param {InitData} data
* @param {number} awareness 0～1
*/
constructor(g, intel, data, awareness) {
this.g = g;
this.intel = intel;
this.rules = data.rules;
this.awareness = awareness;
this.decay = lerp(P.decay0, P.decay100, awareness);
this.trust = lerp(P.trust0, P.trust100, awareness);
this.clearTtl = Math.round(lerp(P.clearTtl0, P.clearTtl100, awareness) * data.rules.ticksPerSecond);
/** @type {Map<number, Known>} */
this.known = new Map();
/** @type {Anon[]} */
this.anon = [];
/** @type {Sector[]} */
this.sectors = [];
this.seenTick = new Int32Array(g.N).fill(-1000000);
this.danger = new Float32Array(g.N);
this.stamp = new Int32Array(g.N);
this.stampId = 0;
this.portalThreat = new Float32Array(intel.portals.length);
this.regionSeen = new Float32Array(intel.regionCount);
this.dangerTick = -1000000;
this.dangerDirty = true;
this.lastTick = -1;
this.updates = 0;
/** @type {Map<number, boolean>} */
this.mateAlive = new Map();
this.liveStart = -1;
/** @type {{ dir: number, tick: number } | null} */
this.lastHurt = null;
/** @type {Sector | null} */
this.lastSound = null;
/** @type {number[]} */
this.newIds = [];
this.myTeam = /** @type {Team} */ ('T');
/** @type {Observation['effects']} */
this.effects = [];
this.belief = new Belief(g, intel, data);
}
reset() {
this.belief.reset();
this.known.clear();
this.anon.length = 0;
this.sectors.length = 0;
this.seenTick.fill(-1000000);
this.danger.fill(0);
this.portalThreat.fill(0);
this.regionSeen.fill(0);
this.dangerTick = -1000000;
this.dangerDirty = true;
this.lastTick = -1;
this.mateAlive.clear();
this.liveStart = -1;
this.lastHurt = null;
this.lastSound = null;
this.effects = [];
}
/** @param {Observation} obs */
update(obs) {
const me = obs.me;
const t = obs.tick;
this.myTeam = me.team;
this.effects = obs.effects;
this.updates++;
if (this.liveStart < 0 && obs.round.phase !== 'freeze') this.liveStart = t;
const dt = this.lastTick < 0 ? 0 : (t - this.lastTick) / this.rules.ticksPerSecond;
this.lastTick = t;
this.newIds = [];
const loss = this.decay * dt;
for (const [id, k] of this.known) {
k.conf -= loss;
if (k.conf <= 0) this.known.delete(id);
}
this.anon = this.anon.filter((a) => (a.conf -= loss * (a.src === 'death' ? 0.35 : 1)) > 0);
this.sectors = this.sectors.filter((s) => (s.conf -= loss * 1.5) > 0);
for (const e of obs.enemies) {
const k = this.known.get(e.id);
let vx = 0;
let vy = 0;
if (k !== undefined && t - k.tick > 0 && t - k.tick <= 9) {
vx = (e.x - k.x) / (t - k.tick);
vy = (e.y - k.y) / (t - k.tick);
}
if (k === undefined || k.conf < P.unconfirmed) {
this.newIds.push(e.id);
this.dangerDirty = true;
}
this.known.set(e.id, { id: e.id, x: e.x, y: e.y, vx, vy, facing: e.facing, weapon: e.weapon, tick: t, seenTick: t, conf: P.confSee, src: 'see' });
}
for (const r of obs.radar) {
const k = this.known.get(r.id);
if (k !== undefined && k.tick === t) continue;
let vx = 0;
let vy = 0;
if (k !== undefined && t - k.tick > 0 && t - k.tick <= 9) {
vx = (r.x - k.x) / (t - k.tick);
vy = (r.y - k.y) / (t - k.tick);
}
if (k === undefined || k.conf < P.unconfirmed) this.dangerDirty = true;
const conf = Math.max(k?.conf ?? 0, P.confRadar * this.trust);
this.known.set(r.id, { id: r.id, x: r.x, y: r.y, vx, vy, facing: k?.facing ?? 0, weapon: k?.weapon ?? '?', tick: t, seenTick: k?.seenTick ?? -1, conf, src: 'radar' });
}
for (const tr of obs.tracers) {
if (tr.friendly) continue;
this.notePoint(tr.x0, tr.y0, P.confTracer, t);
}
for (const h of me.hurt) {
this.addSector(me.x, me.y, h.dirDeg, 0, 40, P.confHurt, t, 'hurt');
this.lastHurt = { dir: h.dirDeg, tick: t };
}
for (const s of obs.sounds) {
if (s.friendly || !ENEMY_SOUNDS.has(s.kind)) continue;
const band = BANDS[s.range];
this.lastSound = this.addSector(me.x, me.y, s.dirDeg, band[0], band[1], P.confSound * this.trust, t, s.kind);
}
for (const m of obs.teammates) {
if (this.mateAlive.get(m.id) === true && !m.alive) {
this.anon.push({ x: m.x, y: m.y, tick: t, conf: P.confDeath, src: 'death' });
for (let i = 0; i < this.g.N; i++) {
if (this.seenTick[i] < t - this.clearTtl) continue;
const p = this.g.center(i);
if (dist(p.x, p.y, m.x, m.y) < 12 * UNIT) this.seenTick[i] = -1000000;
}
this.dangerDirty = true;
}
this.mateAlive.set(m.id, m.alive);
}
if (this.known.size > obs.enemiesAlive) {
const list = [...this.known.values()].filter((k) => k.tick !== t).sort((a, b) => a.conf - b.conf || a.id - b.id);
while (this.known.size > obs.enemiesAlive && list.length > 0) this.known.delete(/** @type {Known} */ (list.shift()).id);
}
if (me.alive && me.blindTicks === 0) this.scan(me.x, me.y, me.facing, me.scoped ? this.rules.scopedFovDeg : this.rules.fovDeg, me.scoped ? (this.rules.scopedViewRange ?? 60) : this.rules.viewRange, t);
this.belief.update(obs, this);
if (this.dangerDirty || t - this.dangerTick >= this.rules.ticksPerSecond) this.computeDanger(t);
}
/** @param {number} id */
forget(id) {
this.belief.tracks.delete(id);
this.belief.next = -1;
if (this.known.delete(id)) this.dangerDirty = true;
}
clearEnemies() {
this.belief.reset();
if (this.known.size === 0 && this.anon.length === 0 && this.sectors.length === 0) return;
this.known.clear();
this.anon.length = 0;
this.sectors.length = 0;
this.lastSound = null;
this.lastHurt = null;
this.dangerDirty = true;
this.danger.fill(0);
this.portalThreat.fill(0);
}
/** @param {number} x @param {number} y @param {number} conf @param {number} t */
notePoint(x, y, conf, t) {
let best = null;
let bestD = 2500;
for (const k of this.known.values()) {
const d = dist(k.x, k.y, x, y);
if (d < bestD) {
bestD = d;
best = k;
}
}
if (best !== null) {
if (best.tick !== t) {
best.x = x;
best.y = y;
best.tick = t;
}
best.conf = Math.max(best.conf, conf);
return;
}
const a = this.anon.find((p) => p.src === 'tracer' && dist(p.x, p.y, x, y) < 2000);
if (a !== undefined) {
a.x = x;
a.y = y;
a.tick = t;
a.conf = Math.max(a.conf, conf);
return;
}
this.anon.push({ x, y, tick: t, conf, src: 'tracer' });
this.dangerDirty = true;
}
/**
* @param {number} ox @param {number} oy @param {number} dir @param {number} r0 @param {number} r1 @param {number} conf @param {number} t @param {string} kind
*/
addSector(ox, oy, dir, r0, r1, conf, t, kind) {
for (const s of this.sectors) {
if (Math.abs(adiff(s.dir, dir)) < 20 && s.r0 === r0 && dist(s.ox, s.oy, ox, oy) < 3 * UNIT) {
s.ox = ox;
s.oy = oy;
s.dir = dir;
s.tick = t;
s.conf = Math.max(s.conf, conf);
s.kind = kind;
return s;
}
}
/** @type {Sector} */
const s = { ox, oy, dir, r0, r1, tick: t, conf, kind };
this.sectors.push(s);
this.dangerDirty = true;
return s;
}
/** @param {number} x @param {number} y @param {number} facing @param {number} fov @param {number} range @param {number} t */
scan(x, y, facing, fov, range, t) {
const half = fov / 2;
const seen = this.seenTick;
const g = this.g;
const wall = g.wall;
for (let a = -half; a <= half; a += 4) {
const c = cosd(facing + a) * (UNIT / 2);
const s = sind(facing + a) * (UNIT / 2);
for (let k = 1; k <= range * 2; k++) {
const i = g.cellOf(x + c * k, y + s * k);
if (i < 0 || wall[i] === 1 || g.low[i] === 1) break;
const p = g.center(i);
if (this.effects.some((e) => e.kind === 'smoke' && dist(p.x, p.y, e.x, e.y) < e.radius)) break;
seen[i] = t;
}
}
}
/** @param {number} i @param {number} t */
cleared(i, t) {
if (i < 0 || this.seenTick[i] < t - this.clearTtl) return false;
const p = this.g.center(i);
for (const k of this.known.values()) if (k.conf >= P.unconfirmed && dist(k.x, k.y, p.x, p.y) < 3 * UNIT) return false;
return true;
}
/** @param {number} i @param {number} t @param {number} [margin] */
reachable(i, t, margin = 2) {
if (i < 0) return false;
const enemy = this.myTeam === 'T' ? 'CT' : 'T';
const d = this.intel.distSpawn[enemy][i] / 10;
if (this.liveStart < 0) return d <= margin;
return d <= ((t - this.liveStart) / this.rules.ticksPerSecond) * P.enemySpeed + margin;
}
/** @param {number} t */
computeDanger(t) {
const g = this.g;
const danger = this.danger;
danger.fill(0);
this.portalThreat.fill(0);
this.dangerTick = t;
this.dangerDirty = false;
const range = P.dangerRange;
/** @param {number} x @param {number} y @param {number} value */
const fromPoint = (x, y, value) => {
const id = ++this.stampId;
const stamp = this.stamp;
const c = g.cellOf(x, y);
if (c >= 0) {
stamp[c] = id;
danger[c] += value;
}
for (let a = 0; a < 360; a += 3) {
g.ray(x, y, a, range, (i, d) => {
if (stamp[i] === id) return;
stamp[i] = id;
danger[i] += value * (1 - (0.5 * d) / range);
});
}
};
for (const k of this.known.values()) if (k.conf >= 15) fromPoint(k.x, k.y, k.conf * P.dangerCoef);
for (const a of this.anon) if (a.conf >= 15) fromPoint(a.x, a.y, a.conf * P.dangerCoef * (a.src === 'death' ? 0.7 : 1));
for (const s of this.sectors) {
if (s.conf < 15) continue;
const id = ++this.stampId;
const value = s.conf * P.sectorCoef;
for (let r = Math.max(2, s.r0); r <= Math.min(s.r1, 35); r += 1.5) {
for (let a = -P.sectorHalfDeg; a <= P.sectorHalfDeg; a += 5) {
const i = g.cellOf(s.ox + cosd(s.dir + a) * r * UNIT, s.oy + sind(s.dir + a) * r * UNIT);
if (i < 0 || g.block[i] === 1 || this.stamp[i] === id) continue;
this.stamp[i] = id;
danger[i] += value;
}
}
}
const portals = this.intel.portals;
for (const p of portals) {
let v = 0;
for (const k of this.known.values()) {
const d = dist(k.x, k.y, p.x, p.y) / UNIT;
if (d < 10) v = Math.max(v, k.conf * (1 - d / 10));
}
for (const a of this.anon) {
const d = dist(a.x, a.y, p.x, p.y) / UNIT;
if (a.src === 'tracer' && d < 10) v = Math.max(v, a.conf * (1 - d / 10));
}
this.portalThreat[p.id] = Math.max(v, this.belief.risk[g.cellOf(p.x, p.y)] ?? 0);
}
const n = this.intel.regionCount;
const tot = new Int32Array(n);
const seen = new Int32Array(n);
const lim = t - this.clearTtl;
for (let i = 0; i < g.N; i++) {
const r = this.intel.region[i];
if (r < 0) continue;
tot[r]++;
if (this.seenTick[i] >= lim) seen[r]++;
}
for (let r = 0; r < n; r++) this.regionSeen[r] = tot[r] === 0 ? 1 : seen[r] / tot[r];
}
/** @param {number} t */
unconfirmedRegions(t) {
/** @type {number[]} */
const out = [];
for (let r = 0; r < this.intel.regionCount; r++) {
if (this.regionSeen[r] >= 0.5) continue;
const reg = this.intel.map.regions[r];
const c = this.intel.nearestOpen(Math.floor((reg.x0 + reg.x1) / 2), Math.floor((reg.y0 + reg.y1) / 2));
if (this.reachable(c, t, 6)) out.push(r);
}
return out;
}
/** @param {number} x @param {number} y @param {number} [minConf] @returns {Threat[]} */
threats(x, y, minConf = P.unconfirmed) {
/** @type {Threat[]} */
const out = [];
for (const k of this.known.values()) if (k.conf >= minConf) out.push({ x: k.x, y: k.y, conf: k.conf, src: k.src, id: k.id });
for (const a of this.anon) if (a.src === 'tracer' && a.conf >= minConf) out.push({ x: a.x, y: a.y, conf: a.conf, src: a.src, id: -1 });
out.sort((a, b) => dist(x, y, a.x, a.y) - dist(x, y, b.x, b.y));
return out;
}
/** @param {number} x @param {number} y */
nearestThreat(x, y) {
const t = this.threats(x, y)[0];
return t === undefined ? null : { ...t, dir: angleTo(x, y, t.x, t.y) };
}
}
/** @typedef {{ portal: number, hold: Pt, far: Pt, cross: Pt, phase: 'approach' | 'hold' | 'shoulder' | 'back', left: number, since: number, reach: number }} Peek */
/** @typedef {{ cmds: Command[], look: Pt | null, moving: boolean, peeking: boolean, arrived: boolean, walk: boolean }} NavOut */
class Navigator {
/**
* @param {Grid} g
* @param {MapIntel} intel
* @param {Perception} perc
* @param {{ aggression: number, movement: number }} attrs 0～1（侵略：探頭等待與方式；走位：肩探與靜步）
* @param {InitData} data
*/
constructor(g, intel, perc, attrs, data) {
this.g = g;
this.intel = intel;
this.perc = perc;
this.attrs = attrs;
this.tps = data.rules.ticksPerSecond;
this.heap = new Heap();
this.gScore = new Float64Array(g.N);
this.parent = new Int32Array(g.N);
this.visit = new Int32Array(g.N);
this.visitId = 0;
this.extra = new Float32Array(g.N);
this.base = new Float32Array(g.N);
for (let i = 0; i < g.N; i++) {
if (g.block[i] === 1) continue;
const c = intel.cover[i];
this.base[i] = ((c & 1) !== 0 ? P.wallHug : 0) - ((c & 2) !== 0 ? P.lowBonus : 0);
}
this.peekHold = Math.round(lerp(P.peekHold0, P.peekHold100, attrs.aggression));
/** @type {Set<number>} */
this.hazard = new Set();
this.hazardSize = 0;
/** @type {Pt | null} */
this.goal = null;
/** @type {Route | null} */
this.route = null;
/** @type {number[]} */
this.path = [];
/** @type {Pt[]} */
this.wps = [];
this.wpIdx = 0;
this.planTick = -1000000;
this.stuck = 0;
this.moveStreak = 0;
/** @type {Set<number> | null} */
this.avoid = null;
this.avoidUntil = -1;
/** @type {{ x: number, y: number, until: number } | null} */
this.side = null;
/** @type {Pt | null} */
this.prevPt = null;
/** @type {Peek | null} */
this.peek = null;
/** @type {Map<number, number>} */
this.peeked = new Map();
this.replans = 0;
this.detour = false;
this.priority = false;
this.jammed = 0;
/** @type {{ x: number, y: number, t: number } | null} */
this.lastPeek = null;
}
reset() {
/** @type {Pt | null} */
this.goal = null;
/** @type {Route | null} */
this.route = null;
/** @type {number[]} */
this.path = [];
/** @type {Pt[]} */
this.wps = [];
this.wpIdx = 0;
this.planTick = -1000000;
this.stuck = 0;
this.moveStreak = 0;
/** @type {Set<number> | null} */
this.avoid = null;
this.avoidUntil = -1;
/** @type {{ x: number, y: number, until: number } | null} */
this.side = null;
/** @type {Pt | null} */
this.prevPt = null;
/** @type {Peek | null} */
this.peek = null;
/** @type {Map<number, number>} */
this.peeked = new Map();
this.replans = 0;
this.detour = false;
this.priority = false;
this.jammed = 0;
/** @type {{ x: number, y: number, t: number } | null} */
this.lastPeek = null;
}
/**
* @param {number} x @param {number} y @param {Route | null} [route]
*/
setGoal(x, y, route = null) {
if (this.goal !== null && dist(this.goal.x, this.goal.y, x, y) < 500 && this.route === route) return;
this.goal = { x, y };
this.route = route;
this.path = [];
this.wps = [];
this.peek = null;
}
clearGoal() {
this.goal = null;
this.path = [];
this.wps = [];
this.peek = null;
}
/**
* @param {number} start @param {number} goal @param {Set<number> | null} avoid
*/
astar(start, goal, avoid) {
const g = this.g;
if (start < 0 || goal < 0) return null;
const W = g.W;
const extra = this.extra;
const danger = this.perc.danger;
const route = this.route;
const region = this.intel.region;
for (let i = 0; i < g.N; i++) {
if (g.block[i] === 1) continue;
let e = this.base[i] + danger[i] * (this.priority ? 0.15 : 1);
if (!this.priority && route !== null && !route.regionSet.has(region[i])) e += P.offRoute;
extra[i] = e;
}
for (const i of this.hazard) extra[i] += 300;
const id = ++this.visitId;
const vis = this.visit;
const gs = this.gScore;
const par = this.parent;
const heap = this.heap;
heap.clear();
const gx = goal % W;
const gy = (goal - gx) / W;
/** @param {number} i */
const h = (i) => {
const dx = Math.abs((i % W) - gx);
const dy = Math.abs(Math.floor(i / W) - gy);
return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
};
vis[start] = id;
gs[start] = 0;
par[start] = -1;
heap.push(start, h(start));
while (heap.size > 0) {
const i = heap.pop();
const f = heap.lastKey;
if (f > gs[i] + h(i) + 1e-6) continue;
if (i === goal) break;
const x = i % W;
const y = (i - x) / W;
for (const [dx, dy, c] of DIR8) {
const nx = x + dx;
const ny = y + dy;
if (g.isBlock(nx, ny)) continue;
if (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy))) continue;
const j = ny * W + nx;
if (avoid !== null && j !== goal && (avoid.has(j) || (dx !== 0 && dy !== 0 && (avoid.has(y * W + x + dx) || avoid.has((y + dy) * W + x))))) continue;
const ng = gs[i] + c + Math.max(-c / 2, extra[j]);
if (vis[j] !== id || ng < gs[j]) {
vis[j] = id;
gs[j] = ng;
par[j] = i;
heap.push(j, ng + h(j));
}
}
}
if (vis[goal] !== id) return null;
/** @type {number[]} */
const out = [];
for (let i = goal; i >= 0; i = par[i]) out.push(i);
out.reverse();
return out;
}
/** @param {Pt} a @param {Pt} b @param {Set<number> | null} avoid */
lineOK(a, b, avoid) {
const g = this.g;
if (!g.walkLine(a.x, a.y, b.x, b.y)) return false;
if (avoid === null || avoid.size === 0) return true;
const len = dist(a.x, a.y, b.x, b.y);
if (len < 1) return !avoid.has(g.cellOf(a.x, a.y));
const px = (-(b.y - a.y) / len) * 400;
const py = ((b.x - a.x) / len) * 400;
const steps = Math.max(1, Math.ceil(len / 250));
for (let k = 0; k <= steps; k++) {
const x = a.x + ((b.x - a.x) * k) / steps;
const y = a.y + ((b.y - a.y) * k) / steps;
for (const o of [0, 1, -1]) if (avoid.has(g.cellOf(x + px * o, y + py * o))) return false;
}
return true;
}
/** @param {number[]} path @param {Set<number> | null} avoid @param {Pt} from 起點（自己的位置） @returns {Pt[]} */
smooth(path, avoid, from) {
const g = this.g;
/** @type {Set<number> | null} */
let bad = avoid;
if (this.hazard.size > 0) bad = new Set([...(avoid ?? []), ...this.hazard]);
/** @type {Pt[]} */
const out = [];
let i = 0;
const maxJ = Math.round(P.maxSegment * 1.2);
while (i < path.length - 1) {
const a = i === 0 ? from : g.center(path[i]);
let j = Math.min(path.length - 1, i + maxJ);
for (; j > i + 1; j--) {
const b = g.center(path[j]);
if (dist(a.x, a.y, b.x, b.y) <= P.maxSegment * UNIT && this.lineOK(a, b, bad)) break;
}
out.push(g.center(path[j]));
i = j;
}
return out;
}
/** @param {Observation} obs @param {Set<number> | null} avoid */
plan(obs, avoid) {
const me = obs.me;
const goal = /** @type {Pt} */ (this.goal);
const g = this.g;
let start = g.cellOf(me.x, me.y);
if (!g.walkable(start)) start = this.intel.nearestOpen(Math.floor(me.x / UNIT), Math.floor(me.y / UNIT));
let gc = g.cellOf(goal.x, goal.y);
if (!g.walkable(gc)) gc = this.intel.nearestOpen(Math.floor(goal.x / UNIT), Math.floor(goal.y / UNIT));
this.replans++;
const path = this.astar(start, gc, avoid) ?? (avoid !== null ? this.astar(start, gc, null) : null);
this.planTick = obs.tick;
if (path === null) {
this.path = [];
this.wps = [{ x: goal.x, y: goal.y }];
this.wpIdx = 0;
return;
}
this.path = path;
const wps = this.smooth(path, avoid, { x: me.x, y: me.y });
this.hazardSize = this.hazard.size;
if (wps.length > 0) wps[wps.length - 1] = { x: goal.x, y: goal.y };
else wps.push({ x: goal.x, y: goal.y });
this.wps = wps;
this.wpIdx = 0;
}
/**
* @param {Observation} obs
* @param {{ allowPeek: boolean, speed: number, evading: boolean, priority?: boolean }} opts
* @returns {NavOut}
*/
step(obs, opts) {
const me = obs.me;
const t = obs.tick;
if (this.priority !== (opts.priority ?? false)) { this.priority = opts.priority ?? false; this.wps = []; this.path = []; }
/** @type {NavOut} */
const out = { cmds: [], look: null, moving: false, peeking: false, arrived: false, walk: false };
if (this.goal === null) {
this.moveStreak = 0;
return out;
}
const goal = this.goal;
if (dist(me.x, me.y, goal.x, goal.y) < 450) {
out.arrived = true;
this.moveStreak = 0;
this.stuck = 0;
this.peek = null;
return out;
}
const freeze = obs.round.phase === 'freeze';
const still = Math.abs(me.vx) + Math.abs(me.vy) < opts.speed * 0.25;
const holding = this.peek !== null && this.peek.phase === 'hold';
if (!freeze && !holding && this.moveStreak >= 3 && still) this.stuck++;
else this.stuck = 0;
if (!still) this.jammed = 0;
let avoid = this.avoid !== null && t < this.avoidUntil ? this.avoid : null;
const blockedAhead = this.stuck >= 4 && this.personAhead(obs);
if (this.stuck >= P.stuckDecisions || blockedAhead) {
const jam = obs.teammates.filter((m) => m.alive && dist(m.x, m.y, me.x, me.y) < 900);
if (jam.length > 0 && this.jammed >= 1) this.side = this.scatter(obs, jam);
else if (blockedAhead && jam.length > 0) this.side = this.sideStep(obs);
this.jammed++;
avoid = this.peopleCells(obs);
this.avoid = avoid;
this.avoidUntil = t + 2 * this.tps;
this.stuck = 0;
this.peek = null;
this.plan(obs, avoid);
}
const wp = this.wps[this.wpIdx];
const off = wp !== undefined && dist(me.x, me.y, wp.x, wp.y) > 4 * UNIT && !this.g.walkLine(me.x, me.y, wp.x, wp.y);
if (opts.evading) this.detour = true;
const back = this.detour && !opts.evading;
if (back) this.detour = false;
if (back || this.wps.length === 0 || off || this.hazard.size !== this.hazardSize || (this.perc.dangerTick > this.planTick && t - this.planTick >= P.replanTicks)) this.plan(obs, avoid);
while (this.wpIdx < this.wps.length - 1) {
const p = this.wps[this.wpIdx];
if (dist(me.x, me.y, p.x, p.y) >= P.waypointReach) break;
this.prevPt = p;
this.wpIdx++;
}
let target = this.wps[this.wpIdx];
if (!opts.allowPeek || freeze) this.peek = null;
else {
if (this.peek === null) this.peek = this.findPeek(obs);
if (this.peek !== null) {
const pk = this.peek;
const dHold = dist(me.x, me.y, pk.hold.x, pk.hold.y);
if (dHold > pk.reach || t - pk.since > 8 * this.tps) {
this.peeked.set(pk.portal, t);
this.peek = null;
} else {
out.peeking = true;
out.look = pk.far;
out.walk = dHold < 4 * UNIT;
if (pk.phase === 'approach') {
target = pk.hold;
if (dHold < 700) {
pk.phase = 'hold';
pk.left = this.peekHold;
}
}
if (pk.phase === 'hold') {
target = pk.hold;
if (--pk.left <= 0) {
this.lastPeek = { x: pk.hold.x, y: pk.hold.y, t };
if (this.attrs.aggression * 100 < P.shoulderBelow && this.attrs.movement * 100 >= P.shoulderMove) {
pk.phase = 'shoulder';
pk.left = 3;
} else {
this.peeked.set(pk.portal, t);
this.peek = null;
}
}
} else if (pk.phase === 'shoulder') {
target = pk.cross;
if (--pk.left <= 0) {
pk.phase = 'back';
pk.left = 3;
}
} else if (pk.phase === 'back') {
target = pk.hold;
if (--pk.left <= 0) {
this.peeked.set(pk.portal, t);
this.peek = null;
}
}
}
}
}
if (this.peek !== null && this.peek.phase === 'hold' && dist(me.x, me.y, this.peek.hold.x, this.peek.hold.y) < 700) {
out.cmds.push({ type: 'stop' });
this.moveStreak = 0;
out.moving = false;
return out;
}
if (this.side !== null && t < this.side.until) target = this.side;
out.cmds.push({ type: 'move', x: Math.round(target.x), y: Math.round(target.y) });
this.moveStreak++;
out.moving = true;
if (!out.walk && this.attrs.movement * 100 > P.silentMove && obs.round.phase === 'live') {
const th = this.perc.nearestThreat(me.x, me.y);
if (th !== null && dist(th.x, th.y, me.x, me.y) < 20 * UNIT) out.walk = true;
}
return out;
}
/** @param {Observation} obs */
sideStep(obs) {
const me = obs.me;
const wp = this.wps[this.wpIdx] ?? this.goal ?? me;
const len = Math.max(1, dist(me.x, me.y, wp.x, wp.y));
const px = -(wp.y - me.y) / len;
const py = (wp.x - me.x) / len;
for (const sgn of me.id % 2 === 0 ? [1, -1] : [-1, 1]) {
const x = me.x + sgn * px * 1200;
const y = me.y + sgn * py * 1200;
if (this.g.walkLine(me.x, me.y, x, y)) return { x, y, until: obs.tick + 15 };
}
return null;
}
/** @param {Observation} obs @param {{ x: number, y: number }[]} jam */
scatter(obs, jam) {
const me = obs.me;
const cx = jam.reduce((a, m) => a + m.x, me.x) / (jam.length + 1);
const cy = jam.reduce((a, m) => a + m.y, me.y) / (jam.length + 1);
const len = dist(me.x, me.y, cx, cy);
if (len < 1) return this.sideStep(obs);
const x = me.x + ((me.x - cx) / len) * 1500;
const y = me.y + ((me.y - cy) / len) * 1500;
return this.g.walkLine(me.x, me.y, x, y) ? { x, y, until: obs.tick + 15 } : this.sideStep(obs);
}
/** @param {Observation} obs */
personAhead(obs) {
const me = obs.me;
const wp = this.wps[this.wpIdx];
if (wp === undefined) return false;
const len = dist(me.x, me.y, wp.x, wp.y);
if (len < 1) return false;
const ux = (wp.x - me.x) / len;
const uy = (wp.y - me.y) / len;
/** @param {number} x @param {number} y */
const ahead = (x, y) => {
const along = (x - me.x) * ux + (y - me.y) * uy;
const side = Math.abs((x - me.x) * uy - (y - me.y) * ux);
return along > 0 && along < 1100 && side < 700;
};
return obs.teammates.some((m) => m.alive && ahead(m.x, m.y)) || obs.enemies.some((e) => ahead(e.x, e.y));
}
/** @param {Observation} obs */
peopleCells(obs) {
const g = this.g;
/** @type {Set<number>} */
const s = new Set();
const mine = g.cellOf(obs.me.x, obs.me.y);
const people = [...obs.teammates.filter((m) => m.alive), ...obs.enemies];
for (const q of people) {
if (dist(q.x, q.y, obs.me.x, obs.me.y) > 8 * UNIT) continue;
const cx = Math.floor(q.x / UNIT);
const cy = Math.floor(q.y / UNIT);
for (let dy = -1; dy <= 1; dy++) {
for (let dx = -1; dx <= 1; dx++) {
const i = (cy + dy) * g.W + cx + dx;
if (i === mine || !g.walkable(i)) continue;
const c = g.center(i);
if (dist(c.x, c.y, q.x, q.y) < 900 && dist(c.x, c.y, obs.me.x, obs.me.y) > 1000) s.add(i);
}
}
}
return s;
}
/**
* @param {Observation} obs
* @returns {Peek | null}
*/
findPeek(obs) {
const g = this.g;
const me = obs.me;
const t = obs.tick;
const path = this.path;
if (path.length < 4) return null;
const mine = g.cellOf(me.x, me.y);
let k = path.indexOf(mine);
if (k < 0) {
let best = Infinity;
for (let i = 0; i < path.length; i++) {
const c = g.center(path[i]);
const d = dist(c.x, c.y, me.x, me.y);
if (d < best) {
best = d;
k = i;
}
}
}
const region = this.intel.region;
for (let i = Math.max(k, 0); i < Math.min(path.length - 1, k + 12); i++) {
if (region[path[i]] === region[path[i + 1]]) continue;
const pid = this.intel.portalAt[path[i]] >= 0 ? this.intel.portalAt[path[i]] : this.intel.portalAt[path[i + 1]];
if (pid < 0) continue;
const portal = this.intel.portals[pid];
if (!portal.choke && !this.isEntrance(pid)) continue;
const last = this.peeked.get(pid);
if (last !== undefined && t - last < 15 * this.tps) continue;
if (this.lastPeek !== null && t - this.lastPeek.t < 5 * this.tps && dist(this.lastPeek.x, this.lastPeek.y, g.center(path[i]).x, g.center(path[i]).y) < 8 * UNIT) continue;
const farIdx = Math.min(path.length - 1, i + 6);
const far = g.center(path[farIdx]);
if (!this.perc.reachable(path[farIdx], t, 4) || this.perc.cleared(path[farIdx], t)) continue;
if (obs.teammates.some((m) => m.alive && dist(m.x, m.y, far.x, far.y) < 6 * UNIT)) continue;
const holdIdx = Math.max(k, i - P.peekStop);
if (holdIdx === k && i - k < P.peekStop) {
this.peeked.set(pid, t);
continue;
}
const hold = g.center(path[holdIdx]);
return { portal: pid, hold, far, cross: g.center(path[i]), phase: 'approach', left: 0, since: t, reach: dist(me.x, me.y, hold.x, hold.y) + 3 * UNIT };
}
return null;
}
/** @param {number} pid */
isEntrance(pid) {
return this.intel.sites.A.entrances.some((e) => e.portal === pid) || this.intel.sites.B.entrances.some((e) => e.portal === pid);
}
/**
* @param {Observation} obs @param {readonly Pt[]} threats
* @returns {Pt | null}
*/
findCover(obs, threats) {
if (threats.length === 0) return null;
const g = this.g;
const start = g.cellOf(obs.me.x, obs.me.y);
if (start < 0) return null;
const W = g.W;
/** @type {number[]} */
const queue = [start];
const depth = new Map([[start, 0]]);
for (let h = 0; h < queue.length; h++) {
const i = queue[h];
const d = /** @type {number} */ (depth.get(i));
const p = g.center(i);
if (i !== start && threats.every((th) => !g.los(th.x, th.y, p.x, p.y))) return p;
if (d >= P.coverRadius) continue;
const x = i % W;
const y = (i - x) / W;
for (const [dx, dy] of DIR8) {
const nx = x + dx;
const ny = y + dy;
if (g.isBlock(nx, ny)) continue;
if (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy))) continue;
const j = ny * W + nx;
if (depth.has(j)) continue;
depth.set(j, d + 1);
queue.push(j);
}
}
return null;
}
/**
* @param {Observation} obs @param {(i: number) => boolean} bad @param {number} maxDepth
* @returns {Pt | null}
*/
escape(obs, bad, maxDepth) {
const g = this.g;
const start = g.cellOf(obs.me.x, obs.me.y);
if (start < 0) return null;
const W = g.W;
/** @type {number[]} */
const queue = [start];
const depth = new Map([[start, 0]]);
for (let h = 0; h < queue.length; h++) {
const i = queue[h];
const d = /** @type {number} */ (depth.get(i));
if (!bad(i)) return g.center(i);
if (d >= maxDepth) continue;
const x = i % W;
const y = (i - x) / W;
for (const [dx, dy] of DIR8) {
const nx = x + dx;
const ny = y + dy;
if (g.isBlock(nx, ny)) continue;
if (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy))) continue;
const j = ny * W + nx;
if (depth.has(j)) continue;
depth.set(j, d + 1);
queue.push(j);
}
}
return null;
}
}
/**
* @typedef {{ engaged: boolean, aim: Pt | null, fire: boolean, move: 'stop' | Pt | null, crouch: boolean | null, holdNav: boolean, cmds: Command[], why: string }} Fight
*/
const HALF_ANGLE_K = 300 * 5730;
class Combat {
/**
* @param {Grid} g @param {MapIntel} intel @param {Perception} perc @param {Navigator} nav
* @param {Record<AttributeKey, number> & { offAim?: number }} attrs 0～1（offAim：拿狙擊槍以外的槍時的瞄準）
* @param {InitData} data @param {Helpers} h
*/
constructor(g, intel, perc, nav, attrs, data, h) {
this.g = g;
this.intel = intel;
this.perc = perc;
this.nav = nav;
this.attrs = attrs;
this.h = h;
this.rules = data.rules;
this.tps = data.rules.ticksPerSecond;
/** @type {Map<string, WeaponInfo>} */
this.weapons = new Map(data.weapons.map((w) => [w.id, w]));
this.err0 = lerp(P.aimErr0, P.aimErr100, attrs.aim) * UNIT;
this.conv = lerp(P.aimConv0, P.aimConv100, attrs.aim);
const off = attrs.offAim ?? attrs.aim;
this.errOff = lerp(P.aimErr0, P.aimErr100, off) * UNIT;
this.convOff = lerp(P.aimConv0, P.aimConv100, off);
this.reactExtra = Math.max(0, lerp(P.react0, P.react100, attrs.reaction) + lerp(P.reactAggr0, P.reactAggr100, attrs.aggression));
this.preAim = 1 - P.preAimErr * attrs.awareness;
this.awareness = attrs.awareness;
this.wait = Math.round(this.reactExtra);
this.notice = lerp(P.notice0, P.notice100, attrs.awareness);
/** @type {Map<number, number>} */
this.noticed = new Map();
this.soundReact = Math.round(lerp(3, 0, attrs.reaction));
this.lead = data.rules.reactionTicks + P.leadExtra;
this.retreatHp = lerp(P.retreatHp0, P.retreatHp100, attrs.aggression);
this.outnumber = Math.floor(lerp(P.outnumber0, P.outnumber100, attrs.aggression) + 1e-9);
this.holdAngle = Math.round(lerp(P.holdAngle0, P.holdAngle100, attrs.aggression) * this.tps);
this.sloppy = lerp(P.sloppyStop0, P.sloppyStop100, attrs.movement);
this.scanEvery = P.scanEvery;
this.friendClear = lerp(P.friendClear0, P.friendClear100, attrs.discipline);
this.firm = attrs.discipline * 100 >= P.holdFirm;
this.targetId = -1;
this.seen = 0;
this.errX = 0;
this.errY = 0;
this.lostTick = -1000000;
/** @type {Pt | null} */
this.lostPos = null;
this.blocked = 0;
this.pistolUntil = -1;
/** @type {Pt | null} */
this.retreat = null;
this.retreatUntil = -1;
this.engagedDecisions = 0;
this.scanIdx = 0;
this.scanLeft = 0;
this.soundSeen = -1;
this.soundWait = 0;
/** @type {Pt[]} */
this.trail = [];
this.trailTick = -1000000;
/** @type {Pt | null} */
this.blindBack = null;
/** @type {Map<string, { x: number, y: number, radius: number, cells: readonly number[], until: number }>} */
this.fires = new Map();
/** @type {Map<string, { x: number, y: number, radius: number, tick: number, until: number }>} */
this.smokes = new Map();
this.smokeRadius = data.grenades.find((e) => e.id === 'smoke')?.radius ?? 0;
this.smokeGrowth = this.smokeRadius / Math.max(1, data.rules.grenadeRules.smokeBloomTicks);
}
reset() {
this.fires = new Map();
this.smokes.clear();
this.noticed = new Map();
this.targetId = -1;
this.seen = 0;
this.errX = 0;
this.errY = 0;
this.lostTick = -1000000;
/** @type {Pt | null} */
this.lostPos = null;
this.blocked = 0;
this.pistolUntil = -1;
/** @type {Pt | null} */
this.retreat = null;
this.retreatUntil = -1;
this.engagedDecisions = 0;
this.scanIdx = 0;
this.scanLeft = 0;
this.soundSeen = -1;
this.soundWait = 0;
/** @type {Pt[]} */
this.trail = [];
this.trailTick = -1000000;
/** @type {Pt | null} */
this.blindBack = null;
}
clearTargets() {
this.lostPos = null;
this.retreat = null;
this.targetId = -1;
}
/** @param {string} id */
weapon(id) {
return this.weapons.get(id);
}
/** @param {Observation['me']} me @param {WeaponInfo} w @param {boolean} still @param {boolean} crouch */
baseSpread(me, w, still, crouch) {
const base = me.scoped && w.scopedSpread !== null ? w.scopedSpread : w.spread;
const mul = crouch ? 0.7 : still ? 1 : me.walking ? 1.2 : w.movingMul;
return base * mul;
}
/** @param {Observation} obs */
track(obs) {
const me = obs.me;
if (obs.tick - this.trailTick < this.tps / 2) return;
const last = this.trail[this.trail.length - 1];
if (last !== undefined && dist(last.x, last.y, me.x, me.y) < 600) return;
this.trailTick = obs.tick;
this.trail.push({ x: me.x, y: me.y });
if (this.trail.length > 8) this.trail.shift();
}
/**
* @param {Observation} obs
* @returns {{ move: Pt | null, crouch: boolean, why: string } | null}
*/
evade(obs) {
const me = obs.me;
const g = this.g;
for (const e of obs.effects) {
if (e.kind === 'fire' && e.cells !== undefined) this.fires.set(`${e.x},${e.y}`, { x: e.x, y: e.y, radius: e.radius, cells: e.cells, until: obs.tick + e.ticksLeft });
if (e.kind === 'smoke' && e.radius > 0 && e.ticksLeft > 0) this.smokes.set(`${e.x},${e.y},${obs.tick + e.ticksLeft}`, { x: e.x, y: e.y, radius: e.radius, tick: obs.tick, until: obs.tick + e.ticksLeft });
}
for (const [key, s] of this.smokes) if (obs.tick >= s.until) this.smokes.delete(key);
/** @type {Set<number>} */
const fire = new Set();
for (const [key, f] of this.fires) {
const quenched = [...this.smokes.values()].some((s) => dist(s.x, s.y, f.x, f.y) < f.radius + Math.max(s.radius, Math.min(this.smokeRadius, s.radius + Math.floor((obs.tick - s.tick) * this.smokeGrowth))));
if (obs.tick >= f.until || quenched) this.fires.delete(key);
else for (const c of f.cells) fire.add(c);
}
this.nav.hazard = fire;
const mine = g.cellOf(me.x, me.y);
if (fire.has(mine)) {
const p = this.nav.escape(obs, (i) => fire.has(i), 10);
if (p !== null) return { move: p, crouch: false, why: '離開火區' };
}
for (const pr of obs.projectiles) {
if (pr.kind !== 'he' && pr.kind !== 'molotov' && pr.kind !== 'incendiary') continue;
if (dist(pr.x, pr.y, me.x, me.y) > P.nadeAvoid * UNIT) continue;
const r = (P.nadeAvoid + 1) * UNIT;
const p = this.nav.escape(obs, (i) => {
const c = g.center(i);
return dist(c.x, c.y, pr.x, pr.y) < r || fire.has(i);
}, 9);
if (p !== null) return { move: p, crouch: false, why: '躲道具' };
}
if (me.blindTicks <= 0) this.blindBack = null;
else {
if (this.blindBack !== null) {
if (dist(me.x, me.y, this.blindBack.x, this.blindBack.y) < 600) return { move: null, crouch: true, why: '被閃・蹲' };
return { move: this.blindBack, crouch: false, why: '被閃・後退' };
}
let back = null;
for (let i = this.trail.length - 1; i >= 0; i--) {
const p = this.trail[i];
if (dist(p.x, p.y, me.x, me.y) >= 2500 && g.walkLine(me.x, me.y, p.x, p.y)) {
back = p;
break;
}
}
if (back === null) {
const th = this.perc.nearestThreat(me.x, me.y);
const dir = th !== null ? th.dir + 180 : me.facing + 180;
const p = this.nav.escape(obs, (i) => {
const c = g.center(i);
return dist(c.x, c.y, me.x, me.y) < 2500 || Math.abs(adiff(angleTo(me.x, me.y, c.x, c.y), dir)) > 60;
}, 5);
back = p;
}
if (back === null) return { move: null, crouch: true, why: '被閃・原地蹲' };
this.blindBack = back;
return { move: back, crouch: false, why: '被閃・後退' };
}
return null;
}
/** @param {Observation} obs @param {Enemy} e */
spot(obs, e) {
const me = obs.me;
const t = obs.tick;
const last = this.noticed.get(e.id);
const ok = (last !== undefined && t - last <= this.tps) || e.firing || Math.abs(adiff(angleTo(me.x, me.y, e.x, e.y), me.facing)) <= P.periphDeg || this.h.random() < this.notice;
if (ok) this.noticed.set(e.id, t);
return ok;
}
/**
* @param {Observation} obs
* @param {{ holding: boolean, objective: boolean }} ctx holding＝守位中；objective＝下包／拆包中（不開槍不移動）
* @returns {Fight}
*/
engage(obs, ctx) {
const me = obs.me;
const t = obs.tick;
/** @type {Fight} */
const out = { engaged: false, aim: null, fire: false, move: null, crouch: null, holdNav: false, cmds: [], why: '' };
for (const s of me.shots) if (s.kill && this.targetId >= 0) this.perc.forget(this.targetId);
const vis = obs.enemies.filter((e) => this.spot(obs, e));
if (vis.length === 0) return this.noEnemy(obs, out, ctx);
let best = vis[0];
let bestS = -Infinity;
for (const e of vis) {
const d = dist(me.x, me.y, e.x, e.y) / UNIT;
let s = 100 - 2.5 * d;
if (Math.abs(adiff(e.facing, angleTo(e.x, e.y, me.x, me.y))) < 25) s += 25;
if (e.weapon === 'awp') s += 10;
if (e.planting || e.defusing) s += 40;
if (e.firing) s += 10;
if (e.id === this.targetId) s += 15;
if (s > bestS) {
bestS = s;
best = e;
}
}
const e = best;
out.engaged = true;
this.engagedDecisions++;
if (e.id !== this.targetId) {
this.targetId = e.id;
this.seen = 0;
const ahead = Math.abs(adiff(angleTo(me.x, me.y, e.x, e.y), me.facing)) <= P.preAimDeg;
const cut = ahead && this.h.random() < this.awareness ? 1 : 0;
const extra = Math.floor(this.reactExtra + this.h.random());
this.wait = Math.max(Math.min(1, extra), extra - cut);
const a = Math.floor(this.h.random() * 360);
const mag = (me.weapon === 'awp' ? this.err0 : this.errOff) * (0.6 + 0.8 * this.h.random()) * (ahead ? this.preAim : 1);
this.errX = cosd(a) * mag;
this.errY = sind(a) * mag;
} else {
this.seen++;
const moving = Math.abs(me.vx) + Math.abs(me.vy) > 30;
const c = me.weapon === 'awp' ? this.conv : this.convOff;
const k = moving ? Math.sqrt(c) : c;
this.errX *= k;
this.errY *= k;
}
this.lostTick = t;
const k = this.perc.known.get(e.id);
let vx = k?.vx ?? 0;
let vy = k?.vy ?? 0;
const sp = Math.sqrt(vx * vx + vy * vy);
if (sp > 200) {
vx = (vx * 200) / sp;
vy = (vy * 200) / sp;
}
const px = e.x + vx * this.lead;
const py = e.y + vy * this.lead;
this.lostPos = { x: px, y: py };
const aim = { x: Math.round(px + this.errX), y: Math.round(py + this.errY) };
out.aim = aim;
const d = dist(me.x, me.y, e.x, e.y);
const dc = d / UNIT;
if (ctx.objective) {
out.why = '下包／拆包中';
return out;
}
const primary = me.loadout.primary;
const secondary = me.loadout.secondary;
const wid = me.weapon;
if (wid === 'knife' && (primary !== null || secondary !== null) && dc > 2) {
out.cmds.push({ type: 'switch', slot: primary !== null ? 'primary' : 'secondary' });
out.why = '拔槍';
return this.finishMove(obs, out, e, false, d, ctx);
}
const w = this.weapon(wid);
if (w === undefined) return out;
if (wid === 'awp' && dc < P.awpClose && secondary !== null && me.weapon !== secondary) {
out.cmds.push({ type: 'switch', slot: 'secondary' });
this.pistolUntil = t + 3 * this.tps;
out.why = '近距離切手槍';
return this.finishMove(obs, out, e, false, d, ctx);
}
if (me.ammoMag === 0 && w.magazine > 0) {
if (wid === primary && secondary !== null && dc < P.pistolSwitch) {
out.cmds.push({ type: 'switch', slot: 'secondary' });
this.pistolUntil = t + 3 * this.tps;
out.why = '沒子彈・切手槍';
return this.finishMove(obs, out, e, false, d, ctx);
}
if (me.ammoReserve > 0 && me.reloadTicksLeft === 0) out.cmds.push({ type: 'reload' });
out.why = '換彈';
return this.finishMove(obs, out, e, false, d, ctx, true);
}
const inRange = wid === 'knife' ? dc <= 1.4 : dc <= w.range;
if (!inRange) {
if (ctx.holding && this.firm) {
out.why = '射程外・守位不追';
return out;
}
out.why = '射程外・接近';
out.move = { x: e.x, y: e.y };
return out;
}
if (!this.lineClear(obs, [aim, e])) {
this.blocked++;
out.why = '隊友擋線';
if (this.blocked >= 2 && !ctx.holding) {
const side = this.sidestep(obs, aim);
if (side !== null) {
out.move = side;
return out;
}
}
return this.finishMove(obs, out, e, false, d, ctx);
}
this.blocked = 0;
if (this.seen < this.wait) {
out.why = '反應中';
return this.finishMove(obs, out, e, false, d, ctx);
}
if (me.reloadTicksLeft > 0 && wid !== 'shotgun') {
out.why = '換彈中';
return this.finishMove(obs, out, e, false, d, ctx, true);
}
if (w.scopedSpread !== null && !me.scoped) {
out.cmds.push({ type: 'scope', on: true });
out.why = '開鏡';
return this.finishMove(obs, out, e, false, d, ctx);
}
const errMag = Math.sqrt(this.errX * this.errX + this.errY * this.errY);
if (w.scopedSpread !== null && errMag > P.awpErr * UNIT) {
out.why = '狙擊瞄準中';
return this.finishMove(obs, out, e, false, d, ctx);
}
const lowWall = this.lowCoverNear(me.x, me.y, e.x, e.y);
const wantCrouch = !lowWall && dc >= P.crouchFireMin;
const still = Math.abs(me.vx) + Math.abs(me.vy) === 0;
const recoil = Math.max(0, me.spread - this.baseSpread(me, w, still, me.crouching));
const next = this.baseSpread(me, w, true, wantCrouch && me.crouching) + Math.max(0, recoil - w.fireTicks * 4);
const half = HALF_ANGLE_K / Math.max(d, 500);
const ok = next <= Math.max(half * P.fireSpreadK, w.spread * 1.05) || wid === 'shotgun' || wid === 'knife';
out.fire = ok;
out.why = ok ? '開火' : '等散佈';
return this.finishMove(obs, out, e, ok, d, ctx);
}
/**
* @param {Observation} obs @param {Pt[]} pts
*/
lineClear(obs, pts) {
const me = obs.me;
const drift = (Math.abs(me.vx) + Math.abs(me.vy)) * this.rules.reactionTicks;
const far = Math.max(...pts.map((q) => dist(me.x, me.y, q.x, q.y)), 8 * UNIT);
const lines = [...pts, { x: me.x + cosd(me.facing) * far, y: me.y + sind(me.facing) * far }];
for (const m of obs.teammates) {
if (!m.alive) continue;
for (const q of lines) {
const d = Math.max(dist(me.x, me.y, q.x, q.y), 1);
const reach = d + P.friendBehind * UNIT;
const s = segDist(m.x, m.y, me.x, me.y, me.x + ((q.x - me.x) * reach) / d, me.y + ((q.y - me.y) * reach) / d);
if (s.t <= 0 || s.t >= 1) continue;
const along = s.t * reach;
if (along <= d ? s.d < this.friendClear + drift + along * P.friendSpread : s.d < P.friendBehindClear * UNIT && this.g.los(me.x, me.y, m.x, m.y)) return false;
}
}
return true;
}
/**
* @param {Observation} obs @param {Fight} out @param {Enemy} e
* @param {boolean} firing @param {number} d @param {{ holding: boolean, objective: boolean }} ctx @param {boolean} [weak]
*/
finishMove(obs, out, e, firing, d, ctx, weak = false) {
const me = obs.me;
const t = obs.tick;
const mateNear = obs.teammates.some((m) => m.alive && dist(m.x, m.y, me.x, me.y) < P.mateNear * UNIT);
const outnumbered = obs.enemies.length >= this.outnumber && !mateNear;
const lowHp = me.hp < this.retreatHp && (!firing || obs.enemies.length >= 2);
if (outnumbered || lowHp || (weak && d > 4 * UNIT)) {
if (this.retreat === null || t > this.retreatUntil) {
this.retreat = this.nav.findCover(obs, obs.enemies.map((x) => ({ x: x.x, y: x.y })));
this.retreatUntil = t + 3 * this.tps;
}
if (this.retreat !== null && dist(me.x, me.y, this.retreat.x, this.retreat.y) > 400) {
out.move = this.retreat;
out.crouch = false;
out.why += '・撤退';
return out;
}
}
const lowWall = this.lowCoverNear(me.x, me.y, e.x, e.y);
if (this.engagedDecisions <= 1 && me.weapon !== 'awp' && this.h.random() < this.sloppy) out.move = null;
else out.move = 'stop';
if (lowWall) out.crouch = !firing;
else out.crouch = firing && d >= P.crouchFireMin * UNIT;
return out;
}
/** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
lowCoverNear(ax, ay, bx, by) {
const len = dist(ax, ay, bx, by);
if (len < 1) return false;
const r = Math.min(len, this.rules.lowCoverRange * UNIT);
for (let s = 250; s <= r; s += 250) {
const x = ax + ((bx - ax) * s) / len;
const y = ay + ((by - ay) * s) / len;
const i = this.g.cellOf(x, y);
if (i >= 0 && this.g.low[i] === 1 && this.g.filled(i, x, y)) return true;
}
return false;
}
/** @param {Observation} obs @param {Pt} aim */
sidestep(obs, aim) {
const me = obs.me;
const a = angleTo(me.x, me.y, aim.x, aim.y);
for (const s of this.h.random() < 0.5 ? [90, -90] : [-90, 90]) {
const x = me.x + cosd(a + s) * 1500;
const y = me.y + sind(a + s) * 1500;
if (this.g.walkable(this.g.cellOf(x, y)) && this.g.walkLine(me.x, me.y, x, y)) return { x: Math.round(x), y: Math.round(y) };
}
return null;
}
/**
* @param {Observation} obs @param {Fight} out @param {{ holding: boolean, objective: boolean }} ctx
*/
noEnemy(obs, out, ctx) {
const me = obs.me;
const t = obs.tick;
this.engagedDecisions = 0;
this.blocked = 0;
if (t - this.lostTick > this.tps / 2) this.targetId = -1;
if (this.lostPos !== null && t - this.lostTick < this.holdAngle && !ctx.objective) {
out.aim = this.lostPos;
out.crouch = false;
out.holdNav = ctx.holding || this.attrs.aggression < 0.5 || me.weapon === 'awp';
out.why = '架槍（目標剛消失）';
if (this.retreat !== null && t < this.retreatUntil && dist(me.x, me.y, this.retreat.x, this.retreat.y) > 400) {
out.move = this.retreat;
out.why = '撤退中';
}
return out;
}
this.lostPos = null;
const hurt = this.perc.lastHurt;
if (hurt !== null && t - hurt.tick < this.tps && me.hp < 60 && !ctx.objective) {
const th = { x: me.x + cosd(hurt.dir) * 10 * UNIT, y: me.y + sind(hurt.dir) * 10 * UNIT };
if (this.retreat === null || t > this.retreatUntil) {
this.retreat = this.nav.findCover(obs, [th]);
this.retreatUntil = t + 2 * this.tps;
}
if (this.retreat !== null && dist(me.x, me.y, this.retreat.x, this.retreat.y) > 400) {
out.move = this.retreat;
out.why = '受傷・找掩體';
}
}
return out;
}
/**
* @param {Observation} obs @param {boolean} holding 站定守位
* @returns {Command[]}
*/
upkeep(obs, holding) {
const me = obs.me;
/** @type {Command[]} */
const out = [];
const primary = me.loadout.primary;
if (primary !== null && me.weapon !== primary && obs.tick > this.pistolUntil) {
out.push({ type: 'switch', slot: 'primary' });
return out;
}
if (primary === null && me.weapon === 'knife' && me.loadout.secondary !== null) {
out.push({ type: 'switch', slot: 'secondary' });
return out;
}
const w = this.weapon(me.weapon);
if (w === undefined || w.magazine === 0) return out;
if (me.ammoMag < w.magazine * P.reloadBelow && me.ammoReserve > 0 && me.reloadTicksLeft === 0) out.push({ type: 'reload' });
if (w.scopedSpread !== null && me.reloadTicksLeft === 0 && holding !== me.scoped) out.push({ type: 'scope', on: holding });
return out;
}
/** @param {Sector} snd */
heard(snd) {
if (this.soundSeen !== snd.tick) {
this.soundSeen = snd.tick;
this.soundWait = this.soundReact;
}
if (this.soundWait <= 0) return true;
this.soundWait--;
return false;
}
/**
* @param {Observation} obs @param {boolean} holding @returns {Pt | null}
*/
alert(obs, holding) {
const me = obs.me;
const t = obs.tick;
const hurt = this.perc.lastHurt;
if (hurt !== null && t - hurt.tick < this.tps) return { x: me.x + cosd(hurt.dir) * 8 * UNIT, y: me.y + sind(hurt.dir) * 8 * UNIT };
const snd = this.perc.lastSound;
if (holding || snd === null || t - snd.tick >= this.tps || snd.r0 > 0 || Math.abs(adiff(snd.dir, me.facing)) <= this.rules.fovDeg / 2 || !this.heard(snd)) return null;
return { x: me.x + cosd(snd.dir) * 6 * UNIT, y: me.y + sind(snd.dir) * 6 * UNIT };
}
/**
* @param {Observation} obs
* @param {{ hold: Spot | null, holding: boolean, navLook: Pt | null, ahead: Pt | null }} ctx
* @returns {Pt | null}
*/
look(obs, ctx) {
const me = obs.me;
const t = obs.tick;
const g = this.g;
let best = null;
let bestD = 30 * UNIT;
for (const r of obs.radar) {
const d = dist(me.x, me.y, r.x, r.y);
if (d < bestD) {
bestD = d;
best = r;
}
}
if (best !== null) return { x: best.x, y: best.y };
const hurt = this.perc.lastHurt;
if (hurt !== null && t - hurt.tick < this.tps) return { x: me.x + cosd(hurt.dir) * 8 * UNIT, y: me.y + sind(hurt.dir) * 8 * UNIT };
const snd = this.perc.lastSound;
if (snd !== null && t - snd.tick < this.tps && this.heard(snd)) {
const r = clamp((snd.r0 + snd.r1) / 2, 4, 12);
return { x: me.x + cosd(snd.dir) * r * UNIT, y: me.y + sind(snd.dir) * r * UNIT };
}
for (const th of this.perc.threats(me.x, me.y, 50)) {
if (dist(me.x, me.y, th.x, th.y) > 25 * UNIT) break;
const k = this.perc.known.get(th.id);
if (k !== undefined && t - k.tick > 3 * this.tps) continue;
return { x: th.x, y: th.y };
}
if (ctx.navLook !== null) return ctx.navLook;
if (ctx.hold !== null && ctx.holding) {
const hold = ctx.hold;
if (--this.scanLeft <= 0) {
this.scanLeft = this.scanEvery;
this.scanIdx++;
}
/** @type {Pt[]} */
const views = [{ x: hold.fx, y: hold.fy }];
for (const p of this.intel.portals) {
if (views.length >= 3) break;
const d = dist(p.x, p.y, hold.x, hold.y);
if (d < 5 * UNIT || d > 25 * UNIT || !g.los(hold.x, hold.y, p.x, p.y)) continue;
if (!this.perc.reachable(g.cellOf(p.x, p.y), t, 6)) continue;
if (Math.abs(adiff(angleTo(hold.x, hold.y, p.x, p.y), angleTo(hold.x, hold.y, hold.fx, hold.fy))) < 20) continue;
views.push({ x: p.x, y: p.y });
}
const k = this.scanIdx % (views.length + 1);
return k < 2 ? views[0] : views[k - 1];
}
let pick = null;
let pickS = -Infinity;
for (const p of this.intel.portals) {
const d = dist(me.x, me.y, p.x, p.y);
if (d < 2 * UNIT || d > 15 * UNIT) continue;
const c = g.cellOf(p.x, p.y);
if (!this.perc.reachable(c, t, 3) || this.perc.cleared(c, t)) continue;
if (ctx.ahead !== null && Math.abs(adiff(angleTo(me.x, me.y, p.x, p.y), angleTo(me.x, me.y, ctx.ahead.x, ctx.ahead.y))) > 100) continue;
if (!g.los(me.x, me.y, p.x, p.y)) continue;
const s = this.perc.portalThreat[p.id] * 2 - d / UNIT + (p.choke ? 3 : 0);
if (s > pickS) {
pickS = s;
pick = p;
}
}
if (pick !== null) return { x: pick.x, y: pick.y };
return ctx.ahead;
}
}
/** @typedef {'full' | 'force' | 'half' | 'eco'} BuyCall */
/** @param {string} text @returns {BuyCall | null} */
function parseBuy(text) {
const m = /^B:(full|force|half|eco)$/.exec(text);
return m === null ? null : /** @type {BuyCall} */ (m[1]);
}
const UTIL = {
T: [
['flash', 'smoke', 'he'],
['flash', 'he', 'smoke'],
['smoke', 'flash', 'molotov'],
['molotov', 'flash', 'smoke'],
['smoke', 'flash'],
['flash', 'he', 'smoke'],
],
CT: [
['flash', 'he'],
['flash', 'he'],
['flash', 'incendiary', 'smoke'],
['incendiary', 'flash', 'he'],
['flash', 'smoke'],
['flash', 'he', 'smoke'],
],
};
class Economy {
/**
* @param {InitData} data @param {Helpers} h
* @param {{ economy: number, discipline: number }} opts
*/
constructor(data, h, opts) {
this.data = data;
this.h = h;
this.opts = opts;
/** @type {Map<string, number>} */
this.price = new Map(data.weapons.map((w) => [w.id, w.price]));
for (const n of data.grenades) this.price.set(n.id, n.price);
this.lossLevel = 0;
this.enemyLevel = 0;
/** @type {boolean | null} */
this.lastWon = null;
this.roundInHalf = 0;
this.half = -1;
this.prevMine = 0;
this.prevTheirs = 0;
this.lastRound = -1;
}
/** @param {string} id */
cost(id) {
return this.price.get(id) ?? Infinity;
}
/** @param {Observation} obs */
roundStart(obs) {
const r = obs.round;
if (r.number === this.lastRound) return;
this.lastRound = r.number;
const mine = obs.me.team === 'T' ? r.scoreT : r.scoreCT;
const theirs = obs.me.team === 'T' ? r.scoreCT : r.scoreT;
if (r.half !== this.half) {
this.half = r.half;
this.roundInHalf = 1;
this.lossLevel = 0;
this.enemyLevel = 0;
this.lastWon = null;
} else {
this.roundInHalf++;
const ladder = this.data.rules.economy.lossBonus.length;
if (mine > this.prevMine) {
this.lastWon = true;
this.lossLevel = Math.max(0, this.lossLevel - 1);
this.enemyLevel = Math.min(ladder, this.enemyLevel + 1);
} else if (theirs > this.prevTheirs) {
this.lastWon = false;
this.lossLevel = Math.min(ladder, this.lossLevel + 1);
this.enemyLevel = Math.max(0, this.enemyLevel - 1);
}
}
this.prevMine = mine;
this.prevTheirs = theirs;
}
/** @param {Team} team */
fullCost(team) {
const r = this.data.rules;
return this.cost(team === 'T' ? 'ak' : 'm4') + r.armorPrice + (team === 'CT' ? r.kitPrice : 0) + this.cost('flash');
}
/** @param {number} money @param {WeaponId | null} primary @param {Team} team */
shortOf(money, primary, team) {
const need = this.hasGood(primary) ? this.data.rules.armorPrice + this.cost('flash') : this.fullCost(team);
return need - money;
}
/** @param {WeaponId | string | null} primary */
hasGood(primary) {
return primary !== null && this.cost(primary) >= this.cost('smg') + 1000;
}
/** @param {Observation} obs */
pistolRound(obs) {
return obs.me.money <= this.data.rules.economy.startMoney + 100 && obs.me.loadout.primary === null && this.roundInHalf <= 1;
}
/**
* @param {Observation} obs @returns {BuyCall}
*/
teamCall(obs) {
const me = obs.me;
const team = me.team;
if (this.pistolRound(obs)) return 'force';
const people = [{ money: me.money, primary: me.loadout.primary }, ...obs.teammates.map((m) => ({ money: m.money, primary: this.hasGood(m.weapon) ? m.weapon : null }))];
const can = people.filter((p) => this.shortOf(p.money, p.primary, team) <= 0).length;
const n = people.length;
if (can >= n - 1 || (this.lastWon === true && this.enemyLevel >= 2 && can >= n - 2)) return 'full';
const ladder = this.data.rules.economy.lossBonus;
const nextPay = ladder[Math.min(ladder.length, this.lossLevel + 1) - 1];
const canNext = people.filter((p) => this.shortOf(p.money + nextPay, p.primary, team) <= 0).length;
const r = obs.round;
const theirs = team === 'T' ? r.scoreCT : r.scoreT;
const lastOfHalf = this.roundInHalf >= (r.overtime > 0 ? (this.data.rules.overtime === false ? 3 : this.data.rules.overtime.roundsPerHalf) : this.data.rules.roundsPerHalf);
const critical = theirs >= this.data.rules.winRounds - 1 || lastOfHalf;
const avg = people.reduce((s, p) => s + p.money, 0) / n;
const half = this.cost('smg') + this.data.rules.armorPrice;
if (critical && avg >= half * 0.8) return 'force';
if (this.roundInHalf === 2 && this.lastWon === true && avg >= half) return 'half';
if (this.roundInHalf === 2 && this.lastWon === false) return /** @type {BuyCall} */ (P.afterPistol);
if (canNext >= n - 1) return 'eco';
if (this.opts.economy === 2 && avg >= half) return 'force';
if (this.opts.economy !== 1 && avg >= half + 600) return 'half';
return 'eco';
}
/**
* @param {Observation} obs @param {BuyCall} call @param {number} role @param {boolean} awper @returns {BuyItem[]}
*/
items(obs, call, role, awper) {
const me = obs.me;
const rules = this.data.rules;
const team = me.team;
let money = me.money;
const primary = me.loadout.primary;
const rifle = team === 'T' ? 'ak' : 'm4';
/** @type {BuyItem[]} */
const items = [];
/** @param {BuyItem} id @param {number} price */
const take = (id, price) => {
if (price > money) return false;
items.push(id);
money -= price;
return true;
};
const armorLeft = () => me.loadout.armor < rules.maxArmor && !items.includes('armor') ? rules.armorPrice : 0;
const armor = () => armorLeft() > 0 && take('armor', rules.armorPrice);
const kit = () => team === 'CT' && !me.loadout.kit && !items.includes('kit') && take('kit', rules.kitPrice);
const util = (/** @type {number} */ max) => {
const owned = [...me.loadout.grenades];
let n = 0;
for (const g of UTIL[team][role] ?? UTIL[team][0]) {
if (n >= max || owned.length >= rules.grenadeSlots) break;
const def = this.data.grenades.find((x) => x.id === g);
if (def === undefined || def.maxCarry < 1 || owned.some((x) => x === g)) continue;
if (take(/** @type {BuyItem} */ (g), def.price)) {
owned.push(/** @type {GrenadeId} */ (g));
n++;
}
}
};
const rebel = this.opts.discipline < 0.5 && this.h.random() < 1 - 2 * this.opts.discipline;
let mode = call;
if (rebel && call === 'half' && this.shortOf(money, primary, team) <= 0) mode = 'full';
const good = this.hasGood(primary);
if (this.pistolRound(obs)) {
armor();
} else if (mode === 'full' || (good && mode !== 'eco')) {
if (awper && primary !== 'awp' && money >= this.cost('awp') + rules.armorPrice + 200) take('awp', this.cost('awp'));
else if (!good && !take(rifle, this.cost(rifle))) take('smg', this.cost('smg'));
armor();
kit();
util(4);
} else if (mode === 'force') {
if (role === 1) armor();
if (!good && money >= this.cost(rifle) + armorLeft()) take(rifle, this.cost(rifle));
else if (!good && money >= this.cost('smg') + armorLeft()) take('smg', this.cost('smg'));
armor();
if (!good && primary === null && items.length === 1 && money >= this.cost('deagle')) take('deagle', this.cost('deagle'));
kit();
util(1);
} else if (mode === 'half') {
if (role === 1) armor();
if (!good && primary === null) take('smg', this.cost('smg'));
armor();
if (role === 3) kit();
util(1);
} else if (rebel && money >= this.cost('deagle') + 1000 && me.loadout.secondary !== 'deagle') {
take('deagle', this.cost('deagle'));
}
const w = this.data.weapons.find((x) => x.id === (primary ?? me.weapon));
if (w !== undefined && w.reserve > 0 && me.ammoReserve < w.reserve / 2 && me.weapon === w.id && mode !== 'eco') take('ammo', rules.ammoPrice);
return items;
}
}
/** @typedef {{ kind: GrenadeId, x: number, y: number, why: string }} ThrowWish */
/** @typedef {{ cmds: Command[], look: Pt | null, stop: boolean, thrown: ThrowWish | null }} UtilOut */
class Utility {
/**
* @param {Grid} g @param {InitData} data
*/
constructor(g, data) {
this.g = g;
this.rules = data.rules;
this.tps = data.rules.ticksPerSecond;
this.range = data.rules.grenadeRules.maxThrowRange * UNIT;
this.speed = data.rules.grenadeRules.flySpeed;
/** @type {Map<string, number>} */
this.fuse = new Map(data.grenades.map((n) => [n.id, n.fuseTicks]));
this.flashR = (data.grenades.find((n) => n.id === 'flash')?.radius ?? 15 * UNIT);
this.lastThrow = -1000000;
this.lastEnemy = -1000000;
this.aimSince = -1;
this.lastLook = -1;
/** @type {Pt | null} */
this.aimAt = null;
/** @type {{ x: number, y: number, tx: number, ty: number, from: number, until: number } | null} */
this.away = null;
/** @type {Set<string>} */
this.used = new Set();
this.throws = 0;
}
reset() {
this.lastThrow = -1000000;
this.lastEnemy = -1000000;
this.aimSince = -1;
this.aimAt = null;
this.away = null;
this.used = new Set();
}
/** @param {Observation['me']} me @param {GrenadeId} kind */
has(me, kind) {
return me.loadout.grenades.includes(kind) && !this.used.has(kind);
}
/** @param {Observation['me']} me @param {GrenadeId[]} kinds */
pick(me, kinds) {
return kinds.find((k) => this.has(me, k)) ?? null;
}
/**
* @param {number} ax @param {number} ay @param {number} bx @param {number} by
*/
solve(ax, ay, bx, by) {
const d = dist(ax, ay, bx, by);
if (d < 2 * UNIT || d > this.range) return null;
const deg = angleTo(ax, ay, bx, by);
const power = Math.max(1, Math.min(100, Math.round((d / this.range) * 100)));
const land = this.fly(ax, ay, deg, power);
if (land === null || dist(land.x, land.y, bx, by) > 1.2 * UNIT) return null;
return { deg, power, x: land.x, y: land.y };
}
/** @param {number} ax @param {number} ay @param {number} deg @param {number} power */
fly(ax, ay, deg, power) {
const dx = Math.round(cosd(deg) * 10000);
const dy = Math.round(sind(deg) * 10000);
let x = ax;
let y = ay;
let left = Math.floor((power * this.range) / 100);
for (let k = 0; k < 400 && left > 0; k++) {
const step = Math.min(this.speed, left);
const wx = Math.trunc((dx * step) / 10000);
const wy = Math.trunc((dy * step) / 10000);
if (this.hits(x + wx, y)) return null;
x += wx;
if (this.hits(x, y + wy)) return null;
y += wy;
left -= step;
}
return { x, y };
}
/** @param {number} x @param {number} y */
hits(x, y) {
const g = this.g;
const r = 120;
for (let cy = Math.floor((y - r) / UNIT); cy <= Math.floor((y + r) / UNIT); cy++) {
for (let cx = Math.floor((x - r) / UNIT); cx <= Math.floor((x + r) / UNIT); cx++) {
if (!g.isWall(cx, cy)) continue;
const i = cx >= 0 && cy >= 0 && cx < g.W && cy < g.H ? cy * g.W + cx : -1;
if (i >= 0 && g.slope[i] >= 0) {
if (g.slopeDistSq(i, x, y) <= r * r) return true;
continue;
}
const nx = Math.max(cx * UNIT, Math.min(x, cx * UNIT + UNIT));
const ny = Math.max(cy * UNIT, Math.min(y, cy * UNIT + UNIT));
if ((nx - x) * (nx - x) + (ny - y) * (ny - y) <= r * r) return true;
}
}
return false;
}
/**
* @param {Observation} obs @param {number} x @param {number} y @param {Set<number>} busy 最近在交戰的隊友
*/
flashSafe(obs, x, y, busy) {
if (obs.radar.some((r) => dist(r.x, r.y, x, y) < this.flashR)) return false;
for (const m of obs.teammates) {
if (!m.alive) continue;
if (!this.g.los(m.x, m.y, x, y)) continue;
const d = dist(m.x, m.y, x, y);
if (d < P.flashMateClear * UNIT) return false;
if (busy.has(m.id) && d < this.blindRange) return false;
}
return true;
}
/**
* @param {Observation} obs @param {ThrowWish | null} wish @param {Set<number>} busy 最近在交戰的隊友 @returns {UtilOut}
*/
step(obs, wish, busy) {
const me = obs.me;
const t = obs.tick;
/** @type {UtilOut} */
const out = { cmds: [], look: null, stop: false, thrown: null };
if (obs.enemies.length > 0) this.lastEnemy = t;
if (this.away !== null) {
if (t > this.away.until) this.away = null;
else {
out.look = t < this.away.from ? { x: this.away.tx, y: this.away.ty } : { x: me.x + (me.x - this.away.x) * 2, y: me.y + (me.y - this.away.y) * 2 };
return out;
}
}
if (wish === null || obs.round.phase === 'freeze' || me.blindTicks > 0 || t - this.lastThrow < this.tps) return out;
if (!this.has(me, wish.kind)) return out;
if (obs.enemies.length > 0 && (wish.kind === 'flash' || wish.kind === 'smoke')) return out;
const s = this.solve(me.x, me.y, wish.x, wish.y);
if (s === null) return out;
if (wish.kind === 'flash' && !this.flashSafe(obs, s.x, s.y, busy)) return out;
out.look = { x: wish.x, y: wish.y };
out.stop = true;
if (this.aimAt === null || dist(this.aimAt.x, this.aimAt.y, wish.x, wish.y) > UNIT || t - this.lastLook > this.rules.decisionInterval) this.aimSince = t;
this.aimAt = { x: wish.x, y: wish.y };
this.lastLook = t;
if (t - this.aimSince <= this.rules.reactionTicks) return out;
const half = (me.scoped ? this.rules.scopedFovDeg : this.rules.fovDeg) / 2;
if (Math.abs(adiff(s.deg, me.facing)) > half - 15 || Math.abs(me.vx) + Math.abs(me.vy) > 20) return out;
if ((wish.kind === 'flash' || wish.kind === 'smoke') && t - this.lastEnemy <= 2 * this.rules.reactionTicks) return out;
out.cmds.push({ type: 'throw', grenade: wish.kind, deg: s.deg, power: s.power });
this.lastThrow = t;
this.used.add(wish.kind);
this.throws++;
out.thrown = { ...wish, x: Math.round(s.x), y: Math.round(s.y) };
if (wish.kind === 'flash') {
const pop = t + this.rules.reactionTicks + (this.fuse.get('flash') ?? 45);
this.away = { x: s.x, y: s.y, tx: wish.x, ty: wish.y, from: t + this.rules.reactionTicks + 1, until: pop + 3 };
out.cmds.push({ type: 'say', text: `E:flash ${Math.round(s.x / 100)} ${Math.round(s.y / 100)} ${pop}` });
} else if (wish.kind === 'smoke') out.cmds.push({ type: 'say', text: `E:smoke ${Math.round(s.x / 100)} ${Math.round(s.y / 100)}` });
else if (wish.kind === 'molotov' || wish.kind === 'incendiary') out.cmds.push({ type: 'say', text: `E:burn ${Math.round(s.x / 100)} ${Math.round(s.y / 100)} ${t + 8 * this.tps}` });
return out;
}
get flashRadius() {
return this.flashR;
}
get blindRange() {
return this.flashR;
}
}
const ENTRY = 1;
const SUPPORT = 2;
const ANCHOR = 3;
const AWP = 4;
const LURK = 5;
const ROLE_NAME = ['無', '突破', '支援', '錨點', '狙擊', '游擊'];
const AUTO = [ENTRY, SUPPORT, ANCHOR, LURK, AWP];
const FILL = [ENTRY, SUPPORT, ANCHOR, LURK];
/** @param {number} slot @param {number} awpSlot */
function autoRole(slot, awpSlot) {
if (slot === awpSlot) return AWP;
const r = AUTO[slot] ?? ENTRY;
return r === AWP ? LURK : r;
}
/** @param {string} text */
function parseRole(text) {
const m = /^R:([1-5])$/.exec(text);
return m === null ? 0 : Number(m[1]);
}
class Roles {
/** @param {number[]} ids 全隊 id（排序＝隊內序號） @param {number} me @param {number} mine 自己喊的角色 @param {number} awpSlot */
constructor(ids, me, mine, awpSlot) {
this.ids = ids;
/** @type {Map<number, number>} */
this.said = new Map([[me, mine]]);
this.awpSlot = awpSlot;
/** @type {Map<number, number>} */
this.eff = new Map();
/** @type {Map<number, number>} */
this.holder = new Map();
this.key = '';
this.solve();
}
/** @param {number} id @param {number} r */
hear(id, r) {
if (r === 0 || this.said.get(id) === r || !this.ids.includes(id)) return;
this.said.set(id, r);
this.solve();
}
/** @param {number} id */
announced(id) {
return this.said.get(id) ?? autoRole(this.ids.indexOf(id), 4);
}
solve() {
this.eff = new Map();
this.holder = new Map();
/** @type {number[]} */
const extra = [];
for (const id of this.ids) {
const r = this.announced(id);
if (this.holder.has(r)) extra.push(id);
else {
this.holder.set(r, id);
this.eff.set(id, r);
}
}
for (const id of extra) {
if (this.announced(id) === AWP) {
this.eff.set(id, ENTRY);
if (!this.holder.has(ENTRY)) this.holder.set(ENTRY, id);
continue;
}
const r = FILL.find((x) => !this.holder.has(x)) ?? 0;
this.eff.set(id, r);
if (r !== 0) this.holder.set(r, id);
}
this.key = this.ids.map((id) => this.eff.get(id) ?? 0).join('');
}
/** @param {number} id */
of(id) {
return this.eff.get(id) ?? 0;
}
/** @param {number} r */
who(r) {
return this.holder.get(r) ?? -1;
}
awper() {
for (const id of this.ids) if (this.announced(id) === AWP) return id;
return -1;
}
}
class Cooperation {
/** @param {Grid} g @param {MapIntel} intel @param {Perception} perc @param {InitData} data */
constructor(g, intel, perc, data) {
this.g = g;
this.intel = intel;
this.perc = perc;
this.tps = data.rules.ticksPerSecond;
/** @type {Map<number, boolean>} */
this.alive = new Map();
/** @type {Map<number, { x: number, y: number, facing: number, tick: number, dead: boolean }>} */
this.cues = new Map();
this.acted = false;
}
reset() { this.alive.clear(); this.cues.clear(); }
/** @param {Observation} obs */
observe(obs) {
for (const m of obs.teammates) {
if (m.alive && m.firing) this.cues.set(m.id, { x: m.x, y: m.y, facing: m.facing, tick: obs.tick, dead: false });
if (this.alive.get(m.id) === true && !m.alive) this.cues.set(m.id, { x: m.x, y: m.y, facing: m.facing, tick: obs.tick, dead: true });
this.alive.set(m.id, m.alive);
}
for (const [id, c] of this.cues) if (obs.tick - c.tick > (c.dead ? 2 : 0.9) * this.tps) this.cues.delete(id);
}
/** @param {Observation} obs @param {TacOut} out */
apply(obs, out) {
const me = obs.me;
this.acted = false;
if (obs.round.phase === 'freeze' || obs.enemiesAlive === 0 || me.blindTicks > 0 || out.objective || out.commit || out.urgent || out.stop || obs.enemies.length > 0) return;
if (out.task === 'execute' || out.task === 'retake') {
const cues = [...this.cues].sort((a, b) => b[1].tick - a[1].tick || a[0] - b[0]);
for (const [id, cue] of cues) {
const d = dist(me.x, me.y, cue.x, cue.y);
if (d < 1800 || d > 9 * UNIT || me.hasBomb) continue;
const helpers = [{ id: me.id, x: me.x, y: me.y, hasBomb: me.hasBomb, blind: me.blindTicks > 0 }, ...obs.teammates.filter((m) => m.alive && !m.planting && !m.defusing)].filter((m) => m.id !== id && !m.hasBomb && !m.blind && dist(m.x, m.y, cue.x, cue.y) <= 9 * UNIT).sort((a, b) => dist(a.x, a.y, cue.x, cue.y) - dist(b.x, b.y, cue.x, cue.y) || a.id - b.id);
if (helpers[0]?.id !== me.id) continue;
const target = this.perc.threats(cue.x, cue.y, 45).find((p) => dist(p.x, p.y, cue.x, cue.y) < 18 * UNIT);
const trace = obs.tracers.find((p) => p.friendly && dist(p.x0, p.y0, cue.x, cue.y) < 1500);
const look = target ?? (trace === undefined ? null : { x: trace.x1, y: trace.y1 });
if (look === null || !this.g.los(me.x, me.y, cue.x, cue.y)) continue;
/** @type {Pt | null} */
let best = null;
let score = -Infinity;
const center = this.g.cellOf(cue.x, cue.y);
const cx = center % this.g.W;
const cy = Math.floor(center / this.g.W);
for (let y = cy - 3; y <= cy + 3; y++) for (let x = cx - 3; x <= cx + 3; x++) {
const i = y * this.g.W + x;
if (x < 0 || x >= this.g.W || y < 0 || y >= this.g.H || !this.g.walkable(i)) continue;
const p = this.g.center(i);
const gap = dist(p.x, p.y, cue.x, cue.y);
if ((!cue.dead && gap < 1600) || gap > 4000 || !this.g.walkLine(me.x, me.y, p.x, p.y) || !this.g.los(p.x, p.y, look.x, look.y)) continue;
if (!cue.dead && segDist(p.x, p.y, cue.x, cue.y, look.x, look.y).d < 1100) continue;
if (obs.effects.some((e) => e.kind === 'fire' && dist(p.x, p.y, e.x, e.y) < e.radius + 500)) continue;
const s = (this.intel.cover[i] > 0 ? 2 : 0) - dist(me.x, me.y, p.x, p.y) / UNIT - Math.abs(gap / UNIT - 2.5) - this.perc.danger[i] / 40;
if (s > score) { score = s; best = p; }
}
if (best !== null) {
out.goal = best;
out.route = null;
out.hold = null;
out.look = look;
out.walk = false;
out.allowPeek = false;
out.role += cue.dead ? '・補槍接替' : '・跟進掩護';
this.acted = true;
return;
}
}
}
if (out.hold === null || dist(me.x, me.y, out.hold.x, out.hold.y) > 2500 || out.look !== null) return;
const confirmed = this.perc.threats(me.x, me.y, 60).find((p) => dist(me.x, me.y, p.x, p.y) < 25 * UNIT && this.g.los(me.x, me.y, p.x, p.y));
if (confirmed !== undefined) { out.look = { x: confirmed.x, y: confirmed.y }; return; }
if (Math.floor(obs.tick / this.tps) % 3 !== 0) return;
const site = this.intel.distSite.A[this.g.cellOf(me.x, me.y)] <= this.intel.distSite.B[this.g.cellOf(me.x, me.y)] ? this.intel.sites.A : this.intel.sites.B;
const team = [{ id: me.id, x: me.x, y: me.y }, ...obs.teammates.filter((m) => m.alive && !m.blind && !m.planting && !m.defusing && dist(m.x, m.y, me.x, me.y) < 16 * UNIT)].sort((a, b) => a.id - b.id);
const reserved = new Set();
for (const actor of team) {
let best = -Infinity;
let chosen = null;
for (const e of site.entrances) {
if (!this.g.los(actor.x, actor.y, e.ox, e.oy) || dist(actor.x, actor.y, e.ox, e.oy) > 30 * UNIT) continue;
const i = this.g.cellOf(e.ox, e.oy);
const risk = this.perc.belief.risk[i] ?? 0;
const sc = (reserved.has(e.portal) ? -6 : 3) + risk / 20 - dist(actor.x, actor.y, e.ox, e.oy) / (20 * UNIT);
if (sc > best) { best = sc; chosen = e; }
}
if (chosen !== null) reserved.add(chosen.portal);
if (actor.id === me.id) { if (chosen !== null) out.look = { x: chosen.ox, y: chosen.oy }; break; }
}
if (out.look !== null) out.role += '・互補守角';
}
}
/** @typedef {'A' | 'B'} LearnedSite */
/** @typedef {{ team: 'T' | 'CT', site: LearnedSite | null, fast: boolean | null, plan: string, won: boolean, rotated: boolean | null }} RoundSample */
class Adaptation {
constructor() {
/** @type {RoundSample[]} */
this.history = [];
/** @type {RoundSample | null} */
this.sample = null;
this.round = -1;
this.start = -1;
/** @type {Map<number, LearnedSite>} */
this.locations = new Map();
/** @type {Map<number, LearnedSite>} */
this.baitBaseline = new Map();
this.baitAt = -1;
this.fakeReason = '';
this.mine = 0;
this.theirs = 0;
}
/** @param {Observation} obs @param {boolean | null} won */
begin(obs, won) {
if (this.round === obs.round.number) return;
const mine = obs.me.team === 'T' ? obs.round.scoreT : obs.round.scoreCT;
const theirs = obs.me.team === 'T' ? obs.round.scoreCT : obs.round.scoreT;
const result = this.round >= 0 && obs.round.number !== this.round + 1 ? null : won ?? (mine > this.mine ? true : theirs > this.theirs ? false : null);
if (this.sample !== null && result !== null) {
this.history.push({ ...this.sample, won: result });
if (this.history.length > 16) this.history.shift();
}
this.sample = { team: obs.me.team, site: null, fast: null, plan: '', won: false, rotated: null };
this.round = obs.round.number;
this.mine = mine; this.theirs = theirs;
this.start = -1;
this.locations.clear();
this.baitBaseline.clear();
this.baitAt = -1;
this.fakeReason = '';
}
/** @param {Observation} obs @param {Perception} perc @param {(cell: number) => LearnedSite | null} siteNear */
observe(obs, perc, siteNear) {
if (this.sample === null || obs.round.phase === 'freeze') return;
if (this.start < 0) this.start = obs.tick;
const counts = { A: 0, B: 0 };
for (const k of perc.known.values()) {
if (k.tick !== obs.tick || k.src === 'tracer') continue;
const s = siteNear(perc.g.cellOf(k.x, k.y));
if (s !== null) { this.locations.set(k.id, s); counts[s]++; }
}
if (obs.me.team !== 'CT') return;
const planted = obs.bomb.state === 'planted' || obs.bomb.state === 'defusing';
const site = planted ? obs.bomb.site : counts.A >= 2 && counts.A > counts.B ? 'A' : counts.B >= 2 && counts.B > counts.A ? 'B' : null;
if (site !== null) {
this.sample.site = site;
if (this.sample.fast === null) this.sample.fast = obs.tick - this.start < 18 * perc.rules.ticksPerSecond;
}
}
/** @param {'T' | 'CT'} team */
advice(team) {
const samples = this.history.filter((s) => s.team === team);
const out = { A: 0, B: 0, fast: 0.5, rotation: 0.5, evidence: samples.filter((s) => team === 'CT' ? s.site !== null : s.plan !== '').length, plans: /** @type {Record<string, number>} */ ({}) };
if (samples.length < 3) return out;
let sites = 0, tempo = 0, rotations = 0, fast = 0, rotated = 0;
/** @type {Record<string, { n: number, wins: number }>} */
const plans = {};
for (let i = 0; i < samples.length; i++) {
const s = samples[i];
const w = 0.75 ** (samples.length - 1 - i);
if (s.site !== null) { out[s.site] += w; sites += w; }
if (s.fast !== null) { tempo += w; if (s.fast) fast += w; }
if (s.rotated !== null) { rotations += w; if (s.rotated) rotated += w; }
if (s.plan !== '') {
const p = plans[s.plan] ?? { n: 0, wins: 0 };
p.n += w; if (s.won) p.wins += w; plans[s.plan] = p;
}
}
if (sites > 0) { out.A /= sites; out.B /= sites; }
out.fast = (fast + 1) / (tempo + 2);
out.rotation = (rotated + 1) / (rotations + 2);
for (const [kind, p] of Object.entries(plans)) out.plans[kind] = clamp(1 + ((p.wins + 1.5) / (p.n + 3) - 0.5), 0.75, 1.25);
return out;
}
/** @param {Observation} obs @param {Perception} perc @param {TPlan} plan @param {boolean} probed */
fake(obs, perc, plan, probed) {
if (this.baitAt < 0) { this.baitAt = obs.tick; this.baitBaseline = new Map(this.locations); return null; }
const tps = perc.rules.ticksPerSecond;
if (obs.tick - this.baitAt < 1.5 * tps) return null;
const bait = plan.site === 'A' ? 'B' : 'A';
const counts = { A: 0, B: 0 };
let moved = 0;
for (const k of perc.known.values()) {
if (obs.tick - k.tick > tps || k.conf < 60 || k.src === 'tracer') continue;
const a = perc.intel.distSite.A[perc.g.cellOf(k.x, k.y)];
const b = perc.intel.distSite.B[perc.g.cellOf(k.x, k.y)];
const site = a < b ? 'A' : 'B';
if (Math.min(a, b) > 180 || Math.abs(a - b) < 50) continue;
counts[site]++;
if (site === bait && this.baitBaseline.get(k.id) === plan.site) moved++;
}
if (moved > 0 && counts[bait] >= 2 && counts[plan.site] <= 1) {
if (this.sample !== null) this.sample.rotated = true;
this.fakeReason = '佯攻牽動輪轉';
return plan.site;
}
if (probed && counts[plan.site] >= 2 && counts[bait] === 0) {
if (this.sample !== null) this.sample.rotated = false;
this.fakeReason = '探到空點轉打';
return bait;
}
return null;
}
}
const MAIN_PRI = [3, 0, 1, 2, 5, 4];
const SMOKE_PREF = [SUPPORT, ANCHOR, LURK, 0, ENTRY, AWP];
/** @typedef {'A' | 'B'} SiteId */
/** @typedef {{ kind: 'go' | 'default' | 'rush' | 'split' | 'fake', site: SiteId, r1: number, r2: number, exec: SiteId | null }} TPlan */
/** @typedef {{ kind: 'hold', a: number, m: number, b: number, rot: SiteId | null, go: boolean }} CTPlan */
/** @typedef {TPlan | CTPlan} Plan */
/** @typedef {{ kind: 'contact', region: string, n: number } | { kind: 'dead', region: string } | { kind: 'planted', site: SiteId } | { kind: 'flash', x: number, y: number, pop: number } | { kind: 'smoke', x: number, y: number } | { kind: 'burn', x: number, y: number, until: number } | { kind: 'awp', x: number, y: number } | { kind: 'kit' | 'smoker' }} TeamEvent */
/**
* @typedef {{ goal: Pt | null, route: Route | null, hold: Spot | null, objective: boolean, allowPeek: boolean, cmds: Command[], role: string, look: Pt | null, urgent: boolean, hard: boolean, stop: boolean, walk: boolean | null, noise: boolean, escape: boolean, task?: 'hold' | 'execute' | 'retrieve' | 'plant' | 'defuse' | 'retake' | 'cover' | 'save', commit?: boolean }} TacOut
*/
const SITES = /** @type {const} */ (['A', 'B']);
/** @param {SiteId} s @returns {SiteId} */
const other = (s) => (s === 'A' ? 'B' : 'A');
/** @param {number} round @param {number} salt */
const rollOf = (round, salt) => {
const a = Math.imul(round + 1, 2654435761) ^ Math.imul(salt + 1, 40503);
return (a ^ (a >>> 15)) >>> 0;
};
/** @param {string} text @returns {Plan | null} */
function parsePlan(text) {
let m = /^P:go ([AB]) (\d+)$/.exec(text);
if (m !== null) {
const site = /** @type {SiteId} */ (m[1]);
return { kind: 'go', site, r1: Number(m[2]), r2: Number(m[2]), exec: site };
}
m = /^P:(rush|split)([AB]) (\d+)(?: (\d+))?( go)?$/.exec(text);
if (m !== null) {
const site = /** @type {SiteId} */ (m[2]);
const kind = /** @type {'rush' | 'split'} */ (m[1]);
const r1 = Number(m[3]);
return { kind, site, r1, r2: m[4] !== undefined ? Number(m[4]) : r1, exec: kind === 'rush' || m[5] !== undefined ? site : null };
}
m = /^P:(default|fake) ([AB]) (\d+) (\d+)(?: >([AB]))?$/.exec(text);
if (m !== null) return { kind: /** @type {'default' | 'fake'} */ (m[1]), site: /** @type {SiteId} */ (m[2]), r1: Number(m[3]), r2: Number(m[4]), exec: m[5] !== undefined ? /** @type {SiteId} */ (m[5]) : null };
m = /^P:hold A=(\d) (?:M=(\d) )?B=(\d)(?: rot=([AB]))?( go)?$/.exec(text);
if (m !== null) return { kind: 'hold', a: Number(m[1]), m: m[2] !== undefined ? Number(m[2]) : 0, b: Number(m[3]), rot: m[4] !== undefined ? /** @type {SiteId} */ (m[4]) : null, go: m[5] !== undefined };
return null;
}
/** @param {Plan} p */
function planText(p) {
switch (p.kind) {
case 'go':
return `P:go ${p.site} ${p.r1}`;
case 'rush':
return `P:rush${p.site} ${p.r1}`;
case 'split':
return `P:split${p.site} ${p.r1} ${p.r2}${p.exec !== null ? ' go' : ''}`;
case 'default':
case 'fake':
return `P:${p.kind} ${p.site} ${p.r1} ${p.r2}${p.exec !== null ? ` >${p.exec}` : ''}`;
default:
return `P:hold A=${p.a}${p.m > 0 ? ` M=${p.m}` : ''} B=${p.b}${p.rot !== null ? ` rot=${p.rot}` : ''}${p.go ? ' go' : ''}`;
}
}
/** @param {string} text @returns {TeamEvent | null} */
function parseEvent(text) {
let m = /^E:contact (\S+) (\d+)$/.exec(text);
if (m !== null) return { kind: 'contact', region: m[1], n: Number(m[2]) };
m = /^E:dead (\S+)$/.exec(text);
if (m !== null) return { kind: 'dead', region: m[1] };
m = /^E:planted ([AB])$/.exec(text);
if (m !== null) return { kind: 'planted', site: /** @type {SiteId} */ (m[1]) };
m = /^E:flash (\d+) (\d+) (\d+)$/.exec(text);
if (m !== null) return { kind: 'flash', x: Number(m[1]) * 100, y: Number(m[2]) * 100, pop: Number(m[3]) };
m = /^E:smoke (\d+) (\d+)$/.exec(text);
if (m !== null) return { kind: 'smoke', x: Number(m[1]) * 100, y: Number(m[2]) * 100 };
m = /^E:burn (\d+) (\d+) (\d+)$/.exec(text);
if (m !== null) return { kind: 'burn', x: Number(m[1]) * 100, y: Number(m[2]) * 100, until: Number(m[3]) };
m = /^E:awp (\d+) (\d+)$/.exec(text);
if (m !== null) return { kind: 'awp', x: Number(m[1]) * 100, y: Number(m[2]) * 100 };
if (text === 'E:kit') return { kind: 'kit' };
if (text === 'E:smoker') return { kind: 'smoker' };
return null;
}
class Tactics {
/**
* @param {Grid} g @param {MapIntel} intel @param {Perception} perc
* @param {InitData} data @param {Helpers} h
* @param {{ awpSlot: number, role: number, economy: number, ctSplitA: number, plan: number }} opts
* @param {{ aim: number, reaction: number, awareness: number, aggression: number, discipline: number, movement: number }} attrs
*/
constructor(g, intel, perc, data, h, opts, attrs) {
this.g = g;
this.intel = intel;
this.perc = perc;
this.data = data;
this.h = h;
this.opts = opts;
this.attrs = attrs;
this.tps = data.rules.ticksPerSecond;
const reaction = clamp(data.attributes.reaction, 0, 100);
const nominal = 5 + Math.max(0, 70 - reaction) / 8;
const exact = 5 + Math.max(0, 70 - Math.round(reaction)) / 8;
const declared = data.rules.reactionTicks;
const attributed = Math.round(nominal) === declared;
this.delayMin = attributed ? Math.min(declared, Math.floor(exact)) : declared;
this.delayMax = attributed ? Math.max(declared, Math.ceil(exact)) : declared;
this.econ = new Economy(data, h, { economy: opts.economy, discipline: attrs.discipline });
this.util = new Utility(g, data);
this.ids = [data.playerId, ...data.teammateIds].sort((a, b) => a - b);
this.roles = new Roles(this.ids, data.playerId, opts.role, opts.awpSlot);
this.roleSaid = false;
this.yielded = 0;
this.slow = false;
this.spawnHeld = 0;
this.goTick = -1;
this.readyAt = -1;
this.eventDelay = Math.round(lerp(P.eventDelay0, P.eventDelay100, attrs.awareness) * data.rules.decisionInterval);
/** @type {Map<string, Spot[]>} */
this.spotCache = new Map();
/** @type {Combat | null} */
this.combat = null;
/** @type {Navigator | null} */
this.nav = null;
/** @type {Judgment | null} */
this.judge = null;
/** @type {Mission | null} */
this.mission = null;
this.coop = new Cooperation(g, intel, perc, data);
this.adapt = new Adaptation();
this.rotSince = -1;
/** @type {Map<number, number>} */
this.defuseStarted = new Map();
this.defuseIssued = -1;
this.fakeProbe = false;
/** @type {{ x: number, y: number, until: number }[]} */
this.burns = [];
this.defuseAlarm = -1;
this.postSaid = false;
/** @type {Set<number>} */
this.postSmokers = new Set();
/** @type {Pt | null} */
this.hide = null;
this.hideFor = -1;
/** @type {SiteId[]} */
this.hits = [];
this.siteScore = { A: 0, B: 0 };
/** @type {Record<string, [number, number]>} */
this.planStats = {};
this.lastKind = '';
this.lastSite = /** @type {SiteId | null} */ (null);
this.lastAttack = /** @type {SiteId | null} */ (null);
this.enemiesAlive = 5;
/** @type {{ spot: Spot, site: SiteId, len: number } | null | undefined} */
this.sniper = undefined;
/** @type {Plan | null} */
this.plan = null;
this.commander = -1;
this.saidAs = -1;
this.saidText = '';
this.bought = false;
/** @type {BuyCall | null} */
this.buyCall = null;
this.routeOverride = -1;
/** @type {Map<string, { near: number, main: Entrance, second: Entrance, wait: number } | null>} */
this.flankCache = new Map();
/** @type {Map<SiteId, Route>} */
this.aroundCache = new Map();
/** @type {Map<string, Pt[]>} */
this.smokeCache = new Map();
this.flankStart = -1;
this.flankGo = false;
this.flanked = false;
this.steppedIn = false;
this.rushReady = false;
this.queueHeld = 0;
/** @type {{ ready: number, from: number, text: string }[]} */
this.inbox = [];
/** @type {Map<string, { n: number, tick: number }>} */
this.contacts = new Map();
/** @type {Map<string, SiteId | null>} */
this.contactSite = new Map();
/** @type {Map<string, { n: number, tick: number }>} */
this.saidContact = new Map();
/** @type {Pt[]} */
this.smokeSeen = [];
/** @type {Map<number, number> | null} */
this.groups = null;
this.groupKey = '';
this.execTick = -1;
this.stageArrive = -1;
this.noiseLeft = 0;
/** @type {{ x: number, y: number, pop: number }[]} */
this.mateFlash = [];
this.flashHeard = -1;
this.smokeHeard = -1;
this.flashCue = -1;
this.flashPop = -1000000;
/** @type {Pt[]} */
this.flashSpots = [];
/** @type {Pt[]} */
this.smokes = [];
this.flashKey = '';
/** @type {{ x: number, y: number, sc: number }[]} */
this.flashList = [];
/** @type {Set<number>} */
this.kits = new Set();
this.kitSaid = false;
/** @type {{ x: number, y: number, tick: number } | null} */
this.awp = null;
this.awpSaid = -1000000;
/** @type {Pt[]} */
this.awpHist = [];
this.awpTeam = '';
this.dodged = false;
this.lineHeld = 0;
this.lineDeath = -1;
/** @type {{ x: number, y: number, until: number } | null} */
this.trade = null;
/** @type {{ x: number, y: number, until: number } | null} */
this.chase = null;
/** @type {Map<number, number>} */
this.dealt = new Map();
/** @type {Map<number, boolean>} */
this.mateAlive = new Map();
/** @type {Map<number, number>} */
this.mateFired = new Map();
this.liveStart = -1;
this.plantedSaid = false;
this.saving = false;
this.awper = -1;
this.awperFixed = false;
/** @type {Map<number, { spot: Spot, site: SiteId | null }> | null} */
this.layout = null;
this.layoutKey = '';
/** @type {Pt | null} */
this.saveCache = null;
}
/** @param {Observation | null} obs */
reset(obs) {
if (obs !== null) {
this.econ.roundStart(obs);
this.adapt.begin(obs, this.econ.lastWon);
const won = this.econ.lastWon;
if (won !== null && this.lastKind !== '') {
const st = this.planStats[this.lastKind] ?? [0, 0];
this.planStats[this.lastKind] = st;
st[0]++;
if (won) st[1]++;
if (this.lastSite !== null) this.siteScore[this.lastSite] = clamp(this.siteScore[this.lastSite] + (won ? 1 : -1), -2, 2);
}
if (this.lastAttack !== null) {
this.hits.push(this.lastAttack);
if (this.hits.length > 6) this.hits.shift();
}
}
if (this.awp !== null) {
this.awpHist.push({ x: this.awp.x, y: this.awp.y });
if (this.awpHist.length > 3) this.awpHist.shift();
}
this.awp = null;
this.awpSaid = -1000000;
this.dodged = false;
this.lineHeld = 0;
this.lineDeath = -1;
this.lastKind = '';
this.lastSite = null;
this.lastAttack = null;
this.plan = null;
this.commander = -1;
this.saidAs = -1;
this.saidText = '';
this.bought = false;
this.buyCall = null;
this.routeOverride = -1;
this.flankStart = -1;
this.flankGo = false;
this.flanked = false;
this.steppedIn = false;
this.rushReady = false;
this.queueHeld = 0;
this.inbox = [];
this.contacts = new Map();
this.contactSite = new Map();
this.saidContact = new Map();
this.smokeSeen = [];
this.groups = null;
this.groupKey = '';
this.execTick = -1;
this.stageArrive = -1;
this.noiseLeft = 0;
this.mateFlash = [];
this.flashHeard = -1;
this.smokeHeard = -1;
this.flashCue = -1;
this.flashPop = -1000000;
this.flashSpots = [];
/** @type {Pt[]} */
this.smokes = [];
this.flashKey = '';
/** @type {{ x: number, y: number, sc: number }[]} */
this.flashList = [];
this.kits = new Set();
this.kitSaid = false;
this.trade = null;
this.chase = null;
this.dealt = new Map();
this.mateAlive = new Map();
this.mateFired = new Map();
this.liveStart = -1;
this.plantedSaid = false;
this.saving = false;
this.awper = -1;
this.awperFixed = false;
this.layout = null;
this.layoutKey = '';
this.saveCache = null;
this.roleSaid = false;
this.yielded = 0;
this.slow = false;
this.spawnHeld = 0;
this.goTick = -1;
this.readyAt = -1;
this.util.reset();
this.burns = [];
this.defuseAlarm = -1;
this.postSaid = false;
this.postSmokers.clear();
this.coop.reset();
this.rotSince = -1;
this.defuseStarted.clear();
this.defuseIssued = -1;
this.fakeProbe = false;
}
/** @param {Observation} obs */
commanderOf(obs) {
let c = obs.me.alive ? obs.me.id : Infinity;
for (const m of obs.teammates) if (m.alive && m.id < c) c = m.id;
return Number.isFinite(c) ? c : -1;
}
/** @param {number} id */
slotOf(id) {
return this.ids.indexOf(id);
}
/** @param {Observation} obs */
alive(obs) {
const me = obs.me;
const out = obs.teammates.filter((m) => m.alive).map((m) => ({ id: m.id, x: m.x, y: m.y }));
if (me.alive) out.push({ id: me.id, x: me.x, y: me.y });
return out.sort((a, b) => a.id - b.id);
}
/** @param {string} id */
regionCell(id) {
const r = this.intel.map.regions.find((x) => x.id === id);
if (r === undefined) return -1;
return this.intel.nearestOpen(Math.floor((r.x0 + r.x1) / 2), Math.floor((r.y0 + r.y1) / 2));
}
/** @param {number} c @returns {SiteId | null} */
siteNear(c) {
if (c < 0) return null;
const a = this.intel.distSite.A[c] / 10;
const b = this.intel.distSite.B[c] / 10;
if (a <= 25 && a < b - 5) return 'A';
if (b <= 25 && b < a - 5) return 'B';
return null;
}
/**
* @param {Observation} obs
* @returns {TacOut}
*/
update(obs) {
const me = obs.me;
const t = obs.tick;
/** @type {TacOut} */
const out = { goal: null, route: null, hold: null, objective: me.plantTicks > 0 || me.defuseTicks > 0, allowPeek: false, cmds: [], role: '', look: null, urgent: false, hard: false, stop: false, walk: null, noise: false, escape: false };
if (this.liveStart < 0 && obs.round.phase !== 'freeze') this.liveStart = t;
this.enemiesAlive = obs.enemiesAlive;
if (obs.enemiesAlive === 0) {
this.trade = null;
this.chase = null;
this.saving = false;
}
if (!this.roleSaid) {
this.roleSaid = true;
out.cmds.push({ type: 'say', text: `R:${this.opts.role}` });
}
this.trackTeam(obs, out);
this.trackAwp(obs, out);
this.coop.observe(obs);
this.readChat(obs);
this.adapt.observe(obs, this.perc, (c) => this.siteNear(c));
const cmd = this.commanderOf(obs);
this.commander = cmd;
if (cmd === me.id) this.lead(obs, out);
else if (this.plan === null && obs.round.phase !== 'freeze' && t - this.liveStart > this.tps) this.plan = this.choosePlan(obs);
this.buy(obs, out, cmd === me.id);
this.report(obs, out);
const live = obs.round.phase === 'live';
out.allowPeek = live && obs.round.phaseTicksLeft > 25 * this.tps;
this.slow = false;
/** @type {ThrowWish | null} */
let wish = me.team === 'T' ? this.tGoal(obs, out) : this.ctGoal(obs, out);
if (this.slow) {
out.walk = true;
out.role += '・讓突破手先走';
}
if (this.mission?.avoidFire(obs, out, this.combat?.fires, this.nav)) wish = null;
this.mission?.assess(obs, out);
if (wish === null && !out.commit) wish = this.anyNade(obs);
this.overlay(obs, out);
if (wish === null) {
this.coop.apply(obs, out);
if (!this.coop.acted) wish = this.lineCheck(obs, out);
}
/** @type {Set<number>} */
const busy = new Set();
for (const [id, tk] of this.mateFired) if (t - tk < 1.5 * this.tps) busy.add(id);
if (out.commit || out.urgent || this.mateFlash.some((x) => t <= x.pop)) wish = null;
const u = this.util.step(obs, wish, busy);
if (u.thrown !== null && u.thrown.kind === 'smoke') this.smokes.push({ x: u.thrown.x, y: u.thrown.y });
if (u.thrown !== null && u.thrown.kind === 'flash' && this.util.away !== null) {
this.flashPop = this.util.away.until - 3;
this.flashSpots.push({ x: u.thrown.x, y: u.thrown.y });
}
if (u.thrown !== null && (u.thrown.kind === 'molotov' || u.thrown.kind === 'incendiary')) this.burns.push({ x: u.thrown.x, y: u.thrown.y, until: t + 8 * this.tps });
out.cmds.push(...u.cmds);
if (u.look !== null) {
out.look = u.look;
if (this.util.away !== null) out.urgent = true;
}
if (u.stop) out.stop = true;
if (this.plan !== null) {
this.lastKind = this.plan.kind === 'hold' ? '' : this.plan.kind;
if (this.plan.kind !== 'hold') this.lastSite = this.plan.exec ?? this.plan.site;
if (this.adapt.sample !== null) this.adapt.sample.plan = this.lastKind;
}
if (out.cmds.some((c) => c.type === 'defuse')) this.defuseIssued = t;
else if (!out.objective || me.defuseTicks > 0 || t > this.defuseIssued + this.delayMax + this.data.rules.decisionInterval) this.defuseIssued = -1;
return out;
}
/**
* @param {Observation} obs @param {TacOut} out
*/
trackTeam(obs, out) {
const me = obs.me;
const t = obs.tick;
const tid = this.combat?.targetId ?? -1;
for (const s of me.shots) if (s.hit === 'enemy' && tid >= 0) this.dealt.set(tid, (this.dealt.get(tid) ?? 0) + s.damage);
for (const m of obs.teammates) {
if (!m.alive) this.kits.delete(m.id);
if (m.alive && m.defusing) { if (!this.defuseStarted.has(m.id)) this.defuseStarted.set(m.id, t); }
else this.defuseStarted.delete(m.id);
if (m.firing) this.mateFired.set(m.id, t);
if (this.mateAlive.get(m.id) === true && !m.alive) {
if (me.alive && dist(m.x, m.y, me.x, me.y) <= P.tradeRange * UNIT) this.trade = { x: m.x + cosd(m.facing) * 10 * UNIT, y: m.y + sind(m.facing) * 10 * UNIT, until: t + Math.round(P.tradeHold * this.tps) };
if (this.commanderOf(obs) === me.id) {
const r = this.intel.region[this.g.cellOf(m.x, m.y)];
if (r >= 0) out.cmds.push({ type: 'say', text: `E:dead ${this.intel.map.regions[r].id}` });
}
const near = this.siteNear(this.g.cellOf(m.x, m.y));
if (near !== null) this.noteContact(`#dead${m.id}`, 1, t, near);
}
this.mateAlive.set(m.id, m.alive);
}
}
/** @param {Observation} obs @param {TacOut} out */
trackAwp(obs, out) {
const me = obs.me;
const t = obs.tick;
if (this.awpTeam !== me.team) {
this.awpTeam = me.team;
this.awpHist = [];
}
const e = obs.enemies.find((q) => q.weapon === 'awp');
if (e !== undefined) {
this.awp = { x: e.x, y: e.y, tick: t };
if (t - this.awpSaid >= 3 * this.tps) {
this.awpSaid = t;
out.cmds.push({ type: 'say', text: `E:awp ${Math.round(e.x / 100)} ${Math.round(e.y / 100)}` });
}
return;
}
if (this.awp !== null && t - this.awp.tick < P.awpMemo * this.tps) return;
const s = obs.sounds.find((q) => q.kind === 'shot' && q.weapon === 'awp' && !q.friendly);
if (s === undefined) return;
const r = (s.range === 'near' ? 6 : s.range === 'mid' ? 20 : 40) * UNIT;
const c = this.intel.nearestOpen(Math.floor((me.x + cosd(s.dirDeg) * r) / UNIT), Math.floor((me.y + sind(s.dirDeg) * r) / UNIT));
if (c >= 0) this.awp = { ...this.g.center(c), tick: t };
}
/** @param {string} key @param {number} n @param {number} t @param {SiteId | null} site */
noteContact(key, n, t, site) {
this.contacts.set(key, { n, tick: t });
this.contactSite.set(key, site);
}
/** @param {Observation} obs */
readChat(obs) {
const me = obs.me;
const t = obs.tick;
for (const c of obs.chat) {
if (c.from === me.id) continue;
const r = parseRole(c.text);
if (r > 0) {
this.roles.hear(c.from, r);
continue;
}
const first = (this.plan === null || this.roles.of(me.id) === LURK) && c.text.startsWith('P:');
this.inbox.push({ ready: first || c.text.startsWith('B:') ? t : t + this.eventDelay, from: c.from, text: c.text });
}
const keep = [];
for (const msg of this.inbox) {
if (msg.ready > t) {
keep.push(msg);
continue;
}
const text = msg.text;
const p = parsePlan(text);
if (p !== null) {
if (msg.from < me.id && (p.kind === 'hold') === (me.team === 'CT')) this.setPlan(p, obs);
continue;
}
const b = parseBuy(text);
if (b !== null) {
if (msg.from < me.id) this.buyCall = b;
continue;
}
const e = parseEvent(text);
if (e === null) continue;
if (e.kind === 'contact') {
const c = this.regionCell(e.region);
this.noteContact(e.region, e.n, t, this.siteNear(c));
} else if (e.kind === 'flash') this.mateFlash.push({ x: e.x, y: e.y, pop: e.pop });
else if (e.kind === 'smoke') {
this.smokeHeard = t;
this.smokes.push({ x: e.x, y: e.y });
}
else if (e.kind === 'kit' && this.isAlive(obs, msg.from)) this.kits.add(msg.from);
else if (e.kind === 'burn') this.burns.push(e);
else if (e.kind === 'awp') this.awp = { x: e.x, y: e.y, tick: t };
else if (e.kind === 'smoker') this.postSmokers.add(msg.from);
if (e.kind === 'flash') {
this.flashHeard = t;
this.flashPop = e.pop;
this.flashSpots.push({ x: e.x, y: e.y });
}
}
this.inbox = keep;
}
/** @param {Plan} p @param {Observation} obs */
setPlan(p, obs) {
const prev = this.plan;
this.plan = p;
if (p.kind === 'hold' && (prev === null || prev.kind !== 'hold' || p.rot !== prev.rot)) this.rotSince = obs.tick;
if (p.kind !== 'hold' && p.exec !== null && (prev === null || prev.kind === 'hold' || prev.exec === null)) this.execTick = obs.tick;
if (prev !== null && prev.kind !== 'hold' && p.kind !== 'hold' && prev.r1 !== p.r1) this.routeOverride = -1;
}
/** @param {Observation} obs @param {TacOut} out */
lead(obs, out) {
if (this.plan === null) this.setPlan(this.choosePlan(obs), obs);
const p = /** @type {Plan} */ (this.plan);
const next = p.kind === 'hold' ? this.leadCT(obs, p) : this.dodgeLine(obs, this.leadT(obs, p));
if (next !== p) this.setPlan(next, obs);
const text = planText(/** @type {Plan} */ (this.plan));
if (this.saidAs !== obs.me.id || this.saidText !== text) {
out.cmds.push({ type: 'say', text });
this.saidAs = obs.me.id;
this.saidText = text;
}
const b = obs.bomb;
if (!this.plantedSaid && b.state === 'planted' && b.site !== null) {
this.plantedSaid = true;
out.cmds.push({ type: 'say', text: `E:planted ${b.site}` });
}
}
/** @param {Observation} obs @returns {Plan} */
choosePlan(obs) {
if (obs.me.team === 'CT') return this.chooseCT();
return this.chooseT(obs);
}
/**
* @param {Observation} obs @returns {TPlan}
*/
chooseT(obs) {
const h = this.h;
const ag = this.attrs.aggression;
const call = this.buyCall ?? this.econ.teamCall(obs);
const learned = this.adapt.advice('T');
const wA = Math.max(0.2, 1 + 0.35 * this.siteScore.A);
const wB = Math.max(0.2, 1 + 0.35 * this.siteScore.B);
/** @type {SiteId} */
const site = h.random() * (wA + wB) < wA ? 'A' : 'B';
const forced = ['', 'default', 'rush', 'split', 'fake'][this.opts.plan] ?? '';
let kind = forced;
if (kind === '') {
const w = call === 'eco' ? { default: 0, rush: 0.65, split: 0.35, fake: 0 } : this.enemyEco() ? { default: 0.1, rush: 0.35 + 0.2 * ag, split: 0.4, fake: 0.1 } : { default: 0.22, rush: 0.12 + 0.2 * ag, split: 0.4, fake: 0.18 };
for (const k of /** @type {const} */ (['default', 'rush', 'split', 'fake'])) w[k] *= learned.plans[k] ?? 1;
w.fake *= 0.75 + learned.rotation * 0.5;
let r = h.random() * (w.default + w.rush + w.split + w.fake);
kind = 'fake';
for (const k of /** @type {const} */ (['default', 'rush', 'split'])) {
if ((r -= w[k]) < 0) {
kind = k;
break;
}
}
}
const routes = this.intel.routes.T[site];
const n = Math.max(1, routes.length);
if (kind === 'rush') return { kind: 'rush', site, r1: Math.floor(h.random() * Math.min(2, n)), r2: 0, exec: site };
if (kind === 'split') {
const r1 = 0;
const entrance1 = routes[r1]?.portals[routes[r1].portals.length - 1];
const others = routes.map((_, i) => i).filter((i) => i !== r1 && routes[i].portals[routes[i].portals.length - 1] !== entrance1);
const r2 = others.length > 0 ? others[Math.floor(h.random() * others.length)] : 0;
return { kind: 'split', site, r1, r2, exec: null };
}
const nOther = Math.max(1, this.intel.routes.T[other(site)].length);
if (kind === 'fake') return { kind: 'fake', site, r1: 0, r2: Math.floor(h.random() * Math.min(2, nOther)), exec: null };
return { kind: 'default', site, r1: Math.floor(h.random() * Math.min(2, n)), r2: Math.floor(h.random() * Math.min(2, nOther)), exec: null };
}
/** @returns {CTPlan} */
chooseCT() {
let a = clamp(this.opts.ctSplitA, 0, 5);
let b = Math.min(P.ctB, 5 - a);
let m = 5 - a - b;
const learned = this.adapt.advice('CT');
const bias = learned.A - learned.B;
if (learned.evidence >= 5 && Math.abs(bias) > 0.9 && learned.fast > 0.6) {
a = bias > 0 ? 4 : 1;
b = 5 - a;
m = 0;
} else if (learned.evidence >= 3 && m > 0) {
if (bias > 0.5) {
a++;
m--;
} else if (bias < -0.5) {
b++;
m--;
}
}
return { kind: 'hold', a, m, b, rot: null, go: false };
}
/**
* @param {Observation} obs @param {TPlan} p @returns {TPlan}
*/
leadT(obs, p) {
if (obs.round.phase !== 'live' || p.exec !== null) return p;
const t = obs.tick;
const el = (t - this.liveStart) / this.tps;
const left = obs.round.phaseTicksLeft / this.tps;
if (left <= P.forceExecLeft) return { ...p, exec: this.nearestSite(obs) };
if (p.kind === 'split') {
const ready = this.alive(obs).every((m) => {
const s = this.memberStage(obs, m.id, p);
return s === null || dist(m.x, m.y, s.x, s.y) < 4.5 * UNIT;
});
if (!ready) this.readyAt = -1;
else if (this.readyAt < 0) this.readyAt = t;
const far = Math.max(this.tRoute(p.site, p.r1)?.length ?? 0, this.tRoute(p.site, p.r2)?.length ?? 0);
if ((ready && t - this.readyAt >= 1.5 * this.tps) || el >= Math.max(P.splitWait, far / P.routeSpeed)) return { ...p, exec: p.site };
}
if (p.kind === 'fake') {
const fakers = this.alive(obs).filter((m) => this.groupOf(obs, m.id, p) === 1);
const there = fakers.some((m) => {
const s = this.memberStage(obs, m.id, p);
return s !== null && dist(m.x, m.y, s.x, s.y) < 4 * UNIT;
});
if (there && this.stageArrive < 0) this.stageArrive = t;
if (there) {
const bait = other(p.site);
const probed = fakers.some((m) => this.inRectSite(m.x, m.y, bait));
const response = this.adapt.fake(obs, this.perc, p, probed);
if (response !== null) return { ...p, exec: response };
}
if ((this.stageArrive >= 0 && t - this.stageArrive >= P.fakeDelay * this.tps) || el >= P.splitWait + 6) return { ...p, exec: p.site };
}
if (p.kind === 'default') {
const at = lerp(P.defaultExec0, P.defaultExec100, this.attrs.aggression) * (this.enemyEco() ? 0.6 : 1);
const heat = this.heat(obs);
const early = el >= at * 0.5 && Math.abs(heat.A - heat.B) >= 2;
if (el >= at || early) return { ...p, exec: heat.A < heat.B ? 'A' : heat.B < heat.A ? 'B' : p.site };
}
return p;
}
/** @param {Pt} q @param {Entrance | null} e */
covers(q, e) {
return e !== null && dist(q.x, q.y, e.ox, e.oy) < 45 * UNIT && (this.g.los(q.x, q.y, e.ox, e.oy) || this.g.los(q.x, q.y, e.ix, e.iy));
}
/**
* @param {Observation} obs @param {TPlan} p @returns {TPlan}
*/
dodgeLine(obs, p) {
if (this.dodged || p.kind === 'go' || (p.exec !== null && p.exec !== p.site)) return p;
const last = this.awpHist[this.awpHist.length - 1];
const q = this.awp ?? last;
if (q === undefined) return p;
const ent = this.entranceOf(p.site, p.r1);
if (!this.covers(q, ent) || ent === null) return p;
this.dodged = true;
if (this.awp === null && this.h.random() >= P.awpAvoid) return p;
if (this.alive(obs).some((m) => dist(m.x, m.y, ent.ox, ent.oy) < 12 * UNIT)) return p;
const n = this.intel.routes.T[p.site].length;
for (let i = 0; i < n; i++) {
const e = this.entranceOf(p.site, i);
if (i !== p.r2 && e !== null && e.portal !== ent.portal && !this.covers(q, e)) return { ...p, r1: i };
}
return p;
}
enemyEco() {
return this.econ.lastWon === true && this.econ.enemyLevel >= 2;
}
/** @param {Observation} obs @returns {SiteId} */
nearestSite(obs) {
const c = obs.teammates.find((m) => m.alive && m.hasBomb) ?? obs.me;
const cell = this.g.cellOf(c.x, c.y);
if (cell < 0) return 'A';
return this.intel.distSite.A[cell] <= this.intel.distSite.B[cell] ? 'A' : 'B';
}
/**
* @param {Observation} obs
*/
heat(obs) {
const t = obs.tick;
const out = { A: 0, B: 0 };
const seen = { A: 0, B: 0 };
for (const k of this.perc.known.values()) {
if (k.conf < 50) continue;
const s = this.siteNear(this.g.cellOf(k.x, k.y));
if (s !== null) seen[s]++;
}
const heard = { A: 0, B: 0 };
for (const [key, c] of this.contacts) {
if (t - c.tick > P.contactTtl * this.tps) {
this.contacts.delete(key);
continue;
}
const s = this.contactSite.get(key) ?? null;
if (s !== null) heard[s] += c.n;
}
for (const s of SITES) out[s] = Math.max(seen[s], heard[s]);
return out;
}
/**
* @param {Observation} obs @param {CTPlan} p @returns {CTPlan}
*/
leadCT(obs, p) {
if (obs.round.phase === 'freeze') return p;
const b = obs.bomb;
if ((b.state === 'planted' || b.state === 'defusing') && b.site !== null) {
const clear = obs.enemiesAlive === 0;
if (p.rot !== b.site) return { ...p, rot: b.site, go: clear };
if (!p.go && (clear || this.retakeReady(obs, b.site))) return { ...p, go: true };
return p;
}
const heat = this.heat(obs);
if (p.rot === null) {
for (const s of SITES) if (heat[s] >= P.rotateHeat && heat[s] > heat[other(s)]) { this.rotSince = obs.tick; return { ...p, rot: s }; }
} else if (obs.tick - this.rotSince >= 4 * this.tps) {
const next = other(p.rot);
if (heat[next] >= P.rotateHeat && heat[next] > heat[p.rot] + 1) { this.rotSince = obs.tick; return { ...p, rot: next }; }
if (heat.A === 0 && heat.B === 0 && obs.tick - this.rotSince >= 7 * this.tps) {
let n = 0, seen = 0;
for (let i = 0; i < this.g.N; i++) if (this.intel.sites[p.rot].regions.has(this.intel.region[i])) {
n++; if (this.perc.seenTick[i] >= Math.max(this.rotSince, obs.tick - this.tps)) seen++;
}
if (n > 0 && seen / n >= 0.65) { this.rotSince = obs.tick; return { ...p, rot: null }; }
}
}
return p;
}
/** @param {Observation} obs @param {SiteId} s */
retakeReady(obs, s) {
const b = obs.bomb;
const bx = b.x ?? this.intel.sites[s].cx;
const by = b.y ?? this.intel.sites[s].cy;
const stage = this.stageSpots('CT', s, 0);
if (stage.length === 0) return true;
const left = (b.ticksLeft ?? 0) / this.tps;
const feasible = this.defuseTeam(obs, bx, by).filter((m) => m.eta <= left);
if (feasible.length === 0 || feasible.some((m) => m.defusing || m.pending || m.cautious > left) || left <= Math.min(...feasible.map((m) => m.cautious)) + P.saveMargin + 2) return true;
return feasible.every((m) => this.inSite(m.x, m.y, s, bx, by) || stage.some((sp) => dist(m.x, m.y, sp.x, sp.y) < P.retakeGather * UNIT));
}
/**
* @param {Observation} obs @param {number} bx @param {number} by
*/
defuseTeam(obs, bx, by) {
const me = obs.me;
const r = this.data.rules;
const field = this.judge?.field(bx, by);
const pending = this.defuseIssued >= 0 && obs.tick <= this.defuseIssued + this.delayMax + r.decisionInterval;
const team = this.alive(obs).map((m) => ({ ...m, weapon: m.id === me.id ? me.weapon : obs.teammates.find((q) => q.id === m.id)?.weapon, kit: m.id === me.id ? me.loadout.kit : this.kits.has(m.id), d: field === undefined ? dist(m.x, m.y, bx, by) : field[this.g.cellOf(m.x, m.y)] / 10 * UNIT, defusing: m.id === me.id ? me.defuseTicks > 0 : obs.teammates.some((q) => q.id === m.id && q.defusing), pending: m.id === me.id && pending }));
return team.map((m) => {
const duration = m.kit ? r.defuseKitTicks : r.defuseTicks;
const walking = dist(m.x, m.y, bx, by) < 1300 ? 0 : this.judge !== null ? Math.max(0, this.judge.travel(m, bx, by) * this.tps - r.reactionTicks) : m.d / 4.6 / UNIT * this.tps;
const finish = (/** @type {number} */ delay) => {
if (m.defusing) {
const progress = m.id === me.id ? me.defuseTicks : 1 + obs.tick - (this.defuseStarted.get(m.id) ?? obs.tick);
return Math.max(0, duration - progress) / this.tps;
}
if (m.pending) return Math.max(0, this.defuseIssued + delay + duration - 1 - obs.tick) / this.tps;
const ready = walking === 0 ? 0 : Math.ceil((walking + delay) / r.decisionInterval) * r.decisionInterval;
const handoff = team.some((q) => q.defusing) ? Math.ceil(delay / r.decisionInterval) * r.decisionInterval : 0;
return (Math.max(ready, handoff) + delay + duration - 1) / this.tps;
};
return { ...m, eta: finish(this.delayMin), cautious: finish(this.delayMax) };
});
}
/** @param {number} x @param {number} y @param {SiteId} s @param {number} bx @param {number} by */
inSite(x, y, s, bx, by) {
const c = this.g.cellOf(x, y);
return (c >= 0 && this.intel.sites[s].regions.has(this.intel.region[c])) || dist(x, y, bx, by) < 8 * UNIT;
}
/** @param {Observation} obs @param {TacOut} out @param {boolean} isCmd */
buy(obs, out, isCmd) {
const me = obs.me;
if (!obs.round.canBuy || this.bought) {
if (!this.kitSaid && me.loadout.kit && obs.round.phase !== 'freeze') {
this.kitSaid = true;
out.cmds.push({ type: 'say', text: 'E:kit' });
}
return;
}
if (isCmd && this.buyCall === null) {
this.buyCall = this.econ.teamCall(obs);
out.cmds.push({ type: 'say', text: `B:${this.buyCall}` });
}
const waited = obs.round.phase !== 'freeze' || this.data.rules.freezeTicks - obs.round.phaseTicksLeft >= this.tps;
if (this.buyCall === null && !waited) return;
const call = this.buyCall ?? this.econ.teamCall(obs);
const items = this.econ.items(obs, call, this.roles.of(me.id), this.roles.awper() === me.id);
if (items.length > 0) out.cmds.push({ type: 'buy', items });
this.bought = true;
}
/**
* @param {Observation} obs @param {TacOut} out
*/
report(obs, out) {
if (obs.round.phase === 'freeze') return;
const t = obs.tick;
if (obs.me.team === 'CT' && this.smokeAlarm(obs, out)) return;
if (obs.enemies.length === 0) return;
/** @type {Map<number, number>} */
const byRegion = new Map();
for (const e of obs.enemies) {
const r = this.intel.region[this.g.cellOf(e.x, e.y)];
if (r >= 0) byRegion.set(r, (byRegion.get(r) ?? 0) + 1);
}
for (const [r, n] of byRegion) {
const id = this.intel.map.regions[r].id;
const last = this.saidContact.get(id);
if (last !== undefined && (last.n >= n || t - last.tick < P.contactEvery * this.tps) && t - last.tick < 4 * P.contactEvery * this.tps) continue;
this.saidContact.set(id, { n, tick: t });
const c = this.regionCell(id);
this.noteContact(id, n, t, this.siteNear(c));
out.cmds.push({ type: 'say', text: `E:contact ${id} ${n}` });
return;
}
}
/**
* @param {Observation} obs @param {TacOut} out @returns {boolean}
*/
smokeAlarm(obs, out) {
for (const q of obs.effects) {
if (q.kind !== 'smoke' || this.smokes.some((m) => dist(m.x, m.y, q.x, q.y) < 2 * UNIT) || this.smokeSeen.some((m) => dist(m.x, m.y, q.x, q.y) < 2 * UNIT)) continue;
this.smokeSeen.push({ x: q.x, y: q.y });
const s = this.siteNear(this.g.cellOf(q.x, q.y));
if (s === null) continue;
const id = this.intel.map.regions[/** @type {number} */ ([...this.intel.sites[s].regions][0])].id;
this.noteContact(id, 2, obs.tick, s);
out.cmds.push({ type: 'say', text: `E:contact ${id} 2` });
return true;
}
return false;
}
/** @param {number} id */
mainPri(id) {
return MAIN_PRI[this.roles.of(id)] * 10 + this.slotOf(id);
}
/**
* @param {Observation} obs @param {number} id @param {TPlan} p
*/
groupOf(obs, id, p) {
if (p.kind === 'rush' || p.kind === 'go') return 0;
const key = `${p.kind}${p.site}${this.roles.key}`;
if (this.groups === null || this.groupKey !== key) {
const carrier = obs.me.hasBomb ? obs.me.id : (obs.teammates.find((m) => m.hasBomb)?.id ?? -1);
const others = this.ids.filter((x) => x !== carrier).sort((a, b) => this.mainPri(a) - this.mainPri(b));
const main = carrier >= 0 ? [carrier, ...others.slice(0, 2)] : others.slice(0, 3);
this.groups = new Map(this.ids.map((x) => [x, main.includes(x) ? 0 : 1]));
this.groupKey = key;
}
return this.groups.get(id) ?? 0;
}
/** @param {Observation} obs @param {number} id @param {TPlan} p */
memberIndex(obs, id, p) {
const gid = this.groupOf(obs, id, p);
const carrier = obs.me.hasBomb ? obs.me.id : (obs.teammates.find((m) => m.hasBomb)?.id ?? -1);
const last = this.roles.of(carrier) === ENTRY ? -1 : carrier;
const list = this.ids.filter((x) => this.isAlive(obs, x) && this.groupOf(obs, x, p) === gid).sort((a, b) => (a === last ? 1 : 0) - (b === last ? 1 : 0) || this.mainPri(a) - this.mainPri(b));
return Math.max(0, list.indexOf(id));
}
/** @param {Observation} obs @param {number} id @param {TPlan} p @returns {{ site: SiteId, route: number }} */
setupOf(obs, id, p) {
const gid = this.groupOf(obs, id, p);
if (gid === 0) return { site: p.site, route: p.r1 };
if (p.kind === 'split') return { site: p.site, route: p.r2 };
return { site: other(p.site), route: p.r2 };
}
/** @param {Observation} obs @param {number} id @param {TPlan} p */
memberStage(obs, id, p) {
if (p.kind === 'rush' || p.kind === 'go') return null;
const s = this.setupOf(obs, id, p);
const spots = this.stageSpots('T', s.site, s.route);
if (spots.length === 0) return null;
return spots[this.memberIndex(obs, id, p) % spots.length];
}
/** @param {SiteId} site @param {number} idx */
tRoute(site, idx) {
const routes = this.intel.routes.T[site];
return routes.length === 0 ? null : routes[Math.min(idx, routes.length - 1)];
}
/**
* @param {Observation} obs @param {TacOut} out
* @returns {ThrowWish | null}
*/
tGoal(obs, out) {
const me = obs.me;
const t = obs.tick;
const b = obs.bomb;
out.task = me.hasBomb ? 'plant' : 'execute';
if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) return this.postPlant(obs, out, b.x, b.y, b.site ?? 'A');
if (b.state === 'dropped' && b.x !== null && b.y !== null) {
const bx = b.x;
const by = b.y;
const myD = dist(me.x, me.y, bx, by);
const retriever = this.judge?.retriever(obs, bx, by);
if (retriever !== undefined ? retriever === me.id : !obs.teammates.some((m) => m.alive && dist(m.x, m.y, bx, by) < myD)) {
out.goal = { x: bx, y: by };
out.role = '撿炸彈';
out.task = 'retrieve';
return null;
}
}
const p = this.plan !== null && this.plan.kind !== 'hold' ? this.plan : null;
if (p === null) return null;
let exec = p.exec;
if (exec === null && obs.round.phase === 'live' && obs.round.phaseTicksLeft <= (P.forceExecLeft - 3) * this.tps) exec = this.nearestSite(obs);
const setup = this.setupOf(obs, me.id, p);
this.slow = obs.round.phase === 'live' && p.kind !== 'go' && this.spawnWait(obs, p, exec ?? setup.site);
if (this.slow && this.spawnHeld <= P.spawnStop * this.tps) {
out.stop = true;
out.role = '讓突破手先走';
return null;
}
if (exec === null) {
const st = this.memberStage(obs, me.id, p);
out.route = this.pickRoute(obs, setup.site, setup.route);
if (st === null) return null;
out.goal = { x: st.x, y: st.y };
out.hold = st;
const d = dist(me.x, me.y, st.x, st.y);
out.role = p.kind === 'fake' && this.groupOf(obs, me.id, p) === 1 ? '佯攻' : '待命';
if (out.role === '佯攻') {
if (obs.enemies.length > 0 || this.heat(obs)[setup.site] >= 2) this.fakeProbe = false;
else if (this.stageArrive >= 0 && t - this.stageArrive >= 1.5 * this.tps) this.fakeProbe = true;
if (this.fakeProbe) {
const e = this.entranceOf(setup.site, setup.route);
if (e !== null) {
out.goal = this.intel.sites[setup.site].plants[0]; out.hold = null; out.role = '佯攻試探';
out.walk = true; out.look = { x: e.ix, y: e.iy };
return null;
}
}
}
this.awpSettle(obs, out, st);
if (d < 10 * UNIT && this.attrs.movement >= 0.3) out.walk = true;
if (out.role === '佯攻' && d < 2.5 * UNIT) {
if (this.noiseLeft === 0 && this.stageArrive < 0) {
this.stageArrive = t;
this.noiseLeft = 4;
}
if (this.noiseLeft > 0) {
this.noiseLeft--;
out.noise = true;
out.look = { x: st.fx, y: st.fy };
}
const site = this.intel.sites[setup.site];
const kind = this.util.pick(me, ['he', 'flash', 'molotov']);
if (kind !== null && kind !== 'flash') return { kind, x: site.cx, y: site.cy, why: '佯攻' };
}
return null;
}
if (p.kind !== 'go') {
out.allowPeek = false;
out.walk = false;
}
const site = this.intel.sites[exec];
const mine = setup.site === exec;
out.route = mine ? this.pickRoute(obs, exec, setup.route) : null;
const flank = this.flankOf(p, exec);
if (flank !== null && mine && this.flankHold(obs, p, exec, flank)) {
const st = this.memberStage(obs, me.id, p);
if (st !== null) {
this.execTick = t;
out.goal = { x: st.x, y: st.y };
out.hold = st;
out.role = '等第二組';
this.awpSettle(obs, out, st);
return null;
}
}
const ent = mine ? this.entranceOf(exec, setup.route) : flank?.second ?? null;
if (flank !== null && !mine && !this.flanked) {
if (dist(me.x, me.y, flank.second.ox, flank.second.oy) < 3 * UNIT || this.inRectSite(me.x, me.y, exec)) this.flanked = true;
else {
out.goal = { x: flank.second.ox, y: flank.second.oy };
out.route = this.aroundSite(exec);
out.role = `繞第二入口 ${exec}`;
return null;
}
}
/** @type {ThrowWish | null} */
let wish = null;
const sinceExec = this.execTick >= 0 ? (t - this.execTick) / this.tps : 99;
if (ent !== null && !this.inSite(me.x, me.y, exec, site.cx, site.cy) && dist(me.x, me.y, ent.ox, ent.oy) < 22 * UNIT) {
const idx = this.memberIndex(obs, me.id, p);
const role = this.roles.of(me.id);
const smokeFirst = p.kind !== 'rush' && p.kind !== 'go';
const cue = this.leadDist(obs, p, ent) < P.flashLead * UNIT;
if (!cue) this.flashCue = -1;
else if (this.flashCue < 0) this.flashCue = t;
const flashTurn = idx === Math.min(1, this.groupSize(obs, p) - 1) || (this.flashCue >= 0 && t - this.flashCue > P.flashTurn * this.tps);
const st = this.memberStage(obs, me.id, p);
const near = st !== null && dist(me.x, me.y, st.x, st.y) < 6 * UNIT;
const supportFirst = role !== SUPPORT && this.isAlive(obs, this.roles.who(SUPPORT)) && this.smokeHeard < 0 && sinceExec < 8;
if (this.util.has(me, 'smoke') && smokeFirst && idx === this.smokerIndex(obs, me.id, p)) {
const sp = supportFirst ? null : this.smokeTarget(obs, p, exec, ent);
if (sp !== null) wish = { kind: 'smoke', x: sp.x, y: sp.y, why: '封架點' };
} else if (this.util.has(me, 'flash') && cue && flashTurn && !this.flashDone(ent) && (!smokeFirst || this.smokeHeard >= 0 || this.util.used.has('smoke') || sinceExec > (this.isAlive(obs, this.roles.who(SUPPORT)) ? 4 : 1.5))) {
const fp = this.flashPoint(obs, exec, ent, smokeFirst ? 2 : 5);
if (fp !== null && (smokeFirst || this.viewer(fp, exec))) wish = { kind: 'flash', x: fp.x, y: fp.y, why: '閃進點' };
}
const smoker = this.util.has(me, 'smoke') && smokeFirst && idx === this.smokerIndex(obs, me.id, p) && !supportFirst;
if (wish === null && smoker && sinceExec < 7 && dist(me.x, me.y, ent.ox, ent.oy) > 3 * UNIT) {
out.goal = { x: ent.ox, y: ent.oy };
out.walk = true;
out.role = '找丟道具的位置';
return null;
}
const travel = (dist(me.x, me.y, ent.ox, ent.oy) / UNIT / P.routeSpeed) * this.tps;
const pending = this.mateFlash.some((x) => t <= x.pop - travel);
const flashHere = st !== null && dist(st.x, st.y, ent.ox, ent.oy) < P.flashLead * UNIT;
const cover = smokeFirst && near && wish === null && !cue && flashTurn && idx > 0 && sinceExec < P.stageLead + 3 && !this.flashDone(ent) && this.util.has(me, 'flash') && this.flashPoint(obs, exec, ent, 2) !== null;
const waiting = cover || (smokeFirst && near && wish === null && (pending || (flashHere && sinceExec < 3 && this.flashHeard < 0 && !this.util.used.has('flash'))));
const lead = smokeFirst && near && wish === null && sinceExec < P.stageLead && this.waitEntry(obs, exec);
if ((waiting || lead || (smokeFirst && near && wish !== null && sinceExec < 4)) && st !== null) {
out.goal = { x: st.x, y: st.y };
out.hold = st;
out.role = wish !== null ? '丟道具' : lead && !waiting ? '等突破手先走' : '等閃光';
this.awpSettle(obs, out, st);
return wish;
}
}
out.role = `執行 ${exec}`;
const flashed = t >= this.flashPop && t < this.flashPop + 2 * this.tps;
if (p.kind !== 'go' && !flashed && this.yieldTo(obs, exec)) {
out.stop = true;
out.look = { x: site.cx, y: site.cy };
out.role = this.roles.of(me.id) === AWP ? '等隊友先進' : '等突破手先進';
const st = this.memberStage(obs, me.id, p);
if (this.roles.of(me.id) === AWP && st !== null) out.hold = { ...st, x: me.x, y: me.y };
return wish;
}
if (p.kind !== 'go' && !flashed && ent !== null && obs.enemies.length === 0 && this.tooClose(obs, exec, ent)) {
out.walk = true;
out.role = '拉開間距';
}
if (p.kind === 'rush' && ent !== null && !this.rushReady) {
if (this.inRectSite(me.x, me.y, exec) || dist(me.x, me.y, ent.ix, ent.iy) < 900) this.rushReady = true;
else {
out.goal = dist(me.x, me.y, ent.ox, ent.oy) > 2 * UNIT ? { x: ent.ox, y: ent.oy } : { x: ent.ix, y: ent.iy };
return wish;
}
}
if (me.hasBomb) {
const spot = site.plants[0];
out.goal = { x: spot.x, y: spot.y };
out.role = '持彈';
out.task = 'plant';
const cx = Math.floor(me.x / UNIT);
const cy = Math.floor(me.y / UNIT);
const r = site.rect;
const inside = inRect({ x0: r.x0 + 1, y0: r.y0 + 1, x1: r.x1 - 1, y1: r.y1 - 1 }, cx, cy);
const atSpot = dist(me.x, me.y, spot.x, spot.y) < 1500;
const hurry = obs.round.phaseTicksLeft < 20 * this.tps;
if (obs.round.phase === 'live' && inside && (atSpot || hurry) && (!P.plantRequireClear || obs.enemies.length === 0) && me.plantTicks === 0) {
out.cmds.push({ type: 'plant' });
out.objective = true;
}
return wish;
}
const k = this.rank(obs, (id) => id !== this.carrierId(obs));
const holds = this.postSpots(exec, site.cx, site.cy);
const spot = holds.length > 0 ? holds[k % holds.length] : site.plants[0];
if (this.roles.of(me.id) === ENTRY && !this.inRectSite(me.x, me.y, exec) && !this.steppedIn) {
out.goal = { x: site.cx, y: site.cy };
return wish;
}
this.steppedIn = true;
out.goal = { x: spot.x, y: spot.y };
out.hold = spot;
return wish;
}
/**
* @param {Observation} obs @param {SiteId} exec @param {Entrance} ent
*/
tooClose(obs, exec, ent) {
const me = obs.me;
if (this.roles.of(me.id) === ENTRY || this.queueHeld >= P.entryWaitMax * this.tps || this.inRectSite(me.x, me.y, exec)) return false;
const mine = dist(me.x, me.y, ent.ix, ent.iy);
if (mine > P.entryZone * UNIT) return false;
const entry = obs.teammates.find((m) => m.alive && m.id === this.roles.who(ENTRY));
if (entry !== undefined && !this.inRectSite(entry.x, entry.y, exec) && dist(entry.x, entry.y, ent.ix, ent.iy) > mine) return false;
const held = obs.teammates.some((m) => m.alive && !this.inRectSite(m.x, m.y, exec) && dist(m.x, m.y, me.x, me.y) < P.entryGap * UNIT && dist(m.x, m.y, ent.ix, ent.iy) < mine);
if (held) this.queueHeld += this.data.rules.decisionInterval;
return held;
}
/** @param {Entrance} ent */
flashDone(ent) {
return this.flashSpots.some((f) => dist(f.x, f.y, ent.ix, ent.iy) < 12 * UNIT);
}
/** @param {Observation} obs @param {TPlan} p */
groupSize(obs, p) {
const gid = this.groupOf(obs, obs.me.id, p);
return this.alive(obs).filter((m) => this.groupOf(obs, m.id, p) === gid).length;
}
/** @param {Observation} obs @param {TPlan} p @param {Entrance} ent */
leadDist(obs, p, ent) {
const gid = this.groupOf(obs, obs.me.id, p);
let best = Infinity;
for (const m of this.alive(obs)) if (this.groupOf(obs, m.id, p) === gid) best = Math.min(best, dist(m.x, m.y, ent.ox, ent.oy));
return best;
}
/** @param {Observation} obs @param {number} id @param {TPlan} p */
smokerIndex(obs, id, p) {
const gid = this.groupOf(obs, id, p);
const members = this.ids.filter((x) => this.groupOf(obs, x, p) === gid && obs.teammates.every((m) => m.id !== x || m.alive));
for (const r of SMOKE_PREF) {
const who = members.find((x) => this.roles.of(x) === r);
if (who !== undefined) return this.memberIndex(obs, who, p);
}
return -1;
}
/**
* @param {TPlan} p @param {SiteId} exec @returns {{ near: number, main: Entrance, second: Entrance, wait: number } | null}
*/
flankOf(p, exec) {
if (p.kind !== 'default' && p.kind !== 'fake') return null;
const key = `flank${p.site}${exec}${p.r1}${p.r2}`;
const hit = this.flankCache.get(key);
if (hit !== undefined) return hit;
const near = exec === p.site ? 0 : 1;
const main = this.entranceOf(exec, near === 0 ? p.r1 : p.r2);
const farSite = near === 0 ? other(p.site) : p.site;
const farRoute = near === 0 ? p.r2 : p.r1;
const from = this.stageSpots('T', farSite, farRoute)[0];
let out = null;
if (main !== null && from !== undefined) {
let best = Infinity;
for (const e of this.intel.sites[exec].entrances) {
if (e.portal === main.portal) continue;
const d = dijkstra(this.g, [this.g.cellOf(e.ox, e.oy)])[from.cell];
const sc = d + (dist(e.ox, e.oy, main.ox, main.oy) < 10 * UNIT ? 100000 : 0);
if (sc < best) {
best = sc;
out = { near, main, second: e, wait: Math.min(P.flankWait, d / 10 / 4.5) };
}
}
}
this.flankCache.set(key, out);
return out;
}
/** @param {Observation} obs @param {TPlan} p @param {SiteId} exec @param {{ near: number, second: Entrance, wait: number }} f */
flankHold(obs, p, exec, f) {
if (this.flankStart < 0) this.flankStart = obs.tick;
if ((obs.tick - this.flankStart) / this.tps >= f.wait || obs.round.phaseTicksLeft <= P.forceExecLeft * this.tps || this.flankGo) return false;
const far = obs.teammates.filter((m) => m.alive && this.groupOf(obs, m.id, p) !== f.near);
const done = far.length === 0 || far.some((m) => dist(m.x, m.y, f.second.ox, f.second.oy) < P.flankNear * UNIT || this.inRectSite(m.x, m.y, exec));
if (done) this.flankGo = true;
return !done;
}
/** @param {SiteId} s @returns {Route} */
aroundSite(s) {
let r = this.aroundCache.get(s);
if (r === undefined) {
const site = this.intel.sites[s];
const regionSet = new Set(this.intel.map.regions.map((_, i) => i).filter((i) => !site.regions.has(i)));
r = /** @type {Route} */ ({ site: s, team: 'T', regions: [...regionSet], regionSet, portals: [], points: [], length: 0 });
this.aroundCache.set(s, r);
}
return r;
}
/** @param {number} x @param {number} y @param {SiteId} s */
inRectSite(x, y, s) {
return inRect(this.intel.sites[s].rect, Math.floor(x / UNIT), Math.floor(y / UNIT));
}
/**
* @param {Observation} obs @param {SiteId} s
*/
yieldTo(obs, s) {
const me = obs.me;
const c = this.g.cellOf(me.x, me.y);
const cap = this.plan?.kind === 'rush' ? P.yieldMax : P.yieldMaxSplit;
if (c < 0 || this.intel.distSite[s][c] > P.yieldNear * 10 || this.yielded >= cap * this.tps) return false;
const wait = this.waitEntry(obs, s);
if (wait) this.yielded += this.data.rules.decisionInterval;
return wait;
}
/**
* @param {Observation} obs @param {TPlan} p @param {SiteId} s
*/
spawnWait(obs, p, s) {
const me = obs.me;
const e = obs.teammates.find((m) => m.alive && m.id === this.roles.who(ENTRY));
const c = this.g.cellOf(me.x, me.y);
if (e === undefined || c < 0 || this.spawnHeld >= P.spawnLeadMax * this.tps || this.intel.distSpawn.T[c] > P.spawnLead * 10) return false;
if (this.groupOf(obs, e.id, p) !== this.groupOf(obs, me.id, p)) return false;
const ce = this.g.cellOf(e.x, e.y);
const dS = this.intel.distSite[s];
const wait = ce >= 0 && dS[ce] >= dS[c] - 10;
if (wait) this.spawnHeld += this.data.rules.decisionInterval;
return wait;
}
/** @param {Observation} obs @param {TacOut} out @param {Spot} st */
awpSettle(obs, out, st) {
const me = obs.me;
if (this.roles.of(me.id) !== AWP || me.loadout.primary !== 'awp' || dist(me.x, me.y, st.x, st.y) >= 4 * UNIT) return;
out.stop = true;
out.hold = { ...st, x: me.x, y: me.y };
}
/** @param {Observation} obs @param {SiteId} s */
waitEntry(obs, s) {
const me = obs.me;
const role = this.roles.of(me.id);
const dS = this.intel.distSite[s];
const c = this.g.cellOf(me.x, me.y);
if (role === ENTRY || c < 0 || this.inRectSite(me.x, me.y, s)) return false;
const mates = obs.teammates.filter((m) => m.alive);
if (role === AWP) return mates.filter((m) => this.inRectSite(m.x, m.y, s)).length < Math.min(2, mates.length);
const e = mates.find((m) => m.id === this.roles.who(ENTRY));
const ce = e === undefined ? -1 : this.g.cellOf(e.x, e.y);
return e !== undefined && ce >= 0 && !this.inRectSite(e.x, e.y, s) && dS[ce] >= dS[c] - 10;
}
/** @param {SiteId} site @param {number} routeIdx */
entranceOf(site, routeIdx) {
const r = this.tRoute(site, routeIdx);
if (r === null) return null;
const pid = r.portals[r.portals.length - 1];
return this.intel.sites[site].entrances.find((e) => e.portal === pid) ?? null;
}
/**
* @param {SiteId} s @param {Entrance} e
*/
smokePoint(s, e) {
const g = this.g;
let best = null;
let bestS = -Infinity;
if (this.awp !== null && dist(this.awp.x, this.awp.y, e.ix, e.iy) <= 40 * UNIT && g.los(this.awp.x, this.awp.y, e.ix, e.iy)) {
best = { x: this.awp.x, y: this.awp.y };
bestS = Infinity;
}
for (const k of this.perc.known.values()) {
if (k.conf < 50 || dist(k.x, k.y, e.ix, e.iy) > 25 * UNIT || !g.los(k.x, k.y, e.ix, e.iy)) continue;
const sc = 100 + k.conf;
if (sc > bestS) {
bestS = sc;
best = { x: k.x, y: k.y };
}
}
if (best === null) {
for (const hs of this.intel.sites[s].holds) {
const d = dist(hs.x, hs.y, e.ix, e.iy);
if (d > 25 * UNIT || !g.los(hs.x, hs.y, e.ix, e.iy)) continue;
if (d > bestS) {
bestS = d;
best = { x: hs.x, y: hs.y };
}
}
}
if (best === null) return null;
const d = dist(best.x, best.y, e.ix, e.iy);
const f = Math.min(0.6, (P.smokeOff * UNIT) / Math.max(d, 1));
return { x: e.ix + (best.x - e.ix) * f, y: e.iy + (best.y - e.iy) * f };
}
/** @param {SiteId} s @param {Entrance} e @returns {Pt[]} */
smokeSpots(s, e) {
const key = `${s}${e.portal}`;
const hit = this.smokeCache.get(key);
if (hit !== undefined) return hit;
/** @type {Pt[]} */
const out = [];
const holds = this.intel.sites[s].holds.filter((h) => dist(h.x, h.y, e.ix, e.iy) <= 25 * UNIT && this.g.los(h.x, h.y, e.ix, e.iy)).sort((a, b) => dist(b.x, b.y, e.ix, e.iy) - dist(a.x, a.y, e.ix, e.iy) || a.cell - b.cell);
for (const h of holds) {
const f = Math.min(0.6, (P.smokeOff * UNIT) / Math.max(dist(h.x, h.y, e.ix, e.iy), 1));
out.push({ x: e.ix + (h.x - e.ix) * f, y: e.iy + (h.y - e.iy) * f });
}
out.push({ x: e.ix, y: e.iy });
this.smokeCache.set(key, out);
return out;
}
/**
* @param {Observation} obs @param {TPlan} p @param {SiteId} exec @param {Entrance} ent @returns {Pt | null}
*/
smokeTarget(obs, p, exec, ent) {
const me = obs.me;
const gap = P.smokeGap * UNIT;
const rank = this.groupOf(obs, me.id, p) === 0 ? 0 : 1;
const flank = this.flankOf(p, exec);
const mine = this.smokeSpots(exec, ent);
/** @type {Entrance | null} */
let peer = null;
if (p.kind === 'split') peer = this.entranceOf(exec, rank === 0 ? p.r2 : p.r1);
else if (flank !== null) peer = ent.portal === flank.main.portal ? flank.second : flank.main;
const peerSpots = peer !== null ? this.smokeSpots(exec, peer) : [];
/** @type {Pt[]} */
let list;
if (rank === 0) {
const second = peerSpots.find((q) => dist(q.x, q.y, mine[0].x, mine[0].y) >= gap);
const known = this.smokePoint(exec, ent);
list = [...(known !== null ? [known] : []), ...mine].filter((q) => second === undefined || dist(q.x, q.y, second.x, second.y) >= gap);
} else {
const first = peerSpots[0];
list = mine.filter((q) => first === undefined || dist(q.x, q.y, first.x, first.y) >= gap);
}
return list.find((q) => this.smokes.every((m) => dist(m.x, m.y, q.x, q.y) >= gap) && this.util.solve(me.x, me.y, q.x, q.y) !== null) ?? null;
}
/** @param {number} x @param {number} y @param {Pt} c @param {number} depth */
canHide(x, y, c, depth) {
const g = this.g;
const start = g.cellOf(x, y);
if (start < 0) return false;
let frontier = [start];
const seen = new Set(frontier);
for (let d = 0; d <= depth; d++) {
/** @type {number[]} */
const next = [];
for (const i of frontier) {
const q = g.center(i);
if (!g.los(q.x, q.y, c.x, c.y)) return true;
const cx = i % g.W;
const cy = (i - cx) / g.W;
for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
const j = (cy + dy) * g.W + cx + dx;
if (g.isBlock(cx + dx, cy + dy) || seen.has(j)) continue;
seen.add(j);
next.push(j);
}
}
frontier = next;
}
return false;
}
/**
* @param {Pt} p @param {SiteId | null} site
*/
viewer(p, site) {
const R = this.util.flashRadius;
if (this.perc.threats(p.x, p.y, 30).some((k) => dist(k.x, k.y, p.x, p.y) < R && this.g.los(k.x, k.y, p.x, p.y))) return true;
const heard = this.perc.sectors.some((s) => {
if (s.conf < 25 || s.kind === 'hurt') return false;
const r = clamp(dist(s.ox, s.oy, p.x, p.y) / UNIT, s.r0, s.r1) * UNIT;
return dist(s.ox + cosd(s.dir) * r, s.oy + sind(s.dir) * r, p.x, p.y) < R * 0.6;
});
if (heard) return true;
if (site === null) return false;
let far = 0;
for (const k of this.perc.known.values()) if (k.conf >= 30 && dist(k.x, k.y, p.x, p.y) > R * 1.5) far++;
if (far >= this.enemiesAlive) return false;
const t = this.perc.lastTick;
return this.intel.sites[site].holds.some((h) => dist(h.x, h.y, p.x, p.y) < R && !this.perc.cleared(h.cell, t) && this.g.los(h.x, h.y, p.x, p.y));
}
/**
* @param {Observation} obs @param {SiteId} s @param {Entrance} e @param {number} ratio
*/
flashPoint(obs, s, e, ratio) {
const g = this.g;
const site = this.intel.sites[s];
const R = this.util.flashRadius;
const key = `${s}${e.portal}:${this.smokes.length}`;
if (this.flashKey !== key) {
this.flashKey = key;
const t = this.perc.lastTick;
const seers = [...site.holds.filter((h) => !this.perc.cleared(h.cell, t)).map((h) => ({ x: h.x, y: h.y, w: 1 })), ...this.perc.threats(e.ix, e.iy, 30).map((k) => ({ x: k.x, y: k.y, w: 2 }))];
for (const sc of this.perc.sectors) {
if (sc.conf < 25 || sc.kind === 'hurt') continue;
const r = clamp(dist(sc.ox, sc.oy, e.ix, e.iy) / UNIT, sc.r0, sc.r1) * UNIT;
const q = { x: sc.ox + cosd(sc.dir) * r, y: sc.oy + sind(sc.dir) * r };
const qc = g.cellOf(q.x, q.y);
if (qc >= 0 && !g.isWall(qc % g.W, Math.floor(qc / g.W)) && site.regions.has(this.intel.region[qc])) seers.push({ x: q.x, y: q.y, w: 1 });
}
/** @type {{ x: number, y: number, sc: number }[]} */
const list = [];
const cx = Math.floor(e.ix / UNIT);
const cy = Math.floor(e.iy / UNIT);
for (let y = cy - 8; y <= cy + 8; y++) {
for (let x = cx - 8; x <= cx + 8; x++) {
if (g.isWall(x, y)) continue;
const i = y * g.W + x;
if (!site.regions.has(this.intel.region[i])) continue;
const c = g.center(i);
const de = dist(c.x, c.y, e.ix, e.iy);
if (de > 8 * UNIT || de < 1.5 * UNIT) continue;
let sc = 0;
for (const v of seers) {
if (dist(v.x, v.y, c.x, c.y) > R || !g.los(v.x, v.y, c.x, c.y)) continue;
if (this.smokes.some((m) => segDist(m.x, m.y, v.x, v.y, c.x, c.y).d < 3 * UNIT)) continue;
sc += v.w;
}
if (sc > 0) list.push({ x: c.x, y: c.y, sc: sc - de / (20 * UNIT) });
}
}
list.sort((a, b) => b.sc - a.sc);
this.flashList = list.slice(0, 12);
{
const d = Math.max(1, dist(e.ix, e.iy, site.cx, site.cy));
const f = Math.min(1, (4 * UNIT) / d);
const ax = e.ix + (site.cx - e.ix) * f;
const ay = e.iy + (site.cy - e.iy) * f;
/** @type {{ x: number, y: number, sc: number }[]} */
const def = [];
for (let y = cy - 8; y <= cy + 8; y++) {
for (let x = cx - 8; x <= cx + 8; x++) {
if (g.isWall(x, y)) continue;
const i = y * g.W + x;
const c = g.center(i);
const de = dist(c.x, c.y, e.ix, e.iy);
if (!site.regions.has(this.intel.region[i]) || de > 8 * UNIT || de < 2 * UNIT || !g.los(e.ox, e.oy, c.x, c.y)) continue;
def.push({ x: c.x, y: c.y, sc: 1 - dist(c.x, c.y, ax, ay) / (40 * UNIT) });
}
}
def.sort((a, b) => b.sc - a.sc);
this.flashList.push(...def.slice(0, 12));
}
}
const me = obs.me;
const B = this.util.blindRange;
const mates = obs.teammates.filter((m) => m.alive);
let best = null;
let bestS = 0;
let tries = 0;
for (const c of this.flashList) {
if (++tries > 12) break;
if (this.util.solve(me.x, me.y, c.x, c.y) === null) continue;
let cost = 0;
for (const m of mates) {
const d = dist(m.x, m.y, c.x, c.y);
if (d < B && g.los(m.x, m.y, c.x, c.y) && !(ratio < 5 && this.canHide(m.x, m.y, c, 4))) cost += 1 - d / B;
}
const hide = this.nav?.escape(obs, (i) => {
const q = g.center(i);
return dist(q.x, q.y, c.x, c.y) < B && g.los(q.x, q.y, c.x, c.y);
}, 6);
if (hide === null || hide === undefined) cost += 1 - dist(me.x, me.y, c.x, c.y) / B;
const gain = 6 * c.sc * 0.5;
if (gain >= ratio * cost && gain - cost > bestS) {
bestS = gain - cost;
best = c;
}
}
return best;
}
/**
* @param {Observation} obs @param {TacOut} out @param {number} bx @param {number} by @param {SiteId} s
* @returns {ThrowWish | null}
*/
postPlant(obs, out, bx, by, s) {
out.task = 'hold';
const me = obs.me;
const t = obs.tick;
if (!this.postSaid) {
this.postSaid = true;
if (this.util.has(me, 'smoke')) {
this.postSmokers.add(me.id);
out.cmds.push({ type: 'say', text: 'E:smoker' });
}
}
const spots = this.postSpots(s, bx, by, true);
const anchor = this.roles.who(ANCHOR);
const ids = [me.id, ...obs.teammates.filter((m) => m.alive).map((m) => m.id)].sort((a, b) => (a === anchor ? -1 : 0) - (b === anchor ? -1 : 0) || a - b);
const k = Math.max(0, ids.indexOf(me.id));
out.hold = spots.length > 0 ? spots[k % spots.length] : null;
out.goal = out.hold ?? { x: bx, y: by };
out.role = '守包';
out.allowPeek = false;
const escape = this.judge?.evacuation(obs, bx, by);
const left = (obs.bomb.ticksLeft ?? this.data.rules.bombTicks) / this.tps;
if (obs.bomb.state === 'defusing' || (this.perc.lastSound?.kind === 'defuse' && t - this.perc.lastSound.tick < this.tps)) this.defuseAlarm = t + this.data.rules.defuseTicks;
const defusing = obs.enemiesAlive > 0 && this.defuseAlarm > t;
const guard = [...this.alive(obs)].sort((a, b) => dist(a.x, a.y, bx, by) - dist(b.x, b.y, bx, by) || a.id - b.id)[0];
const covered = guard.id !== me.id && dist(guard.x, guard.y, bx, by) < 16 * UNIT && this.g.los(guard.x, guard.y, bx, by);
const cannotStart = left < this.data.rules.defuseKitTicks / this.tps;
if (escape !== undefined && escape !== null && (left <= escape.seconds + 1.5 || cannotStart) && !defusing && (cannotStart || covered || obs.enemiesAlive === 0)) {
out.goal = escape;
out.hold = null;
out.walk = false;
out.escape = true;
out.task = 'save';
out.role = '炸彈撤離';
if (me.scoped) out.cmds.push({ type: 'scope', on: false });
return null;
}
if (escape?.guard !== undefined && escape.guard !== null && !defusing && !covered && left <= escape.seconds + 3) {
out.goal = escape.guard;
out.hold = null;
out.look = { x: bx, y: by };
out.urgent = true;
out.walk = false;
out.role = '撤離前守線';
}
if (obs.enemiesAlive === 0) return null;
if (defusing) {
const kind = this.util.pick(me, ['molotov', 'he']);
if (kind !== null && !this.burns.some((p) => p.until > t && dist(p.x, p.y, bx, by) < 3 * UNIT)) return { kind, x: bx, y: by, why: '燒拆包' };
}
return this.postUtility(obs, bx, by, s);
}
/** @param {Observation} obs @param {number} bx @param {number} by @param {SiteId} s @returns {ThrowWish | null} */
postUtility(obs, bx, by, s) {
const me = obs.me;
const left = (obs.bomb.ticksLeft ?? 0) / this.tps;
if (left < 8 || this.data.rules.bombTicks / this.tps - left < 2 || me.blindTicks > 0) return null;
const enemies = this.perc.threats(me.x, me.y, 40);
const entrances = [...this.intel.sites[s].entrances].sort((a, b) => a.ctDist - b.ctDist || a.portal - b.portal);
const alive = this.ids.filter((id) => this.isAlive(obs, id));
const slot = Math.max(0, alive.indexOf(me.id));
const e = entrances[slot % entrances.length];
if (e === undefined) return null;
const near = enemies.some((p) => dist(p.x, p.y, e.ox, e.oy) < 10 * UNIT);
const target = { x: e.ox, y: e.oy };
const smokers = [...new Set([...this.postSmokers, ...(this.util.has(me, 'smoke') ? [me.id] : [])])].filter((id) => this.isAlive(obs, id)).sort((a, b) => a - b);
/** @type {Entrance[]} */
const entries = [];
for (const q of entrances) if (entries.every((p) => dist(p.ox, p.oy, q.ox, q.oy) >= (P.smokeGap + 2) * UNIT)) entries.push(q);
const smoke = entries[smokers.indexOf(me.id)];
if (smoke !== undefined && (enemies.some((p) => dist(p.x, p.y, smoke.ox, smoke.oy) < 10 * UNIT) || this.data.rules.bombTicks / this.tps - left < 4) && dist(smoke.ox, smoke.oy, bx, by) > 5 * UNIT && this.util.has(me, 'smoke') && obs.enemies.length === 0 && this.smokes.every((p) => dist(p.x, p.y, smoke.ox, smoke.oy) >= P.smokeGap * UNIT) && this.util.solve(me.x, me.y, smoke.ox, smoke.oy) !== null) return { kind: 'smoke', x: smoke.ox, y: smoke.oy, why: '封回防入口' };
const burners = alive.filter((id) => this.roles.of(id) === ANCHOR || this.roles.of(id) === SUPPORT);
const reserve = burners[0] ?? alive[0];
if (near && me.id !== reserve && this.util.has(me, 'molotov') && this.burns.every((p) => p.until <= obs.tick || dist(p.x, p.y, target.x, target.y) >= 6 * UNIT) && this.util.solve(me.x, me.y, target.x, target.y) !== null && !obs.teammates.some((m) => m.alive && dist(m.x, m.y, target.x, target.y) < 4 * UNIT)) return { kind: 'molotov', ...target, why: '燒回防入口' };
return null;
}
/** @param {SiteId} s @param {number} bx @param {number} by */
postSpots(s, bx, by, spread = false) {
const site = this.intel.sites[s];
const holds = site.holds.filter((h) => dist(h.x, h.y, bx, by) < 14 * UNIT).sort((a, b) => (site.entrances[a.entrance]?.ctDist ?? 0) - (site.entrances[b.entrance]?.ctDist ?? 0));
const plants = site.plants.filter((h) => dist(h.x, h.y, bx, by) < 12 * UNIT && dist(h.x, h.y, bx, by) > 1500).map((h) => ({ ...h, fx: bx, fy: by }));
const all = [...holds, ...plants];
if (!spread) return all;
/** @type {typeof all} */
const out = [];
for (const h of all) if (dist(h.x, h.y, bx, by) >= P.postMin * UNIT && out.every((o) => dist(o.x, o.y, h.x, h.y) >= P.postGap * UNIT)) out.push(h);
for (const h of all) if (!out.includes(h)) out.push(h);
return out;
}
/**
* @param {Observation} obs @param {SiteId} site @param {number} idx0
*/
pickRoute(obs, site, idx0) {
const all = this.intel.routes.T[site];
if (all.length === 0) return null;
const idx = this.routeOverride >= 0 ? this.routeOverride : Math.min(idx0, all.length - 1);
const routes = all.slice(0, Math.max(P.routeMax, idx + 1));
const me = obs.me;
const c = this.g.cellOf(me.x, me.y);
if (c >= 0 && !routes[idx].regionSet.has(this.intel.region[c])) return routes.find((r) => r.regionSet.has(this.intel.region[c])) ?? null;
if (c < 0 || this.intel.distSpawn.T[c] / 10 > P.routeSwitchNear) return routes[idx];
/** @param {Route} r */
const risk = (r) => {
let v = 0;
for (const p of r.points) v = Math.max(v, this.perc.danger[this.g.cellOf(p.x, p.y)] ?? 0);
return v;
};
const cur = risk(routes[idx]);
if (cur < P.routeSwitchRisk) return routes[idx];
let best = idx;
for (let i = 0; i < routes.length; i++) if (risk(routes[i]) < risk(routes[best])) best = i;
if (best !== idx && risk(routes[best]) < cur / 2) this.routeOverride = best;
const r = routes[this.routeOverride >= 0 ? this.routeOverride : idx];
return risk(r) >= P.routeSwitchRisk ? null : r;
}
/** @param {Observation} obs */
carrierId(obs) {
if (obs.me.hasBomb) return obs.me.id;
const c = obs.teammates.find((m) => m.alive && m.hasBomb);
return c === undefined ? -1 : c.id;
}
/** @param {Observation} obs @param {(id: number) => boolean} [filter] */
rank(obs, filter = () => true) {
const ids = [obs.me.id, ...obs.teammates.filter((m) => m.alive).map((m) => m.id)].filter(filter).sort((a, b) => a - b);
return Math.max(0, ids.indexOf(obs.me.id));
}
/**
* @param {Observation} obs @param {CTPlan} p @returns {Map<number, { spot: Spot, site: SiteId | null }>}
*/
ctLayout(obs, p) {
const key = `${p.a}${p.m}${p.b}${this.awper}${this.roles.key}`;
if (this.layout !== null && this.layoutKey === key) return this.layout;
/** @type {{ spot: Spot, site: SiteId | null, k: number }[]} */
const pos = [];
const mids = this.midSpots();
let m = p.m;
if (mids.length === 0) m = 0;
const a = p.a + (mids.length === 0 ? Math.ceil(p.m / 2) : 0);
const b = 5 - a - m;
const round = obs.round.number;
this.pickHolds('A', a, round).forEach((spot, k) => pos.push({ spot: this.varySpot(spot, round), site: 'A', k }));
for (let i = 0; i < m; i++) pos.push({ spot: this.varySpot(mids[i % mids.length], round), site: null, k: -1 });
this.pickHolds('B', b, round).forEach((spot, k) => pos.push({ spot: this.varySpot(spot, round), site: 'B', k }));
/** @type {Map<number, { spot: Spot, site: SiteId | null }>} */
const out = new Map();
let ids = [...this.ids];
/** @type {SiteId | null} */
let snSite = null;
if (this.awper >= 0) {
const sn = this.sniperSpot();
if (sn !== null) {
let idx = -1;
for (let i = 0; i < pos.length; i++) if (pos[i].site === sn.site) idx = i;
if (idx < 0) idx = pos.length - 1;
pos.splice(idx, 1);
out.set(this.awper, { spot: sn.spot, site: sn.site });
ids = ids.filter((x) => x !== this.awper);
snSite = sn.site;
}
}
/** @type {Record<number, (q: { site: SiteId | null, k: number }) => number>} */
const pref = {
[ANCHOR]: (q) => (q.site === null ? 9 : q.k === 0 ? (q.site !== snSite ? 0 : 1) : 2 + q.k),
[SUPPORT]: (q) => (q.site === null ? 5 : q.k === 1 ? (q.site !== snSite ? 0 : 1) : q.k >= 2 ? 2 : 4),
[LURK]: (q) => (q.site === null ? 0 : q.k >= 2 ? 1 : q.k === 1 ? 2 : 3),
[ENTRY]: (q) => (q.site === null ? 3 : q.k === 0 ? (q.site === snSite ? 0 : 1) : 2),
};
const free = pos.map(() => true);
const order = [ANCHOR, SUPPORT, LURK, ENTRY].map((r) => this.roles.who(r)).filter((id) => ids.includes(id));
for (const id of [...order, ...ids.filter((x) => !order.includes(x))]) {
const f = pref[this.roles.of(id)] ?? (() => 0);
let best = -1;
for (let i = 0; i < pos.length; i++) if (free[i] && (best < 0 || f(pos[i]) < f(pos[best]))) best = i;
if (best < 0) best = ids.indexOf(id) % Math.max(1, pos.length);
else free[best] = false;
const q = pos[best];
if (q !== undefined) out.set(id, { spot: q.spot, site: q.site });
}
this.layout = out;
this.layoutKey = key;
return out;
}
/** @param {Observation} obs @param {CTPlan} p @param {SiteId} s */
anchorOf(obs, p, s) {
const lay = this.ctLayout(obs, p);
const an = this.roles.who(ANCHOR);
if (an >= 0 && lay.get(an)?.site === s && this.isAlive(obs, an)) return an;
for (const id of this.ids) if (lay.get(id)?.site === s && this.isAlive(obs, id)) return id;
return -1;
}
/** @param {Observation} obs @param {CTPlan} p @param {number} id */
stays(obs, p, id) {
if (p.rot === null) return false;
const site = this.ctLayout(obs, p).get(id)?.site ?? null;
return this.anchorOf(obs, p, other(p.rot)) === id || (this.roles.of(id) === ANCHOR && site !== null);
}
/** @param {Observation} obs @param {number} id */
isAlive(obs, id) {
if (id === obs.me.id) return obs.me.alive;
return obs.teammates.some((m) => m.id === id && m.alive);
}
/**
* @param {Observation} obs @param {TacOut} out
* @returns {ThrowWish | null}
*/
ctGoal(obs, out) {
const me = obs.me;
const b = obs.bomb;
out.task = 'hold';
const p = this.plan !== null && this.plan.kind === 'hold' ? this.plan : this.chooseCT();
if (!this.awperFixed) {
this.awper = me.loadout.primary === 'awp' ? me.id : (obs.teammates.find((m) => m.weapon === 'awp')?.id ?? -1);
this.awperFixed = obs.round.phase === 'live';
}
if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) {
this.lastAttack = b.site;
return this.retake(obs, out, p, b.x, b.y, b.site ?? 'A');
}
if (p.rot !== null) this.lastAttack = p.rot;
const lay = this.ctLayout(obs, p).get(me.id);
if (lay === undefined) return null;
let spot = lay.spot;
out.role = lay.site === null ? '中路' : `守 ${lay.site}`;
if (p.rot !== null && lay.site !== p.rot && !this.stays(obs, p, me.id)) {
const stage = this.stageSpots('CT', p.rot, 0);
const rotators = this.ids.filter((id) => this.isAlive(obs, id) && this.ctLayout(obs, p).get(id)?.site !== p.rot && !this.stays(obs, p, id));
if (stage.length > 0) {
spot = stage[Math.max(0, rotators.indexOf(me.id)) % stage.length];
out.role = `輪轉 ${p.rot}`;
out.task = 'retake';
}
out.allowPeek = false;
if (lay.site === null) {
const stack = this.siteSpots(p.rot, 3)[2];
if (stack !== undefined) {
spot = stack;
out.role = `輪轉疊點 ${p.rot}`;
}
}
}
out.goal = { x: spot.x, y: spot.y };
out.hold = spot;
if (obs.round.phase === 'live' && obs.teammates.every((m) => !m.alive) && obs.enemiesAlive <= 2 && this.attrs.aggression >= P.huntAggr) {
const th = this.perc.threats(me.x, me.y, 30)[0];
if (th !== undefined) {
out.goal = { x: th.x, y: th.y };
out.hold = null;
out.role = '殘局找人';
}
}
const s = lay.site ?? p.rot;
return s === null ? null : this.ctUtility(obs, p, s);
}
/** @param {Observation} obs @param {Pt} c */
mateSees(obs, c) {
return obs.teammates.some((m) => m.alive && dist(m.x, m.y, c.x, c.y) < this.util.blindRange && this.g.los(m.x, m.y, c.x, c.y));
}
/**
* @param {Observation} obs @param {SiteId} s @param {Entrance} e
*/
pressure(obs, s, e) {
const site = this.intel.sites[s];
let n = 0;
let sign = 0;
for (const k of this.perc.known.values()) {
if (k.conf < 50 || obs.tick - k.tick > 2 * this.tps) continue;
if (dist(k.x, k.y, e.ox, e.oy) < P.pressNear * UNIT && !site.regions.has(this.intel.region[this.g.cellOf(k.x, k.y)])) n++;
}
for (const c of this.perc.sectors) {
if (c.conf < 15 || c.kind === 'hurt' || c.kind === 'reload') continue;
const d = dist(c.ox, c.oy, e.ox, e.oy) / UNIT;
if (d >= c.r0 - 2 && d <= c.r1 + 2 && Math.abs(adiff(angleTo(c.ox, c.oy, e.ox, e.oy), c.dir)) <= P.sectorHalfDeg + 5) sign++;
}
for (const q of obs.effects) if (q.kind === 'smoke' && dist(q.x, q.y, e.ox, e.oy) < 8 * UNIT && this.smokes.every((m) => dist(m.x, m.y, q.x, q.y) > 2 * UNIT)) sign++;
return { n, sign };
}
/**
* @param {Observation} obs @param {CTPlan} p @param {SiteId} s @returns {ThrowWish | null}
*/
ctUtility(obs, p, s) {
const me = obs.me;
if (obs.round.phase !== 'live' || me.blindTicks > 0) return null;
let best = null;
let top = { n: 0, sign: 0 };
let bestS = 1;
for (const e of this.intel.sites[s].entrances) {
const q = this.pressure(obs, s, e);
const sc = 2 * q.n + Math.min(2, q.sign);
if (sc > bestS) {
bestS = sc;
best = e;
top = q;
}
}
if (best === null) return null;
const e = best;
const out = { x: e.ox + (e.ox - e.ix) * 0.3, y: e.oy + (e.oy - e.iy) * 0.3 };
const burn = this.util.pick(me, ['incendiary', 'molotov']);
if (burn !== null && top.n >= 2) return { kind: burn, ...out, why: '燒入口' };
if (obs.enemies.length > 0) return null;
if (this.util.has(me, 'flash') && !this.flashDone(e)) {
const th = this.perc.threats(e.ox, e.oy, 50).find((k) => dist(k.x, k.y, e.ox, e.oy) < 10 * UNIT);
for (const c of [...(th !== undefined ? [th] : []), { x: e.ox, y: e.oy }, { x: e.x, y: e.y }]) if (this.util.solve(me.x, me.y, c.x, c.y) !== null && !this.mateSees(obs, c)) return { kind: 'flash', x: c.x, y: c.y, why: '守點閃' };
}
const mine = this.alive(obs).filter((m) => this.ctLayout(obs, p).get(m.id)?.site === s).length;
if (this.util.has(me, 'smoke') && top.n >= Math.max(2, mine) && this.smokes.every((m) => dist(m.x, m.y, e.ox, e.oy) >= P.smokeGap * UNIT) && this.util.solve(me.x, me.y, e.ox, e.oy) !== null) return { kind: 'smoke', x: e.ox, y: e.oy, why: '封入口' };
return null;
}
/**
* @param {Observation} obs @param {TacOut} out @param {CTPlan} p @param {number} bx @param {number} by @param {SiteId} s
* @returns {ThrowWish | null}
*/
retake(obs, out, p, bx, by, s) {
const me = obs.me;
const t = obs.tick;
const b = obs.bomb;
out.task = 'retake';
out.allowPeek = false;
const left = (b.ticksLeft ?? 0) / this.tps;
const myD = dist(me.x, me.y, bx, by);
const team = this.defuseTeam(obs, bx, by);
const pending = team.some((m) => m.id === me.id && m.pending);
const clear = obs.enemiesAlive === 0;
const feasible = team.filter((m) => m.eta <= left).sort((a, c) => (a.cautious > left ? 1 : 0) - (c.cautious > left ? 1 : 0) || a.eta - c.eta || a.id - c.id);
const defuser = feasible.find((m) => m.defusing) ?? feasible[0];
const outnumbered = team.length === 1 && obs.enemiesAlive >= 3 && this.attrs.discipline >= 0.5 && this.attrs.aggression < 0.6 && this.econ.shortOf(me.money + 1400, me.loadout.primary, 'CT') > 0;
if (defuser === undefined || (!defuser.defusing && outnumbered)) {
this.saving = true;
const away = this.saveSpot(obs, bx, by);
if (away !== null) out.goal = away;
out.role = '保槍';
out.task = 'save';
out.escape = true;
out.objective = false;
if (me.scoped) out.cmds.push({ type: 'scope', on: false });
return null;
}
this.saving = false;
if (me.defuseTicks > 0 && defuser.id !== me.id) {
out.objective = false;
out.cmds.push({ type: 'move', x: me.x, y: me.y }); // 明確交接；stop 不會取消引擎拆包。
}
const inside = this.inSite(me.x, me.y, s, bx, by);
const stage = this.stageSpots('CT', s, 0);
const go = p.go || this.plan === null || clear;
if (go && this.goTick < 0) this.goTick = t;
const entry = obs.teammates.find((m) => m.alive && m.id === this.roles.who(ENTRY));
const lead = go && !clear && entry !== undefined && feasible.some((m) => m.id === entry.id) && !this.inSite(entry.x, entry.y, s, bx, by) && t - this.goTick < P.retakeLead * this.tps;
if ((!go || lead) && !inside && stage.length > 0) {
const others = this.ids.filter((id) => this.isAlive(obs, id));
const sp = stage[Math.max(0, others.indexOf(me.id)) % stage.length];
out.goal = { x: sp.x, y: sp.y };
out.hold = sp;
out.role = lead ? '等突破手先進' : '回防集結';
if (dist(me.x, me.y, sp.x, sp.y) < 10 * UNIT) out.walk = true;
return null;
}
/** @type {ThrowWish | null} */
let wish = null;
if (!inside && this.util.has(me, 'flash') && defuser.id !== me.id && t - this.flashHeard > 3 * this.tps) {
const th = this.perc.threats(bx, by, 30).find((k) => dist(k.x, k.y, bx, by) < 12 * UNIT);
const c = th ?? { x: bx, y: by };
if (this.util.solve(me.x, me.y, c.x, c.y) !== null && !this.mateSees(obs, c)) wish = { kind: 'flash', x: c.x, y: c.y, why: '回防閃' };
}
if (wish === null && go && !inside && this.util.has(me, 'smoke') && obs.enemies.length === 0) {
const th = this.perc.threats(bx, by, 40).find((k) => dist(k.x, k.y, bx, by) >= 6 * UNIT && dist(k.x, k.y, bx, by) < 20 * UNIT);
if (th !== undefined && this.smokes.every((m) => dist(m.x, m.y, th.x, th.y) >= P.smokeGap * UNIT) && this.util.solve(me.x, me.y, th.x, th.y) !== null) wish = { kind: 'smoke', x: th.x, y: th.y, why: '回防煙' };
}
if (defuser.id === me.id) {
out.goal = { x: bx, y: by };
out.role = '拆包';
out.task = 'defuse';
if (pending) out.objective = true;
const clear = obs.enemies.length === 0;
if (myD < 1300 && b.state === 'planted' && me.defuseTicks === 0 && clear && !pending) {
out.cmds.push({ type: 'defuse' });
out.objective = true;
}
return wish;
}
const others = this.ids.filter((id) => this.isAlive(obs, id) && id !== defuser.id);
const k = Math.max(0, others.indexOf(me.id));
const all = this.postSpots(s, bx, by);
const away = all.filter((q) => dist(q.x, q.y, bx, by) < 12 * UNIT && Math.abs(adiff(angleTo(q.x, q.y, q.fx, q.fy), angleTo(q.x, q.y, bx, by))) > 70);
const spots = away.length > 0 ? [...away, ...all.filter((q) => !away.includes(q))] : all;
const sp = spots.length > 0 ? spots[k % spots.length] : null;
out.hold = sp;
out.goal = sp ?? { x: bx, y: by };
out.role = '回防掩護';
out.task = 'cover';
return wish;
}
/** @param {Observation} obs @param {number} bx @param {number} by */
saveSpot(obs, bx, by) {
const me = obs.me;
if (dist(me.x, me.y, bx, by) >= P.saveDist * UNIT) return { x: me.x, y: me.y };
const escape = this.judge?.evacuation(obs, bx, by);
if (escape !== undefined && escape !== null) return escape;
if (this.saveCache !== null && dist(this.saveCache.x, this.saveCache.y, bx, by) >= P.saveDist * UNIT) return this.saveCache;
const g = this.g;
const zone = this.intel.map.spawnZones.CT;
const c = this.intel.nearestOpen(Math.floor((zone.x0 + zone.x1) / 2), Math.floor((zone.y0 + zone.y1) / 2));
const z = g.center(c);
const far = dist(z.x, z.y, bx, by) >= P.saveDist * UNIT ? z : null;
this.saveCache = far ?? { x: me.x + (me.x - bx), y: me.y + (me.y - by) };
return this.saveCache;
}
/**
* @param {Observation} obs @param {TacOut} out
*/
overlay(obs, out) {
const me = obs.me;
const t = obs.tick;
if (out.escape) return;
const own = this.util.away !== null && t >= this.util.away.from ? this.util.away : null;
this.mateFlash = this.mateFlash.filter((x) => t <= x.pop + 2);
const edge = P.flashEdge * UNIT;
const mf = this.mateFlash.find((x) => dist(me.x, me.y, x.x, x.y) < this.util.blindRange + edge && this.g.los(me.x, me.y, x.x, x.y));
const f = own !== null ? own : mf !== undefined ? { x: mf.x, y: mf.y, until: mf.pop + 2 } : null;
if (f !== null && t <= f.until && !out.objective) {
const R = this.util.blindRange;
const g = this.g;
const d = dist(me.x, me.y, f.x, f.y);
if (d >= R && d < R + edge && mf !== undefined && g.los(me.x, me.y, f.x, f.y)) {
out.stop = true;
return;
}
if (d < R && g.los(me.x, me.y, f.x, f.y) && me.team === 'T') {
if (this.hideFor !== f.until) {
this.hideFor = f.until;
this.hide = this.nav?.escape(obs, (i) => {
const c = g.center(i);
return dist(c.x, c.y, f.x, f.y) < R && g.los(c.x, c.y, f.x, f.y);
}, 7) ?? null;
}
if (this.hide !== null) {
out.goal = this.hide;
out.hold = null;
out.route = null;
out.allowPeek = false;
out.stop = false;
out.walk = false;
}
out.look = { x: me.x + (me.x - f.x) * 2, y: me.y + (me.y - f.y) * 2 };
out.urgent = true;
out.hard = f.until - t <= this.data.rules.reactionTicks + 12;
return;
}
}
const ownPending = this.util.away !== null && t < this.util.away.until - 3 ? this.util.away : null;
const pending = ownPending ?? this.mateFlash.find((x) => t < x.pop && dist(me.x, me.y, x.x, x.y) < this.util.blindRange + ((x.pop - t) / this.tps) * P.routeSpeed * UNIT);
if (!out.objective && pending !== undefined && this.entersView(obs, pending)) {
out.stop = true;
return;
}
if (this.trade !== null) {
if (t > this.trade.until) this.trade = null;
else if (!out.objective && !out.commit && out.task !== 'execute' && out.task !== 'retake') {
out.look = { x: this.trade.x, y: this.trade.y };
out.stop = true;
return;
}
}
const c = this.combat;
if (c !== null && this.attrs.discipline < 0.5 && !out.objective && !out.commit && out.task !== 'cover' && obs.enemies.length === 0) {
if (this.chase === null && c.lostPos !== null && t - c.lostTick < this.tps / 2 && c.targetId >= 0) {
const hp = 100 - (this.dealt.get(c.targetId) ?? 0);
if (hp <= P.chaseHp && dist(me.x, me.y, c.lostPos.x, c.lostPos.y) < P.chaseRange * UNIT) this.chase = { x: c.lostPos.x, y: c.lostPos.y, until: t + P.chaseTime * this.tps };
}
if (this.chase !== null) {
if (t > this.chase.until) this.chase = null;
else {
out.goal = { x: this.chase.x, y: this.chase.y };
out.hold = null;
out.role += '・追殘血';
}
}
}
}
/**
* @param {Observation} obs @param {Pt} soon @returns {(Pt & { awp: boolean }) | null}
*/
gunLine(obs, soon) {
const me = obs.me;
const g = this.g;
const t = obs.tick;
/** @param {Pt} q */
const opens = (q) => !g.los(me.x, me.y, q.x, q.y) && g.los(soon.x, soon.y, q.x, q.y);
for (let i = this.perc.anon.length - 1; i >= 0; i--) {
const a = this.perc.anon[i];
if (a.src !== 'death' || t - a.tick >= P.lineMemo * this.tps) continue;
if (this.lineDeath !== a.tick) {
this.lineDeath = a.tick;
this.lineHeld = 0;
}
const th = this.perc.threats(a.x, a.y, 30).find((q) => dist(q.x, q.y, a.x, a.y) < 30 * UNIT && g.los(q.x, q.y, a.x, a.y));
if (th !== undefined) {
if (opens(th)) return { x: th.x, y: th.y, awp: false };
} else {
const d = dist(me.x, me.y, a.x, a.y);
if (d > 2 * UNIT && d < P.lineZone * UNIT && dist(soon.x, soon.y, a.x, a.y) < d) return { x: a.x, y: a.y, awp: false };
}
}
const q = this.awp;
return q !== null && t - q.tick < P.awpMemo * this.tps && dist(me.x, me.y, q.x, q.y) < 45 * UNIT && opens(q) ? { x: q.x, y: q.y, awp: true } : null;
}
/**
* @param {Observation} obs @param {TacOut} out @returns {ThrowWish | null}
*/
lineCheck(obs, out) {
const me = obs.me;
if (out.goal === null || out.stop || out.urgent || out.commit || out.objective || out.escape || obs.enemies.length > 0 || obs.round.phase !== 'live' || obs.enemiesAlive === 0) return null;
const bomb = obs.bomb.state === 'planted' || obs.bomb.state === 'defusing';
if (me.team === 'CT' && !bomb) return null;
if (bomb ? (obs.bomb.ticksLeft ?? 0) < 20 * this.tps : obs.round.phaseTicksLeft < 15 * this.tps) return null;
const w = this.nav?.wps[this.nav.wpIdx];
if (w === undefined || dist(me.x, me.y, out.goal.x, out.goal.y) < 2 * UNIT) return null;
const k = Math.min(1, (3 * UNIT) / Math.max(dist(me.x, me.y, w.x, w.y), 1));
const soon = { x: me.x + (w.x - me.x) * k, y: me.y + (w.y - me.y) * k };
const q = this.gunLine(obs, soon);
if (q === null || this.lineHeld >= P.lineHold * this.tps) return null;
if (q.awp && obs.teammates.some((m) => m.alive && dist(m.x, m.y, me.x, me.y) < 3.5 * UNIT)) return null;
if (this.smokes.some((s) => segDist(s.x, s.y, soon.x, soon.y, q.x, q.y).d < 3 * UNIT)) return null;
this.lineHeld += this.data.rules.decisionInterval;
out.stop = true;
out.look = { x: q.x, y: q.y };
out.role += '・等槍線';
const d = Math.max(dist(soon.x, soon.y, q.x, q.y), 1);
const f = Math.min(0.6, (6 * UNIT) / d);
const sm = { x: soon.x + (q.x - soon.x) * f, y: soon.y + (q.y - soon.y) * f };
if (this.util.has(me, 'smoke') && this.util.solve(me.x, me.y, sm.x, sm.y) !== null) return { kind: 'smoke', x: sm.x, y: sm.y, why: '封槍線' };
if (this.util.has(me, 'flash') && d < this.util.flashRadius && this.util.solve(me.x, me.y, q.x, q.y) !== null) return { kind: 'flash', x: q.x, y: q.y, why: '閃槍線' };
return null;
}
/** @param {Observation} obs @param {Pt} c */
entersView(obs, c) {
const me = obs.me;
const w = this.nav?.wps[this.nav.wpIdx];
if (w === undefined) return true;
const k = Math.min(1, (3 * UNIT) / Math.max(dist(me.x, me.y, w.x, w.y), 1));
return this.g.los(me.x + (w.x - me.x) * k, me.y + (w.y - me.y) * k, c.x, c.y);
}
/**
* @param {Observation} obs @returns {ThrowWish | null}
*/
anyNade(obs) {
const me = obs.me;
if (!this.util.has(me, 'he') || obs.round.phase === 'freeze') return null;
const list = [...this.perc.known.values()].filter((k) => k.conf >= 70 && obs.tick - k.tick <= this.tps && Math.abs(k.vx) + Math.abs(k.vy) < 40);
for (const a of list) {
const near = list.filter((k) => dist(k.x, k.y, a.x, a.y) < P.nadeCluster * UNIT);
if (near.length < 2) continue;
const x = near.reduce((s, k) => s + k.x, 0) / near.length;
const y = near.reduce((s, k) => s + k.y, 0) / near.length;
if (dist(me.x, me.y, x, y) < 6 * UNIT) continue;
if (obs.teammates.some((m) => m.alive && dist(m.x, m.y, x, y) < 4 * UNIT)) continue;
return { kind: 'he', x, y, why: '手雷' };
}
return null;
}
/**
* @param {'T' | 'CT'} team @param {SiteId} s @param {number} routeIdx @returns {Spot[]}
*/
stageSpots(team, s, routeIdx) {
const key = `${team}${s}${routeIdx}`;
const hit = this.spotCache.get(key);
if (hit !== undefined) return hit;
const g = this.g;
const intel = this.intel;
const routes = intel.routes[team][s];
const route = routes.length === 0 ? null : routes[Math.min(routeIdx, routes.length - 1)];
const site = intel.sites[s];
/** @type {Spot[]} */
const out = [];
const pid = route?.portals[route.portals.length - 1];
const ent = site.entrances.find((e) => e.portal === pid) ?? (team === 'T' ? site.entrances[0] : [...site.entrances].sort((a, b) => a.ctDist - b.ctDist)[0]);
if (ent === undefined) {
this.spotCache.set(key, out);
return out;
}
const field = intel.distSite[s];
const d0 = field[g.cellOf(ent.ox, ent.oy)];
const want = d0 + P.stageBack * 10;
const prev = route !== null && route.points.length >= 3 ? route.points[route.points.length - 3] : this.spawnCenter(team);
const enemyHolds = team === 'T' ? [...site.holds, ...this.midSpots()] : [];
/** @param {Pt} c */
const seenBy = (c) => {
let n = 0;
for (const hs of enemyHolds) if (dist(hs.x, hs.y, c.x, c.y) < 30 * UNIT && g.los(hs.x, hs.y, c.x, c.y)) n++;
return n;
};
let best = -1;
let bestS = -Infinity;
const R = team === 'T' ? 18 + P.stageRetreatSteps * P.stageRetreat : 18;
const onRoute = (/** @type {number} */ i) => team !== 'T' || route === null || route.regionSet.has(intel.region[i]);
const smokes = team === 'T' ? this.smokeSpots(s, ent) : [];
const cx0 = Math.floor(ent.ox / UNIT);
const cy0 = Math.floor(ent.oy / UNIT);
/** @param {number} target @param {boolean} safe */
const scan = (target, safe) => {
for (let y = cy0 - R; y <= cy0 + R; y++) {
for (let x = cx0 - R; x <= cx0 + R; x++) {
if (g.isBlock(x, y)) continue;
const i = y * g.W + x;
if (site.regions.has(intel.region[i]) || !onRoute(i) || !Number.isFinite(field[i]) || Math.abs(field[i] - target) > 30) continue;
const c = g.center(i);
const seen = seenBy(c);
if (safe && seen > 0) continue;
const reach = smokes.some((q) => this.util.solve(c.x, c.y, q.x, q.y) !== null) ? 6 : 0;
const off = segDist(c.x, c.y, prev.x, prev.y, ent.ox, ent.oy).d / UNIT;
const sc = reach - Math.abs(field[i] - target) / 5 - 1.5 * off - 8 * seen - intel.exposure[i] + (intel.cover[i] !== 0 ? 2 : 0) + (team === 'CT' && g.los(c.x, c.y, ent.x, ent.y) ? 4 : 0);
if (sc > bestS) {
bestS = sc;
best = i;
}
}
}
};
if (team === 'T') for (let k = 0; k <= P.stageRetreatSteps && best < 0; k++) scan(want + k * P.stageRetreat * 10, true);
const safe = best >= 0;
if (best < 0) scan(want, false);
if (best < 0) {
this.spotCache.set(key, out);
return out;
}
/** @type {number[]} */
const queue = [best];
const depth = new Map([[best, 0]]);
for (let q = 0; q < queue.length && out.length < 5; q++) {
const i = queue[q];
const c = g.center(i);
if (field[i] >= d0 + 40 && !site.regions.has(intel.region[i]) && onRoute(i) && (!safe || seenBy(c) === 0) && out.every((o) => dist(o.x, o.y, c.x, c.y) >= P.stageGap * UNIT)) out.push({ x: c.x, y: c.y, cell: i, fx: ent.x, fy: ent.y, score: 0, entrance: site.entrances.indexOf(ent) });
const dd = /** @type {number} */ (depth.get(i));
if (dd >= (safe ? 9 : 4)) continue;
const x = i % g.W;
const y = (i - x) / g.W;
for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
const j = (y + dy) * g.W + x + dx;
if (g.isBlock(x + dx, y + dy) || depth.has(j)) continue;
depth.set(j, dd + 1);
queue.push(j);
}
}
if (team === 'T') {
for (const o of out) {
let i = o.cell;
for (let n = 0; n < 60; n++) {
const x = i % g.W;
const y = (i - x) / g.W;
let next = -1;
for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
if (g.isBlock(x + dx, y + dy)) continue;
const j = (y + dy) * g.W + x + dx;
if (field[j] < field[next < 0 ? i : next]) next = j;
}
if (next < 0) break;
const c = g.center(next);
if (!g.los(o.x, o.y, c.x, c.y)) break;
i = next;
}
const c = g.center(i);
if (dist(c.x, c.y, o.x, o.y) >= 3 * UNIT) {
o.fx = c.x;
o.fy = c.y;
}
}
}
if (team === 'T') out.sort((a, b) => dist(a.x, a.y, ent.ox, ent.oy) - dist(b.x, b.y, ent.ox, ent.oy) || a.cell - b.cell);
this.spotCache.set(key, out);
return out;
}
/** @param {'T' | 'CT'} team */
spawnCenter(team) {
const z = this.intel.map.spawnZones[team];
return this.g.center(this.intel.nearestOpen(Math.floor((z.x0 + z.x1) / 2), Math.floor((z.y0 + z.y1) / 2)));
}
/**
* @returns {Spot[]}
*/
midSpots() {
const hit = this.spotCache.get('mid');
if (hit !== undefined) return hit;
const g = this.g;
const intel = this.intel;
const entrancePortals = new Set([...intel.sites.A.entrances, ...intel.sites.B.entrances].map((e) => e.portal));
/** @type {Map<number, number>} */
const uses = new Map();
for (const s of SITES) for (const r of intel.routes.T[s]) for (const pid of r.portals) uses.set(pid, (uses.get(pid) ?? 0) + 1);
let pick = null;
let pickS = -Infinity;
for (const [pid, n] of uses) {
if (entrancePortals.has(pid)) continue;
const p = intel.portals[pid];
const c = g.cellOf(p.x, p.y);
if (c < 0) continue;
const dA = intel.distSite.A[c] / 10;
const dB = intel.distSite.B[c] / 10;
const ct = intel.distSpawn.CT[c] / 10;
const tt = intel.distSpawn.T[c] / 10;
if (dA < 15 || dB < 15 || ct < 12 || ct + 5 > tt) continue;
const sc = 10 * n - Math.abs(dA - dB) / 5 + (tt - ct) / 10;
if (sc > pickS) {
pickS = sc;
pick = p;
}
}
/** @type {Spot[]} */
const out = [];
if (pick !== null) {
const ctAt = intel.distSpawn.CT[g.cellOf(pick.x, pick.y)];
out.push(...this.watchSpots(pick.x, pick.y, (i) => intel.distSpawn.CT[i] < ctAt, 2, [], -1));
}
this.spotCache.set('mid', out);
return out;
}
/**
* @param {number} px @param {number} py @param {(i: number) => boolean} ok @param {number} n @param {Spot[]} avoid @param {number} entrance
* @returns {Spot[]}
*/
watchSpots(px, py, ok, n, avoid, entrance) {
const g = this.g;
const intel = this.intel;
/** @type {Spot[]} */
const ranked = [];
const R = P.holdMax;
const cx0 = Math.floor(px / UNIT);
const cy0 = Math.floor(py / UNIT);
for (let y = cy0 - R; y <= cy0 + R; y++) {
for (let x = cx0 - R; x <= cx0 + R; x++) {
if (g.isBlock(x, y)) continue;
const i = y * g.W + x;
if (!ok(i)) continue;
const c = g.center(i);
const d = dist(c.x, c.y, px, py) / UNIT;
if (d < P.holdMin || d > P.holdMax || !g.los(c.x, c.y, px, py)) continue;
const sc = 100 - 6 * intel.exposure[i] + ((intel.cover[i] & 1) !== 0 ? 8 : 0) + ((intel.cover[i] & 2) !== 0 ? 6 : 0) - Math.abs(d - 13);
ranked.push({ x: c.x, y: c.y, cell: i, fx: px, fy: py, score: sc, entrance });
}
}
ranked.sort((a, b) => b.score - a.score || a.cell - b.cell);
/** @type {Spot[]} */
const out = [];
for (const s of ranked) {
if (out.length >= n) break;
if ([...out, ...avoid].every((o) => dist(o.x, o.y, s.x, s.y) >= 4 * UNIT)) out.push(s);
}
return out;
}
/**
* @param {SiteId} s @param {number} n @returns {Spot[]}
*/
siteSpots(s, n) {
const key = `site${s}${n}`;
const hit = this.spotCache.get(key);
if (hit !== undefined) return hit;
const site = this.intel.sites[s];
const holds = site.holds;
/** @type {Spot[]} */
let out = holds.slice(0, Math.min(2, n));
if (n > 2 && holds.length > 0) {
const ei = Math.max(0, holds[0].entrance);
const e = site.entrances[ei];
const field = this.intel.distSite[s];
out = [...out, ...this.watchSpots(e.x, e.y, (i) => field[i] <= P.holdSiteRadius * 10, n - out.length, out, ei)];
}
for (let i = 0; out.length < n && holds.length > 0; i++) out.push(holds[i % holds.length]);
this.spotCache.set(key, out);
return out;
}
/**
* @param {SiteId} s @param {number} n @param {number} round @returns {Spot[]}
*/
pickHolds(s, n, round) {
const top = this.intel.sites[s].holds.slice(0, 4);
if (n < 1 || n > 2 || top.length <= n) return this.siteSpots(s, n);
const roll = rollOf(round, s === 'A' ? 1 : 2);
if (n === 1) return [top[roll % Math.min(3, top.length)]];
/** @type {Spot[][]} */
const pairs = [];
for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) if (top[i].entrance !== top[j].entrance || dist(top[i].x, top[i].y, top[j].x, top[j].y) >= 5 * UNIT) pairs.push([top[i], top[j]]);
return pairs.length === 0 ? this.siteSpots(s, n) : pairs[roll % pairs.length];
}
/**
* @param {Spot} spot @param {number} round @returns {Spot}
*/
varySpot(spot, round) {
const key = `vary${spot.cell}`;
let list = this.spotCache.get(key);
if (list === undefined) {
const g = this.g;
list = [spot];
const cx = spot.cell % g.W;
const cy = (spot.cell - cx) / g.W;
for (let y = cy - 3; y <= cy + 3; y++) {
for (let x = cx - 3; x <= cx + 3; x++) {
if (g.isBlock(x, y)) continue;
const i = y * g.W + x;
const c = g.center(i);
const d = dist(c.x, c.y, spot.x, spot.y);
if (d >= 1.5 * UNIT && d <= 3 * UNIT && g.walkLine(spot.x, spot.y, c.x, c.y) && g.los(c.x, c.y, spot.fx, spot.fy) && this.intel.exposure[i] <= this.intel.exposure[spot.cell] + 1) list.push({ ...spot, x: c.x, y: c.y, cell: i });
}
}
this.spotCache.set(key, list);
}
return list[rollOf(round, spot.cell) % list.length];
}
/**
* @returns {{ spot: Spot, site: SiteId, len: number } | null}
*/
sniperSpot() {
if (this.sniper !== undefined) return this.sniper;
const g = this.g;
const intel = this.intel;
/** @type {{ spot: Spot, site: SiteId, len: number } | null} */
let best = null;
let bestS = -Infinity;
for (const s of SITES) {
const site = intel.sites[s];
const field = intel.distSite[s];
for (let i = 0; i < g.N; i++) {
if (g.block[i] === 1 || field[i] > 100) continue;
const c = g.center(i);
let others = 0;
let lenBest = 0;
let ei = -1;
site.entrances.forEach((e, k) => {
const d = dist(c.x, c.y, e.x, e.y) / UNIT;
if (d > 30 || !g.los(c.x, c.y, e.x, e.y)) return;
if (d >= 16 && d <= 28 && d > lenBest) {
if (lenBest > 0) others++;
lenBest = d;
ei = k;
} else others++;
});
if (ei < 0) continue;
const sc = 2 * lenBest - 20 * others - 6 * intel.exposure[i] + ((intel.cover[i] & 1) !== 0 ? 6 : 0);
if (sc > bestS) {
bestS = sc;
const e = site.entrances[ei];
best = { spot: { x: c.x, y: c.y, cell: i, fx: e.x, fy: e.y, score: sc, entrance: ei }, site: s, len: lenBest };
}
}
}
this.sniper = best;
return best;
}
}
class Judgment {
/** @param {Grid} g @param {MapIntel} intel @param {Perception} perc @param {InitData} data */
constructor(g, intel, perc, data) {
this.g = g;
this.intel = intel;
this.perc = perc;
this.rules = data.rules;
this.weapons = data.weapons;
this.posts = [...intel.sites.A.holds, ...intel.sites.B.holds, ...intel.chokes.flatMap((p) => p.covers)].map((p) => ({ x: p.x, y: p.y, cell: p.cell }));
for (let i = 0; i < g.N; i++) {
if (!g.walkable(i) || intel.cover[i] === 0) continue;
const p = g.center(i);
if (this.posts.every((q) => dist(q.x, q.y, p.x, p.y) > 2 * UNIT)) this.posts.push({ ...p, cell: i });
}
/** @type {Map<number, number>} */
this.checked = new Map();
this.focus = -1;
this.since = -1;
this.bombKey = '';
this.bombField = new Float64Array(0);
this.escapeKey = '';
this.escapeField = new Float64Array(0);
/** @type {Map<number, Float64Array>} */
this.fields = new Map();
}
reset() {
this.checked.clear();
this.focus = -1;
this.since = -1;
this.bombKey = '';
this.escapeKey = '';
this.fields.clear();
}
/** @param {number} x @param {number} y */
field(x, y) {
const cell = this.g.cellOf(x, y);
let f = this.fields.get(cell);
if (f === undefined) {
f = dijkstra(this.g, [cell]);
if (this.fields.size >= 4) this.fields.delete(/** @type {number} */ (this.fields.keys().next().value));
this.fields.set(cell, f);
}
return f;
}
/** @param {{ x: number, y: number, weapon?: string }} m @param {number} x @param {number} y */
travel(m, x, y) {
const f = this.field(x, y);
const speed = (this.weapons.find((w) => w.id === m.weapon)?.speed ?? 130) * this.rules.ticksPerSecond;
return Math.max(0, (f[this.g.cellOf(m.x, m.y)] ?? Infinity) / 10 * UNIT - 800) / speed + this.rules.reactionTicks / this.rules.ticksPerSecond;
}
/** @param {Observation} obs @param {number} bx @param {number} by */
retriever(obs, bx, by) {
const key = `${bx},${by}`;
if (key !== this.bombKey) {
this.bombKey = key;
this.bombField = dijkstra(this.g, [this.g.cellOf(bx, by)]);
}
const me = obs.me;
const team = [{ id: me.id, x: me.x, y: me.y, hp: me.hp, firing: me.shots.length > 0 }, ...obs.teammates.filter((m) => m.alive)];
const score = (/** @type {typeof team[number]} */ m) => this.bombField[this.g.cellOf(m.x, m.y)] + (m.firing ? 100 : 0) + (m.hp < 30 ? 30 : 0);
return team.sort((a, b) => score(a) - score(b) || a.id - b.id)[0].id;
}
/** @param {Observation} obs @param {Pt} ahead @returns {{ look: Pt | null, stop: boolean, why: string }} */
approach(obs, ahead) {
const me = obs.me;
const g = this.g;
const out = { look: /** @type {Pt | null} */ (null), stop: false, why: '' };
if (obs.enemiesAlive === 0 || me.blindTicks > 0 || obs.round.phase === 'freeze') return out;
const len = Math.max(1, dist(me.x, me.y, ahead.x, ahead.y));
const k = Math.min(1, 3000 / len);
const next = { x: me.x + (ahead.x - me.x) * k, y: me.y + (ahead.y - me.y) * k };
const deaths = this.perc.anon.filter((p) => p.src === 'death' && obs.tick - p.tick < 4 * this.rules.ticksPerSecond);
const known = this.perc.threats(me.x, me.y, 30);
const candidates = [...known.map((p) => ({ ...p, cell: g.cellOf(p.x, p.y), evidence: true })), ...this.posts.map((p) => ({ ...p, evidence: false }))];
for (const p of this.perc.belief.points) if (p.conf >= 20) candidates.push({ ...p, evidence: true });
let best = -Infinity;
for (const p of candidates) {
const d = dist(me.x, me.y, p.x, p.y);
if (p.cell < 0 || d < UNIT || d > 22 * UNIT || !this.perc.reachable(p.cell, obs.tick, 3)) continue;
if (Math.abs(adiff(angleTo(me.x, me.y, p.x, p.y), angleTo(me.x, me.y, ahead.x, ahead.y))) > 100) continue;
const visible = g.los(me.x, me.y, p.x, p.y);
const opens = !visible && g.los(next.x, next.y, p.x, p.y);
const recentDeath = deaths.some((q) => dist(q.x, q.y, p.x, p.y) < 16 * UNIT && g.los(q.x, q.y, p.x, p.y));
if (!p.evidence && !opens && !recentDeath) continue;
if (!p.evidence && !recentDeath && obs.tick - this.perc.seenTick[p.cell] < this.rules.ticksPerSecond) continue;
if ((this.checked.get(p.cell) ?? -1) > obs.tick && !p.evidence && !recentDeath) continue;
const route = me.team === 'CT' && ['A', 'B'].some((s) => this.intel.routes.T[/** @type {'A' | 'B'} */ (s)].some((r) => r.points.some((q) => dist(q.x, q.y, p.x, p.y) < 4 * UNIT)));
const score = (p.evidence ? 16 : 0) + (recentDeath ? 10 : 0) + (opens ? 8 : 0) + (route ? 3 : 0) - d / UNIT * 0.3;
if (score <= best) continue;
best = score;
out.look = p;
}
if (out.look === null) return out;
const target = out.look;
const cell = g.cellOf(target.x, target.y);
if (cell !== this.focus || deaths.some((p) => p.tick > this.since)) {
this.focus = cell;
this.since = obs.tick;
}
const ready = Math.abs(adiff(me.facing, angleTo(me.x, me.y, out.look.x, out.look.y))) < 16;
const soon = { x: me.x + (ahead.x - me.x) * Math.min(1, 1000 / len), y: me.y + (ahead.y - me.y) * Math.min(1, 1000 / len) };
const exposing = !g.los(me.x, me.y, out.look.x, out.look.y) && g.los(soon.x, soon.y, out.look.x, out.look.y);
const loss = deaths.some((p) => dist(p.x, p.y, next.x, next.y) < 6 * UNIT && g.los(p.x, p.y, target.x, target.y));
const hurry = obs.round.phaseTicksLeft < 12 * this.rules.ticksPerSecond;
out.stop = !ready && (exposing || loss) && obs.tick - this.since < this.rules.ticksPerSecond * (hurry ? 0.25 : 0.65);
out.why = out.stop ? '先架危險角度' : '預瞄前進';
if (ready || !out.stop) this.checked.set(cell, obs.tick + 2 * this.rules.ticksPerSecond);
return out;
}
/** @param {Observation} obs @param {number} bx @param {number} by */
evacuation(obs, bx, by) {
const g = this.g;
const key = `${bx},${by}`;
if (key !== this.escapeKey) {
this.escapeKey = key;
const safe = [];
for (let i = 0; i < g.N; i++) {
if (!g.walkable(i)) continue;
const p = g.center(i);
if (dist(p.x, p.y, bx, by) >= P.saveDist * UNIT) safe.push(i);
}
this.escapeField = dijkstra(g, safe);
}
let i = g.cellOf(obs.me.x, obs.me.y);
const cost = this.escapeField[i];
if (!Number.isFinite(cost)) return null;
/** @type {Pt | null} */
let guard = null;
for (let n = 0; n < g.N && this.escapeField[i] > 0; n++) {
const p = g.center(i);
if (dist(p.x, p.y, bx, by) < 14 * UNIT && g.los(p.x, p.y, bx, by)) guard = p;
const x = i % g.W;
const y = Math.floor(i / g.W);
let next = i;
for (const [dx, dy, c] of DIR8) {
if (g.isBlock(x + dx, y + dy) || (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy)))) continue;
const j = (y + dy) * g.W + x + dx;
if (this.escapeField[j] + c <= this.escapeField[i] + 0.01 && this.escapeField[j] < this.escapeField[next]) next = j;
}
if (next === i) return null;
i = next;
}
const speed = this.rules.ticksPerSecond * (this.weapons.find((w) => w.id === obs.me.weapon)?.speed ?? 130);
return { ...g.center(i), guard, seconds: cost / 10 * UNIT / speed + this.rules.reactionTicks / this.rules.ticksPerSecond + 1 };
}
}
class Mission {
/** @param {InitData} data @param {Judgment} judge */
constructor(data, judge) {
this.rules = data.rules;
this.judge = judge;
this.fireHit = Math.max(0, ...data.grenades.filter((g) => g.id === 'molotov' || g.id === 'incendiary').map((g) => g.damage)) * this.rules.grenadeRules.fireTickInterval / this.rules.ticksPerSecond;
this.key = '';
this.since = -1;
this.changes = 0;
this.critical = false;
this.reason = '';
}
reset() { this.key = ''; this.since = -1; this.changes = 0; this.critical = false; this.reason = ''; }
/**
* @param {Observation} obs @param {TacOut} out
* @param {Combat['fires'] | undefined} fires @param {Navigator | null} nav
*/
avoidFire(obs, out, fires, nav) {
if (fires === undefined || nav === null || (!out.objective && out.task !== 'plant' && out.task !== 'defuse')) return false;
const me = obs.me;
const target = out.objective ? me : out.goal;
if (target === null) return false;
const r = this.rules;
const plant = out.task === 'plant' || (out.objective && me.plantTicks > 0);
const progress = plant ? me.plantTicks : me.defuseTicks;
const work = Math.max(1, (plant ? r.plantTicks : me.loadout.kit ? r.defuseKitTicks : r.defuseTicks) - progress + 1) + (progress > 0 ? 0 : r.reactionTicks + r.decisionInterval);
const arrival = out.objective ? 0 : this.judge.travel(me, target.x, target.y) * r.ticksPerSecond;
const cell = this.judge.g.cellOf(target.x, target.y);
let damage = 0;
for (const f of fires.values()) if (f.cells.includes(cell)) damage += Math.ceil(Math.max(0, Math.min(work, f.until - obs.tick - arrival)) / r.grenadeRules.fireTickInterval) * this.fireHit;
if (damage < me.hp) return false;
const safe = nav.escape(obs, (i) => nav.hazard.has(i), 10);
if (safe === null) return false;
out.cmds = out.cmds.filter((c) => c.type !== 'plant' && c.type !== 'defuse');
out.objective = false;
out.goal = safe;
out.route = null;
out.hold = null;
out.escape = true;
out.task = 'hold';
out.role = plant ? '避火待下包' : '避火待拆包';
return true;
}
/** @param {Observation} obs @param {TacOut} out */
assess(obs, out) {
const r = this.rules;
const me = obs.me;
const b = obs.bomb;
const task = out.task ?? 'hold';
const key = `${task}:${out.goal === null ? '' : this.judge.g.cellOf(out.goal.x, out.goal.y)}`;
if (key !== this.key) { this.key = key; this.since = obs.tick; this.changes++; }
const left = (b.ticksLeft ?? obs.round.phaseTicksLeft) / r.ticksPerSecond;
const travel = out.goal === null || task === 'hold' || task === 'cover' || task === 'execute' ? 0 : this.judge.travel(me, out.goal.x, out.goal.y);
const operation = task === 'defuse' || task === 'retake' ? Math.max(0, (me.loadout.kit ? r.defuseKitTicks : r.defuseTicks) - me.defuseTicks) / r.ticksPerSecond : task === 'plant' || task === 'retrieve' || (task === 'execute' && me.team === 'T') ? Math.max(0, r.plantTicks - me.plantTicks) / r.ticksPerSecond : 0;
const objective = task === 'defuse' || task === 'plant' || task === 'retrieve' || task === 'retake' || (task === 'execute' && me.team === 'T');
this.critical = obs.round.phase !== 'freeze' && (out.escape || task === 'save' || (objective && (obs.enemiesAlive === 0 || left <= travel + operation + 4)));
this.reason = this.critical ? task === 'save' || out.escape ? '撤離優先' : '目標期限優先' : '';
out.commit = this.critical;
if (this.critical) { out.allowPeek = false; out.walk = false; out.stop = false; }
}
}
export default class ShooterBaseline {
constructor() {
/** @type {InitData} */
this.data = /** @type {any} */ (null);
/** @type {Helpers} */
this.h = /** @type {any} */ (null);
/** @type {Grid} */
this.g = /** @type {any} */ (null);
/** @type {MapIntel} */
this.intel = /** @type {any} */ (null);
/** @type {Perception} */
this.perc = /** @type {any} */ (null);
/** @type {Navigator} */
this.nav = /** @type {any} */ (null);
/** @type {Combat} */
this.combat = /** @type {any} */ (null);
/** @type {Tactics} */
this.tactics = /** @type {any} */ (null);
this.round = -1;
this.why = '';
}
/** @returns {Declaration} */
declare() {
return {
name: 'shooter-baseline',
version: '2.5',
style: '基準',
knobs: [
{ key: 'aggression', name: '侵略偏移', description: '加在屬性「侵略」上的偏移（−50～50）：影響探頭方式、撤退門檻、架槍時間', min: -50, max: 50, default: 0, integer: true },
{ key: 'economy', name: '經濟風格', description: '0 標準、1 保守（不半買）、2 積極（差一點也全買、半買門檻低）', min: 0, max: 2, default: 0, integer: true },
{ key: 'awpSlot', name: '狙擊手', description: '隊內序號幾號在錢夠時買狙擊槍（5 = 沒有狙擊手）', min: 0, max: 5, default: 4, integer: true },
{ key: 'ctSplitA', name: 'CT 守 A 人數', description: 'CT 開局守 A 點的人數（B 固定 2 人，其餘守中路）', min: 0, max: 5, default: P.ctSplitA, integer: true },
{ key: 'plan', name: 'T 計畫', description: '0 自動（依經濟與侵略抽）；1 default、2 rush、3 split、4 fake（指揮才有作用）', min: 0, max: 4, default: 0, integer: true },
{ key: 'role', name: '角色', description: '0 自動（依隊內序號）；1 突破手、2 支援、3 錨點、4 狙擊手（錢夠就買狙擊槍）、5 游擊', min: 0, max: 5, default: 0, integer: true },
],
};
}
/**
* @param {InitData} data
* @param {Helpers} helpers
*/
init(data, helpers) {
this.data = data;
this.h = helpers;
initTrig(helpers);
const k = data.knobs;
/** @param {AttributeKey} key */
const at = (key) => clamp((data.attributes?.[key] ?? 50) / 100, 0, 1);
const awpSlot = k.awpSlot ?? 4;
const role = (k.role ?? 0) > 0 ? /** @type {number} */ (k.role) : autoRole(data.slot, awpSlot);
const attrs = {
aim: at('aim'),
offAim: role === AWP ? clamp(at('aim') - P.awpOffAim, 0, 1) : at('aim'),
reaction: at('reaction'),
awareness: at('awareness'),
aggression: clamp(at('aggression') + (k.aggression ?? 0) / 100, 0, 1),
discipline: at('discipline'),
movement: at('movement'),
};
this.attrs = attrs;
this.g = new Grid(data.map);
this.intel = new MapIntel(data.map, this.g);
this.perc = new Perception(this.g, this.intel, data, attrs.awareness);
this.nav = new Navigator(this.g, this.intel, this.perc, attrs, data);
this.judge = new Judgment(this.g, this.intel, this.perc, data);
this.mission = new Mission(data, this.judge);
this.combat = new Combat(this.g, this.intel, this.perc, this.nav, attrs, data, helpers);
this.tactics = new Tactics(this.g, this.intel, this.perc, data, helpers, { awpSlot, role, economy: k.economy ?? 0, ctSplitA: k.ctSplitA ?? P.ctSplitA, plan: k.plan ?? 0 }, attrs);
this.tactics.combat = this.combat;
this.tactics.nav = this.nav;
this.tactics.judge = this.judge;
this.tactics.mission = this.mission;
}
/** @param {Observation} obs */
newRound(obs) {
this.round = obs.round.number;
this.perc.reset();
this.nav.reset();
this.judge?.reset();
this.mission?.reset();
this.combat.reset();
this.tactics.reset(obs);
}
/**
* @param {Observation} obs
* @returns {Command[]}
*/
decide(obs) {
const me = obs.me;
if (obs.round.number !== this.round) this.newRound(obs);
if (!me.alive || obs.round.phase === 'over') return [];
this.perc.update(obs);
if (obs.enemiesAlive === 0) {
this.perc.clearEnemies();
this.combat.clearTargets();
}
this.combat.track(obs);
const ev = this.combat.evade(obs);
const tac = this.tactics.update(obs);
/** @type {Command[]} */
const out = [];
/** @type {Command[]} */
const late = [];
for (const c of tac.cmds) (c.type === 'plant' || c.type === 'defuse' ? late : out).push(c);
if (tac.goal !== null) this.nav.setGoal(tac.goal.x, tac.goal.y, tac.route);
else this.nav.clearGoal();
const holding = tac.hold !== null && dist(me.x, me.y, tac.hold.x, tac.hold.y) < 900;
const fight = this.combat.engage(obs, { holding, objective: tac.objective });
const w = this.combat.weapon(me.weapon);
const speed = (w?.speed ?? 130) * (me.walking ? 0.52 : 1) * (me.crouching ? 0.34 : 1);
const nav = this.nav.step(obs, { allowPeek: tac.allowPeek && !tac.commit && !fight.engaged && ev === null, speed, evading: ev !== null, priority: tac.commit });
const ahead = this.nav.wps[this.nav.wpIdx] ?? tac.goal;
const check = ahead !== null && !fight.engaged && ev === null && !tac.objective && !tac.urgent && !tac.stop && !tac.escape && !tac.commit && dist(me.x, me.y, ahead.x, ahead.y) > 900 ? this.judge?.approach(obs, ahead) : null;
let moving = false;
if (!tac.objective) {
if (ev !== null && ev.move !== null) {
out.push({ type: 'move', x: Math.round(ev.move.x), y: Math.round(ev.move.y) });
moving = true;
} else if (ev !== null) out.push({ type: 'stop' });
else if (tac.escape) {
out.push(...nav.cmds);
moving = nav.moving;
} else if (tac.commit && !fight.engaged) {
out.push(...nav.cmds);
moving = nav.moving;
} else if (fight.move === 'stop') out.push({ type: 'stop' });
else if (fight.move !== null) {
out.push({ type: 'move', x: Math.round(fight.move.x), y: Math.round(fight.move.y) });
moving = true;
} else if (check?.stop || fight.holdNav || (tac.stop && !fight.engaged)) out.push({ type: 'stop' });
else {
out.push(...nav.cmds);
moving = nav.moving;
}
}
const next = this.nav.wps[this.nav.wpIdx + 1] ?? this.nav.wps[this.nav.wpIdx] ?? null;
const aim = ((tac.urgent && !fight.engaged) || tac.hard ? tac.look : null) ?? (fight.engaged ? fight.aim : this.combat.alert(obs, holding) ?? check?.look) ?? fight.aim ?? tac.look ?? this.combat.look(obs, { hold: tac.hold, holding: holding && !moving, navLook: nav.look, ahead: next });
if (aim !== null && (Math.abs(aim.x - me.x) > 50 || Math.abs(aim.y - me.y) > 50)) out.push({ type: 'aim', x: Math.round(aim.x), y: Math.round(aim.y) });
const shoot = (fight.fire || (tac.noise && !fight.engaged)) && !tac.objective && !tac.hard;
out.push({ type: 'fire', on: shoot && this.combat.lineClear(obs, aim === null ? [] : [aim]) });
out.push(...fight.cmds.filter((c) => !(tac.escape || (tac.commit && !fight.engaged)) || c.type !== 'scope' || !c.on));
if (tac.commit && me.scoped && !fight.engaged) out.push({ type: 'scope', on: false });
if (!fight.engaged) out.push(...this.combat.upkeep(obs, holding && !moving));
const crouch = moving ? false : ev !== null ? ev.crouch : (fight.crouch ?? false);
if (crouch !== me.crouching) out.push({ type: 'crouch', on: crouch });
const walk = (tac.walk ?? nav.walk) && !tac.commit && !fight.engaged && ev === null;
if (walk !== me.walking) out.push({ type: 'walk', on: walk });
out.push(...late);
const reason = this.mission?.reason ?? '';
this.why = `${ROLE_NAME[this.tactics.roles.of(me.id)]}・${tac.role}${reason ? `・${reason}` : ''}｜${ev !== null && !tac.objective ? ev.why : fight.why || check?.why || (nav.peeking ? `探頭 ${this.nav.peek?.phase ?? ''}` : nav.moving ? '移動' : '待命')}`;
return out;
}
}
