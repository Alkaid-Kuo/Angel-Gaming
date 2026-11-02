import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { compileBot } from '../src/sandbox/compile.ts';
import type ShooterBaseline from '../bots/shooter-src/baseline.js';
import type { CTPlan, TacOut } from '../bots/shooter-src/tactics.js';
import type { ShooterInitData, ShooterObservation } from '../src/shooter/api.ts';
import { dist } from '../bots/shooter-src/base.js';
import { burnCells, DEFAULT_ATTRIBUTES, ShooterMatch, shooterInitData } from '../src/shooter/sim.ts';
import { ScriptController, ShooterDriver, shooterHelpers, type ShooterController } from '../src/shooter/runner.ts';
import { MAPS } from '../src/shooter/map.ts';
import { Roles } from '../bots/shooter-src/roles.js';
import { compactIndent, stripComments } from '../scripts/build-shooter-bots.ts';

const compiled = compileBot(readFileSync('bots/shooter-baseline.js', 'utf8'), 'audit-regression');
const Bot = compiled.createClass() as unknown as typeof ShooterBaseline;
const plan: CTPlan = { kind: 'hold', a: 2, m: 1, b: 2, rot: 'A', go: true };
function fixture(pid = 5): { match: ShooterMatch; bot: ShooterBaseline; obs: ShooterObservation } {
  const match = new ShooterMatch({ seed: 11, mapId: 'redrock' });
  match.tick = 600; match.phase = 'live'; match.phaseEnd = 3600;
  const bot = new Bot();
  bot.init(shooterInitData(match.map, pid, {}), shooterHelpers(match.map, 11, pid));
  const raw = match.observe(pid);
  const obs: ShooterObservation = { ...raw, teammates: raw.teammates.map((m) => ({ ...m, alive: false })), enemies: [], radar: [], sounds: [], tracers: [], chat: [], effects: [], projectiles: [], enemiesAlive: 1, me: { ...raw.me, hasBomb: false, blindTicks: 0 } };
  bot.newRound(obs);
  return { match, bot, obs };
}
const output = (): TacOut => ({ goal: null, route: null, hold: null, objective: false, allowPeek: false, cmds: [], role: '', look: null, urgent: false, hard: false, stop: false, walk: null, noise: false, escape: false });

function defuseFixture(): ReturnType<typeof fixture> & { next: ShooterObservation } {
  const f = fixture();
  const p = f.bot.intel.sites.A.plants[0];
  const field = f.bot.judge!.field(p.x, p.y);
  const i = [...field].findIndex((d, j) => d >= 90 && d <= 100 && f.bot.g.walkable(j));
  expect(i).toBeGreaterThanOrEqual(0);
  const q = f.bot.g.center(i);
  f.bot.tactics.kits.add(6);
  return { ...f, next: { ...f.obs, round: { ...f.obs.round, phase: 'planted' }, me: { ...f.obs.me, ...p, weapon: 'm4', loadout: { ...f.obs.me.loadout, kit: false } }, teammates: f.obs.teammates.map((m) => ({ ...m, ...q, alive: m.id === 6, weapon: 'm4' })), bomb: { state: 'planted', site: 'A', ...p, ticksLeft: 240 } } };
}

describe('Bot 2.4.1：獨立審視的拆包反例', () => {
  it('敵人尚存，最近無 kit 拆不完，通路十格外的 kit 隊友才是拆包者', () => {
    const { bot, next } = defuseFixture();
    const mate = next.teammates.find((m) => m.id === 6)!;
    expect(bot.judge!.travel(mate, next.me.x, next.me.y) + 5).toBeLessThan(8);
    const out = output();
    bot.tactics.retake(next, out, plan, next.me.x, next.me.y, 'A');
    expect(out.cmds.some((c) => c.type === 'defuse')).toBe(false);
    expect(out.task).toBe('cover');
  });
  it('不可完成的既有拆包者明確交接；stop 本身不能解除引擎拆包', () => {
    const { bot, next } = defuseFixture();
    const out = { ...output(), objective: true };
    bot.tactics.retake({ ...next, me: { ...next.me, defuseTicks: 3 } }, out, plan, next.me.x, next.me.y, 'A');
    expect(out.objective).toBe(false);
    expect(out.task).toBe('cover');
    expect(out.cmds.some((c) => c.type === 'move')).toBe(true);
  });
  it('能完成的既有無 kit 拆包者保留，不能因其完整操作需十秒而保槍', () => {
    const { bot, next } = defuseFixture();
    const out = { ...output(), objective: true };
    bot.tactics.retake({ ...next, me: { ...next.me, defuseTicks: 270 }, bomb: { ...next.bomb, state: 'defusing', ticksLeft: 60 } }, out, plan, next.me.x, next.me.y, 'A');
    expect(out.objective).toBe(true);
    expect(out.task).toBe('defuse');
    expect(out.escape).toBe(false);
  });
  it('隊友正在拆且剩餘進度足夠時留下掩護；不能用完整十秒操作誤判全隊無望', () => {
    const { bot, next } = defuseFixture();
    bot.tactics.kits.delete(6);
    bot.tactics.defuseStarted.set(6, next.tick - 270);
    const out = output();
    bot.tactics.retake({ ...next, teammates: next.teammates.map((m) => ({ ...m, defusing: m.id === 6 })), bomb: { ...next.bomb, state: 'defusing', ticksLeft: 60 } }, out, plan, next.me.x, next.me.y, 'A');
    expect(out.task).toBe('cover');
    expect(out.escape).toBe(false);
  });
  it('全隊確實都來不及時才保槍', () => {
    const { bot, next } = defuseFixture();
    const out = output();
    bot.tactics.retake({ ...next, bomb: { ...next.bomb, ticksLeft: 90 } }, out, plan, next.me.x, next.me.y, 'A');
    expect(out.task).toBe('save');
    expect(out.objective).toBe(false);
  });
});

function fireObservation(pid: number, progress: number, hp = 100, lifetime = 240): ReturnType<typeof fixture> & { next: ShooterObservation } {
  const f = fixture(pid);
  const p = f.bot.intel.sites.A.plants[0];
  const plant = pid === 0;
  const next: ShooterObservation = { ...f.obs, round: { ...f.obs.round, phase: plant ? 'live' : 'planted' }, me: { ...f.obs.me, ...p, hp, hasBomb: plant, plantTicks: plant ? progress : 0, defuseTicks: plant ? 0 : progress, loadout: { ...f.obs.me.loadout, kit: true, grenades: [] } }, bomb: { state: plant ? 'carried' : 'defusing', site: plant ? null : 'A', ...p, ticksLeft: plant ? null : 900 }, effects: [{ kind: 'fire', ...p, radius: 3000, ticksLeft: lifetime, cells: burnCells(f.match.map, p.x, p.y, 3000) }] };
  f.bot.tactics.setPlan(plant ? { kind: 'rush', site: 'A', r1: 0, r2: 0, exec: 'A' } : plan, next);
  return { ...f, next };
}

describe('Bot 2.4.1：下／拆包的致命中斷與續作', () => {
  it.each([0, 5])('id %s 的致命火傷會中斷操作並送出移動，取消同批下／拆包', (pid) => {
    const { bot, next } = fireObservation(pid, 3, 10);
    const commands = bot.decide(next);
    expect(commands.some((c) => c.type === 'move')).toBe(true);
    expect(commands.some((c) => c.type === 'plant' || c.type === 'defuse')).toBe(false);
    expect(bot.why).toContain('離開火區');
  });
  it.each([0, 5])('id %s 接近完成且血量足夠時繼續，除錯文字不能宣稱已逃火', (pid) => {
    const { bot, next } = fireObservation(pid, pid === 0 ? 89 : 149);
    const commands = bot.decide(next);
    expect(commands.some((c) => c.type === 'move' || (c.type === 'fire' && c.on))).toBe(false);
    expect(bot.why).not.toContain('離開火區');
  });
  it('火即將熄滅、預計傷害不足致命時不放棄長操作', () => {
    const { bot, next } = fireObservation(5, 3, 100, 3);
    expect(bot.decide(next).some((c) => c.type === 'move')).toBe(false);
  });
  it('尚未開始的致命操作不能送出 defuse 後再覆蓋逃生指令', () => {
    const { bot, next } = fireObservation(5, 0);
    const commands = bot.decide({ ...next, bomb: { ...next.bomb, state: 'planted' } });
    expect(commands.some((c) => c.type === 'move')).toBe(true);
    expect(commands.some((c) => c.type === 'defuse')).toBe(false);
  });
});

function rig(options: { pair?: boolean; progress?: number; fire?: boolean; left?: number; kit?: boolean; singleDefuse?: boolean }): { driver: ShooterDriver; bots: Map<number, ShooterBaseline>; moves: number[] } {
  const bots = new Map<number, ShooterBaseline>();
  const moves = Array<number>(10).fill(0);
  const controllers = Array.from({ length: 10 }, (_, id) => new ScriptController(`audit-${id}`, (obs) => {
    if (id === 5 && options.singleDefuse) return obs.tick === 600 ? [{ type: 'defuse' }] : [];
    const commands = bots.get(id)?.decide(obs) ?? [];
    moves[id] += commands.filter((c) => c.type === 'move').length;
    return commands;
  }));
  const driver = new ShooterDriver({ seed: 11, mapId: 'redrock', controllers, record: false, defaultLoadout: { CT: 'm4', T: 'ak' }, reactionTicks: Array<number>(10).fill(5) });
  const m = driver.match;
  m.tick = 600; m.phase = 'planted'; m.phaseEnd = 600 + (options.left ?? 900);
  for (const a of m.players) { a.hasBomb = false; if (![0, 5, ...(options.pair ? [6] : [])].includes(a.id)) m.kill(a.id); }
  const probe = fixture().bot;
  const p = probe.intel.sites.A.plants[0];
  m.teleport(5, p.x, p.y, 0);
  m.players[5].kit = !options.pair && (options.kit ?? true);
  m.players[5].defuseTicks = options.progress ?? 0;
  if (options.pair) {
    const field = probe.judge!.field(p.x, p.y);
    const i = [...field].findIndex((d, j) => d >= 90 && d <= 100 && probe.g.walkable(j));
    const q = probe.g.center(i);
    m.teleport(6, q.x, q.y, 0); m.players[6].kit = true;
  }
  Object.assign(m.bomb, { state: 'planted', carrier: -1, ...p, site: 'A', explodeTick: m.phaseEnd, planter: 0, defuser: (options.progress ?? 0) > 0 ? 5 : -1 });
  if (options.fire) m.fires.push({ ...p, kind: 'molotov', owner: 0, startTick: 600, endTick: 840, cells: burnCells(m.map, p.x, p.y, 3000) });
  for (const id of options.pair ? [5, 6] : [5]) {
    const bot = new Bot();
    bot.init(shooterInitData(m.map, id, {}), shooterHelpers(m.map, 11, id));
    bot.newRound(m.observe(id)); bot.tactics.setPlan(plan, m.observe(id));
    if (options.pair) bot.tactics.kits.add(6);
    bots.set(id, bot);
  }
  return { driver, bots, moves };
}
function finish(driver: ShooterDriver, maxTicks = 850): void {
  for (let n = 0; n < maxTicks && driver.match.rounds.length === 0; n++) driver.step();
  expect(driver.runtime.map((r) => r.exceptions)).toEqual(Array<number>(10).fill(0));
  expect(driver.runtime.map((r) => r.timeouts)).toEqual(Array<number>(10).fill(0));
}

describe('Bot 2.4.1：真正產物＋引擎＋五 tick 指令延遲', () => {
  it.each([0, 3])('最近無 kit 者進度 %s：遠方 kit 者能在八秒內實際完成拆包', (progress) => {
    const { driver } = rig({ pair: true, progress, left: 240 });
    finish(driver, 241);
    expect(driver.match.rounds[0]?.reason).toBe('defuse');
    expect(driver.match.bomb.defuser).toBe(6);
  });
  it('剛開始拆包遇八秒火：逃出、存活，火熄後重試且拆成功', () => {
    const { driver, moves } = rig({ progress: 3, fire: true });
    finish(driver);
    expect(moves[5]).toBeGreaterThan(0);
    expect(driver.match.players[5].alive).toBe(true);
    expect(driver.match.rounds[0]?.reason).toBe('defuse');
  });
  it('差一瞬完成：留在火內拆完，沒有取消操作', () => {
    const { driver, moves } = rig({ progress: 149, fire: true });
    finish(driver, 10);
    expect(driver.match.rounds[0]?.reason).toBe('defuse');
    expect(driver.match.players[5].alive).toBe(true);
    expect(moves[5]).toBe(0);
  });
});

describe('Bot 2.4.1：可靠清點與購用一致性', () => {
  it('狙擊手在入口外等隊友先進時，停下並開鏡提供掩護', () => {
    const { bot, obs } = fixture(4);
    const site = bot.intel.sites.A;
    const i = [...bot.intel.distSite.A].findIndex((d, j) => d >= 20 && d <= 40 && bot.g.walkable(j));
    const p = bot.g.center(i);
    const next: ShooterObservation = { ...obs, me: { ...obs.me, ...p, weapon: 'awp', loadout: { ...obs.me.loadout, primary: 'awp', grenades: [] } }, teammates: obs.teammates.map((m) => ({ ...m, alive: m.id === 0 || m.id === 1 })) };
    bot.tactics.setPlan({ kind: 'split', site: 'A', r1: 0, r2: 1, exec: 'A' }, next);
    bot.tactics.execTick = obs.tick - 600;
    expect(p.x < site.rect.x0 * 1000 || p.y < site.rect.y0 * 1000 || p.x >= site.rect.x1 * 1000 || p.y >= site.rect.y1 * 1000).toBe(true);
    const commands = bot.decide(next);
    expect(bot.why).toContain('等隊友先進');
    expect(commands.some((c) => c.type === 'move')).toBe(false);
    expect(commands.some((c) => c.type === 'scope' && c.on)).toBe(true);
  });

  it('本人 effects 看不到遠方隊友的煙；煙後敵人不能被幾何視錐排除', () => {
    const { bot, match } = fixture();
    const p = bot.intel.sites.A.plants[0];
    const i = [...Array(bot.g.N).keys()].find((j) => {
      const q = bot.g.center(j); const d = dist(p.x, p.y, q.x, q.y);
      return bot.g.walkable(j) && d >= 8000 && d <= 10000 && bot.g.los(p.x, p.y, q.x, q.y);
    })!;
    const q = bot.g.center(i);
    const smoke = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    for (const a of match.players) if (![0, 5, 6].includes(a.id)) match.kill(a.id);
    const h = shooterHelpers(match.map, 11, 5);
    match.teleport(0, q.x, q.y, 0); match.teleport(6, p.x, p.y, h.angleTo(p.x, p.y, q.x, q.y));
    const far = [...Array(bot.g.N).keys()].find((j) => bot.g.walkable(j) && dist(bot.g.center(j).x, bot.g.center(j).y, smoke.x, smoke.y) > 40000)!;
    const me = bot.g.center(far);
    match.teleport(5, me.x, me.y, h.angleTo(me.x, me.y, smoke.x, smoke.y) + 180);
    match.smokes.push({ ...smoke, startTick: 500, endTick: 1100, owner: 0 });
    const first = match.observe(5); bot.newRound(first); bot.perc.update({ ...first, radar: [{ id: 0, ...q }] });
    match.tick = 615;
    const second = match.observe(5); bot.perc.update(second);
    expect(second.effects).toEqual([]); expect(second.radar).toEqual([]);
    expect(bot.perc.seenTick[i]).toBeLessThan(600);
    expect(bot.perc.belief.tracks.get(0)?.cells.has(i)).toBe(true);
  });
  it.each([0, 5])('陣營代表 id %s 的每種角色只買一閃；留存一閃時不重複買', (pid) => {
    const { bot, obs } = fixture(pid);
    for (let role = 0; role <= 5; role++) {
      const rich = { ...obs, round: { ...obs.round, number: 2 }, me: { ...obs.me, money: 16000, loadout: { ...obs.me.loadout, primary: null, grenades: [] } } };
      const items = bot.tactics.econ.items(rich, 'full', role, false);
      expect(items.filter((x) => x === 'flash')).toHaveLength(1);
      const holding: ShooterObservation = { ...rich, me: { ...rich.me, loadout: { ...rich.me.loadout, grenades: ['flash'] } } };
      expect(bot.tactics.econ.items(holding, 'full', role, false).filter((x) => x === 'flash')).toHaveLength(0);
      bot.tactics.util.reset();
      expect(bot.tactics.util.has(holding.me, 'flash')).toBe(true);
      bot.tactics.util.used.add('flash');
      expect(bot.tactics.util.has({ ...holding.me, loadout: { ...holding.me.loadout, grenades: [] } }, 'flash')).toBe(false);
    }
  });
});

describe('Bot 建置：刪除註解說明不改語意', () => {
  it('保留多行 template 中的註解形狀、空行、插值、raw 值、行內轉型與 ASI', () => {
    const text = ['/** 中文說明 @type {string} */', 'const text = `開始', '  // 字串內的文字', '  /** 這也是文字 @type {string} */', '', '', '結束 ${(() => {', '  // 真正的註解', '  return 7;', '})()}`;', 'const raw = String.raw`\\n`;', 'const cast = /** @type {number} */ (3);', 'function asi() { return', '`不能接成回傳值`; }'].join('\n');
    const packed = compactIndent(stripComments(text.split('\n')).join('\n'));
    const ast = (source: string): string => JSON.stringify(parse(source, { ecmaVersion: 2020, sourceType: 'module' }), (k, v: unknown) => k === 'start' || k === 'end' ? undefined : v);
    expect(ast(packed)).toBe(ast(text));
    expect(packed).toContain('/** @type {string} */');
    expect(packed).toContain('/** @type {number} */');
    expect(packed).toContain('文字 @type {string} */\n\n\n結束');
  });
});

describe('Bot 2.4.2 複審：火區資訊更新', () => {
  it('真實煙已滅火：本次決策先解除記憶與導航危險，八秒內實際拆成功', () => {
    const { driver, bots } = rig({ left: 240 });
    const m = driver.match;
    const bot = bots.get(5)!;
    const p = bot.intel.sites.A.plants[0];
    m.fires.push({ ...p, kind: 'molotov', owner: 0, startTick: 594, endTick: 810, cells: burnCells(m.map, p.x, p.y, 3000) });
    driver.step();
    expect(bot.combat.fires.size).toBe(1);
    m.smokes.push({ ...p, owner: 5, startTick: 500, endTick: 1000 });
    while (m.tick <= 603) driver.step();
    expect(m.fires).toHaveLength(0);
    expect(m.observe(5).effects.some((e) => e.kind === 'smoke')).toBe(true);
    expect(bot.combat.fires.size).toBe(0);
    expect(bot.nav.hazard.size).toBe(0);
    expect(bot.why).not.toContain('避火待拆包');
    finish(driver, 250);
    expect(m.rounds[0]?.reason).toBe('defuse');
  });

  it('轉身或被閃而 effects 沒火，不能清除已觀察的火區', () => {
    const { bot, obs, match } = fixture();
    const p = bot.intel.sites.A.plants[0];
    const cells = burnCells(match.map, p.x, p.y, 3000);
    bot.combat.evade({ ...obs, me: { ...obs.me, ...p }, effects: [{ kind: 'fire', ...p, radius: 3000, cells, ticksLeft: 210 }] });
    for (const blindTicks of [0, 30]) {
      bot.combat.evade({ ...obs, tick: 603, me: { ...obs.me, x: p.x + 10000, y: p.y, facing: 0, blindTicks }, effects: [] });
      expect(bot.combat.fires.size).toBe(1);
      expect(bot.nav.hazard.has(bot.g.cellOf(p.x, p.y))).toBe(true);
    }
  });

  it.each([-1, 0, 1])('兩圓相切邊界偏移 %s 單位：只有嚴格重疊才熄滅整團火', (delta) => {
    const { bot, obs, match } = fixture();
    const p = bot.intel.sites.A.plants[0];
    const cells = burnCells(match.map, p.x, p.y, 3000);
    bot.combat.evade({ ...obs, effects: [{ kind: 'fire', ...p, radius: 3000, cells, ticksLeft: 210 }] });
    bot.combat.evade({ ...obs, tick: 603, effects: [{ kind: 'smoke', x: p.x + 6000 + delta, y: p.y, radius: 3000, ticksLeft: 400 }] });
    expect(bot.combat.fires.size).toBe(delta < 0 ? 0 : 1);
    expect(cells.some((c) => bot.nav.hazard.has(c))).toBe(delta >= 0);
  });

  it('已觀察的煙依公開規則擴散，離開視野後在真正重疊時解除；到期不掩蓋新火', () => {
    const { bot, obs, match } = fixture();
    const p = bot.intel.sites.A.plants[0];
    const cells = burnCells(match.map, p.x, p.y, 3000);
    bot.combat.evade({ ...obs, effects: [{ kind: 'fire', ...p, radius: 3000, cells, ticksLeft: 210 }, { kind: 'smoke', x: p.x + 5000, y: p.y, radius: 1000, ticksLeft: 530 }] });
    expect(bot.combat.fires.size).toBe(1);
    bot.combat.evade({ ...obs, tick: 610, effects: [] });
    expect(bot.combat.fires.size).toBe(1); // 2000 + 3000 恰好相切。
    bot.combat.evade({ ...obs, tick: 611, effects: [] });
    expect(bot.combat.fires.size).toBe(0);
    expect(bot.nav.hazard.size).toBe(0);
    bot.combat.evade({ ...obs, tick: 1130, effects: [{ kind: 'fire', ...p, radius: 3000, cells, ticksLeft: 210 }] });
    expect(bot.combat.fires.size).toBe(1);
  });

  it('不相交的另一團火仍有危險；新回合不能用舊煙壓掉新火', () => {
    const { bot, obs, match } = fixture();
    const p = bot.intel.sites.A.plants[0];
    const j = [...Array(bot.g.N).keys()].find((i) => bot.g.walkable(i) && dist(p.x, p.y, bot.g.center(i).x, bot.g.center(i).y) > 15000)!;
    const q = bot.g.center(j);
    const fire = { kind: 'fire' as const, ...p, radius: 3000, cells: burnCells(match.map, p.x, p.y, 3000), ticksLeft: 210 };
    bot.combat.evade({ ...obs, effects: [fire, { kind: 'fire', ...q, radius: 3000, cells: [j], ticksLeft: 210 }] });
    bot.combat.evade({ ...obs, tick: 603, effects: [{ kind: 'smoke', ...p, radius: 3000, ticksLeft: 400 }] });
    expect(bot.combat.fires.size).toBe(1);
    expect(bot.nav.hazard.has(j)).toBe(true);
    bot.newRound({ ...obs, round: { ...obs.round, number: obs.round.number + 1 } });
    bot.combat.evade({ ...obs, effects: [fire] });
    expect(bot.combat.fires.size).toBe(1);
    expect(bot.nav.hazard.has(bot.g.cellOf(p.x, p.y))).toBe(true);
  });
});

const deadlines = [true, false].flatMap((kit) => [true, false].flatMap((active) => [-1, 0, 1].map((slack) => {
  const duration = kit ? 150 : 300;
  const progress = active ? duration - 90 : 0;
  const completion = active ? 90 : 5 + duration - 1;
  return { kit, active, slack, progress, completion, left: completion + slack };
})));
describe('Bot 2.4.2 複審：完成／爆炸逐 tick 邊界', () => {
  it.each(deadlines)('kit=$kit，進行中=$active，期限餘量=$slack tick', ({ kit, active, progress, completion, left, slack }) => {
    const candidate = rig({ kit, progress, left });
    const control = rig({ kit, progress, left, singleDefuse: !active });
    if (active) control.bots.clear(); // 讓既有拆包自然繼續；不發任何新指令。
    finish(candidate.driver, left + 10);
    finish(control.driver, left + 10);
    const expected = slack >= 0 ? 'defuse' : 'bomb';
    expect(control.driver.match.rounds[0]?.reason).toBe(expected);
    expect(candidate.driver.match.rounds[0]?.reason).toBe(expected);
    expect(candidate.driver.match.rounds[0]?.endTick).toBe(600 + (slack >= 0 ? completion : left));
    if (active && slack >= 0) expect(candidate.moves[5]).toBe(0);
  });
  it('引爆當 tick 已到最後一步，仍先完成拆包，不能因倒數零而取消', () => {
    const { driver, moves } = rig({ kit: true, progress: 150, left: 0 });
    finish(driver, 10);
    expect(driver.match.rounds[0]?.reason).toBe('defuse');
    expect(driver.match.rounds[0]?.endTick).toBe(600);
    expect(moves[5]).toBe(0);
  });
});

describe('Bot 2.4.2 複審：強起護甲預算', () => {
  it.each([0, 5])('陣營代表 id %s：突破／支援在可負擔邊界買槍，已有滿甲不再預留甲錢', (pid) => {
    const { bot, obs } = fixture(pid);
    bot.tactics.econ.roundInHalf = 2;
    const rifle = pid === 0 ? 'ak' : 'm4';
    const rifleCost = bot.tactics.econ.cost(rifle);
    const smgCost = bot.tactics.econ.cost('smg');
    for (const role of [1, 2]) for (const armor of [0, 50, 100]) for (const gun of [rifle, 'smg'] as const) {
      const price = gun === 'smg' ? smgCost : rifleCost;
      const budget = price + (armor < 100 ? 650 : 0);
      const next = { ...obs, me: { ...obs.me, money: budget, loadout: { ...obs.me.loadout, primary: null, armor, kit: false, grenades: [] } } };
      const items = bot.tactics.econ.items(next, 'force', role, false);
      expect(items, JSON.stringify({ role, armor, gun, budget })).toContain(gun);
      expect(items.filter((x) => x === 'armor')).toHaveLength(armor < 100 ? 1 : 0);
      const short = bot.tactics.econ.items({ ...next, me: { ...next.me, money: budget - 1 } }, 'force', role, false);
      expect(short).not.toContain(gun);
    }
  });
  it.each([0, 5])('id %s：真正引擎以 1900 買得起一甲一衝鋒槍，已有步槍則保留', (pid) => {
    const m = new ShooterMatch({ seed: 11, mapId: 'redrock' });
    m.players[pid].money = 1900; m.players[pid].armor = 0; m.players[pid].primary = null; m.players[pid].kit = false;
    const bot = new Bot();
    bot.init(shooterInitData(m.map, pid, {}), shooterHelpers(m.map, 11, pid));
    bot.tactics.econ.roundInHalf = 2;
    const obs = m.observe(pid);
    const items = bot.tactics.econ.items(obs, 'force', 1, false);
    expect(items.slice(0, 2)).toEqual(['armor', 'smg']);
    m.applyCommands(pid, [{ type: 'buy', items }]);
    expect(m.observe(pid).me.loadout.primary).toBe('smg');
    expect(m.players[pid].armor).toBe(100);
    expect(m.players[pid].money).toBe(0);
    const rifle = pid === 0 ? 'ak' as const : 'm4' as const;
    const keep = bot.tactics.econ.items({ ...obs, me: { ...obs.me, loadout: { ...obs.me.loadout, primary: rifle } } }, 'force', 1, false);
    expect(keep.some((x) => x === 'ak' || x === 'm4' || x === 'smg')).toBe(false);
  });
});

function rally(site: 'A' | 'B' = 'B', farKit = false): ReturnType<typeof fixture> & { next: ShooterObservation; p: { x: number; y: number }; left: number } {
  const f = fixture();
  const p = f.bot.intel.sites[site].plants[0];
  const stage = f.bot.tactics.stageSpots('CT', site, 0);
  expect(stage.length).toBeGreaterThan(0);
  const travel = f.bot.judge!.travel({ ...stage[0], weapon: 'm4' }, p.x, p.y);
  const left = Math.ceil((travel + 11) * 30);
  const i = [...Array(f.bot.g.N).keys()].find((j) => {
    if (!f.bot.g.walkable(j)) return false;
    const q = f.bot.g.center(j);
    const eta = f.bot.judge!.travel({ ...q, weapon: 'm4' }, p.x, p.y);
    return !f.bot.tactics.inSite(q.x, q.y, site, p.x, p.y) && eta + (farKit ? 5 : 10) > left / 30 && (farKit || eta + 7 < left / 30) && stage.every((s) => dist(q.x, q.y, s.x, s.y) > 4000);
  });
  expect(i).not.toBeUndefined();
  const q = f.bot.g.center(i!);
  const next: ShooterObservation = { ...f.obs, round: { ...f.obs.round, phase: 'planted', phaseTicksLeft: left }, me: { ...f.obs.me, x: stage[0].x, y: stage[0].y, weapon: 'm4', loadout: { ...f.obs.me.loadout, primary: 'm4', kit: false, grenades: [] } }, teammates: f.obs.teammates.map((m) => ({ ...m, ...q, alive: m.id === 6, weapon: 'm4' })), bomb: { state: 'planted', ...p, site, ticksLeft: left } };
  f.bot.tactics.setPlan({ ...plan, rot: site, go: false }, next);
  if (farKit) f.bot.tactics.kits.add(6);
  return { ...f, next, p, left };
}

describe('Bot 2.4.3 複審：集結與拆包使用同一套逐人判準', () => {
  it('死亡 kit 持有人即使仍在記憶，也不能降低其他人的拆包時間', () => {
    const { bot, next, p } = rally();
    bot.tactics.kits.add(7); // 曾公開喊過 kit，現在已死亡；先於 trackTeam 清理測判斷本身。
    const team = bot.tactics.defuseTeam(next, p.x, p.y);
    expect(team.map((m) => m.id)).toEqual([5, 6]);
    expect(team.every((m) => !m.kit)).toBe(true);
    expect(team.find((m) => m.id === 6)!.eta).toBeGreaterThan(next.bomb.ticksLeft! / 30);
    expect(bot.tactics.retakeReady(next, 'B')).toBe(true);
    bot.decide(next);
    expect(bot.tactics.kits.has(7)).toBe(false);
    expect(bot.tactics.plan?.kind === 'hold' && bot.tactics.plan.go).toBe(true);
    expect(bot.why).not.toContain('回防集結');
  });
  it.each(['A', 'B'] as const)('真實引擎 %s 點：死亡 kit 歷史不延後 go，無 kit 者實際拆成功', (site) => {
    const f = rally(site);
    let goTick = -1;
    const controllers = Array.from({ length: 10 }, (_, id) => new ScriptController(`rally-${id}`, (obs) => {
      if (id !== 5) return [];
      const commands = f.bot.decide(obs);
      if (goTick < 0 && f.bot.tactics.plan?.kind === 'hold' && f.bot.tactics.plan.go) goTick = obs.tick;
      return commands;
    }));
    const d = new ShooterDriver({ seed: 11, mapId: 'redrock', controllers, record: false, reactionTicks: Array<number>(10).fill(5), defaultLoadout: { CT: 'm4', T: 'ak' } });
    const m = d.match;
    m.tick = 600; m.phase = 'planted'; m.phaseEnd = 600 + f.left;
    for (const a of m.players) { a.hasBomb = false; if (![0, 5, 6].includes(a.id)) m.kill(a.id); }
    m.teleport(5, f.next.me.x, f.next.me.y, 0);
    const mate = f.next.teammates.find((q) => q.id === 6)!;
    m.teleport(6, mate.x, mate.y, 0);
    m.players[5].kit = false; m.players[6].kit = false; m.players[5].grenades = [];
    Object.assign(m.bomb, { state: 'planted', carrier: -1, ...f.p, site, explodeTick: m.phaseEnd, planter: 0, defuser: -1 });
    f.bot.newRound(m.observe(5));
    f.bot.tactics.setPlan({ ...plan, rot: site, go: false }, m.observe(5));
    f.bot.tactics.kits.add(7);
    finish(d, f.left + 10);
    expect(goTick).toBe(600);
    expect(m.rounds[0]?.reason).toBe('defuse');
  });
  it('存活 kit 者太遠仍排除；不能因有人有 kit 而讓近處無 kit 者繼續等', () => {
    const { bot, next, p } = rally('B', true);
    const team = bot.tactics.defuseTeam(next, p.x, p.y);
    expect(team.find((m) => m.id === 6)?.kit).toBe(true);
    expect(team.find((m) => m.id === 6)!.eta).toBeGreaterThan(next.bomb.ticksLeft! / 30);
    expect(bot.tactics.retakeReady(next, 'B')).toBe(true);
  });
  it('遠方無 kit 者來不及拆，不因其仍存活就等待', () => {
    const { bot, next, p } = rally();
    const team = bot.tactics.defuseTeam(next, p.x, p.y);
    expect(team.find((m) => m.id === 5)!.eta).toBeLessThan(next.bomb.ticksLeft! / 30);
    expect(team.find((m) => m.id === 6)!.eta).toBeGreaterThan(next.bomb.ticksLeft! / 30);
    expect(bot.tactics.retakeReady(next, 'B')).toBe(true);
  });
  it('正常多人有充足時間則等集結，皆就位後才 go', () => {
    const { bot, next } = rally();
    const plenty = { ...next, bomb: { ...next.bomb, ticksLeft: 1800 } };
    expect(bot.tactics.retakeReady(plenty, 'B')).toBe(false);
    const sp = bot.tactics.stageSpots('CT', 'B', 0)[1];
    const ready = { ...plenty, teammates: plenty.teammates.map((m) => ({ ...m, x: sp.x, y: sp.y })) };
    expect(bot.tactics.retakeReady(ready, 'B')).toBe(true);
  });
  it('已進行中的拆包不再等待遠方可加入的隊友', () => {
    const { bot, next, p } = rally();
    const active = { ...next, me: { ...next.me, ...p, defuseTicks: 60, loadout: { ...next.me.loadout, kit: true } }, bomb: { ...next.bomb, state: 'defusing' as const, ticksLeft: 900 } };
    expect(bot.tactics.retakeReady(active, 'B')).toBe(true);
  });
  it('來不及完成的突破手不能在 go 後再擋住入口等待', () => {
    const { bot, next, p } = rally();
    bot.tactics.roles = new Roles(bot.tactics.ids, 5, 4, 4);
    bot.tactics.roles.hear(6, 1);
    expect(bot.tactics.roles.who(1)).toBe(6);
    const out = output();
    bot.tactics.retake(next, out, plan, p.x, p.y, 'B');
    expect(out.role).not.toBe('等突破手先進');
    expect(out.task).toBe('defuse');
  });
  it('死亡者延遲抵達的 kit 喊話不重新污染記憶', () => {
    const { bot, next } = rally();
    bot.tactics.readChat({ ...next, chat: [{ from: 7, text: 'E:kit' }] });
    bot.tactics.readChat({ ...next, tick: 660 });
    expect(bot.tactics.kits.has(7)).toBe(false);
  });
});

function attributedDefuse(seed: number, reaction: number, left: number, control: boolean): { driver: ShooterDriver; bot: ShooterBaseline; sent: number } {
  const bot = new Bot();
  let sent = 0;
  const map = MAPS.redrock();
  const controllers: ShooterController[] = Array.from({ length: 10 }, (_, id) => {
    const script = new ScriptController(`delay-${id}`, (obs) => {
      if (id !== 5) return [];
      if (control) return obs.tick === 600 ? [{ type: 'defuse' }] : [];
      const commands = bot.decide(obs);
      sent += commands.filter((c) => c.type === 'defuse').length;
      return commands;
    });
    if (id !== 5) return script;
    return { label: script.label, declaration: bot.declare(), init: (data: ShooterInitData) => { bot.init(data, shooterHelpers(map, seed, id)); return script.init(); }, decide: (obs: ShooterObservation) => script.decide(obs) };
  });
  const d = new ShooterDriver({ seed, mapId: 'redrock', controllers, record: false, defaultLoadout: { CT: 'm4', T: 'ak' }, attributes: Array.from({ length: 10 }, () => ({ ...DEFAULT_ATTRIBUTES, reaction })) });
  const m = d.match;
  m.tick = 600; m.phase = 'planted'; m.phaseEnd = 600 + left;
  for (const a of m.players) { a.hasBomb = false; if (![0, 5].includes(a.id)) m.kill(a.id); }
  const p = bot.intel.sites.A.plants[0];
  m.teleport(5, p.x, p.y, 0); m.players[5].kit = true; m.players[5].grenades = [];
  Object.assign(m.bomb, { state: 'planted', carrier: -1, ...p, site: 'A', explodeTick: m.phaseEnd, planter: 0, defuser: -1 });
  bot.newRound(m.observe(5)); bot.tactics.setPlan(plan, m.observe(5));
  finish(d, left + 10);
  return { driver: d, bot, sent };
}

describe('Bot 2.4.3：真正屬性驅動的機率式延遲', () => {
  it.each([69, 66].flatMap((reaction) => [154, 155].map((left) => ({ reaction, left }))))('reaction=$reaction，倒數 $left tick：臨界盡力嘗試，結果與相同種子的單次拆包對照一致', ({ reaction, left }) => {
    const endings = new Set<number>();
    const reasons = new Set<string>();
    for (let seed = 1; seed <= 24; seed++) {
      const control = attributedDefuse(seed, reaction, left, true);
      const actual = attributedDefuse(seed, reaction, left, false);
      expect(actual.bot.data.rules.reactionTicks).toBe(reaction === 69 ? 5 : 6);
      expect(actual.bot.tactics.delayMin).toBe(5);
      expect(actual.bot.tactics.delayMax).toBe(6);
      expect(actual.sent).toBe(1);
      const a = actual.driver.match.rounds[0], c = control.driver.match.rounds[0];
      expect(a?.reason).toBe(c?.reason);
      expect(a?.endTick).toBe(c?.endTick);
      endings.add(c!.endTick); reasons.add(c!.reason);
    }
    if (left === 155) { expect(reasons).toEqual(new Set(['defuse'])); expect(endings).toEqual(new Set([754, 755])); }
    else expect(reasons).toEqual(new Set(['defuse', 'bomb']));
  }, 30000);
});
