// CS 射擊步驟 1 驗收情境：四種回合勝利條件與回合流程，用寫死的腳本控制器（不用陪練 Bot）。
// test/shooter.test.ts 檢查全部通過。
import type { ShooterCommand, ShooterObservation } from './api.ts';
import { ROUND, TEAM_SIZE, UNIT, ticks } from './config.ts';
import { isSolidCell } from './map.ts';
import { ScriptController, ShooterDriver } from './runner.ts';
import { PLAYER_COUNT, type ShooterMatchOptions } from './sim.ts';

export interface ScenarioResult {
  readonly pass: boolean;
  readonly detail: string;
}

export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly expect: string;
  readonly run: () => ScenarioResult;
}

type Script = (obs: ShooterObservation) => readonly ShooterCommand[];

const idle: Script = () => [];

/** 看到敵人就瞄準開火 */
const shooter: Script = (obs) => {
  const e = obs.enemies[0];
  return e === undefined ? [{ type: 'fire', on: false }] : [{ type: 'aim', x: e.x, y: e.y }, { type: 'fire', on: true }];
};

/** 帶炸彈就下包 */
const planter: Script = (obs) => (obs.me.hasBomb ? [{ type: 'plant' }] : []);

/** 炸彈下了而且在旁邊就拆 */
const defuser: Script = (obs) => (obs.bomb.state === 'planted' ? [{ type: 'defuse' }] : []);

/** 依 playerId 指定腳本；沒指定的閒置 */
function driver(scripts: Partial<Record<number, Script>>, opts: Partial<ShooterMatchOptions> = {}): ShooterDriver {
  const controllers = Array.from({ length: PLAYER_COUNT }, (_, pid) => new ScriptController(`script-${pid}`, scripts[pid] ?? idle));
  return new ShooterDriver({ seed: 7, ...opts, controllers, record: false });
}

/** 一格的中心（座標單位）；確認不是牆 */
export function cellCenter(d: ShooterDriver, cx: number, cy: number): [number, number] {
  if (isSolidCell(d.match.map, cx, cy)) throw new Error(`(${cx}, ${cy}) 是牆`);
  return [cx * UNIT + UNIT / 2, cy * UNIT + UNIT / 2];
}

function runUntil(d: ShooterDriver, stop: () => boolean, maxTicks: number): void {
  for (let i = 0; i < maxTicks && !d.match.over && !stop(); i++) d.step();
}

function toLive(d: ShooterDriver): void {
  runUntil(d, () => d.match.phase === 'live', ROUND.freezeTicks + 5);
}

const roundOver = (d: ShooterDriver, n: number): boolean => d.match.rounds.length >= n;

/** 炸彈帶到 B 點中央下包；回傳下包者 */
function plantAtB(d: ShooterDriver): number {
  toLive(d);
  const m = d.match;
  const carrier = m.players.find((p) => p.hasBomb)!.id;
  const [x, y] = cellCenter(d, 19, 36);
  m.teleport(carrier, x, y, 270);
  runUntil(d, () => m.phase === 'planted', ROUND.plantTicks + 30);
  return carrier;
}

function last(d: ShooterDriver): string {
  const r = d.match.rounds[d.match.rounds.length - 1];
  return r === undefined ? '回合未結束' : `${r.winner} ${r.reason}（第 ${r.endTick} tick）`;
}

/** 每回合一開打就殲滅指定組別（加速回合流程測試）；loser(round) 回傳要殲滅的組別 */
function playRounds(d: ShooterDriver, rounds: number, loser: (round: number) => 0 | 1): void {
  const m = d.match;
  for (let n = 0; n < rounds && !m.over; n++) {
    const want = m.rounds.length + 1;
    toLive(d);
    const g = loser(m.roundNumber);
    for (const p of m.players) if (p.group === g) m.kill(p.id);
    runUntil(d, () => roundOver(d, want), 10);
    // 跑完回合結束的展示時間，進到下一回合
    runUntil(d, () => m.roundNumber > want || m.over, ROUND.roundEndTicks + 5);
  }
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'W1',
    name: '殲滅',
    expect: 'T 五人對眼前背對的 CT 開火，殲滅後 T 以 elimination 勝',
    run: () => {
      const scripts: Partial<Record<number, Script>> = {};
      for (let i = 0; i < TEAM_SIZE; i++) scripts[i] = shooter;
      const d = driver(scripts);
      toLive(d);
      const m = d.match;
      for (let i = 0; i < TEAM_SIZE; i++) {
        const t = m.players[i];
        m.teleport(i, t.x, t.y, 270);
        m.teleport(i + TEAM_SIZE, t.x, t.y - 4 * UNIT, 270);
      }
      runUntil(d, () => roundOver(d, 1), ticks(10));
      const r = m.rounds[0];
      return { pass: r !== undefined && r.winner === 'T' && r.reason === 'elimination' && m.players.slice(0, TEAM_SIZE).every((p) => p.alive), detail: last(d) };
    },
  },
  {
    id: 'W2',
    name: '引爆（T 全滅）',
    expect: 'T 在 B 點下包後全隊陣亡，炸彈 40 秒後引爆仍判 T 以 bomb 勝',
    run: () => {
      const scripts: Partial<Record<number, Script>> = {};
      for (let i = 0; i < TEAM_SIZE; i++) scripts[i] = planter;
      const d = driver(scripts);
      plantAtB(d);
      const m = d.match;
      const plantedAt = m.tick;
      if (m.phase !== 'planted') return { pass: false, detail: `沒有下包成功：${m.phase}` };
      for (let i = 0; i < TEAM_SIZE; i++) m.kill(i);
      runUntil(d, () => roundOver(d, 1), ROUND.bombTicks + 10);
      const r = m.rounds[0];
      const pass = r !== undefined && r.winner === 'T' && r.reason === 'bomb' && r.endTick - plantedAt >= ROUND.bombTicks - 1 && m.bomb.site === 'B';
      return { pass, detail: `${last(d)}；下包於 ${plantedAt}、點 ${m.bomb.site}` };
    },
  },
  {
    id: 'W3',
    name: '拆彈',
    expect: 'T 在 B 點下包，CT 貼到炸彈旁拆 10 秒，CT 以 defuse 勝',
    run: () => {
      const scripts: Partial<Record<number, Script>> = {};
      for (let i = 0; i < TEAM_SIZE; i++) scripts[i] = planter;
      scripts[TEAM_SIZE] = defuser;
      const d = driver(scripts);
      plantAtB(d);
      const m = d.match;
      if (m.phase !== 'planted') return { pass: false, detail: `沒有下包成功：${m.phase}` };
      m.teleport(TEAM_SIZE, m.bomb.x + UNIT, m.bomb.y, 180);
      const t0 = m.tick;
      runUntil(d, () => roundOver(d, 1), ROUND.bombTicks + 10);
      const r = m.rounds[0];
      // endTick 是最後處理的 tick，所以經過的時間是 endTick + 1 − t0；指令最晚在下一個決策 tick 才送出
      const took = r === undefined ? -1 : r.endTick + 1 - t0;
      const pass = r !== undefined && r.winner === 'CT' && r.reason === 'defuse' && took >= ROUND.defuseTicks && took <= ROUND.defuseTicks + 3;
      return { pass, detail: `${last(d)}；拆了 ${took} tick` };
    },
  },
  {
    id: 'W4',
    name: '時間到',
    expect: '雙方都不動，115 秒後 CT 以 timeout 勝',
    run: () => {
      const d = driver({});
      toLive(d);
      const live = d.match.liveStartTick;
      runUntil(d, () => roundOver(d, 1), ROUND.roundTicks + 10);
      const r = d.match.rounds[0];
      return { pass: r !== undefined && r.winner === 'CT' && r.reason === 'timeout' && r.endTick - live === ROUND.roundTicks, detail: `${last(d)}；開打於 ${live}` };
    },
  },
  {
    id: 'R1',
    name: '凍結時間限出生區',
    expect: '凍結時間全員往外直走 15 秒，仍都在出生區內',
    run: () => {
      const away: Script = (obs) => [{ type: 'moveDir', deg: obs.me.team === 'T' ? 270 : 90 }];
      const scripts: Partial<Record<number, Script>> = {};
      for (let i = 0; i < PLAYER_COUNT; i++) scripts[i] = away;
      const d = driver(scripts);
      const m = d.match;
      runUntil(d, () => m.tick >= ROUND.freezeTicks - 1, ROUND.freezeTicks);
      const outside = m.players.filter((p) => {
        const z = m.map.spawnZones[p.team];
        return p.x < z.x0 * UNIT || p.x > z.x1 * UNIT || p.y < z.y0 * UNIT || p.y > z.y1 * UNIT;
      });
      const moved = m.players.filter((p) => p.y !== m.map.spawns[p.team][p.slot].y).length;
      return { pass: m.phase === 'freeze' && outside.length === 0 && moved === PLAYER_COUNT, detail: `出界 ${outside.length} 人；有移動 ${moved} 人` };
    },
  },
  {
    id: 'R2',
    name: '12 回合後換邊',
    expect: '上半場 12 回合都由玩家 0～4（T）贏；第 13 回合玩家 0～4 變 CT、比分記在原隊',
    run: () => {
      const d = driver({}, { defaultLoadout: { T: 'ak', CT: 'm4' } });
      const m = d.match;
      playRounds(d, ROUND.roundsPerHalf, () => 1);
      const o = m.observe(0);
      const pass = m.roundNumber === ROUND.roundsPerHalf + 1 && m.players[0].team === 'CT' && m.players[TEAM_SIZE].team === 'T' && o.round.half === 2 && o.round.scoreCT === 12 && o.round.scoreT === 0 && m.players[0].primary?.id === 'm4' && m.players[TEAM_SIZE].primary?.id === 'ak';
      return { pass, detail: `第 ${m.roundNumber} 回合；玩家 0 為 ${m.players[0].team}（${m.players[0].primary?.id}）；比分 T ${o.round.scoreT}：CT ${o.round.scoreCT}` };
    },
  },
  {
    id: 'R3',
    name: '先到 13 勝',
    expect: '玩家 0～4 連贏 13 回合（換邊前後各贏），比賽在第 13 回合結束、13:0',
    run: () => {
      const d = driver({});
      const m = d.match;
      playRounds(d, 30, () => 1);
      return { pass: m.over && m.winner === 0 && m.score[0] === 13 && m.score[1] === 0 && m.rounds.length === 13, detail: `結束 ${m.over}、勝方 ${m.winner}、比分 ${m.score.join(':')}、${m.rounds.length} 回合` };
    },
  },
  {
    id: 'R4',
    name: '12:12 平手',
    expect: '上半場玩家 0～4 全勝、下半場玩家 5～9 全勝，24 回合後 12:12 平手',
    run: () => {
      const d = driver({});
      const m = d.match;
      playRounds(d, 30, (n) => (n <= ROUND.roundsPerHalf ? 1 : 0));
      return { pass: m.over && m.winner === null && m.score[0] === 12 && m.score[1] === 12 && m.rounds.length === 24, detail: `結束 ${m.over}、勝方 ${m.winner}、比分 ${m.score.join(':')}、${m.rounds.length} 回合` };
    },
  },
];
