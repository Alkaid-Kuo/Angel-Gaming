// M5 第三批：比賽個人統計。
// 1. 對帳：3 張請求單，閘道的統計等於「拿錄下的回放逐 tick 重跑、只看引擎公開狀態（存活、擊殺數、炸彈）」重算的值；傷害用上下界對帳。
// 2. 總和：擊殺和＝死亡和扣掉隊殺、自殺、炸彈；有敵殺的回合首殺恰一個；下包數＝有下包的回合數。
// 3. 經營層：賽季累計、戰術紀錄、已知層（對手個人統計公開、對手戰術紀錄隱藏）、第 6 → 7 版遷移、一季存檔增加量。
// 4. 評分與 MVP。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SHOOTER_TACTICS } from '../src/manage/content-shooter.ts';
import { STUB_CONTENT, type ContentPack } from '../src/manage/content.ts';
import { advance, newGame } from '../src/manage/game.ts';
import type { BattleGateway, MatchOutcome, MatchRequest, PlayerStat, SideSpec } from '../src/manage/gateway.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { deserialize, serialize } from '../src/manage/save.ts';
import { mvpIndex, ratingOf } from '../src/manage/stats.ts';
import type { GameState } from '../src/manage/types.ts';
import { knownView } from '../src/manage/view.ts';
import { gatewayDriverOptions, playerStats, runGatewayMatch } from '../src/shooter/gateway.ts';
import { ShooterDriver, ShooterReplayCursor } from '../src/shooter/runner.ts';
import { compileBot } from '../src/sandbox/compile.ts';

const ROLES = ['entry', 'support', 'anchor', 'lurk', 'awp'];
const side = (version: number, habit = 0): SideSpec => ({ players: ROLES.map((lineageId) => ({ lineageId, version, config: { habit } })) });

describe('個人統計：與回放重算對帳', () => {
  const bot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'shooter-baseline.js');
  const reqs: MatchRequest[] = [
    { formatId: 'shooter-mr6', a: side(3), b: side(3), seed: 31 },
    { formatId: 'shooter-mr6', a: side(5, 45), b: side(2, -40), seed: 2_026_110 },
    { formatId: 'shooter-mr6', a: side(1, -60), b: { ...side(4, 20), team: { q_rushA: 80, pref_rushA: 2, economy: 1 } }, seed: 777 },
  ];

  it('閘道統計＝回放逐 tick 重算（擊殺、死亡、首殺、首死、存活、下包、拆包、殘局、回合數）；傷害落在上下界內；總和檢查', () => {
    const totals = { rounds: 0, plants: 0, clutches: 0, firstKills: 0 };
    for (const req of reqs) {
      const m = runGatewayMatch(req, bot);
      const got = m.outcome.players as PlayerStat[];
      expect(got).toHaveLength(10);
      const d = new ShooterDriver(gatewayDriverOptions(req, bot, { record: true }));
      while (!d.match.over) d.step();
      const c = new ShooterReplayCursor(JSON.parse(JSON.stringify(d.replay)) as NonNullable<typeof d.replay>);
      const mt = c.match;
      const n = mt.players.length;
      const grp = (pid: number): number => (pid < n / 2 ? 0 : 1);
      const exp = mt.players.map(() => ({ firstKills: 0, firstDeaths: 0, survived: 0, plants: 0, defuses: 0, clutches: 0 }));
      const hpLost = [0, 0];
      let round = mt.roundNumber;
      let alive = mt.players.map((p) => p.alive);
      let hp = mt.players.map((p) => p.hp);
      let kills = mt.players.map((p) => p.kills);
      let firstDone = false;
      let clutcher = [-1, -1];
      let bomb = mt.bomb.state;
      let ambiguous = 0;
      const closeRound = (r: number): void => {
        alive.forEach((a, pid) => {
          if (a) exp[pid].survived++;
        });
        const w = mt.result().rounds[r - 1]?.winnerGroup;
        if (w !== undefined && clutcher[w] >= 0) exp[clutcher[w]].clutches++;
      };
      while (!mt.over) {
        c.step();
        if (mt.roundNumber !== round) {
          if (round >= 1) closeRound(round);
          round = mt.roundNumber;
          firstDone = false;
          clutcher = [-1, -1];
          alive = mt.players.map((p) => p.alive);
          hp = mt.players.map((p) => p.hp);
          kills = mt.players.map((p) => p.kills);
          bomb = mt.bomb.state;
          continue;
        }
        const nowAlive = mt.players.map((p) => p.alive);
        mt.players.forEach((p, pid) => {
          if (alive[pid]) hpLost[grp(pid)] += Math.max(0, hp[pid] - Math.max(0, p.hp));
        });
        const killers = mt.players.filter((p, pid) => p.kills > kills[pid]).map((p) => p.id);
        const died = nowAlive.flatMap((a, pid) => (alive[pid] && !a ? [pid] : []));
        if (!firstDone && killers.length > 0) {
          firstDone = true;
          if (killers.length === 1 && died.length === 1) {
            exp[killers[0]].firstKills++;
            exp[died[0]].firstDeaths++;
          } else ambiguous++;
        }
        if (died.length > 0) {
          const cnt = [0, 1].map((g) => nowAlive.filter((a, pid) => a && grp(pid) === g).length);
          for (const g of [0, 1]) {
            if (clutcher[g] < 0 && cnt[g] === 1 && cnt[1 - g] >= 1) clutcher[g] = nowAlive.findIndex((a, pid) => a && grp(pid) === g);
          }
        }
        if (mt.bomb.state === 'planted' && bomb !== 'planted') exp[mt.bomb.planter].plants++;
        if (mt.bomb.state === 'defused' && bomb !== 'defused') exp[mt.bomb.defuser].defuses++;
        alive = nowAlive;
        hp = mt.players.map((p) => p.hp);
        kills = mt.players.map((p) => p.kills);
        bomb = mt.bomb.state;
      }
      closeRound(round);
      expect(c.desyncTick).toBeNull();
      expect(mt.hash()).toBe(m.finalHash);
      expect(ambiguous).toBe(0);
      const res = mt.result();
      got.forEach((s, pid) => {
        expect(s.kills).toBe(mt.players[pid].kills);
        expect(s.deaths).toBe(mt.players[pid].deaths);
        expect(s.rounds).toBe(res.rounds.length);
        expect({ firstKills: s.firstKills, firstDeaths: s.firstDeaths, survived: s.survived, plants: s.plants, defuses: s.defuses, clutches: s.clutches }, `座位 ${pid}`).toEqual(exp[pid]);
        if (s.kills > 0) expect(s.damage).toBeGreaterThan(0);
      });
      // 傷害：一組造成的對敵傷害 ≤ 另一組實際掉的血（掉血另含隊友、自己、炸彈）
      for (const g of [0, 1]) {
        const dealt = got.filter((_, pid) => grp(pid) === g).reduce((t, s) => t + s.damage, 0);
        expect(dealt).toBeGreaterThan(0);
        expect(dealt).toBeLessThanOrEqual(hpLost[1 - g]);
      }
      // 總和
      const ks = mt.kills;
      const nonEnemy = ks.filter((k) => k.killer < 0 || grp(k.killer) === grp(k.victim)).length;
      expect(got.reduce((t, s) => t + s.kills, 0)).toBe(got.reduce((t, s) => t + s.deaths, 0) - nonEnemy);
      const enemyRounds = new Set(ks.filter((k) => k.killer >= 0 && grp(k.killer) !== grp(k.victim)).map((k) => k.round)).size;
      expect(got.reduce((t, s) => t + s.firstKills, 0)).toBe(enemyRounds);
      expect(got.reduce((t, s) => t + s.firstDeaths, 0)).toBe(enemyRounds);
      expect(got.reduce((t, s) => t + s.plants, 0)).toBe(res.rounds.filter((r) => r.planter >= 0).length);
      expect(got.reduce((t, s) => t + s.defuses, 0)).toBe(res.rounds.filter((r) => r.reason === 'defuse').length);
      totals.rounds += res.rounds.length;
      totals.plants += got.reduce((t, s) => t + s.plants, 0);
      totals.clutches += got.reduce((t, s) => t + s.clutches, 0);
      totals.firstKills += enemyRounds;
    }
    // 樣本有涵蓋到下包與首殺（殘局看種子，不強求）
    expect(totals.plants).toBeGreaterThan(0);
    expect(totals.firstKills).toBeGreaterThan(0);
  }, 300_000);

  it('playerStats：同回合多人陣亡依擊殺順序推殘局；炸彈與隊殺不算首殺', () => {
    const result = {
      winner: 0,
      score: [1, 0],
      ticks: 0,
      overtimes: 0,
      stats: Array.from({ length: 10 }, () => ({ kills: 0, deaths: 0, damage: 0 })),
      rounds: [{ number: 1, winnerGroup: 0, planter: 2, defuser: -1 }],
    } as unknown as Parameters<typeof playerStats>[0];
    const k = (tick: number, killer: number, victim: number): { tick: number; round: number; killer: number; victim: number; weapon: 'ak47' } => ({ tick, round: 1, killer, victim, weapon: 'ak47' });
    // 先隊殺（1 殺 0）、炸彈炸死 5，第一個敵殺是 6 殺 1；之後組 0 剩 2 號一人對 3 人，2 號贏下
    const ks = [k(10, 1, 0), { ...k(11, -1, 5), weapon: 'bomb' as const }, k(12, 6, 1), k(13, 7, 3), k(14, 8, 4)];
    const s = playerStats(result, ks as unknown as Parameters<typeof playerStats>[1]);
    expect(s[6].firstKills).toBe(1);
    expect(s[1].firstDeaths).toBe(1);
    expect(s[0].firstDeaths + s[5].firstDeaths).toBe(0);
    expect(s[2].clutches).toBe(1);
    expect(s[2].plants).toBe(1);
    expect(s.map((x) => x.survived)).toEqual([0, 0, 1, 0, 0, 0, 1, 1, 1, 1]);
  });
});

/** 暫代內容＋攻防戰戰術；假比賽外加個人統計（依請求單種子確定）與雙方戰術標籤 */
const content: ContentPack = { ...STUB_CONTENT, tactics: SHOOTER_TACTICS };
const fake = new FakeGateway(content);
class StatGateway implements BattleGateway {
  readonly formats = fake.formats;
  async simulateBatch(requests: readonly MatchRequest[]): Promise<MatchOutcome[]> {
    const outs = await fake.simulateBatch(requests);
    return outs.map((o, i) => {
      const seed = requests[i].seed;
      const size = requests[i].a.players.length + requests[i].b.players.length;
      const rounds = o.rounds.length;
      const players: PlayerStat[] = Array.from({ length: size }, (_, j) => ({ kills: (seed + j) % 5, deaths: (seed + 2 * j) % 4, damage: 80 + ((seed * 7 + j * 13) % 400), firstKills: j % 2, firstDeaths: (j + 1) % 2, survived: j % 3, plants: j === 0 ? 1 : 0, defuses: 0, clutches: j === 1 ? 1 : 0, rounds }));
      return { ...o, rounds: o.rounds.map((r) => ({ ...r, tactics: { a: 'rushB', b: 'stackA' } })), players };
    });
  }
}

describe('經營層：賽季累計、戰術紀錄、已知層', () => {
  it('每場統計存進賽程、累計到出賽選手；戰術紀錄依我方標籤；對手個人統計公開、戰術紀錄只有自己', async () => {
    const s = newGame(5, content);
    const g = new StatGateway();
    await advance(s, content, g);
    await advance(s, content, g);
    await advance(s, content, g);
    const done = s.fixtures.filter((f) => f.result !== null);
    expect(done.length).toBeGreaterThan(0);
    for (const f of done) {
      const r = f.result as NonNullable<typeof f.result>;
      expect(r.stats?.[0]).toHaveLength(r.lineupA.length);
      expect(r.stats?.[1]).toHaveLength(r.lineupB.length);
    }
    // 累計＝該選手出賽的每場統計加總
    for (const p of s.players) {
      let games = 0;
      let kills = 0;
      for (const f of done) {
        const r = f.result as NonNullable<typeof f.result>;
        const ia = r.lineupA.indexOf(p.id);
        const ib = r.lineupB.indexOf(p.id);
        const st = ia >= 0 ? r.stats?.[0][ia] : ib >= 0 ? r.stats?.[1][ib] : undefined;
        if (st === undefined) continue;
        games++;
        kills += st.kills;
      }
      expect(p.season.games).toBe(games);
      expect(p.season.kills).toBe(kills);
    }
    // 戰術紀錄：主場記 rushB、客場記 stackA；played＝有標籤的回合數
    const me = s.teams.find((t) => t.id === s.humanTeamId) as GameState['teams'][number];
    const mine = done.filter((f) => f.home === me.id || f.away === me.id);
    const home = mine.filter((f) => f.home === me.id).reduce((t, f) => t + (f.result?.rounds.length ?? 0), 0);
    const away = mine.filter((f) => f.away === me.id).reduce((t, f) => t + (f.result?.rounds.length ?? 0), 0);
    expect(me.tacticLog.rushB?.played ?? 0).toBe(home);
    expect(me.tacticLog.stackA?.played ?? 0).toBe(away);
    // 已知層：NPC 看得到我方比賽的雙方統計與我方選手的賽季累計；只看得到自己的戰術紀錄
    const npc = s.teams.find((t) => !t.human) as GameState['teams'][number];
    const v = knownView(s, content, npc.id);
    const f0 = v.fixtures.find((f) => f.id === mine[0].id);
    expect(f0?.match?.stats?.home).toEqual(mine[0].result?.stats?.[0]);
    expect(f0?.match?.stats?.away).toEqual(mine[0].result?.stats?.[1]);
    const someMine = s.players.find((p) => p.teamId === me.id) as GameState['players'][number];
    expect(v.players.find((p) => p.id === someMine.id)?.season).toEqual(someMine.season);
    expect(v.me.tacticLog).toEqual(npc.tacticLog);
    expect(JSON.stringify(v)).not.toContain(JSON.stringify(me.tacticLog));
  });

  it('第 6 版 → 第 7 版：選手累計歸零、戰術紀錄由舊賽程的回合標籤補回、舊賽程沒有統計；第 7 版存讀一致', async () => {
    const s = newGame(9, content);
    const g = new StatGateway();
    await advance(s, content, g);
    await advance(s, content, g);
    const v6 = JSON.parse(serialize(s)) as GameState & Record<string, unknown>;
    v6.version = 6;
    // 第 6 版的選手是版本制：給回版本、拿掉屬性（遷移串到第 8 版時由版本補回）
    for (const p of v6.players as unknown as Record<string, unknown>[]) {
      p.version = 2;
      p.upgradeUntilWeek = null;
      delete p.attrs;
      delete p.caps;
      delete p.progress;
    }
    for (const p of v6.players as unknown as Record<string, unknown>[]) delete p.season;
    for (const t of v6.teams as unknown as Record<string, unknown>[]) delete t.tacticLog;
    for (const f of v6.fixtures) if (f.result !== null) delete f.result.stats;
    const m = deserialize(JSON.stringify(v6), content);
    expect(m.version).toBe(10);
    expect(m.players.every((p) => p.season.games === 0 && p.season.kills === 0)).toBe(true);
    for (const t of m.teams) expect(t.tacticLog).toEqual(s.teams.find((x) => x.id === t.id)?.tacticLog);
    expect(m.fixtures.every((f) => f.result === null || f.result.stats === undefined)).toBe(true);
    expect(JSON.parse(serialize(deserialize(serialize(s), content)))).toEqual(JSON.parse(serialize(s)));
  });

  it('一季存檔增加量（統計＋累計＋戰術紀錄）< 200 KB', async () => {
    const s = newGame(13, content);
    const g = new StatGateway();
    while (s.phase !== 'ended' && s.phase !== 'bankrupt') await advance(s, content, g);
    const stats = JSON.stringify(s.fixtures.map((f) => f.result?.stats ?? null)).length;
    const season = JSON.stringify(s.players.map((p) => p.season)).length;
    const log = JSON.stringify(s.teams.map((t) => t.tacticLog)).length;
    const total = stats + season + log;
    console.log(`第三批一季存檔增加：賽程統計 ${stats} B、選手累計 ${season} B、戰術紀錄 ${log} B，共 ${(total / 1024).toFixed(1)} KB（全檔 ${(serialize(s).length / 1024).toFixed(1)} KB）`);
    expect(total).toBeLessThan(200 * 1024);
  });
});

describe('評分與 MVP', () => {
  const base = { kills: 0, deaths: 0, damage: 0, firstKills: 0, firstDeaths: 0, survived: 0, plants: 0, defuses: 0, clutches: 0, rounds: 10 };
  it('平均水準約 0.9；沒有回合＝0；殺多、死少、傷害高、首殺多的評分較高', () => {
    expect(ratingOf({ ...base, kills: 6.8, deaths: 6.8, damage: 750 })).toBeCloseTo(0.9, 5);
    expect(ratingOf({ ...base, rounds: 0 })).toBe(0);
    const avg = ratingOf({ ...base, kills: 7, deaths: 7, damage: 750 });
    expect(ratingOf({ ...base, kills: 12, deaths: 7, damage: 750 })).toBeGreaterThan(avg);
    expect(ratingOf({ ...base, kills: 7, deaths: 3, damage: 750 })).toBeGreaterThan(avg);
    expect(ratingOf({ ...base, kills: 7, deaths: 7, damage: 1200 })).toBeGreaterThan(avg);
    expect(ratingOf({ ...base, kills: 7, deaths: 7, damage: 750, firstKills: 3 })).toBeGreaterThan(avg);
  });
  it('MVP＝評分最高、同分取前面；空名單＝−1', () => {
    expect(mvpIndex([{ ...base, kills: 3 }, { ...base, kills: 9 }, { ...base, kills: 9 }])).toBe(1);
    expect(mvpIndex([])).toBe(-1);
  });
});
