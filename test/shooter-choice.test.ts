import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ShooterBaseline from '../bots/shooter-src/baseline.js';
import { P } from '../bots/shooter-src/base.js';
import type { Choice, LogEntry, LookCand, LookStat } from '../bots/shooter-src/choice.js';
import type { CompiledBot } from '../src/sandbox/compile.ts';
import { resolveKnobs } from '../src/sandbox/controller.ts';
import { MAPS } from '../src/shooter/map.ts';
import { ShooterBatchController, ShooterDriver } from '../src/shooter/runner.ts';
import { PLAYER_COUNT } from '../src/shooter/sim.ts';

// Bot 3.0 效用層（設計 docs/2026-11-10_CS射擊_Bot3.0效用式個人層設計.md）第 2 步：特徵範圍、確定性、錯開、紀錄格式。

const base: CompiledBot = { createClass: () => ShooterBaseline as never, sizeBytes: 0 };
type Row = { pid: number; e: LogEntry; feats: { key: string; v: number }[][]; text: string };
/** 視線頭每個 decide tick 的量測與選擇 */
type LookRow = { pid: number; st: LookStat; lk: LookCand | null };
const looks: LookRow[] = [];

/** 特徵表宣告的範圍（跑過一次後填） */
const declared = new Map<string, [number, number]>();

/** 跑 seed 的前 rounds 回合，收集每個人每次效用決策的紀錄與特徵值 */
function run(seed: number, rounds: number): Row[] {
  const ctrl = Array.from({ length: PLAYER_COUNT }, (_, pid) => new ShooterBatchController(base, 'a', seed, pid, MAPS.redrock(), { timeLimits: false }));
  const knobs = ctrl.map((c) => resolveKnobs(c.declaration, {}, c.label));
  const d = new ShooterDriver({ seed, mapId: 'redrock', controllers: ctrl, knobs, record: false } as ConstructorParameters<typeof ShooterDriver>[0]);
  const m = (d as unknown as { match: { over: boolean; roundNumber: number } }).match;
  const choices = (): Choice[] => ctrl.map((c) => (c as unknown as { bot: { choice: Choice } }).bot.choice);
  const last = new Array<number>(PLAYER_COUNT).fill(-1);
  const lastL = new Array<number>(PLAYER_COUNT).fill(-1);
  const rows: Row[] = [];
  looks.length = 0;
  while (!m.over && m.roundNumber <= rounds) {
    d.step();
    choices().forEach((ch, pid) => {
      const st = ch.lstat;
      if (st !== null && st.tick !== lastL[pid]) {
        lastL[pid] = st.tick;
        looks.push({ pid, st, lk: ch.lk === null ? null : { ...ch.lk } });
      }
      const e = ch.log[ch.log.length - 1];
      if (e === undefined || e.tick === last[pid]) return;
      last[pid] = e.tick;
      rows.push({ pid, e, feats: ch.trace, text: ch.text() });
    });
  }
  for (const f of choices()[0].features) declared.set(f.key, [f.min, f.max]);
  return rows;
}

describe('Bot 3.0 效用層：決策與視線頭（第 6 步起驅動行為）', () => {
  let rows: Row[] = [];
  beforeAll(() => {
    P.choiceTrace = true;
    rows = run(5, 2);
  }, 300000);
  afterAll(() => {
    P.choiceTrace = false;
  });

  it('每個特徵值都在宣告的範圍內、是有限數', () => {
    expect(rows.length).toBeGreaterThan(100);
    const seen = new Set<string>();
    for (const r of rows) {
      for (const cand of r.feats) {
        for (const f of cand) {
          const rg = declared.get(f.key);
          expect(rg, f.key).toBeDefined();
          expect(Number.isFinite(f.v), `${f.key}=${f.v}`).toBe(true);
          expect(f.v, f.key).toBeGreaterThanOrEqual(rg?.[0] ?? 0);
          expect(f.v, f.key).toBeLessThanOrEqual(rg?.[1] ?? 1);
          seen.add(f.key);
        }
      }
    }
    // 每個宣告的特徵都至少被算過一次
    expect([...declared.keys()].filter((k) => !seen.has(k))).toEqual([]);
  });

  it('確定性：同種子兩次跑，每個人的決策紀錄完全相同', () => {
    const again = run(5, 2);
    const key = (rs: Row[]): string => rs.map((r) => `${r.pid}@${r.e.tick}:${r.e.ev}:${r.text}:${r.e.act}`).join('\n');
    expect(key(again)).toBe(key(rows));
  }, 300000);

  it('錯開：輪值（非事件）決策時，同一隊同一個 tick 最多一人', () => {
    const byTick = new Map<string, number>();
    for (const r of rows) {
      if (r.e.ev !== '') continue;
      const k = `${r.pid < 5 ? 0 : 1}@${r.e.tick}`;
      byTick.set(k, (byTick.get(k) ?? 0) + 1);
    }
    expect(Math.max(...byTick.values())).toBe(1);
  });

  it('紀錄字串照第七節正式格式；凍結期間不決策', () => {
    for (const r of rows) {
      expect(r.text).toMatch(/^!?([hapftgro]\d+ -?\d*\.\d\d)(\|[hapftgro]\d+ -?\d*\.\d\d){0,2} → [hapftgro]\d+(｜L:[esiwcnj]\d+ -?\d*\.\d\d)?$/);
      expect(r.e.stage).not.toBe('freeze');
    }
  });

  it('視線頭：有作用的拍數夠多；不歸視線頭管時不選、虛擬朝向不超過引擎轉速', () => {
    const act = looks.filter((l) => l.st.active);
    // 有作用的拍數裡，幾乎都有選定的看向（沒有候選才照舊看原來的方向）
    expect(act.filter((l) => l.lk !== null).length / act.length).toBeGreaterThan(0.95);
    expect(act.length).toBeGreaterThan(500);
    for (const l of looks) {
      if (!l.st.active) expect(l.lk).toBeNull();
      if (l.st.rate !== null) expect(l.st.rate[1]).toBeLessThanOrEqual(720 + 1e-6);
    }
    // 六種視線至少出現四種（守點、行進、記得的敵位、窄口這幾種在兩回合內一定會有）
    expect(new Set(act.map((l) => l.lk?.t)).size).toBeGreaterThanOrEqual(4);
  });

  it('視線頭硬優先：探頭 hold／shoulder 鎖窄口；先架危險角度的預瞄 j；沒在探、沒挨打、沒有預瞄與指揮層的看向（i2）時，新鮮的記得敵位（信心 ≥ 60、3 秒內；守位時雷達外要在 25 格內）優先，守位沒有鎖定時照掃描節奏', () => {
    let peeks = 0;
    let fresh = 0;
    for (const l of looks) {
      if (!l.st.active) continue;
      if (l.st.peek !== null) {
        peeks++;
        expect(l.st.hard).toBe('p');
        expect(l.lk?.t === 'i' && l.lk.ref === 0).toBe(true);
      } else if (l.st.hard === 'j') expect(l.lk?.t).toBe('j');
      // 守位掃描（holdScan；守位時雷達外 25 格以上的敵位不鎖，照 r7l 的掃描節奏）
      else if (l.st.hard === 'h') expect(['w', 'c']).toContain(l.lk?.t);
      else if (l.st.hard === 'i') expect(l.lk?.t === 'i' && l.lk.ref === 2).toBe(true);
      else if (l.st.hard !== 'd' && l.st.thr !== null && l.st.thr[2]) {
        fresh++;
        expect(l.st.hard).toBe('e');
        expect(l.lk?.t).toBe('e');
      }
    }
    expect(peeks + fresh).toBeGreaterThan(0);
  });
});

describe('Bot 3.0 視線頭：i2（指揮層這一步的看向）硬優先與失效（第 6 步切換裁定）', () => {
  /** 跑到 live 的第一個 decide tick，回傳 0 號的效用層與一份可改的觀察 */
  function setup(): { ch: Choice; obs: Record<string, unknown> & { tick: number; me: { x: number; y: number; facing: number } } } {
    const ctrl = Array.from({ length: PLAYER_COUNT }, (_, pid) => new ShooterBatchController(base, 'a', 7, pid, MAPS.redrock(), { timeLimits: false }));
    const knobs = ctrl.map((c) => resolveKnobs(c.declaration, {}, c.label));
    const d = new ShooterDriver({ seed: 7, mapId: 'redrock', controllers: ctrl, knobs, record: false } as ConstructorParameters<typeof ShooterDriver>[0]);
    const m = (d as unknown as { match: { phase: string; tick: number; players: { x: number; y: number; facing: number }[] } }).match;
    while (m.phase !== 'live') d.step();
    const ch = (ctrl[0] as unknown as { bot: { choice: Choice } }).bot.choice;
    const p = m.players[0];
    const obs = { tick: m.tick + 1000, me: { x: p.x, y: p.y, facing: p.facing / 100, alive: true }, radar: [], teammates: [], enemies: [], round: { phase: 'live' } };
    return { ch, obs };
  }
  type Li = Parameters<Choice['look']>[1];
  const li = (act: { x: number; y: number } | null, pre: { x: number; y: number; stop: boolean } | null = null): Li => ({ active: true, peek: null, hold: null, holding: false, moving: false, act, pre, ahead: null, soundReact: 0 });

  it('有 i2 時壓過新鮮敵位；指令消失的下一拍回到敵位；換目標就照新的；i2Hard 關掉時敵位優先', () => {
    const { ch, obs } = setup();
    const me = obs.me;
    const perc = (ch as unknown as { perc: { known: Map<number, unknown>; lastHurt: unknown; sectors: unknown[] } }).perc;
    perc.lastHurt = null;
    perc.sectors = [];
    const enemy = { id: 99, x: me.x + 8000, y: me.y, vx: 0, vy: 0, facing: 0, weapon: 'ak', tick: obs.tick, seenTick: obs.tick, conf: 90, src: 'see' };
    perc.known.set(99, enemy);
    const look = (a: { x: number; y: number } | null): { t: string; ref: number; x: number; y: number; hard: string } => {
      obs.tick += 3;
      enemy.tick = obs.tick;
      ch.look(obs as never, li(a), false);
      const lk = ch.lk;
      expect(lk).not.toBeNull();
      return { t: lk?.t ?? '', ref: lk?.ref ?? -1, x: lk?.x ?? 0, y: lk?.y ?? 0, hard: ch.lstat?.hard ?? '' };
    };
    const a1 = { x: me.x, y: me.y + 6000 };
    expect(look(a1)).toMatchObject({ t: 'i', ref: 2, x: a1.x, y: a1.y, hard: 'i' });
    // 指令消失：不殘留，回到新鮮敵位
    expect(look(null)).toMatchObject({ t: 'e', hard: 'e' });
    // 換目標：照這一拍的新指令
    const a2 = { x: me.x - 6000, y: me.y };
    expect(look(a1)).toMatchObject({ t: 'i', x: a1.x, y: a1.y });
    expect(look(a2)).toMatchObject({ t: 'i', ref: 2, x: a2.x, y: a2.y, hard: 'i' });
    // 軟性版：i2 只是計分候選，新鮮敵位照舊硬優先
    P.U.L.i2Hard = false;
    try {
      expect(look(a2)).toMatchObject({ t: 'e', hard: 'e' });
    } finally {
      P.U.L.i2Hard = true;
    }
  }, 120000);

  it('先架危險角度的預瞄 j 壓過 i2 與新鮮敵位；沒給就沒有；approachHard 關掉時只是計分候選', () => {
    const { ch, obs } = setup();
    const me = obs.me;
    const perc = (ch as unknown as { perc: { known: Map<number, unknown>; lastHurt: unknown; sectors: unknown[] } }).perc;
    perc.lastHurt = null;
    perc.sectors = [];
    const enemy = { id: 99, x: me.x + 8000, y: me.y, vx: 0, vy: 0, facing: 0, weapon: 'ak', tick: obs.tick, seenTick: obs.tick, conf: 90, src: 'see' };
    perc.known.set(99, enemy);
    const look = (a: { x: number; y: number } | null, pre: { x: number; y: number; stop: boolean } | null): { t: string; x: number; y: number; hard: string } => {
      obs.tick += 3;
      enemy.tick = obs.tick;
      ch.look(obs as never, li(a, pre), false);
      const lk = ch.lk;
      expect(lk).not.toBeNull();
      return { t: lk?.t ?? '', x: lk?.x ?? 0, y: lk?.y ?? 0, hard: ch.lstat?.hard ?? '' };
    };
    const a1 = { x: me.x, y: me.y + 6000 };
    const j1 = { x: me.x - 5000, y: me.y - 5000, stop: true };
    expect(look(a1, j1)).toMatchObject({ t: 'j', x: j1.x, y: j1.y, hard: 'j' });
    // 預瞄消失：照 i2
    expect(look(a1, null)).toMatchObject({ t: 'i', hard: 'i' });
    // 只有預瞄與敵位：預瞄優先
    expect(look(null, j1)).toMatchObject({ t: 'j', hard: 'j' });
    // 計分版：新鮮敵位照舊硬優先
    P.U.L.approachHard = false;
    try {
      expect(look(null, j1)).toMatchObject({ t: 'e', hard: 'e' });
    } finally {
      P.U.L.approachHard = true;
    }
  }, 120000);
});
