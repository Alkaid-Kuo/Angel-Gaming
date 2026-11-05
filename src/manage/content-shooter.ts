// 射擊內容包（攻防戰，步驟 7）：五個角色＝五個流派；隱藏強度由 scripts/shooter-strength.ts 離線互打產生（見步驟 7 交付報告）。
// 射擊名單 5 人（lineupSize 5，座位順序＝隊內序號）；選手規格 → 屬性與旋鈕由 src/shooter/players.ts 的 derivePlayer 算，
// 內容包只放資料（流派的名稱與說明取角色表）。power 以「整場勝率」的 Elo 尺度（給 expectedPermille），隊伍強度＝五人平均。
// 經濟（步驟 8）：從暫代包放大到 5 人名單跑得起來（陣容上限 8、起始資金與自由選手數約 ×5/3、每回合獎金依 13 回合一場換算、
// 訓練中心每週場數 ÷20，因為真引擎一場要數秒）；平衡留給 M5。品階表與名字庫沿用暫代包。
import { ROLE_TABLE, SHOOTER_ROLES, type ShooterRole } from '../shooter/players.ts';
import { STUB_CONTENT, type AttributeSchema, type ContentPack, type Economy, type PersonaSpec, type TacticSpec } from './content.ts';
import type { Persona } from './types.ts';

/** 隱藏強度表：索引＝版本 − 1（scripts/shooter-strength.ts 的「採用值」；基準 Bot 2.4.3：赤岩舊城、MR6、凍結 3 秒；回合→整場 k = 12.22；量測見 Bot 2.4.3 強度與耗時重量報告） */
export const SHOOTER_POWER: Readonly<Record<ShooterRole, readonly number[]>> = {
  entry: [1153, 1239, 1500, 1570, 1681],
  awp: [1153, 1239, 1500, 1679, 1899],
  support: [1153, 1239, 1500, 1677, 1895],
  anchor: [1153, 1239, 1500, 1657, 1855],
  lurk: [1153, 1239, 1500, 1699, 1940],
};

const STUB_PERSONAS = STUB_CONTENT.personas;

/** 屬性表（M5 第二批）：六項，強度三項可訓練，風格三項開局決定 */
export const SHOOTER_ATTRIBUTES: AttributeSchema = {
  keys: ['aim', 'reaction', 'awareness', 'aggression', 'discipline', 'movement'],
  trainable: ['aim', 'reaction', 'awareness'],
  names: { aim: '瞄準', reaction: '反應', awareness: '警覺', aggression: '侵略', discipline: '紀律', movement: '走位' },
};

/** NPC 個性：起始資金 ×5/3、陣容目標 6～7（5 人上場＋替補），版本範圍與排序風格不變 */
export const SHOOTER_PERSONAS: Readonly<Record<Persona, PersonaSpec>> = {
  whale: { ...STUB_PERSONAS.whale, startCash: 6500, rosterTarget: 7 },
  youth: { ...STUB_PERSONAS.youth, startCash: 3000, rosterTarget: 6 },
  data: { ...STUB_PERSONAS.data, startCash: 4200, rosterTarget: 6 },
  miser: { ...STUB_PERSONAS.miser, startCash: 2500, rosterTarget: 6 },
};

/** 經濟數值（千元）；與暫代包不同的只有下列幾項，見步驟 8 交付報告的經濟數值表 */
export const SHOOTER_ECONOMY: Economy = {
  ...STUB_CONTENT.economy,
  humanStartCash: 2500,
  humanStartRarities: ['SR', 'R', 'R', 'N', 'N'],
  rosterMax: 8,
  freeAgentCount: 18,
  // M5 經濟平衡（2026-11-06，量測見規格 4.10）：訓練與排練成了主要支出，比賽收入跟著調高，讓訓練中心 Lv3 第一季季中付得起、
  // NPC 的訓練＋排練佔支出到 30% 以上。聯賽 MR6 一場平均 12 回合：贏方約 7 回合 × 15 ≈ 105
  roundWinBonus: 15,
  matchWinPrize: 200,
  matchLossPrize: 80,
  sponsorPerFame: 15,
  trainCost: 18,
  rehearseCost: 14,
  // 真引擎一場數秒（Worker 池約 4 場並行）：練習賽每週可排的場數 ÷20；M5 戰術排練一節佔 1 格（平衡）
  scrimCapacity: [10, 30, 75],
  // 訓練中心（M5 經濟平衡）：升級與維護變便宜，Lv3 第一季季中升得上去、升後還練得動
  facilityUpgradeCost: [200, 400],
  facilityMaintenance: [20, 40, 60],
};

/** 戰術手冊（M5 規格 3.1）：T 六個、CT 四個；affinity＝開局個人熟練度 +10 的角色 */
export const SHOOTER_TACTICS: readonly TacticSpec[] = [
  { id: 'rushA', side: 'T', name: 'Rush A', affinity: ['entry'] },
  { id: 'rushB', side: 'T', name: 'Rush B', affinity: ['entry'] },
  { id: 'default', side: 'T', name: 'Default', affinity: ['support'] },
  { id: 'splitA', side: 'T', name: 'Split A', affinity: ['lurk'] },
  { id: 'splitB', side: 'T', name: 'Split B', affinity: ['lurk'] },
  { id: 'fake', side: 'T', name: 'Fake', affinity: ['lurk'] },
  { id: 'ct212', side: 'CT', name: '2-1-2', affinity: ['awp'] },
  { id: 'stackA', side: 'CT', name: '疊 A', affinity: ['anchor'] },
  { id: 'stackB', side: 'CT', name: '疊 B', affinity: ['anchor'] },
  { id: 'ctPush', side: 'CT', name: '激進探點', affinity: [] },
];

export const SHOOTER_CONTENT: ContentPack = {
  id: 'shooter-1',
  formatId: 'shooter-mr6',
  lineupSize: 5,
  slotNames: ['1 號位', '2 號位', '3 號位', '4 號位', '5 號位'],
  lineages: SHOOTER_ROLES.map((r) => ({ id: r, name: ROLE_TABLE[r].name, style: ROLE_TABLE[r].style, power: SHOOTER_POWER[r], base: { ...ROLE_TABLE[r].base }, growth: { ...ROLE_TABLE[r].growth } })),
  attributes: SHOOTER_ATTRIBUTES,
  tactics: SHOOTER_TACTICS,
  rarities: STUB_CONTENT.rarities,
  personas: SHOOTER_PERSONAS,
  economy: SHOOTER_ECONOMY,
  teamNames: ['烈焰突擊', '暗鴉小隊', '鋼鐵防線', '獵鷹戰隊', '雷鳴特攻', '赤狐電競', '零度部隊'],
  humanTeamName: STUB_CONTENT.humanTeamName,
  handles: STUB_CONTENT.handles,
};
