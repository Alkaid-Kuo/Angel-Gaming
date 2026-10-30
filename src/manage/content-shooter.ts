// 射擊內容包（攻防戰，步驟 7）：五個角色＝五個流派；隱藏強度由 scripts/shooter-strength.ts 離線互打產生（見步驟 7 交付報告）。
// 射擊名單 5 人（lineupSize 5，座位順序＝隊內序號）；選手規格 → 屬性與旋鈕由 src/shooter/players.ts 的 derivePlayer 算，
// 內容包只放資料（流派的名稱與說明取角色表）。power 以「整場勝率」的 Elo 尺度（給 expectedPermille），隊伍強度＝五人平均。
// personas、economy、名字庫暫代沿用 STUB_CONTENT（步驟 8／9 審）。
import { ROLE_TABLE, SHOOTER_ROLES, type ShooterRole } from '../shooter/players.ts';
import { STUB_CONTENT, type ContentPack } from './content.ts';

/** 隱藏強度表：索引＝版本 − 1（scripts/shooter-strength.ts 的「採用值」，基準 Bot 2.1 @ 5e6916c；量測方法與原始值見步驟 7 交付報告） */
export const SHOOTER_POWER: Readonly<Record<ShooterRole, readonly number[]>> = {
  entry: [1480, 1490, 1500, 1604, 1614],
  awp: [1373, 1459, 1500, 1659, 1669],
  support: [1172, 1358, 1500, 1760, 1848],
  anchor: [1439, 1490, 1500, 1626, 1636],
  lurk: [1228, 1387, 1500, 1732, 1791],
};

export const SHOOTER_CONTENT: ContentPack = {
  id: 'shooter-1',
  formatId: 'shooter-mr12',
  lineupSize: 5,
  slotNames: ['1 號位', '2 號位', '3 號位', '4 號位', '5 號位'],
  lineages: SHOOTER_ROLES.map((r) => ({ id: r, name: ROLE_TABLE[r].name, style: ROLE_TABLE[r].style, power: SHOOTER_POWER[r] })),
  // 暫代，步驟 8／9 審
  personas: STUB_CONTENT.personas,
  economy: STUB_CONTENT.economy,
  teamNames: ['烈焰突擊', '暗鴉小隊', '鋼鐵防線', '獵鷹戰隊', '雷鳴特攻', '赤狐電競', '零度部隊'],
  humanTeamName: STUB_CONTENT.humanTeamName,
  surnames: STUB_CONTENT.surnames,
  givenNames: STUB_CONTENT.givenNames,
};
