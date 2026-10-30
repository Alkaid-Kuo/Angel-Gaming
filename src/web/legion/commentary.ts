// 軍團戰自動解說：依引擎事件與局勢產生中文字幕（在 Worker 內執行，只讀取比賽狀態）。
import type { LegionEvent } from '../../legion/api.ts';
import { MODE_NAMES, RULES, TERRAIN_NAMES, TPS, UNITS, type DashKind } from '../../legion/config.ts';
import { terrainAt } from '../../legion/map.ts';
import type { LegionMatch, Regiment } from '../../legion/sim.ts';
import type { Caption, PlayerMeta, RegStatic } from './protocol.ts';

const SEC = TPS;
/** 沒有其他解說時，多久報一次局勢 */
const STATUS_EVERY = 35 * SEC;
/** 正面接戰的解說最短間隔 */
const FRONT_CONTACT_GAP = 10 * SEC;
/** 同一種招牌技能的解說最短間隔 */
const SKILL_GAP = 12 * SEC;
/** 同一面旗「開始佔領／遭到攻擊」的解說最短間隔 */
const FLAG_GAP = 15 * SEC;
const DASH_NAME: Readonly<Record<DashKind, string>> = { charge: '衝鋒', assault: '突擊', infiltrate: '切入' };

export class LegionCommentator {
  private out: Caption[] = [];
  private lastAny = 0;
  private lastStatus = 0;
  private lastFront = -1000;
  private firstContact = false;
  private firstSight: boolean[] = [];
  private seenCav: Set<number>[] = [];
  private warned = false;
  private routs: number[] = [];
  private lastSkill = new Map<string, number>();
  private flagPrev: { capturer: number; contested: boolean; said: number }[] = [];
  private scoreSaid = new Set<number>();

  private readonly regs: readonly RegStatic[];
  private readonly players: readonly PlayerMeta[];
  /** 玩家指揮時是哪一方（-1 = 觀戰）：只講這一方看得到的事 */
  private readonly viewer: number;
  private match: LegionMatch | null = null;

  constructor(regs: readonly RegStatic[], players: readonly PlayerMeta[], viewer = -1) {
    this.regs = regs;
    this.players = players;
    this.viewer = viewer;
    this.firstSight = players.map(() => false);
    this.seenCav = players.map(() => new Set<number>());
    this.routs = players.map(() => 0);
  }

  private name(id: number): string {
    const r = this.regs[id];
    return r === undefined ? '某團' : `${this.players[r.owner].side}${r.name}`;
  }

  private place(m: LegionMatch, x: number, y: number): string {
    let best = '';
    let bestD = 13000 * 13000;
    for (const l of m.map.landmarks) {
      const d = (l.x - x) * (l.x - x) + (l.y - y) * (l.y - y);
      if (d < bestD) {
        bestD = d;
        best = l.name;
      }
    }
    if (best !== '') return best;
    const t = terrainAt(m.map, x, y);
    const side = x < (m.map.width * 1000) / 2 ? '河西' : '河東';
    return `${side}的${TERRAIN_NAMES[t]}`;
  }

  private say(tick: number, text: string, big = false, at?: Regiment): void {
    // 玩家指揮：看不到的敵軍不播報
    const v = this.viewer;
    if (v >= 0 && at !== undefined && at.owner !== v && this.match !== null && this.match.visible[v][at.id] !== 1) return;
    this.out.push({ tick, text, ...(big ? { big: true } : {}), ...(at !== undefined ? { x: at.x, y: at.y } : {}) });
    this.lastAny = tick;
  }

  start(m: LegionMatch): void {
    this.match = m;
    const [a, b] = this.players;
    const army = (p: PlayerMeta): string => {
      const counts = new Map<string, number>();
      for (const r of this.regs) if (r.owner === p.id) counts.set(UNITS[r.kind].name, (counts.get(UNITS[r.kind].name) ?? 0) + 1);
      return [...counts].map(([n, c]) => `${n}×${c}`).join('、');
    };
    this.say(0, `比賽開始！${MODE_NAMES[m.mode]}・${m.map.name}。${a.side}「${a.bot}」對${b.side}「${b.bot}」`, true);
    for (const p of [a, b]) if (this.viewer < 0 || p.id === this.viewer) this.say(0, `${p.side}陣容：${army(p)}（${p.cost} 點）`);
    if (m.mode === 'capture') this.say(0, `佔點模式：${m.flags.map((f) => `${f.name}（每秒 ${f.points} 分）`).join('、')}三面旗，佔領後每秒得分，先到 ${RULES.capture.scoreTarget} 分獲勝；也可以直接殲滅對手`);
    else this.say(0, '殲滅戰：打光對手全軍，或時間到時比剩餘兵力');
  }

  onEvent(m: LegionMatch, ev: LegionEvent): void {
    const t = ev.tick;
    const reg = (id: number): Regiment | undefined => m.regiments[id];
    switch (ev.type) {
      case 'contact': {
        const a = reg(ev.a);
        const b = reg(ev.b);
        if (a === undefined || b === undefined) return;
        if (!this.firstContact) {
          this.firstContact = true;
          this.say(t, `雙方第一次短兵相接！${this.name(a.id)} 與 ${this.name(b.id)} 在${this.place(m, a.x, a.y)}交鋒`, true, a);
          return;
        }
        if (ev.flank !== 'front') {
          this.say(t, `${this.name(a.id)} 從${ev.flank === 'rear' ? '背後' : '側面'}殺進 ${this.name(b.id)}！${ev.flank === 'rear' ? '背擊傷害兩倍' : '側擊傷害 1.5 倍'}`, ev.flank === 'rear', a);
          return;
        }
        if (t - this.lastFront >= FRONT_CONTACT_GAP) {
          this.lastFront = t;
          this.say(t, `${this.name(a.id)} 與 ${this.name(b.id)} 正面接戰`, false, a);
        }
        return;
      }
      case 'ambush': {
        const r = reg(ev.reg);
        if (r === undefined) return;
        this.say(t, `埋伏！${this.name(r.id)} 從${this.place(m, r.x, r.y)}殺出，對手來不及反應！`, true, r);
        return;
      }
      case 'impact': {
        const r = reg(ev.reg);
        if (r === undefined || ev.target < 0) return;
        const target = this.name(ev.target);
        const dash = DASH_NAME[ev.kind];
        if (ev.braced) {
          const by = reg(ev.target)?.kind === 'shield' ? '盾牆' : '槍林';
          this.say(t, `${target} 的${by}擋下了 ${this.name(r.id)} 的${dash}！`, ev.kind === 'charge', r);
          return;
        }
        const flank = ev.flank === 'rear' ? '的背後' : ev.flank === 'side' ? '的側面' : '';
        if (ev.kind === 'infiltrate') {
          this.say(t, `${this.name(r.id)} 切入 ${target}${flank}，攪亂陣形！`, false, r);
          return;
        }
        const hit = [ev.kills > 0 ? `${ev.kills} 人陣亡` : '', ev.downed > 0 ? `${ev.downed} 人被撞倒` : ''].filter((x) => x !== '').join('、');
        if (hit === '') this.say(t, `${this.name(r.id)} ${dash}撞上 ${target}${flank}，但沒能撞開陣線`, false, r);
        else this.say(t, `${this.name(r.id)} ${dash}撞進 ${target}${flank}，${hit}！`, ev.kills >= 4 || ev.flank !== 'front', r);
        return;
      }
      case 'enter':
      case 'withdraw': {
        const r = reg(ev.reg);
        if (r === undefined) return;
        const key = `${r.owner}:${ev.type}`;
        if (t - (this.lastSkill.get(key) ?? -SKILL_GAP) < SKILL_GAP) return;
        this.lastSkill.set(key, t);
        const where = ev.at < 0 ? '出生點' : '補給站';
        this.say(t, ev.type === 'enter' ? `${this.name(r.id)} 從${where}入場` : `${this.name(r.id)} 在${where}撤回後備休整`, false, r);
        return;
      }
      case 'skill': {
        const r = reg(ev.reg);
        if (r === undefined) return;
        const key = `${r.owner}:${ev.skill}`;
        if (t - (this.lastSkill.get(key) ?? -SKILL_GAP) < SKILL_GAP) return;
        const where = this.place(m, r.x, r.y);
        let text = '';
        if (ev.skill === 'volley' && r.volley !== null) text = `${this.name(r.id)} 對${this.place(m, r.volley.x, r.volley.y)}齊射！`;
        else if (ev.skill === 'charge') text = `${this.name(r.id)} 在${where}發起衝鋒！`;
        else if (ev.skill === 'assault') text = `${this.name(r.id)} 發動突擊！`;
        else if (ev.skill === 'wall') text = `${this.name(r.id)} 在${where}架起盾牆`;
        if (text === '') return;
        this.lastSkill.set(key, t);
        this.say(t, text, false, r);
        return;
      }
      case 'routed': {
        const r = reg(ev.reg);
        if (r === undefined) return;
        this.routs[r.owner] += 1;
        this.say(t, `${this.name(r.id)} 撐不住了，潰散逃離戰場！`, UNITS[r.kind].cavalry || this.routs[r.owner] === 1, r);
        const left = m.regiments.filter((x) => x.owner === r.owner && !x.destroyed && !x.routed).length;
        if (left > 0 && left <= 2 && (this.viewer < 0 || r.owner === this.viewer)) this.say(t, `${this.players[r.owner].side}只剩 ${left} 團還在戰鬥`);
        return;
      }
      case 'levelUp': {
        const r = reg(ev.reg);
        if (r === undefined) return;
        this.say(t, `${this.name(r.id)} 升為 ${ev.level} 級老兵（攻擊與血量 +${RULES.veteran.levels[ev.level - 1].attack - 100}%）`, false, r);
        return;
      }
      case 'flag': {
        const f = m.flags[ev.flag];
        const held = m.flags.filter((x) => x.owner === ev.owner).length;
        this.say(t, `${this.players[ev.owner].side}佔領了${f.name}！每秒 +${f.points} 分（目前握有 ${held} 面旗）`, f.points > 1 || held >= 2);
        return;
      }
      default:
        return;
    }
  }

  /** 佔點：開始佔領、旗點遭到攻擊、分數接近目標 */
  private watchFlags(m: LegionMatch): void {
    const t = m.tick;
    m.flags.forEach((f, i) => {
      const prev = this.flagPrev[i] ?? { capturer: -1, contested: false, said: -FLAG_GAP };
      const quiet = t - prev.said >= FLAG_GAP;
      if (f.capturer >= 0 && f.capturer !== prev.capturer && quiet) {
        prev.said = t;
        const by = f.owner >= 0 ? `，要從${this.players[f.owner].side}手上奪走` : '';
        this.say(t, `${this.players[f.capturer].side}開始佔領${f.name}${by}`, false);
      }
      if (f.contested && !prev.contested && f.owner >= 0 && quiet) {
        prev.said = t;
        this.say(t, `${this.players[f.owner].side}的${f.name}遭到攻擊，暫停得分`, false);
      }
      this.flagPrev[i] = { capturer: f.capturer, contested: f.contested, said: prev.said };
    });
    for (const p of m.players) {
      const sc = m.scoreOf(p.id);
      const goal = RULES.capture.scoreTarget;
      for (const pct of [50, 75, 90]) {
        const key = p.id * 1000 + pct;
        if (sc * 100 >= goal * pct && !this.scoreSaid.has(key)) {
          this.scoreSaid.add(key);
          const other = m.scoreOf(1 - p.id);
          this.say(t, `${this.players[p.id].side}拿到 ${sc} 分（對手 ${other} 分），再 ${goal - sc} 分就獲勝！`, pct >= 75);
        }
      }
    }
  }

  /** 每 tick 結束後呼叫：發現敵軍、時間提醒、局勢 */
  afterTick(m: LegionMatch): void {
    const t = m.tick;
    if (m.mode === 'capture') this.watchFlags(m);
    for (let p = 0; p < this.players.length; p++) {
      if (this.viewer >= 0 && p !== this.viewer) continue;
      const vis = m.visible[p];
      for (const r of m.regiments) {
        if (r.owner === p || r.destroyed || vis[r.id] !== 1) continue;
        if (!this.firstSight[p]) {
          this.firstSight[p] = true;
          this.say(t, `${this.players[p].side}第一次發現敵軍：${this.name(r.id)}，在${this.place(m, r.x, r.y)}`, false, r);
        } else if (UNITS[r.kind].cavalry && !this.seenCav[p].has(r.id)) {
          this.seenCav[p].add(r.id);
          this.say(t, `${this.players[p].side}發現 ${this.name(r.id)} 出現在${this.place(m, r.x, r.y)}`, false, r);
        }
      }
    }
    if (!this.warned && m.timeLimitTicks - t === 60 * SEC) {
      this.warned = true;
      const s = m.mode === 'capture' ? m.players.map((p) => m.scoreOf(p.id)) : m.players.map((p) => m.strength(p.id));
      const what = m.mode === 'capture' ? '分數' : '兵力';
      const lead = s[0] === s[1] ? `雙方${what}相當` : `${this.players[s[0] > s[1] ? 0 : 1].side}${what}領先`;
      this.say(t, `剩 1 分鐘！${m.mode === 'capture' ? '時間到先比分數、再比兵力' : '時間到比剩餘兵力'}，目前${lead}`, true);
    }
    if (this.firstSight.some((x) => x) && t - this.lastAny >= 15 * SEC && t - this.lastStatus >= STATUS_EVERY) {
      this.lastStatus = t;
      const pct = m.players.map((p) => Math.floor(m.strength(p.id) / Math.max(1, p.cost)));
      const score = m.mode === 'capture' ? `；分數 ${this.players.map((p) => `${p.side} ${m.scoreOf(p.id)}`).join('，')}` : '';
      this.say(t, `局勢：剩餘兵力 ${this.players.map((p, i) => `${p.side} ${pct[i]}%`).join('，')}${score}`);
    }
  }

  end(m: LegionMatch): void {
    const r = m.result();
    const why = r.reason === 'score' ? `先拿到 ${RULES.capture.scoreTarget} 分（${r.score[0]}：${r.score[1]}）` : r.reason === 'annihilation' ? '打垮了對手全軍' : m.mode === 'capture' ? '時間到，比較分數' : '時間到，比較剩餘兵力';
    if (r.winner === null) this.say(m.tick, `比賽結束，平手！（${why}）`, true);
    else this.say(m.tick, `${this.players[r.winner].side}「${this.players[r.winner].bot}」獲勝！${why}`, true);
  }

  take(): Caption[] {
    const out = this.out;
    this.out = [];
    return out;
  }
}
