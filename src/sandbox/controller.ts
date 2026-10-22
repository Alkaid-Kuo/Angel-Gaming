// 選手控制器介面、宣告驗證、旋鈕解析、批次模式控制器。
import type { Bot, BotDeclaration, Command, InitData, KnobDef, KnobValues } from '../api/types.ts';
import { RULES } from '../config/index.ts';
import type { ObservationPacket } from '../core/observe.ts';
import { BotLoadError, type CompiledBot } from './compile.ts';
import { BotHelpers } from './helpers.ts';

export interface InitOutcome {
  readonly exception: string | null;
  /** 超過 init 上限 → 整場閒置 */
  readonly killed: boolean;
  readonly elapsedMs: number;
}

export interface DecideOutcome {
  /** JSON 安全的指令副本 */
  readonly commands: unknown;
  /** 軟超時（> 5 ms）作廢 */
  readonly voided: boolean;
  readonly exception: string | null;
  /** 超過硬上限被終止 → 整場閒置 */
  readonly killed: boolean;
  readonly elapsedMs: number;
}

export interface BotController {
  readonly label: string;
  readonly declaration: BotDeclaration;
  init(data: InitData): InitOutcome | Promise<InitOutcome>;
  decide(packet: ObservationPacket): DecideOutcome | Promise<DecideOutcome>;
  dispose(): void | Promise<void>;
  /**
   * 即時輸入（只有人類玩家實作）：非決策 tick 也取出累積的指令，在該 tick 立即套用並錄進回放。
   * 選手 Bot 不實作，維持每 5 tick 決策一次。
   */
  takeRealtime?(): Command[];
}

/** 驗證 declare() 的結果；不合規格拋出 BotLoadError */
export function validateDeclaration(raw: unknown, label: string): BotDeclaration {
  const fail = (msg: string): never => {
    throw new BotLoadError(`${label}：declare() ${msg}`);
  };
  if (typeof raw !== 'object' || raw === null) return fail('必須回傳物件');
  const d = raw as Record<string, unknown>;
  if (typeof d.name !== 'string' || d.name.length === 0) fail('缺少 name');
  if (d.version !== undefined && typeof d.version !== 'string') fail('version 必須是字串');
  if (typeof d.style !== 'string') fail('缺少 style');
  if (!Array.isArray(d.knobs)) return fail('缺少 knobs 陣列');
  const knobs = d.knobs as unknown[];
  if (knobs.length < RULES.botModule.minKnobs || knobs.length > RULES.botModule.maxKnobs) {
    fail(`旋鈕數量必須為 ${RULES.botModule.minKnobs}～${RULES.botModule.maxKnobs}，收到 ${knobs.length}`);
  }
  const keys = new Set<string>();
  const out: KnobDef[] = [];
  for (const k of knobs) {
    if (typeof k !== 'object' || k === null) return fail('旋鈕必須是物件');
    const o = k as Record<string, unknown>;
    if (typeof o.key !== 'string' || o.key.length === 0) return fail('旋鈕缺少 key');
    if (keys.has(o.key)) fail(`旋鈕 key 重複：${o.key}`);
    keys.add(o.key);
    if (typeof o.name !== 'string' || typeof o.description !== 'string') fail(`旋鈕 ${o.key} 缺少 name／description`);
    if (typeof o.min !== 'number' || typeof o.max !== 'number' || typeof o.default !== 'number' || typeof o.integer !== 'boolean') {
      return fail(`旋鈕 ${o.key} 的 min／max／default／integer 型別錯誤`);
    }
    if (!(o.min <= o.default && o.default <= o.max)) fail(`旋鈕 ${o.key} 必須 min ≤ default ≤ max`);
    if (o.integer && !(Number.isInteger(o.min) && Number.isInteger(o.max) && Number.isInteger(o.default))) fail(`整數旋鈕 ${o.key} 的範圍必須是整數`);
    out.push({ key: o.key, name: o.name as string, description: o.description as string, min: o.min, max: o.max, default: o.default, integer: o.integer });
  }
  return { name: d.name as string, version: typeof d.version === 'string' ? d.version : '', style: d.style as string, knobs: out };
}

/** 預設值＋指定值；指定值超出範圍或不存在的代碼拋出例外 */
export function resolveKnobs(decl: BotDeclaration, overrides: KnobValues | undefined, label: string): KnobValues {
  const out: Record<string, number> = {};
  for (const k of decl.knobs) out[k.key] = k.default;
  for (const [key, v] of Object.entries(overrides ?? {})) {
    const def = decl.knobs.find((k) => k.key === key);
    if (def === undefined) throw new BotLoadError(`${label}：沒有旋鈕 ${key}`);
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new BotLoadError(`${label}：旋鈕 ${key} 的值必須是數字`);
    if (def.integer && !Number.isInteger(v)) throw new BotLoadError(`${label}：旋鈕 ${key} 是整數旋鈕，不接受 ${v}`);
    if (v < def.min || v > def.max) throw new BotLoadError(`${label}：旋鈕 ${key} 的值 ${v} 超出範圍 ${def.min}～${def.max}`);
    out[key] = v;
  }
  return out;
}

/** 轉成 JSON 安全副本（回放紀錄與重建看到的是同一份資料） */
export function jsonClone(v: unknown): unknown {
  const s = JSON.stringify(v);
  return s === undefined ? null : (JSON.parse(s) as unknown);
}

function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

const now = (): number => performance.now();

/** 批次模式：與引擎同一執行緒，直接呼叫；不做 5 ms 軟計時，50 ms 硬上限以呼叫後檢查耗時處理 */
export class BatchController implements BotController {
  readonly label: string;
  readonly declaration: BotDeclaration;
  private readonly bot: Bot;
  private helpers: BotHelpers | null = null;

  constructor(compiled: CompiledBot, label: string) {
    this.label = label;
    const Cls = compiled.createClass();
    this.bot = new Cls();
    this.declaration = validateDeclaration(this.bot.declare(), label);
  }

  init(data: InitData): InitOutcome {
    this.helpers = new BotHelpers(data);
    const t0 = now();
    let exception: string | null = null;
    try {
      this.bot.init(data, this.helpers.toPublic());
    } catch (e) {
      exception = errorText(e);
    }
    const elapsedMs = now() - t0;
    return { exception, killed: elapsedMs > RULES.timing.initMs, elapsedMs };
  }

  decide(packet: ObservationPacket): DecideOutcome {
    this.helpers!.update(packet.obs, packet.exploredDelta);
    const t0 = now();
    let raw: unknown = [];
    let exception: string | null = null;
    try {
      raw = this.bot.decide(packet.obs);
    } catch (e) {
      exception = errorText(e);
    }
    const elapsedMs = now() - t0;
    if (elapsedMs > RULES.timing.hardMs) return { commands: [], voided: false, exception, killed: true, elapsedMs };
    let commands: unknown = [];
    if (exception === null) {
      try {
        commands = jsonClone(raw);
      } catch (e) {
        exception = errorText(e);
        commands = [];
      }
    }
    return { commands, voided: false, exception, killed: false, elapsedMs };
  }

  dispose(): void {}
}
