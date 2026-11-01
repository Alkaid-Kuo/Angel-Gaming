// @ts-check
// 任務的期限與中斷政策。每次重算可行性，已失效的保槍／換血／道具準備不永久鎖住下一個任務。
export class Mission {
  /** @param {import('./base.js').InitData} data @param {import('./judgment.js').Judgment} judge */
  constructor(data, judge) {
    this.rules = data.rules;
    this.judge = judge;
    this.key = '';
    this.since = -1;
    this.changes = 0;
    this.critical = false;
    this.reason = '';
  }
  reset() { this.key = ''; this.since = -1; this.changes = 0; this.critical = false; this.reason = ''; }
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
