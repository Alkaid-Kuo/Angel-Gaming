// M5 規格 6.6／6.8 第 4 條（視野公平）：教練模式送到畫面的資料，只來自己方活著選手的觀察資料聯集＋計分板公開欄位。
// 每個決策 tick 檢查：敵人、雷達、掉落物、煙火、飛行中的道具、子彈都在某名活著的己方選手的觀察資料裡；炸彈狀態不比任何一名己方選手知道的多；
// 隊內喊話只有己方；計分板只有己方的金錢；畫面資料（Worker 送出的 frame）沒有引擎全狀態、沒有對方的教練指令。
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MatchRequest, SideSpec } from '../src/manage/gateway.ts';
import { SHOOTER_TACTICS } from '../src/manage/content-shooter.ts';
import type { ShooterObservation } from '../src/shooter/api.ts';
import { coachBoard, coachFrame, coachViewId, teamObservation } from '../src/shooter/coach-view.ts';
import { LiveCoach } from '../src/shooter/live-coach.ts';
import { compileBot } from '../src/sandbox/compile.ts';

const bot = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'baseline');
const ROLES = ['entry', 'support', 'anchor', 'lurk', 'awp'];
const ALL = SHOOTER_TACTICS.map((t) => t.id);
const side = (): SideSpec => ({
  players: ROLES.map((lineageId) => ({ lineageId, version: 3, config: { habit: 0, ...Object.fromEntries(ALL.map((t) => [`p_${t}`, 50])) } })),
  team: { ...Object.fromEntries(ALL.map((t) => [`q_${t}`, 50])), ...Object.fromEntries(ALL.map((t) => [`pref_${t}`, 0])), economy: 0 },
});
// 對方有 AI 教練（會喊指令），驗證對方指令不進畫面
const req: MatchRequest = { formatId: 'shooter-mr6', a: side(), b: side(), seed: 2468, coachAi: { a: null, b: 1 } };

const OBS_KEYS = ['tick', 'round', 'me', 'teammates', 'enemies', 'radar', 'tracers', 'sounds', 'bomb', 'effects', 'items', 'projectiles', 'chat', 'enemiesAlive', 'coach'].sort();
const BOMB_RANK: Record<string, number> = { unknown: 0, carried: 1, dropped: 2, planting: 3, planted: 3, defusing: 4, defused: 5, exploded: 5 };

describe('教練視角：只有己方看得到的東西', () => {
  it('前 4 回合每個決策 tick（兩組都驗）：聯集的每一項都出自某名活著的己方選手；計分板、喊話、畫面資料不洩漏；之後打完，對方的指令只在賽後紀錄', () => {
    const lc = new LiveCoach({ request: req, bot, side: 'a', assistant: false });
    const m = lc.driver.match;
    let checked = 0;
    let enemiesSeen = 0;
    const want: [number, number] = [0, 5];
    const keyed = (list: readonly object[]): Set<string> => new Set(list.map((x) => JSON.stringify(x)));
    while (!m.over && m.roundNumber <= 4) {
      lc.step();
      if (!m.isDecisionTick()) continue;
      for (const g of [0, 1] as const) {
        want[g] = coachViewId(m, g, want[g]);
        const tv = teamObservation(m, g, want[g]);
        const mates = m.players.filter((p) => p.group === g && p.alive);
        const src: ShooterObservation[] = mates.length > 0 ? mates.map((p) => m.observe(p.id)) : [m.observe(want[g])];
        expect(Object.keys(tv).sort()).toEqual(OBS_KEYS);
        expect(m.players[tv.me.id].group).toBe(g);
        for (const t of tv.teammates) expect(m.players[t.id].group).toBe(g);
        const enemyKeys = keyed(src.flatMap((o) => o.enemies));
        for (const e of tv.enemies) {
          expect(m.players[e.id].group).not.toBe(g);
          expect(enemyKeys.has(JSON.stringify(e))).toBe(true);
        }
        enemiesSeen += tv.enemies.length;
        const radarKeys = keyed(src.flatMap((o) => o.radar));
        for (const r of tv.radar) expect(radarKeys.has(JSON.stringify(r))).toBe(true);
        for (const k of ['items', 'effects', 'projectiles', 'tracers'] as const) {
          const ks = keyed(src.flatMap((o) => o[k] as readonly object[]));
          for (const it of tv[k] as readonly object[]) expect(ks.has(JSON.stringify(it)), k).toBe(true);
        }
        expect(keyed(src.map((o) => o.bomb)).has(JSON.stringify(tv.bomb))).toBe(true);
        expect(Math.max(...src.map((o) => BOMB_RANK[o.bomb.state]))).toBe(BOMB_RANK[tv.bomb.state]);
        for (const c of tv.chat) expect(m.players[c.from].group).toBe(g);
        for (const row of coachBoard(m, g)) expect(row.money === null).toBe(m.players[row.id].group !== g);
        // Worker 送出的 frame：沒有全狀態、不含任何 calls 紀錄（每 8 次驗一次序列化）
        const fr = coachFrame(m, g, want[g]);
        expect(fr.full).toBeNull();
        if (checked % 8 === 0) expect(JSON.stringify(fr).includes('"calls"')).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(enemiesSeen).toBeGreaterThan(0);
    // 教練離席（不然第 7 回合換邊會停下等指令），打完
    lc.leave();
    while (!m.over) lc.step();
    // 對方（有 AI 教練）有喊過指令，但只在比賽結束後的紀錄裡（畫面資料從來不含 calls）
    expect(lc.log.some((c) => c.side === 'b')).toBe(true);
  }, 300_000);
});
