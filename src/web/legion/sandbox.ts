// 軍團戰自訂對戰（沙盒）：平地測試場上自動面對面擺放、布陣驗證，以及沙盒用的控制器（待命不動、直接進攻、用現有 AI 指揮指定的兵團）。
import type { Deployment, LegionDeclaration, LegionInitData, LegionObservation } from '../../legion/api.ts';
import { RULES, TILE, UNITS, walkable, type FormationKind, type UnitKind } from '../../legion/config.ts';
import { formationShape } from '../../legion/formation.ts';
import type { LegionMap } from '../../legion/map.ts';
import type { CallOutcome, LegionController } from '../../legion/runner.ts';
import { LegionMatch } from '../../legion/sim.ts';
import type { SandboxSetup, SandboxUnit } from './protocol.ts';

export const SANDBOX_MAP = 'test-field';
/** 沙盒的時間上限：20 分鐘 */
export const SANDBOX_TICKS = 20 * 60 * 10;

const ok = <T>(value: T): CallOutcome<T> => ({ value, exception: null, killed: false, elapsedMs: 0 });

/** 一團預設陣形的尺寸（半寬：沿著正面方向；半深：前後方向） */
function size(kind: UnitKind, formation: FormationKind): { halfW: number; halfD: number; rad: number } {
  const u = UNITS[kind];
  const depth = Math.max(2, Math.ceil(u.men / u.squareWidth));
  return formationShape(formation, u.men, u.lineWidth, depth, u.spacingX, u.spacingY);
}

/** 前排、後排、側翼 */
const ROW: Record<UnitKind, 'front' | 'back' | 'flank'> = { spear: 'front', sword: 'front', shield: 'front', light: 'front', archer: 'back', lightCav: 'flank', heavyCav: 'flank' };

/**
 * 自動面對面：以地圖中央為準，藍方在西、紅方在東，前排相距 distance 格。
 * 步兵排成前排（南北一列），騎兵接在前排兩端，弓兵在前排後方 7 格；一列太長（超過 64 格）就往後再起一列。
 */
export function faceOff(armies: SandboxSetup['armies'], distance: number, map: LegionMap): [SandboxUnit[], SandboxUnit[]] {
  const cx = (map.width * TILE) / 2;
  const cy = (map.height * TILE) / 2;
  const out: [SandboxUnit[], SandboxUnit[]] = [[], []];
  for (const p of [0, 1]) {
    const dir = p === 0 ? -1 : 1;
    const facing = p === 0 ? 0 : 180;
    const kinds = armies[p];
    const front = kinds.map((k, i) => ({ k, i })).filter((u) => ROW[u.k] === 'front');
    const flank = kinds.map((k, i) => ({ k, i })).filter((u) => ROW[u.k] === 'flank');
    const back = kinds.map((k, i) => ({ k, i })).filter((u) => ROW[u.k] === 'back');
    // 前排：騎兵分到兩端；沒有步兵時騎兵或弓兵自己當前排
    const lineup = [...flank.filter((_, j) => j % 2 === 1).reverse(), ...front, ...flank.filter((_, j) => j % 2 === 0)];
    const rows = lineup.length > 0 ? [lineup, back] : [back];
    const slots: SandboxUnit[] = new Array<SandboxUnit>(kinds.length);
    let depth = 0;
    for (const row of rows) {
      if (row.length === 0) continue;
      // 依寬度切成幾列
      const lines: (typeof row)[] = [[]];
      let width = 0;
      for (const u of row) {
        const w = 2 * size(u.k, UNITS[u.k].formations[0]).halfW + 1.5 * TILE;
        if (width + w > 64 * TILE && lines[lines.length - 1].length > 0) {
          lines.push([]);
          width = 0;
        }
        lines[lines.length - 1].push(u);
        width += w;
      }
      for (const line of lines) {
        const ws = line.map((u) => 2 * size(u.k, UNITS[u.k].formations[0]).halfW + 1.5 * TILE);
        const halfD = Math.max(...line.map((u) => size(u.k, UNITS[u.k].formations[0]).halfD));
        const x = cx + dir * ((distance * TILE) / 2 + depth + halfD);
        let y = cy - ws.reduce((t, w) => t + w, 0) / 2;
        line.forEach((u, j) => {
          slots[u.i] = { kind: u.k, x: Math.round(x), y: Math.round(y + ws[j] / 2), facing, formation: UNITS[u.k].formations[0] };
          y += ws[j];
        });
        depth += 2 * halfD + 5 * TILE;
      }
    }
    out[p] = slots;
  }
  return out;
}

/** 布陣轉成引擎的 deploy() 格式 */
export function toDeployment(units: readonly SandboxUnit[]): Deployment[] {
  return units.map((u) => ({ type: u.kind, x: u.x, y: u.y, facing: u.facing, formation: u.formation }));
}

/** 檢查一組布陣：每一團都要擺得下（可通行、不重疊、不出界）。合格回傳空字串，否則回傳原因 */
export function checkPlacement(placement: readonly [readonly SandboxUnit[], readonly SandboxUnit[]], map: LegionMap): string {
  for (const side of placement) {
    for (const u of side) {
      const tx = Math.floor(u.x / TILE);
      const ty = Math.floor(u.y / TILE);
      if (tx < 1 || ty < 1 || tx >= map.width - 1 || ty >= map.height - 1) return '超出地圖';
      if (!walkable(map.terrain[ty * map.width + tx])) return '那裡不能站（河流或建築）';
    }
  }
  const m = new LegionMatch({ seed: 0, mode: 'annihilation', mapId: SANDBOX_MAP, deployments: placement.map(toDeployment), sandbox: true });
  const rejected = [0, 1].flatMap((p) => m.observe(p).events).filter((e) => e.type === 'deployRejected');
  if (rejected.length > 0) return (rejected[0] as { reason: string }).reason.replace(/^與第 \d+ 個軍團重疊$/, '跟其他軍團重疊了');
  return '';
}

/** 沙盒控制器共用：deploy 回傳指定的布陣 */
abstract class FixedController implements LegionController {
  abstract readonly label: string;
  abstract readonly declaration: LegionDeclaration;
  protected readonly units: Deployment[];

  constructor(units: Deployment[]) {
    this.units = units;
  }

  init(): CallOutcome<null> {
    return ok(null);
  }

  deploy(): CallOutcome<unknown> {
    return ok(this.units);
  }

  abstract decide(obs: LegionObservation): CallOutcome<unknown>;
}

/** 待命：自己不下指令（軍團照引擎的預設反應：被近身就還手），但玩家可以替它下指令（測試對方架槍林、盾牆等） */
export class IdleController extends FixedController {
  readonly label = 'idle';
  readonly declaration: LegionDeclaration = { name: '待命', version: '', style: '自己不會動，你可以替它下指令', knobs: [] };
  private queue: unknown[] = [];

  push(cmds: readonly unknown[]): void {
    this.queue.push(...cmds);
  }

  decide(): CallOutcome<unknown> {
    return ok(this.queue.splice(0, RULES.commandsPerDecision));
  }
}

/** 直接進攻：每一團打最近的看得到的敵人；騎兵衝鋒好了、距離合適就衝；都看不到就往敵軍開戰時的位置邊走邊打 */
export class AttackController extends FixedController {
  readonly label = 'attack';
  readonly declaration: LegionDeclaration = { name: '直接進攻', version: '', style: '全軍朝最近的敵人攻過去', knobs: [] };
  private readonly toward: { x: number; y: number };

  constructor(units: Deployment[], toward: { x: number; y: number }) {
    super(units);
    this.toward = toward;
  }

  decide(obs: LegionObservation): CallOutcome<unknown> {
    const cmds: unknown[] = [];
    const foes = obs.enemies.filter((e) => !e.routed);
    for (const r of obs.regiments) {
      if (r.reserve || r.routed || r.dashing !== null || cmds.length >= RULES.commandsPerDecision) continue;
      let best = null;
      let bestD = Infinity;
      for (const e of foes) {
        const d = Math.hypot(e.x - r.x, e.y - r.y);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
      if (best === null) {
        if (r.order !== 'attackMove') cmds.push({ type: 'attackMove', id: r.id, x: Math.round(this.toward.x), y: Math.round(this.toward.y), intent: '直接進攻：找敵人' });
        continue;
      }
      const cav = UNITS[r.kind].cavalry;
      const gap = (bestD - r.radius - best.radius) / TILE;
      if (cav && r.skillCooldown === 0 && !r.engaged && gap >= 4 && gap <= 20) {
        cmds.push({ type: 'charge', id: r.id, x: best.x, y: best.y, intent: `直接進攻：衝鋒${UNITS[best.kind].name}` });
        continue;
      }
      if (r.target !== best.id || r.order !== 'attack') cmds.push({ type: 'attack', id: r.id, target: best.id, intent: `直接進攻：打${UNITS[best.kind].name}` });
    }
    return ok(cmds);
  }
}

/** 用現有 AI 指揮指定的兵團：AI 照常初始化與布陣（讓它建立自己的計畫），實際上場的換成指定的兵團，之後的決策都交給它 */
export class SquadController implements LegionController {
  private readonly inner: LegionController;
  private readonly units: Deployment[];

  constructor(inner: LegionController, units: Deployment[]) {
    this.inner = inner;
    this.units = units;
  }

  get label(): string {
    return this.inner.label;
  }

  get declaration(): LegionDeclaration {
    return this.inner.declaration;
  }

  init(data: LegionInitData): CallOutcome<null> {
    return this.inner.init(data);
  }

  deploy(data: LegionInitData): CallOutcome<unknown> {
    const out = this.inner.deploy(data);
    return { ...out, value: this.units };
  }

  decide(obs: LegionObservation): CallOutcome<unknown> {
    return this.inner.decide(obs);
  }
}
