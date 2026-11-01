// 射擊內容包（攻防戰，步驟 7）：五個角色＝五個流派；隱藏強度由 scripts/shooter-strength.ts 離線互打產生（見步驟 7 交付報告）。
// 射擊名單 5 人（lineupSize 5，座位順序＝隊內序號）；選手規格 → 屬性與旋鈕由 src/shooter/players.ts 的 derivePlayer 算，
// 內容包只放資料（流派的名稱與說明取角色表）。power 以「整場勝率」的 Elo 尺度（給 expectedPermille），隊伍強度＝五人平均。
// 經濟（步驟 8）：從暫代包放大到 5 人名單跑得起來（陣容上限 8、起始資金與自由選手數約 ×5/3、每回合獎金依 13 回合一場換算、
// 訓練中心每週場數 ÷20，因為真引擎一場要數秒）；平衡留給 M5。名字庫沿用暫代包。
import { ROLE_TABLE, SHOOTER_ROLES, type ShooterRole } from '../shooter/players.ts';
import { STUB_CONTENT, type ContentPack, type Economy, type PersonaSpec } from './content.ts';
import type { Persona } from './types.ts';

/** 隱藏強度表：索引＝版本 − 1（scripts/shooter-strength.ts 的「採用值」；基準 Bot 2.2：赤岩舊城、MR6、凍結 3 秒，基準 Bot 2.1；回合→整場 k = 11.96；量測見規則 1.2 交付報告） */
export const SHOOTER_POWER: Readonly<Record<ShooterRole, readonly number[]>> = {
  entry: [1092, 1370, 1500, 1592, 1690],
  awp: [1092, 1370, 1500, 1839, 2183],
  support: [1092, 1370, 1500, 1775, 2055],
  anchor: [1092, 1370, 1500, 1651, 1808],
  lurk: [1092, 1370, 1500, 1710, 1926],
};

const STUB_PERSONAS = STUB_CONTENT.personas;

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
  rosterMax: 8,
  freeAgentCount: 18,
  // 聯賽 MR6 一場平均 12 回合（規則 1.2）：贏方約 7 回合 × 3 ≈ 21，比 MR12 時期（約 39）少；數值未動，平衡留給 M5
  roundWinBonus: 3,
  // 真引擎一場數秒（Worker 池約 4 場並行）：練習賽與研發每週可排的場數 ÷20，研發半飽和跟著 ÷20
  scrimCapacity: [10, 30, 75],
  researchHalfSat: 5,
};

export const SHOOTER_CONTENT: ContentPack = {
  id: 'shooter-1',
  formatId: 'shooter-mr6',
  lineupSize: 5,
  slotNames: ['1 號位', '2 號位', '3 號位', '4 號位', '5 號位'],
  lineages: SHOOTER_ROLES.map((r) => ({ id: r, name: ROLE_TABLE[r].name, style: ROLE_TABLE[r].style, power: SHOOTER_POWER[r] })),
  personas: SHOOTER_PERSONAS,
  economy: SHOOTER_ECONOMY,
  teamNames: ['烈焰突擊', '暗鴉小隊', '鋼鐵防線', '獵鷹戰隊', '雷鳴特攻', '赤狐電競', '零度部隊'],
  humanTeamName: STUB_CONTENT.humanTeamName,
  surnames: STUB_CONTENT.surnames,
  givenNames: STUB_CONTENT.givenNames,
};
