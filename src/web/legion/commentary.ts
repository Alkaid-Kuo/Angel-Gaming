// 軍團戰自動解說：依引擎事件與局勢產生中文字幕（在 Worker 內執行，只讀取比賽狀態）。
import type { LegionEvent } from '../../legion/api.ts';
import { MODE_NAMES, RULES, TERRAIN_NAMES, TPS, UNITS } from '../../legion/config.ts';
import { terrainAt } from '../../legion/map.ts';
import type { LegionMatch, Regiment } from '../../legion/sim.ts';
import type { Caption, PlayerMeta, RegStatic } from './protocol.ts';

const SEC = TPS;
/** 沒有其他解說時，多久報一次局勢 */
const STATUS_EVERY = 35 * SEC;
/** 正面接戰的解說最短間隔 */
const FRONT_CONTACT_GAP = 10 * SEC;

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

  private readonly regs: readonly RegStatic[];
  private readonly players: readonly PlayerMeta[];

  constructor(regs: readonly RegStatic[], players: readonly PlayerMeta[]) {
    this.regs = regs;
    this.players = players;
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
    this.out.push({ tick, text, ...(big ? { big: true } : {}), ...(at !== undefined ? { x: at.x, y: at.y } : {}) });
    this.lastAny = tick;
  }

  start(m: LegionMatch): void {
    const [a, b] = this.players;
    const army = (p: PlayerMeta): string => {
      const counts = new Map<string, number>();
      for (const r of this.regs) if (r.owner === p.id) counts.set(UNITS[r.kind].name, (counts.get(UNITS[r.kind].name) ?? 0) + 1);
      return [...counts].map(([n, c]) => `${n}×${c}`).join('、');
    };
    this.say(0, `比賽開始！${MODE_NAMES[m.mode]}・${m.map.name}。${a.side}「${a.bot}」對${b.side}「${b.bot}」`, true);
    this.say(0, `${a.side}陣容：${army(a)}（${a.cost} 點）`);
    this.say(0, `${b.side}陣容：${army(b)}（${b.cost} 點）`);
    if (m.mode === 'capture') this.say(0, `佔點模式：地圖上 ${m.flags.length} 面旗，同時控制過半 ${RULES.capture.dominationTicks / SEC} 秒就獲勝；也可以直接殲滅對手`);
    else this.say(0, '殲滅戰：打垮對手全軍（潰散也算），或時間到時比剩餘兵力');
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
        const target = ev.target >= 0 ? this.name(ev.target) : '敵陣';
        if (r === undefined) return;
        if (ev.braced) {
          this.say(t, `${target} 架起長槍，擋下了 ${this.name(r.id)} 的衝鋒！騎兵反被長槍刺傷`, true, r);
          return;
        }
        const flank = ev.flank === 'rear' ? '的背後' : ev.flank === 'side' ? '的側面' : '';
        if (ev.kills === 0) this.say(t, `${this.name(r.id)} 衝鋒撞上 ${target}${flank}，但沒能撞開陣線`, false, r);
        else this.say(t, `${this.name(r.id)} 衝鋒撞進 ${target}${flank}，${ev.kills} 人倒下！`, ev.kills >= 4 || ev.flank !== 'front', r);
        return;
      }
      case 'routed': {
        const r = reg(ev.reg);
        if (r === undefined) return;
        this.routs[r.owner] += 1;
        this.say(t, `${this.name(r.id)} 撐不住了，潰散逃離戰場！`, UNITS[r.kind].cavalry || this.routs[r.owner] === 1, r);
        const left = m.regiments.filter((x) => x.owner === r.owner && !x.destroyed && !x.routed).length;
        if (left > 0 && left <= 2) this.say(t, `${this.players[r.owner].side}只剩 ${left} 團還在戰鬥`);
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
        if (ev.owner < 0) this.say(t, `${f.name}的旗被打成中立`);
        else this.say(t, `${this.players[ev.owner].side}拿下${f.name}的旗`, f.name === '中央淺灘');
        return;
      }
      case 'domination':
        if (ev.started) this.say(t, `${this.players[ev.player].side}控制過半旗點，${RULES.capture.dominationTicks / SEC} 秒倒數開始！`, true);
        else if (!m.over) this.say(t, `${this.players[ev.player].side}的壓制倒數被打斷了！`, true);
        return;
      default:
        return;
    }
  }

  /** 每 tick 結束後呼叫：發現敵軍、時間提醒、局勢 */
  afterTick(m: LegionMatch): void {
    const t = m.tick;
    for (let p = 0; p < this.players.length; p++) {
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
      const s = m.players.map((p) => m.strength(p.id));
      const lead = s[0] === s[1] ? '雙方兵力相當' : `${this.players[s[0] > s[1] ? 0 : 1].side}兵力領先`;
      this.say(t, `剩 1 分鐘！${m.mode === 'capture' ? '時間到先比旗點、再比兵力' : '時間到比剩餘兵力'}，目前${lead}`, true);
    }
    if (this.firstSight.some((x) => x) && t - this.lastAny >= 15 * SEC && t - this.lastStatus >= STATUS_EVERY) {
      this.lastStatus = t;
      const pct = m.players.map((p) => Math.floor(m.strength(p.id) / Math.max(1, p.cost)));
      this.say(t, `局勢：剩餘兵力 ${this.players.map((p, i) => `${p.side} ${pct[i]}%`).join('，')}`);
    }
  }

  end(m: LegionMatch): void {
    const r = m.result();
    const why = r.reason === 'domination' ? '控制過半旗點撐完倒數' : r.reason === 'annihilation' ? '打垮了對手全軍' : '時間到，比較剩餘兵力';
    if (r.winner === null) this.say(m.tick, `比賽結束，平手！（${why}）`, true);
    else this.say(m.tick, `${this.players[r.winner].side}「${this.players[r.winner].bot}」獲勝！${why}`, true);
  }

  take(): Caption[] {
    const out = this.out;
    this.out = [];
    return out;
  }
}
