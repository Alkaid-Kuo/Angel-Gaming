// 介面文字與配色。
import type { GameEvent } from '../api/types.ts';
import type { BuildingType, RejectReason, ResearchType, Stance, UnitType } from '../config/index.ts';

/** 8 種隊伍色（色盲友善為主） */
export const TEAM_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#a855f7', '#f97316', '#06b6d4', '#ec4899'];

export const UNIT_NAME: Record<UnitType, string> = { worker: '工人', spear: '長槍兵', archer: '弓兵', cavalry: '騎兵', siege: '攻城車' };
export const BUILDING_NAME: Record<BuildingType, string> = { base: '主堡', depot: '採集站', supply: '補給站', barracks: '兵營', tower: '防禦塔', forge: '鍛造所', workshop: '攻城工坊' };
export const BUILDING_GLYPH: Record<BuildingType, string> = { base: '堡', depot: '站', supply: '補', barracks: '營', tower: '塔', forge: '鍛', workshop: '坊' };
export const RESEARCH_NAME: Record<ResearchType, string> = { weapons: '武器', armor: '護甲' };
export const STANCE_NAME: Record<Stance, string> = { aggressive: '積極', defensive: '防守', hold: '堅守', retreat: '撤退' };
export const ORDER_NAME: Record<string, string> = {
  idle: '閒置',
  move: '移動',
  attackMove: '攻擊移動',
  attack: '攻擊',
  gather: '採集',
  build: '前往建造',
  construct: '建造中',
};
export const REJECT_NAME: Record<RejectReason, string> = {
  NO_TECH: '科技等級不足（需要升級主堡）',
  NO_MINERALS: '礦不足',
  NO_SUPPLY: '人口不足',
  BAD_PLACEMENT: '位置不可建造',
  QUEUE_FULL: '生產佇列已滿',
  WRONG_PRODUCER: '該建築不能生產此單位',
  INVALID_TARGET: '目標不合法',
  NOT_OWNED: '不屬於自己',
  BAD_FORMAT: '指令格式錯誤',
  NO_BUDGET: '超出指令額度',
};

/** B 之後的建築鍵 */
export const BUILD_KEYS: Record<string, BuildingType> = { c: 'base', d: 'depot', s: 'supply', r: 'barracks', t: 'tower', f: 'forge', g: 'workshop' };
/** 選建築時 Q／W／E 生產的單位 */
export const TRAIN_KEYS: Record<BuildingType, Partial<Record<string, UnitType>>> = {
  base: { q: 'worker' },
  barracks: { q: 'spear', w: 'archer', e: 'cavalry' },
  depot: {},
  supply: {},
  tower: {},
  forge: {},
  workshop: { q: 'siege' },
};
/** 選建築時的研究鍵（鍛造所 Q 武器、W 護甲） */
export const RESEARCH_KEYS: Partial<Record<BuildingType, Partial<Record<string, ResearchType>>>> = { forge: { q: 'weapons', w: 'armor' } };

export function formatTime(tick: number): string {
  const sec = Math.floor(tick / 10);
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/** 事件轉成一行文字；名稱查不到時用 id */
export function eventText(ev: GameEvent, playerName: (id: number) => string): string | null {
  switch (ev.type) {
    case 'underAttack':
      return null; // 太頻繁，不列入記錄（改以小地圖閃爍提示）
    case 'unitDied':
      return `我方${UNIT_NAME[ev.unitType]}陣亡`;
    case 'buildingDestroyed':
      return `我方${BUILDING_NAME[ev.buildingType]}被摧毀`;
    case 'enemyKilled':
      return `擊殺 ${playerName(ev.owner)} 的${ev.kind === 'unit' ? UNIT_NAME[ev.entityType as UnitType] : BUILDING_NAME[ev.entityType as BuildingType]}`;
    case 'buildingComplete':
      return `${BUILDING_NAME[ev.buildingType]}完工`;
    case 'unitTrained':
      return `${UNIT_NAME[ev.unitType]}生產完成`;
    case 'nodeDepleted':
      return '礦點枯竭';
    case 'towerChanged':
      return ev.owner === null ? '瞭望塔失守' : `${playerName(ev.owner)} 佔領瞭望塔`;
    case 'playerEliminated':
      return `${playerName(ev.playerId)} 被淘汰`;
    case 'commandRejected':
      return `指令被拒：${REJECT_NAME[ev.reason]}`;
    case 'buildFailed':
      return `${BUILDING_NAME[ev.building]}無法開工：${REJECT_NAME[ev.reason]}`;
    case 'upgradeComplete':
      return `主堡升級為 Lv${ev.level}`;
    case 'researchComplete':
      return `${RESEARCH_NAME[ev.research]}研究完成（Lv${ev.level}）`;
  }
}
