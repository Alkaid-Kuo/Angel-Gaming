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
  // 助理教練（M5 第四批，平衡）：約一名 N 卡選手的週薪
  assistantSalary: 20,
  // 真引擎一場數秒（Worker 池約 4 場並行）：練習賽每週可排的場數 ÷20；M5 戰術排練一節佔 1 格（平衡）
  scrimCapacity: [10, 30, 75],
  // 訓練中心（M5 經濟平衡）：升級與維護變便宜，Lv3 第一季季中升得上去、升後還練得動
  facilityUpgradeCost: [200, 400],
  facilityMaintenance: [20, 40, 60],
};

/** 戰術手冊（M5 規格 3.1）：T 六個、CT 四個；affinity＝開局個人熟練度 +10 的角色 */
export const SHOOTER_TACTICS: readonly TacticSpec[] = [
  { id: 'rushA', abbr: 'RA', side: 'T', name: 'Rush A', affinity: ['entry'],
    desc: '五人走同一條路直衝 A 點，閃光先行、路上不停下來探頭。速度最快，CT 來不及輪轉就已經下包；存錢局也常這樣打。風險：A 點人多或入口架好時一頭撞進交叉火力，可能整隊一起倒。',
    tips: '對疊 B 與平均站位還打得過（46%、42%），撞上疊 A 只剩 34%；對面常疊 A 時改打 Rush B 或 Fake。',
  },
  { id: 'rushB', abbr: 'RB', side: 'T', name: 'Rush B', affinity: ['entry'],
    desc: '五人走同一條路直衝 B 點，閃光先行、路上不停下來探頭。速度最快，CT 來不及輪轉就已經下包；存錢局也常這樣打。風險：B 點人多或入口架好時一頭撞進交叉火力，可能整隊一起倒。',
    tips: '對面疊 A 時打 B 最划算（49%），撞上疊 B 只剩 41%；對面常疊 B 時改打 Default 或 Fake。',
  },
  { id: 'default', abbr: 'DEF', side: 'T', name: 'Default', affinity: ['support'],
    desc: '主力 3 人到一個點外待命、2 人去另一點控圖拿情報，佈置好或時間到才決定打哪個點，控圖的人再從第二入口包夾。慢而穩、看得到防守怎麼站再出手，經濟差的存錢局不適合。風險：拖太久時間被壓縮，控圖的人落單容易被各個擊破。',
    tips: '最穩的進攻，對平均站位、疊 B、激進探點都有七成以上；只有對面疊 A 時被壓到五五，這時改 Fake 或 Split B。',
  },
  { id: 'splitA', abbr: 'SA', side: 'T', name: 'Split A', affinity: ['lurk'],
    desc: '分兩組、走入口不同的兩條路到 A 點外待命，兩組都到位才同時進點，從兩個方向夾擊守點的人。適合對面在 A 只守兩三人的時候。風險：兩組不同步就變成各打各的，比快攻多花時間。',
    tips: '對平均站位與疊 B 很強（65%、67%），對面疊 A 時只剩五五，改打 Fake 或 Split B。',
  },
  { id: 'splitB', abbr: 'SB', side: 'T', name: 'Split B', affinity: ['lurk'],
    desc: '分兩組、走入口不同的兩條路到 B 點外待命，兩組都到位才同時進點，從兩個方向夾擊守點的人。適合對面在 B 只守兩三人的時候。風險：兩組不同步就變成各打各的，比快攻多花時間。',
    tips: '整體偏弱（平均 48%），只在對面疊 A、B 點變空時好用（56%）。',
  },
  { id: 'fake', abbr: 'FK', side: 'T', name: 'Fake', affinity: ['lurk'],
    desc: '少數人去一個點丟道具、製造聲音，引 CT 輪轉過去，主力再打另一個點。對面輪轉積極時最有效。風險：佯攻的人少，被識破時主力要面對完整的防守。',
    tips: '專剋疊點：對疊 B 有 71%，對面疊 A 時也是最好的選擇（58%）。',
  },
  { id: 'ct212', abbr: '212', side: 'CT', name: '2-1-2', affinity: ['awp'],
    desc: 'A 兩人、中路一人、B 兩人的平均站位，哪邊被打就由中路和另一點支援輪轉。沒有明顯的弱點，是最穩的預設防守。風險：每點只有兩人，碰上五人快攻要撐到隊友輪轉過來。',
    tips: '擋得住快攻（Rush 只剩四成多），但怕 Default、Split A 慢慢佈置（對方 65～73%）；對面常慢打時改疊點。',
  },
  { id: 'stackA', abbr: '疊A', side: 'CT', name: '疊 A', affinity: ['anchor'],
    desc: 'A 點放三人以上，B 只留一到兩人當錨點，賭對面打 A。猜中時 A 點火力壓倒對面。風險：對面打 B 時 B 只有少數人，要撐到回防。',
    tips: '整體最穩的防守（對方平均只有 49%），專剋 Rush A、Default、Split A；怕 Fake 與 Split B 打空的 B 點。',
  },
  { id: 'stackB', abbr: '疊B', side: 'CT', name: '疊 B', affinity: ['anchor'],
    desc: 'B 點放三人以上，A 只留一到兩人當錨點，賭對面打 B。猜中時 B 點火力壓倒對面。風險：對面打 A 時 A 只有少數人，要撐到回防。',
    tips: '只擋得住打 B 的 Rush B、Split B；對 Default、Fake、Split A 很吃虧（對方七成上下），沒把握對面打 B 時別用。',
  },
  { id: 'ctPush', abbr: '探', side: 'CT', name: '激進探點', affinity: [],
    desc: '以 2-1-2 為底，一到兩人凍結結束就往前壓，搶情報或先拿擊殺再退回。能早點知道對面往哪走。風險：前壓的人被抓到，開局就少一人。',
    tips: '前壓抓快攻有效（Rush A 只剩 40%），對 Default、Fake 慢打吃虧（對方 66～75%）。',
  },
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
