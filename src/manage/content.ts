// 內容包：流派（真實強度表）、經濟數值、NPC 個性、名字庫。
// 這份是「暫代內容」：流派曲線與數值都是為了讓經營層能跑起來的假資料，全部待審。
// 正式內容（軍備競賽產出的流派與離線算好的真實強度）之後以同樣的型別換入。
import type { Persona } from './types.ts';

export interface Lineage {
  readonly id: string;
  readonly name: string;
  readonly style: string;
  /** 真實強度（隱藏）：依版本，索引＝版本 − 1；長度＝最高版本 */
  readonly power: readonly number[];
}

export type LineupStyle = 'strongest-first' | 'ace-last' | 'random';

export interface PersonaSpec {
  readonly label: string;
  readonly startCash: number;
  /** 起始選手的版本範圍（含） */
  readonly versions: readonly [number, number];
  /** 休賽期想把陣容補到幾人 */
  readonly rosterTarget: number;
  readonly lineup: LineupStyle;
}

/** 金額單位：千元 */
export interface Economy {
  readonly humanStartCash: number;
  readonly humanVersions: readonly [number, number];
  readonly rosterMax: number;
  readonly freeAgentCount: number;
  readonly salaryBase: number;
  /** 每升一版的週薪倍率（%） */
  readonly salaryGrowthPct: number;
  readonly signingFeeWeeks: number;
  /** 索引＝訓練中心等級 − 1 */
  readonly facilityMaintenance: readonly number[];
  /** 索引＝目前等級 − 1，升到下一級的費用 */
  readonly facilityUpgradeCost: readonly number[];
  /** 每週可跑練習賽場數，索引＝等級 − 1 */
  readonly scrimCapacity: readonly number[];
  readonly startFame: number;
  readonly sponsorPerFame: number;
  readonly matchWinPrize: number;
  readonly matchLossPrize: number;
  readonly slotWinBonus: number;
  /** 賽段名次獎金，索引＝名次 − 1 */
  readonly seasonPrizes: readonly number[];
  readonly fameWin: number;
  readonly fameLoss: number;
  /** 賽段名次名氣加成，索引＝名次 − 1 */
  readonly fameRank: readonly number[];
  readonly betMarginPermille: number;
  readonly betMin: number;
  readonly betLimitBase: number;
  readonly betLimitPerFame: number;
  readonly scoutCost: number;
  readonly scoutSd: number;
  readonly upgradeCostWeeks: number;
  readonly upgradeWeeks: number;
  readonly researchCapGeneric: number;
  readonly researchCapSpecific: number;
  readonly researchHalfSat: number;
  readonly researchMaxPresets: number;
  readonly eloK: number;
}

export interface ContentPack {
  readonly id: string;
  readonly formatId: string;
  readonly lineages: readonly Lineage[];
  readonly personas: Readonly<Record<Persona, PersonaSpec>>;
  readonly economy: Economy;
  /** 7 支 NPC 戰隊名 */
  readonly teamNames: readonly string[];
  readonly humanTeamName: string;
  readonly surnames: readonly string[];
  readonly givenNames: readonly string[];
}

export const STUB_CONTENT: ContentPack = {
  id: 'stub-1',
  formatId: 'stub-bo1',
  lineages: [
    { id: 'ambush', name: '伏擊流', style: '埋伏後突襲，後期版本成長快', power: [1430, 1490, 1560, 1640, 1720] },
    { id: 'push', name: '強攻流', style: '開局強勢，後期成長有限', power: [1500, 1540, 1570, 1590] },
    { id: 'ranged', name: '遠程流', style: '以射擊消耗取勝，穩定成長', power: [1410, 1480, 1560, 1630, 1690] },
    { id: 'shield', name: '盾牆流', style: '正面硬碰硬，不易崩盤', power: [1470, 1520, 1570, 1610, 1640] },
    { id: 'cavalry', name: '騎襲流', style: '高風險高報酬，版本越高越強', power: [1390, 1470, 1580, 1700] },
    { id: 'swarm', name: '人海流', style: '以量取勝，上限偏低', power: [1460, 1500, 1530, 1550] },
    { id: 'turtle', name: '龜守流', style: '大器晚成，要養很多版', power: [1440, 1480, 1520, 1560, 1600, 1640] },
    { id: 'balance', name: '均衡流', style: '沒有明顯弱點也沒有明顯強項', power: [1450, 1500, 1550, 1600, 1650] },
  ],
  personas: {
    whale: { label: '豪門', startCash: 4000, versions: [3, 4], rosterTarget: 5, lineup: 'strongest-first' },
    youth: { label: '青訓派', startCash: 1800, versions: [1, 2], rosterTarget: 4, lineup: 'random' },
    data: { label: '數據派', startCash: 2500, versions: [2, 3], rosterTarget: 4, lineup: 'ace-last' },
    miser: { label: '守財奴', startCash: 1500, versions: [1, 3], rosterTarget: 3, lineup: 'strongest-first' },
  },
  economy: {
    humanStartCash: 1500,
    humanVersions: [1, 2],
    rosterMax: 5,
    freeAgentCount: 10,
    salaryBase: 40,
    salaryGrowthPct: 130,
    signingFeeWeeks: 4,
    facilityMaintenance: [20, 60, 140],
    facilityUpgradeCost: [400, 1200],
    scrimCapacity: [200, 600, 1500],
    startFame: 10,
    sponsorPerFame: 8,
    matchWinPrize: 120,
    matchLossPrize: 30,
    slotWinBonus: 20,
    seasonPrizes: [1200, 700, 450, 300, 200, 150, 100, 50],
    fameWin: 2,
    fameLoss: 1,
    fameRank: [12, 8, 5, 3, 1, 0, 0, 0],
    betMarginPermille: 80,
    betMin: 10,
    betLimitBase: 200,
    betLimitPerFame: 20,
    scoutCost: 10,
    scoutSd: 35,
    upgradeCostWeeks: 8,
    upgradeWeeks: 2,
    researchCapGeneric: 12,
    researchCapSpecific: 36,
    researchHalfSat: 100,
    researchMaxPresets: 4,
    eloK: 24,
  },
  teamNames: ['雷霆電競', '北辰戰隊', '赤焰俱樂部', '蒼穹電競', '暗影工作室', '星河戰隊', '鐵壁電競'],
  humanTeamName: '天使戰隊',
  surnames: ['林', '陳', '張', '黃', '李', '王', '吳', '劉', '蔡', '楊', '許', '鄭', '謝', '郭', '洪', '曾', '邱', '廖', '賴', '徐'],
  givenNames: ['宇軒', '子翔', '承恩', '冠廷', '柏翰', '家豪', '俊傑', '紹軒', '品睿', '奕辰', '彥廷', '哲瑋', '昱翔', '子睿', '懷恩', '星宇', '政宏', '志明', '信宏', '明哲'],
};
