// @ts-check
// 任務的期限與中斷政策。每次重算可行性，已失效的保槍／換血／道具準備不永久鎖住下一個任務。
export class Mission {
  /** @param {import('./base.js').InitData} data @param {import('./judgment.js').Judgment} judge */
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
   * 火傷會先致命才中斷；已接近完成、或火會提早熄滅則繼續。未知所有者以敵火保守估算。
   * 走向操作點時也檢查預計到達後的火傷，避免反覆走進火裡又逃出來。
   * @param {import('./base.js').Observation} obs @param {import('./tactics.js').TacOut} out
   * @param {import('./combat.js').Combat['fires'] | undefined} fires @param {import('./nav.js').Navigator | null} nav
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
  /** @param {import('./base.js').Observation} obs @param {import('./tactics.js').TacOut} out */
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
