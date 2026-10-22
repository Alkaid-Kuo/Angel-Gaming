// 自動解說（觀戰與回放）：依比賽狀態與事件產生口語播報與局勢評語。只讀狀態，不影響模擬。
// 文字中的 {P0}、{P1}… 由畫面換成帶隊伍色的選手名稱。
import type { GameEvent } from '../api/types.ts';
import { CONQUEST, DAMAGE_MULTIPLIER, MAP_MODES, RULES, TICKS_PER_SECOND, TILE_SIZE, UNIT_STATS, type BuildingType, type UnitType } from '../config/index.ts';
import type { MatchState } from '../core/state.ts';
import { buildingCenterX, buildingCenterY } from '../core/world.ts';
import { FIGHT_LEVEL, type CombatMeter } from '../view/broadcast.ts';
import type { ScoreRow } from '../view/scoreboard.ts';
import { BUILDING_NAME, RESEARCH_NAME, UNIT_NAME } from './labels.ts';

export interface Comment {
  readonly tick: number;
  readonly text: string;
  /** 重大事件：同時顯示為大字幕 */
  readonly major: boolean;
}

const SEC = TICKS_PER_SECOND;
/** 攻進敵方主基地的判定範圍與最少兵數 */
const PUSH_RADIUS = 18 * TILE_SIZE;
const PUSH_MIN_UNITS = 4;
/** 局勢評語的間隔，以及需要先安靜多久 */
const STATUS_EVERY = 90 * SEC;
const STATUS_QUIET = 15 * SEC;
/** 人口卡住多久才提醒 */
const SUPPLY_BLOCK_TICKS = 20 * SEC;
/** 剩多少 tick 時提醒時限 */
const END_WARNING_TICKS = 120 * SEC;
const COMBAT: readonly UnitType[] = ['spear', 'archer', 'cavalry', 'siege'];

const P = (id: number): string => `{P${id}}`;

interface Fight {
  readonly start: number;
  readonly players: Set<number>;
  readonly place: string;
  /** 交戰期間各選手損失的單位成本 */
  readonly lost: number[];
  /** 交戰開始時各選手數量最多的兵種 */
  readonly main: (UnitType | null)[];
}

export class Commentator {
  private out: Comment[] = [];
  private seen = new Set<number>();
  private barracks: number[] = [];
  private towers: number[] = [];
  private expanded = new Set<string>();
  private eliminated = new Set<number>();
  private minedOut = new Set<number>();
  private capped = new Set<number>();
  private lastSaid = new Map<string, number>();
  private blockedSince: number[] = [];
  private fight: Fight | null = null;
  private lastAny = 0;
  private lastTowerTick = -1;
  private warnedEnd = false;
  /** 搶點模式：控制點名稱（依 id）與上一 tick 的壓制倒數 */
  private pointName = new Map<number, string>();
  private prevDomination: number[] = [];
  private conquest = false;

  /** 開局或回放跳轉後：以目前狀態為起點，已經存在的東西不再播報 */
  prime(s: MatchState): void {
    this.out = [];
    this.seen = new Set(s.buildings.map((b) => b.id));
    this.barracks = s.players.map((p) => s.buildings.filter((b) => b.owner === p.id && b.type === 'barracks').length);
    this.towers = s.players.map((p) => s.buildings.filter((b) => b.owner === p.id && b.type === 'tower').length);
    this.expanded = new Set();
    for (const b of s.buildings) {
      const area = this.areaOf(s, buildingCenterX(b), buildingCenterY(b));
      if (area !== null) this.expanded.add(`${b.owner}:${area}`);
    }
    this.eliminated = new Set(s.players.filter((p) => !p.alive).map((p) => p.id));
    this.minedOut = new Set(s.players.filter((p) => this.mainMinedOut(s, p.id)).map((p) => p.id));
    this.capped = new Set(s.players.filter((p) => p.supplyCap >= RULES.supply.hardCap && p.supplyUsed >= p.supplyCap).map((p) => p.id));
    this.lastSaid = new Map();
    this.blockedSince = s.players.map(() => -1);
    this.fight = null;
    this.lastAny = s.tick;
    this.lastTowerTick = -1;
    this.warnedEnd = s.tick >= s.timeLimitTicks - END_WARNING_TICKS;
    this.conquest = s.ruleset === 'conquest';
    this.prevDomination = s.players.map((p) => p.domination);
    this.pointName = new Map();
    if (this.conquest) {
      // 控制點依建立順序對應非主礦區（見 Match 建構）；中央點最後
      const areas = s.map.areas.filter((a) => a.kind !== 'main');
      s.towers.forEach((t, k) => {
        if (t.center) {
          this.pointName.set(t.id, '中央控制點');
          return;
        }
        const a = areas[k];
        if (a === undefined) return;
        if (a.kind === 'expansion' && a.slot !== null) this.pointName.set(t.id, `${P(this.slotOwner(s, a.slot))} 的分礦點`);
        else {
          const near = [...s.players].sort((x, y) => (x.startX - t.x) ** 2 + (x.startY - t.y) ** 2 - ((y.startX - t.x) ** 2 + (y.startY - t.y) ** 2))[0];
          this.pointName.set(t.id, `${P(near.id)} 附近的富礦點`);
        }
      });
    }
  }

  take(): Comment[] {
    const c = this.out;
    this.out = [];
    return c;
  }

  private say(tick: number, text: string, major = false, key?: string, cooldown = 0): void {
    if (key !== undefined) {
      const last = this.lastSaid.get(key);
      if (last !== undefined && tick - last < cooldown) return;
      this.lastSaid.set(key, tick);
    }
    this.out.push({ tick, text, major });
    this.lastAny = tick;
  }

  // ───────── 事件 ─────────

  onEvent(pid: number, ev: GameEvent): void {
    switch (ev.type) {
      case 'unitDied':
        if (this.fight !== null && this.fight.players.has(pid)) this.fight.lost[pid] += UNIT_STATS[ev.unitType].cost;
        break;
      case 'upgradeComplete':
        this.say(ev.tick, `${P(pid)} 的主堡升到 Lv${ev.level}${ev.level === 2 ? '，可以蓋鍛造所和攻城工坊了' : ''}`);
        break;
      case 'researchComplete':
        this.say(ev.tick, `${P(pid)} 完成${RESEARCH_NAME[ev.research]} Lv${ev.level} 研究，部隊${ev.research === 'weapons' ? '攻擊' : '護甲'}再 +1`);
        break;
      case 'towerChanged':
        if (this.conquest) {
          // 搶點模式：同一點同一 tick 只播一次
          const key = `point-${ev.towerId}-${ev.tick}`;
          if (this.lastSaid.has(key)) break;
          this.lastSaid.set(key, ev.tick);
          const name = this.pointName.get(ev.towerId) ?? '控制點';
          if (ev.owner === null) this.say(ev.tick, `${name}被打成中立`);
          else this.say(ev.tick, `${P(ev.owner)} 拿下${name}`, name === '中央控制點');
          break;
        }
        if (ev.tick === this.lastTowerTick) break;
        this.lastTowerTick = ev.tick;
        if (ev.owner === null) this.say(ev.tick, '瞭望塔失守，現在無人佔領');
        else this.say(ev.tick, `${P(ev.owner)} 佔領了地圖中央的瞭望塔，看得到大片地圖`, true);
        break;
      case 'playerEliminated':
        if (this.eliminated.has(ev.playerId)) break;
        this.eliminated.add(ev.playerId);
        this.say(ev.tick, `${P(ev.playerId)} 被淘汰了！`, true);
        break;
      case 'enemyKilled':
        if (ev.kind !== 'building') break;
        if (ev.entityType === 'base') this.say(ev.tick, `${P(pid)} 摧毀了 ${P(ev.owner)} 的主堡！`, true, `base-${ev.id}`, Number.MAX_SAFE_INTEGER);
        else this.say(ev.tick, `${P(pid)} 拆掉了 ${P(ev.owner)} 的${BUILDING_NAME[ev.entityType as BuildingType]}`, false, `kill-${pid}-${ev.owner}-${ev.entityType}`, 30 * SEC);
        break;
      default:
        break;
    }
  }

  // ───────── 逐 tick ─────────

  update(s: MatchState, meter: CombatMeter, rows: () => ScoreRow[]): void {
    const t = s.tick;
    if (t === 1) {
      const minutes = Math.round(s.timeLimitTicks / SEC / 60);
      if (this.conquest) this.say(t, `比賽開始！搶點模式：地圖上 ${s.towers.length} 個控制點，同時控制超過半數就開始 ${CONQUEST.dominationTicks / SEC} 秒倒數，倒數完獲勝；${minutes} 分鐘內沒分出勝負就比勝利點`);
      else this.say(t, `比賽開始！${MAP_MODES[s.mode].players} 位選手，摧毀對手所有主堡即獲勝；${minutes} 分鐘內沒分出勝負就比資產分數`);
    }
    if (this.conquest) this.trackDomination(s);
    this.newBuildings(s);
    this.trackFight(s, meter);
    if (t % 10 === 0) this.trackPushes(s);
    if (t % 50 === 0) this.trackSupplyAndMines(s);
    if (t >= 60 * SEC && t - this.lastAny >= STATUS_QUIET && t % STATUS_EVERY === 0) {
      if (this.conquest) this.conquestStatus(t, rows());
      else this.status(t, rows());
    }
    if (!this.warnedEnd && t >= s.timeLimitTicks - END_WARNING_TICKS) {
      this.warnedEnd = true;
      if (this.conquest) {
        const alive = rows().filter((r) => r.alive).sort((a, b) => b.vp - a.vp);
        if (alive.length >= 2) this.say(t, `剩 2 分鐘！沒人壓制成功就比勝利點，目前 ${P(alive[0].id)} 領先（${alive[0].vp} 對 ${alive[1].vp}）`, true);
      } else {
        const alive = rows().filter((r) => r.alive).sort((a, b) => b.assets - a.assets);
        if (alive.length >= 2) this.say(t, `剩 2 分鐘！時間到就比資產分數，目前 ${P(alive[0].id)} 領先（${alive[0].assets} 對 ${alive[1].assets}）`, true);
      }
    }
  }

  /** 搶點模式：壓制倒數開始、最後 15 秒、被打斷 */
  private trackDomination(s: MatchState): void {
    const half = Math.floor(s.towers.length / 2) + 1;
    for (const p of s.players) {
      const d = p.domination;
      const prev = this.prevDomination[p.id] ?? 0;
      if (d === 1) this.say(s.tick, `${P(p.id)} 控制過半（${half}/${s.towers.length}），${CONQUEST.dominationTicks / SEC} 秒壓制倒數開始！`, true);
      if (d === CONQUEST.dominationTicks - 15 * SEC) this.say(s.tick, `${P(p.id)} 再撐 15 秒就獲勝！`, true);
      if (d === 0 && prev > 0 && !s.over && p.alive) this.say(s.tick, `${P(p.id)} 的壓制倒數被打斷了（還差 ${Math.ceil((CONQUEST.dominationTicks - prev) / SEC)} 秒）！`, true);
      this.prevDomination[p.id] = d;
    }
  }

  private conquestStatus(t: number, rows: ScoreRow[]): void {
    const alive = rows.filter((r) => r.alive).sort((a, b) => b.pointsHeld - a.pointsHeld || b.vp - a.vp);
    if (alive.length < 2) return;
    this.say(t, `局勢：控制點 ${alive.map((r) => `${P(r.id)} ${r.pointsHeld}`).join('、')}；勝利點 ${alive.map((r) => r.vp).join(' 對 ')}`);
  }

  private newBuildings(s: MatchState): void {
    for (const b of s.buildings) {
      if (this.seen.has(b.id)) continue;
      this.seen.add(b.id);
      const o = b.owner;
      if (b.type === 'barracks') {
        this.barracks[o] += 1;
        if (this.barracks[o] === 1) this.say(s.tick, `${P(o)} 蓋下第一座兵營，準備出兵`);
        else if (this.barracks[o] === 3) this.say(s.tick, `${P(o)} 已經有 3 座兵營，要大量出兵了`);
      } else if (b.type === 'tower') {
        this.towers[o] += 1;
        if (this.towers[o] === 1) this.say(s.tick, `${P(o)} 蓋了第一座防禦塔，加強防守`);
        else if (this.towers[o] % 5 === 0) this.say(s.tick, `${P(o)} 已經蓋了 ${this.towers[o]} 座防禦塔——塔也算進資產分數`);
      } else if (b.type === 'forge') {
        this.say(s.tick, `${P(o)} 蓋了鍛造所，要研究武器和護甲了`);
      } else if (b.type === 'workshop') {
        this.say(s.tick, `${P(o)} 蓋了攻城工坊，攻城車專拆建築`);
      } else if (b.type === 'base' || b.type === 'depot') {
        const area = this.areaOf(s, buildingCenterX(b), buildingCenterY(b));
        const key = `${o}:${area}`;
        if (area === null || area === s.players[o].mainAreaId || this.expanded.has(key)) continue;
        this.expanded.add(key);
        const a = s.map.areas[area];
        const where = a.kind === 'rich' ? '富礦區（每趟 8 礦）' : a.slot !== null && a.slot !== s.players[o].slot ? `${P(this.slotOwner(s, a.slot))} 那一側的分礦` : '分礦';
        this.say(s.tick, `${P(o)} 擴張到${where}，經濟要起飛了`);
      }
    }
  }

  private trackFight(s: MatchState, meter: CombatMeter): void {
    const top = meter.hotspots[0];
    if (this.fight === null) {
      if (meter.level >= FIGHT_LEVEL && top !== undefined && top.players.length >= 2) {
        const players = new Set(top.players);
        const place = this.placeName(s, top.x, top.y);
        this.fight = { start: s.tick, players, place, lost: s.players.map(() => 0), main: s.players.map((p) => this.mainType(s, p.id)) };
        this.say(s.tick, `${[...players].map(P).join(' 與 ')} 在${place}交戰！`, true, 'fight', 10 * SEC);
      }
      return;
    }
    if (top !== undefined) for (const p of top.players) this.fight.players.add(p);
    if (!meter.quiet) return;
    const f = this.fight;
    this.fight = null;
    const ps = [...f.players].filter((p) => f.lost[p] > 0 || s.players[p].alive);
    const total = ps.reduce((a, p) => a + f.lost[p], 0);
    if (total < 100) return;
    if (ps.length === 2) {
      const [a, b] = f.lost[ps[0]] >= f.lost[ps[1]] ? [ps[0], ps[1]] : [ps[1], ps[0]];
      const la = f.lost[a];
      const lb = f.lost[b];
      if (la >= lb * 1.6 && la >= 150) {
        const wa = f.main[b];
        const lt = f.main[a];
        const counter = wa !== null && lt !== null && (DAMAGE_MULTIPLIER[wa][lt] ?? 100) > 100 ? `——${UNIT_NAME[wa]}剋${UNIT_NAME[lt]}` : '';
        this.say(s.tick, `交戰結束：${P(a)} 損失 ${la} 礦的單位，${P(b)} 只損失 ${lb}，${P(b)} 佔上風${counter}`);
      } else {
        this.say(s.tick, `交戰結束：雙方損失相當（${P(a)} ${la}、${P(b)} ${lb} 礦），勢均力敵`);
      }
    } else {
      this.say(s.tick, `混戰結束：${ps.sort((x, y) => f.lost[y] - f.lost[x]).map((p) => `${P(p)} 損失 ${f.lost[p]}`).join('、')}`);
    }
  }

  private trackPushes(s: MatchState): void {
    for (const p of s.players) {
      if (!p.alive) continue;
      for (const q of s.players) {
        if (q.id === p.id || !q.alive) continue;
        const units = s.units.filter((u) => u.owner === p.id && (COMBAT as readonly string[]).includes(u.type) && (u.x - q.startX) ** 2 + (u.y - q.startY) ** 2 <= PUSH_RADIUS ** 2);
        if (units.length < PUSH_MIN_UNITS) continue;
        const counts = new Map<UnitType, number>();
        for (const u of units) counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
        const comp = [...counts.entries()].map(([type, n]) => `${UNIT_NAME[type]} ${n}`).join('、');
        this.say(s.tick, `${P(p.id)} 帶著 ${units.length} 隻兵（${comp}）殺進 ${P(q.id)} 的主基地！`, true, `push-${p.id}-${q.id}`, 90 * SEC);
      }
    }
  }

  private trackSupplyAndMines(s: MatchState): void {
    for (const p of s.players) {
      if (!p.alive) continue;
      if (p.supplyUsed >= p.supplyCap && p.supplyCap < RULES.supply.hardCap) {
        if (this.blockedSince[p.id] < 0) this.blockedSince[p.id] = s.tick;
        else if (s.tick - this.blockedSince[p.id] >= SUPPLY_BLOCK_TICKS) this.say(s.tick, `${P(p.id)} 人口卡在 ${p.supplyCap}，要蓋補給站才能繼續生產`, false, `supply-${p.id}`, 120 * SEC);
      } else {
        this.blockedSince[p.id] = -1;
      }
      if (!this.capped.has(p.id) && p.supplyCap >= RULES.supply.hardCap && p.supplyUsed >= p.supplyCap) {
        this.capped.add(p.id);
        this.say(s.tick, `${P(p.id)} 人口達到上限 ${RULES.supply.hardCap}，多的礦只能拿去蓋建築或研究`);
      }
      if (!this.minedOut.has(p.id) && this.mainMinedOut(s, p.id)) {
        this.minedOut.add(p.id);
        this.say(s.tick, `${P(p.id)} 的主礦採光了，接下來要靠分礦`);
      }
    }
  }

  private status(t: number, rows: ScoreRow[]): void {
    const alive = rows.filter((r) => r.alive);
    if (alive.length < 2) return;
    const byIncome = [...alive].sort((a, b) => b.incomePerMin - a.incomePerMin || b.workers - a.workers);
    const byArmy = [...alive].sort((a, b) => b.army - a.army);
    const [e1, e2] = byIncome;
    const [a1, a2] = byArmy;
    // 差距夠大才說誰領先
    const econLead = e1.incomePerMin >= e2.incomePerMin * 1.15 && e1.incomePerMin - e2.incomePerMin >= 50;
    const armyLead = a1.army >= a2.army * 1.25 && a1.army - a2.army >= 100;
    const two = alive.length === 2;
    const econ = econLead
      ? `${P(e1.id)} 經濟${two ? '較好' : '最好'}（收入每分鐘 ${e1.incomePerMin}${two ? ` 對 ${e2.incomePerMin}` : ''}）`
      : `經濟差不多（收入每分鐘 ${byIncome.map((r) => r.incomePerMin).join('、')}）`;
    const army = a1.army === 0 ? (two ? '雙方都還沒出兵' : '大家都還沒出兵') : armyLead ? `${P(a1.id)} 兵力${two ? '較多' : '最多'}（${a1.army}${two ? ` 對 ${a2.army}` : ''}）` : '兵力相當';
    this.say(t, `局勢：${econ}；${army}`);
  }

  // ───────── 輔助 ─────────

  /** 最近的礦區（8 格內），沒有則 null */
  private areaOf(s: MatchState, x: number, y: number): number | null {
    let best: number | null = null;
    let bestD = (8 * TILE_SIZE) ** 2;
    for (const n of s.nodes) {
      const d = ((n.tileX + 0.5) * TILE_SIZE - x) ** 2 + ((n.tileY + 0.5) * TILE_SIZE - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = n.areaId;
      }
    }
    return best;
  }

  private slotOwner(s: MatchState, slot: number): number {
    return s.players.find((p) => p.slot === slot)?.id ?? 0;
  }

  private placeName(s: MatchState, x: number, y: number): string {
    if (this.conquest) {
      let best: string | null = null;
      let bestD = (7 * TILE_SIZE) ** 2;
      for (const t of s.towers) {
        const d = (t.x - x) ** 2 + (t.y - y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = this.pointName.get(t.id) ?? null;
        }
      }
      if (best !== null) return best;
    }
    for (const p of s.players) if ((p.startX - x) ** 2 + (p.startY - y) ** 2 <= (16 * TILE_SIZE) ** 2) return `${P(p.id)} 的主基地`;
    const area = this.areaOf(s, x, y);
    if (area !== null) {
      const a = s.map.areas[area];
      if (a.kind === 'rich') return '富礦區';
      if (a.kind === 'expansion' && a.slot !== null) return `${P(this.slotOwner(s, a.slot))} 的分礦`;
    }
    const cx = (s.width * TILE_SIZE) / 2;
    const cy = (s.height * TILE_SIZE) / 2;
    if ((cx - x) ** 2 + (cy - y) ** 2 <= (12 * TILE_SIZE) ** 2) return '地圖中央';
    return '野外';
  }

  private mainType(s: MatchState, pid: number): UnitType | null {
    const counts = new Map<UnitType, number>();
    for (const u of s.units) if (u.owner === pid && (COMBAT as readonly string[]).includes(u.type)) counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
    let best: UnitType | null = null;
    let n = 0;
    for (const [t, c] of counts) if (c > n) [best, n] = [t, c];
    return best;
  }

  private mainMinedOut(s: MatchState, pid: number): boolean {
    const nodes = s.nodes.filter((n) => n.areaId === s.players[pid].mainAreaId);
    return nodes.length > 0 && nodes.every((n) => n.reserve <= 0);
  }
}
