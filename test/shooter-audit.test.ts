import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { compileBot } from '../src/sandbox/compile.ts';
import type ShooterBaseline from '../bots/shooter-src/baseline.js';
import type { CTPlan, TacOut } from '../bots/shooter-src/tactics.js';
import type { ShooterObservation } from '../src/shooter/api.ts';
import { dist } from '../bots/shooter-src/base.js';
import { burnCells, ShooterMatch, shooterInitData } from '../src/shooter/sim.ts';
import { ScriptController, ShooterDriver, shooterHelpers } from '../src/shooter/runner.ts';
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

function rig(options: { pair?: boolean; progress?: number; fire?: boolean; left?: number }): { driver: ShooterDriver; bots: Map<number, ShooterBaseline>; moves: number[] } {
  const bots = new Map<number, ShooterBaseline>();
  const moves = Array<number>(10).fill(0);
  const controllers = Array.from({ length: 10 }, (_, id) => new ScriptController(`audit-${id}`, (obs) => {
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
  m.players[5].kit = !options.pair;
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
