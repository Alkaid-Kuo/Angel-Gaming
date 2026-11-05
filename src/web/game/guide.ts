// 新手引導的規則與文案（純資料，不碰畫面）：功能逐週開放、帶路步驟、各頁說明、基地的「下一步」。
// 開放只擋介面入口，遊戲規則與存檔不變；進度存在介面偏好（prefs.guide），舊存檔沒有這欄＝全部開放。
import type { ContentPack, KnownView } from '../../manage/index.ts';

export type Screen = 'title' | 'create' | 'hub' | 'squad' | 'player' | 'market' | 'training' | 'tactics' | 'league' | 'betting' | 'finance' | 'inbox';

export interface GuideState {
  /** false＝關閉教學、全部開放 */
  on: boolean;
  /** 看完的步驟 id */
  done: string[];
}

/** 第幾週開放（v.week：0＝休賽期、1＝第 1 週）；沒列的一開始就有 */
export const UNLOCK_WEEK: Partial<Record<Screen, number>> = { league: 1, finance: 1, training: 2, tactics: 2, betting: 3 };

export const SCREEN_NAME: Partial<Record<Screen, string>> = { league: '聯賽', finance: '財務', training: '訓練基地', tactics: '戰術室', betting: '賭盤' };

/** 這個畫面還要等到第幾週才開放；已開放回傳 null */
export function lockedUntil(screen: Screen, v: Pick<KnownView, 'week' | 'phase'>, guide: GuideState | undefined): number | null {
  if (!guide?.on || v.phase === 'ended' || v.phase === 'bankrupt') return null;
  const w = UNLOCK_WEEK[screen];
  return w !== undefined && v.week < w ? w : null;
}

export interface Step {
  id: string;
  /** 這一步出現在哪個畫面 */
  screen: Screen;
  /** 要亮起來的元素；沒有＝置中的對話框 */
  target?: string;
  title: string;
  /** 小標（NEW、STEP…） */
  tag?: string;
  body: (v: KnownView, c: ContentPack) => string;
  /** 要玩家自己點亮起來的地方、進到這個畫面才算完成（沒有＝按「下一步」） */
  go?: Screen;
  /** 對話框上的「去看看」 */
  open?: Screen;
  /** 第一步：顯示「跳過教學」 */
  first?: boolean;
  /** 按鈕文字（預設「下一步」） */
  ok?: string;
}

interface Lesson {
  when: (v: KnownView) => boolean;
  steps: Step[];
}

const wan = (k: number): string => {
  const x = k / 10;
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
};

const inSeason = (week: number) => (v: KnownView): boolean => v.phase === 'season' && v.week >= week;

const LESSONS: readonly Lesson[] = [
  {
    when: (v) => v.phase === 'offseason',
    steps: [
      {
        id: 'intro.welcome',
        screen: 'hub',
        first: true,
        tag: 'WELCOME',
        title: '歡迎，經理',
        body: () => '你接手了一支新創電競戰隊。比賽由選手上場打，你的工作是<b>簽人、排名單、管錢</b>。<br><br>這一季的目標：<b>例行賽 7 週打進前 4 名</b>，季後賽拿冠軍，而且<b>現金不能跌破 0</b>。<br><br>接下來帶你走一遍開季前要看的東西，大約一分鐘。',
      },
      {
        id: 'intro.funds',
        screen: 'hub',
        target: '[data-guide="funds"]',
        title: '現金',
        body: (v) => `戰隊現在有 <b>${wan(v.me.cash)} 萬</b>。每週要付週薪與設施維護，贊助只補回一部分，目前每週固定少 <b>${wan(Math.max(0, v.me.weeklyFixedCost - v.me.weeklySponsor))} 萬</b>。<br>週結算後現金小於 0 就破產，這局結束。`,
      },
      {
        id: 'intro.runway',
        screen: 'hub',
        target: '[data-guide="runway"]',
        title: '資金跑道',
        body: () => '照目前的支出，現金還撐得了幾週。少於 3 週會變紅。<br>打比賽有獎金，賽段結束還有名次獎金，所以數字不必一直很高，但花錢前要看一眼。',
      },
      {
        id: 'intro.squad',
        screen: 'hub',
        target: '.panel.squad',
        go: 'squad',
        title: '先看你的選手',
        body: () => '點這塊面板，進到戰隊頁。',
      },
      {
        id: 'intro.lineup',
        screen: 'squad',
        target: '.v-squad .lineup',
        title: '出賽名單',
        body: (_v, c) => `這 ${c.lineupSize} 張卡就是比賽時上場的人。現在是<b>自動名單</b>：評分最高的 ${c.lineupSize} 人。<br>想換人：點一個出賽位，再點右邊的選手。`,
      },
      {
        id: 'intro.roster',
        screen: 'squad',
        target: '.v-squad .roster',
        title: '看懂選手',
        body: () => '<b>版本</b> v1～v5：越高越強，週薪也越高。<br><b>評分</b>：公開戰績算出來的數字，不等於真實強度。<br><b>角色</b>：決定他在場上做什麼，例如突破手衝點、狙擊手架槍。',
      },
      {
        id: 'intro.market',
        screen: 'squad',
        target: '.rail [data-to="market"]',
        go: 'market',
        title: '開季前可以補人',
        body: () => '點左邊的「市場」。',
      },
      {
        id: 'intro.fa',
        screen: 'market',
        target: '.v-market .list',
        title: '自由球員',
        body: (_v, c) => `這些人沒有合約，先到先簽。簽約要付 <b>${c.economy.signingFeeWeeks} 週週薪</b>的簽約金，之後每週多一份薪水。<br>派球探（${wan(c.economy.scoutCost)} 萬）可以看到比評分更準的真實強度，下週回報。`,
      },
      {
        id: 'intro.sim',
        screen: 'market',
        target: '.v-market .sim',
        title: '簽之前先看這裡',
        body: () => '點左邊任何一位，這裡會算出簽下之後現金和資金跑道怎麼變。<br>你的陣容已經夠上場，<b>不簽也能開打</b>。錢不多時別一次花光。',
      },
      {
        id: 'intro.back',
        screen: 'market',
        target: '.rail [data-to="hub"]',
        go: 'hub',
        title: '回基地',
        body: () => '點左邊的「基地」。',
      },
      {
        id: 'intro.go',
        screen: 'hub',
        target: '.deploy .go',
        ok: '知道了',
        title: '開幕',
        body: () => '想好了就按這裡進入第 1 週，不急，可以先回去簽人或排名單。<br>之後每按一次就打一週：比賽、結算、下一週。<b>聯賽、財務、訓練、賭盤會隨賽季逐步開放</b>，開放時會告訴你怎麼用。',
      },
    ],
  },
  {
    when: inSeason(1),
    steps: [
      {
        id: 'w1.unlock',
        screen: 'hub',
        tag: 'NEW // 新功能開放',
        title: '聯賽、財務',
        body: () => '<b>聯賽</b>：排名、賽程、季後賽。前 4 名進季後賽，勝 3 分、平 1 分。<br><b>財務</b>：現金曲線和每週收支，錢去哪裡了都看得到。<br>左邊的選單和城市裡的建築都能點進去。',
      },
      {
        id: 'w1.match',
        screen: 'hub',
        target: '.deploy .go',
        ok: '知道了',
        title: '第一場比賽',
        body: () => '本週對手在右下角。按「開戰」進賽前畫面，可以<b>看整場比賽</b>，也可以<b>跳過</b>直接看結果。<br>看比賽時可以調速度、切鏡頭，隨時能跳過。',
      },
    ],
  },
  {
    when: inSeason(2),
    steps: [
      {
        id: 'w2.unlock',
        screen: 'hub',
        tag: 'NEW // 新功能開放',
        title: '訓練基地',
        open: 'training',
        body: () => '每週可以排練習賽，<b>推進一週後才出報告</b>：估我方對某隊的真實勝率。<br>場數有上限，升級訓練中心可以多排，但維護費也會增加。',
      },
      {
        id: 'w2.tactics',
        screen: 'hub',
        tag: 'NEW // 新功能開放',
        title: '戰術室',
        open: 'tactics',
        body: () => '<b>排練</b>一個戰術：隊伍默契和出賽五人的熟練度一起漲，選手打這個戰術會更有默契。<br><b>比賽計畫</b>：替戰術打星或禁用，選手自己選戰術時照這個偏好。排練和練習賽共用訓練時段。',
      },
    ],
  },
  {
    when: inSeason(3),
    steps: [
      {
        id: 'w3.unlock',
        screen: 'hub',
        tag: 'NEW // 新功能開放',
        title: '賭盤',
        open: 'betting',
        body: () => '每週可以押比賽勝負，自己的比賽只能押自己。賠率只看公開評分，亂押長期會虧。<br>如果球探或練習賽讓你知道得比賠率多，才有機會贏莊家。<b>現金不夠時別下注</b>，輸了可能直接破產。',
      },
    ],
  },
];

/** 目前該顯示的帶路步驟；沒有＝null。不管玩家在哪個畫面，由呼叫端帶回 step.screen */
export function currentStep(guide: GuideState | undefined, v: KnownView): Step | null {
  if (!guide?.on) return null;
  for (const l of LESSONS) {
    if (!l.when(v)) continue;
    const s = l.steps.find((x) => !guide.done.includes(x.id));
    if (s) return s;
  }
  return null;
}

/** 各頁說明：頂列「i」隨時看；標記 auto 的畫面第一次進去會自動跳出來 */
export const HELP: Partial<Record<Screen, { title: string; auto?: boolean; items: string[] }>> = {
  hub: {
    title: '基地：一週怎麼玩',
    items: [
      '<b>賽前</b>：看本週對手、調名單、簽人、排訓練，順序隨意。',
      '<b>開戰</b>：按中間的按鈕打這週的比賽，可以看完整場，也可以跳過。',
      '<b>結算</b>：領獎金、付薪水，訓練與球探的報告寄到信件。',
      '例行賽 7 週，前 4 名進季後賽（第 8 週準決賽、第 9 週決賽）。',
      '城市裡有線框的建築可以點，功能和左邊選單相同。',
    ],
  },
  squad: {
    title: '戰隊',
    items: [
      '上方卡片是出賽名單。點出賽位再點右邊的人，或把人拖到出賽位；選到已上場的人會互換。',
      '點陣容裡的人看詳情：升版、解約、戰術熟練度。',
      '<b>升版</b>要花錢和時間，替補就是拿來應付這種時候。',
    ],
  },
  player: {
    title: '選手詳情',
    auto: true,
    items: [
      '<b>版本線</b>：升下一版的費用、需時與之後的週薪。',
      '<b>戰術熟練度</b>跟著選手走：簽一個很會打某個戰術的人，隊伍打那個戰術也會變好。',
      '別隊的選手不能簽，但可以派球探，或跟他的戰隊打練習賽。',
    ],
  },
  market: {
    title: '轉會市場',
    items: [
      '<b>自由球員</b>：付簽約金就能簽，先到先簽。',
      '<b>球探</b>：下週回報真實強度（有誤差）。同樣是 v3，真實強度也可能差很多。',
      '右下「簽下之後」會算出現金與資金跑道的變化，簽之前看一眼。',
    ],
  },
  training: {
    title: '訓練基地',
    auto: true,
    items: [
      '環裡是本週還能排的場數，練習賽與戰術排練共用。',
      '<b>練習賽</b>：我方名單對某隊，報告給估計勝率，場數越多越準；推進時要多等幾秒。',
      '<b>戰術排練</b>在戰術室排。',
      '這週排的工作，推進一週後才出報告。',
    ],
  },
  tactics: {
    title: '戰術室',
    auto: true,
    items: [
      '<b>執行熟練度</b>：隊伍默契與出賽五人的個人熟練度各半，決定選手打這個戰術打得像不像。',
      '<b>排練</b>：一節佔一個訓練時段，越熟越難漲；比賽裡打過的戰術也會慢慢變熟。',
      '<b>比賽計畫</b>：星越多選手越常選；禁用的不會選。每一邊至少留一個戰術。',
      '新人第一次上場，隊伍默契會掉一些；他自己的熟練度會帶進來。',
    ],
  },
  league: {
    title: '聯賽',
    auto: true,
    items: ['上方時間軸可以點，切換看哪一週的賽程。', '打完的比賽有「觀戰」，可以回看任何一場。', '虛線以上進季後賽；同分比比分差。', '名次獎金差距很大，排名值得拚。'],
  },
  betting: {
    title: '賭盤',
    auto: true,
    items: ['點賠率加入下注單，輸入金額後確認。賠率下注時鎖定。', '自己的比賽只能押自己；每場有下注上限，名氣越高上限越高。', '賠率只看公開評分，球探與練習賽才是你的優勢。'],
  },
  finance: {
    title: '財務',
    auto: true,
    items: ['<b>資金跑道</b>：照固定支出還撐幾週，沒算比賽收入。', '資金曲線的虛線是照目前固定收支的推估。', '賽段在第 9 週結束，名次獎金會先發，再檢查破產。'],
  },
  inbox: {
    title: '信件',
    items: ['戰報、週結算、球探、練習賽、排練的報告都寄到這裡。', '報告信可以直接跳到相關頁面。'],
  },
};

/** 自動跳說明的畫面：還沒看過就回傳 id */
export function autoHelpId(guide: GuideState | undefined, screen: Screen): string | null {
  if (!guide?.on || !HELP[screen]?.auto) return null;
  const id = `help.${screen}`;
  return guide.done.includes(id) ? null : id;
}

export interface NextHint {
  text: string;
  to?: Screen;
}

export interface HintInput {
  v: KnownView;
  guide: GuideState | undefined;
  /** 沒讀的報告信數（戰報、公告不算） */
  unread: number;
  /** 本週對手的名字（沒有比賽＝null） */
  foe: string | null;
  /** 訓練容量（本週全部） */
  capacity: number;
}

/** 基地上的「下一步」：只給一件事，依急迫程度排 */
export function nextHint({ v, guide, unread, foe, capacity }: HintInput): NextHint {
  if (v.phase === 'ended') return { text: '賽段結束了，到聯賽看最終成績，或開始新的賽季', to: 'league' };
  if (v.phase === 'bankrupt') return { text: '戰隊破產了，到財務看錢去了哪裡', to: 'finance' };
  const open = (s: Screen): boolean => lockedUntil(s, v, guide) === null;
  const r = v.me.runwayWeeks;
  if (r !== null && r < 3) return open('finance') ? { text: `現金只夠撐 ${r} 週，先看財務，別再加支出`, to: 'finance' } : { text: `現金只夠撐 ${r} 週，先別再簽人` };
  if (unread > 0) return { text: `有 ${unread} 封新報告，看完再決定本週怎麼安排`, to: 'inbox' };
  if (v.phase === 'offseason') return { text: '開季前看看名單，需要補人到市場，準備好就按開幕', to: 'squad' };
  if (open('training') && v.me.capacityLeft >= capacity) return { text: `本週還沒排訓練，有 ${v.me.capacityLeft} 場可用`, to: 'training' };
  return foe ? { text: `本週對手：${foe}。看過名單就按開戰`, to: 'squad' } : { text: '本週沒有我方比賽，按開戰看其他賽場' };
}
