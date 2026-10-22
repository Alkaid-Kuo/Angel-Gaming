// 介面文字與配色。
import type { GameEvent } from '../api/types.ts';
import type { BuildingType, RejectReason, ResearchType, Stance, UnitType } from '../config/index.ts';

/** 8 種隊伍色（色盲友善為主） */
export const TEAM_COLORS = ['#3b82f6', '#ef4444', '#22c55e', '#eab308', '#a855f7', '#f97316', '#06b6d4', '#ec4899'];

export const UNIT_NAME: Record<UnitType, string> = { worker: '工人', spear: '長槍兵', archer: '弓兵', cavalry: '騎兵', siege: '攻城車' };
export const BUILDING_NAME: Record<BuildingType, string> = { base: '主堡', depot: '採集站', supply: '補給站', barracks: '兵營', tower: '防禦塔', forge: '鍛造所', workshop: '攻城工坊' };
export const RESEARCH_NAME: Record<ResearchType, string> = { weapons: '武器', armor: '護甲' };
/** 指令格與說明用的一句話介紹 */
export const UNIT_TIP: Record<UnitType, string> = {
  worker: '採礦、建造；只有你指定攻擊目標時才會戰鬥',
  spear: '便宜、血厚；剋騎兵',
  archer: '射程遠、血薄；打建築傷害減半',
  cavalry: '移動最快；剋弓兵與攻城車',
  siege: '只能攻擊建築，拆建築極快；怕防禦塔',
};
export const BUILDING_TIP: Record<BuildingType, string> = {
  base: '生產工人、卸礦點、人口 +10；升級後解鎖鍛造所與攻城工坊',
  depot: '卸礦點：蓋在礦區旁，縮短工人往返',
  supply: '人口上限 +8',
  barracks: '生產長槍兵、弓兵、騎兵',
  tower: '自動攻擊附近的敵方單位；不佔人口',
  forge: '研究武器、護甲（戰鬥單位攻擊／護甲 +1）',
  workshop: '生產攻城車',
};
export const RESEARCH_TIP: Record<ResearchType, string> = { weapons: '所有戰鬥單位攻擊 +1', armor: '所有戰鬥單位護甲 +1（每次受到的傷害 −1）' };
/** 指令被拒時給人類看的補充建議 */
export const REJECT_HINT: Partial<Record<RejectReason, string>> = {
  NO_SUPPLY: '請先蓋補給站',
  NO_MINERALS: '多派工人採礦，或等一下',
  BAD_PLACEMENT: '要平地、已探索，不能壓到礦點或其他建築',
  NO_TECH: '選取主堡按 U 升級',
  QUEUE_FULL: '一次最多排 5 個',
};
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
