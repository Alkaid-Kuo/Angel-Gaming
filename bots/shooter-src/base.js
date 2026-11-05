// @ts-check
// CS 射擊基準 Bot 共用函式庫：型別、參數表、三角表、格子視線與射線、二元堆積、Dijkstra、小工具。
// 選手模組不能 import：scripts/build-shooter-bots.ts 會把 bots/shooter-src/ 的檔案合併成單檔 bots/shooter-baseline.js。
// 公平：所有推理只用 init 資料（地圖、規則）與每次的觀察資料；不讀引擎內部。

/** @typedef {import('../../src/shooter/api.ts').ShooterInitData} InitData */
/** @typedef {import('../../src/shooter/api.ts').ShooterHelpers} Helpers */
/** @typedef {import('../../src/shooter/api.ts').ShooterObservation} Observation */
/** @typedef {import('../../src/shooter/api.ts').ShooterCommand} Command */
/** @typedef {import('../../src/shooter/api.ts').ShooterDeclaration} Declaration */
/** @typedef {import('../../src/shooter/api.ts').EnemyInfo} Enemy */
/** @typedef {import('../../src/shooter/api.ts').WeaponInfo} WeaponInfo */
/** @typedef {import('../../src/shooter/api.ts').MapInfo} MapInfo */
/** @typedef {import('../../src/shooter/api.ts').Team} Team */
/** @typedef {import('../../src/shooter/api.ts').BuyItem} BuyItem */
/** @typedef {import('../../src/shooter/api.ts').WeaponId} WeaponId */
/** @typedef {import('../../src/shooter/api.ts').AttributeKey} AttributeKey */
/** @typedef {import('../../src/shooter/api.ts').GrenadeId} GrenadeId */
/** @typedef {{ x: number, y: number }} Pt */
/** @typedef {{ x0: number, y0: number, x1: number, y1: number }} Rect */

/** 1 格 = 1000 座標單位 */
export const UNIT = 1000;

/**
 * 參數表：全部是初值，步驟 7 訓練會調。距離單位標在註解（格或座標單位），時間以決策次數（0.1 秒）或秒標明。
 * 屬性（0～100）以 lerp(值0, 值100, 屬性/100) 接上，屬性 50 取中間值。
 */
export const P = {
  // ── 地圖分析 ──
  /** 窄口：區域交界通道寬度上限（格） */
  chokeWidth: 6,
  /** 守點位離入口的距離範圍（格） */
  holdMin: 8,
  holdMax: 20,
  /** 守點位候選：離包點矩形的路徑距離上限（格） */
  holdSiteRadius: 8,
  /** 暴露度：8 個方向射線，走得到這麼遠（格）就算暴露 */
  exposeRay: 6,
  /** 路線集：長度不超過最短路線的倍數、每個包點最多幾條 */
  routeSlack: 1.6,
  routeMax: 3,
  /** 繞後路線（2.6）：長度上限 × 最短；游擊走繞後的機率（再乘 0.6～1.4 依侵略）、主力喊執行後幾秒才進（lurkSlack 0 ＝ 關） */
  lurkSlack: 2.4,
  lurkProb: 0.35,
  lurkDelay: 4,

  // ── 感知 ──
  confSee: 100,
  confRadar: 80,
  confTracer: 70,
  confHurt: 60,
  confSound: 40,
  confDeath: 50,
  /** 信心每秒衰減（步驟 7 起不跟警覺連動：衰減慢會一直防著過時的位置，警覺高反而吃虧） */
  decay0: 25,
  decay100: 25,
  /** 低於這個信心就移到「未確認」 */
  unconfirmed: 30,
  /** 「已清空」維持幾秒（步驟 7 起不跟警覺連動，理由同上） */
  clearTtl0: 7.5,
  clearTtl100: 7.5,
  /** 聲音扇形半寬（度）與距離帶（格） */
  sectorHalfDeg: 15,
  bandNear: [0, 12],
  bandMid: [12, 30],
  bandFar: [30, 60],
  /** 雷達與聲音的採信倍率：警覺 0 → 100 */
  trust0: 0.7,
  trust100: 1,
  /** 守位時輪流看幾個方向：每幾次決策換一個 */
  scanEvery: 9,

  // ── 導航（A* 基本成本：直走 10、斜走 14） ──
  /** 危險格成本 = 信心 × 係數（敵人看得到的格；距離衰減：dangerRange 格處剩一半） */
  dangerCoef: 0.6,
  /** 聲音扇形內的格 */
  sectorCoef: 0.3,
  /** 危險射線的最遠距離（格） */
  dangerRange: 30,
  /** 貼牆加成（避免卡角）與矮牆旁優惠 */
  wallHug: 4,
  lowBonus: 3,
  /** 跟路線時，路線以外區域的格加成 */
  offRoute: 12,
  /** 換路線：離 T 出生區這麼近（格）才換；路線交界點的危險格成本超過這個值就換 */
  routeSwitchNear: 35,
  routeSwitchRisk: 15,
  /** 重算路徑的間隔（tick） */
  replanTicks: 30,
  /** 被擋住：連續幾次決策幾乎沒動（1 秒） */
  stuckDecisions: 10,
  /** 到路徑點的判定距離（座標單位）；平滑線段上限（格） */
  waypointReach: 1200,
  maxSegment: 6,
  /** 探頭：停在窄口前幾格、等幾次決策（侵略 0 → 100） */
  peekStop: 2,
  peekHold0: 10,
  peekHold100: 1,
  /** 侵略低於這個值、而且走位不低於 shoulderMove 才用肩探（露一半再退），否則直接寬探過去 */
  shoulderBelow: 60,
  shoulderMove: 40,
  /** 走位高於這個值：附近（20 格）有記得的敵人時靜步移動 */
  silentMove: 60,
  /** 敵人最快的移動速度（格／秒，含裕度）：用來判斷某格敵人「可能已經到了」 */
  enemySpeed: 4.6,

  // ── 戰鬥 ──
  /** 瞄準誤差初值（格）：aim 0 → 100 */
  aimErr0: 1.0,
  aimErr100: 0.15,
  /** 每次決策的誤差收斂比例：aim 0 → 100 */
  aimConv0: 0.8,
  aimConv100: 0.4,
  /** 預判：反應延遲之外再多看幾 tick */
  leadExtra: 2,
  /** 看到新目標後額外等幾次決策才開火：reaction 0 → 100 */
  react0: 3,
  react100: 0,
  /** 敢開槍（2.2）：侵略 0 → 100 時上面的等待再加減幾次決策（小數用機率進位）。保守的人多看一眼，敢衝的人先開火，赤岩舊城上侵略才量得出強度差 */
  reactAggr0: 0.6,
  reactAggr100: -0.6,
  /** 預瞄：新目標在自己朝向 ±preAimDeg 度內出現時，初始瞄準誤差 × (1 − preAimErr × 警覺) */
  preAimErr: 0.6,
  preAimDeg: 20,
  /** 餘光察覺：離準心這麼多度以外出現的敵人，每次決策注意到的機率（警覺 0 → 100） */
  periphDeg: 25,
  notice0: 0.35,
  notice100: 1,
  /** 開火散佈門檻：散佈 ≤ 目標半張角 × K（或基礎散佈）才開火 */
  fireSpreadK: 2.6,
  /** 狙擊開火的瞄準誤差上限（格） */
  awpErr: 0.22,
  /** 狙擊近距離切手槍（格） */
  awpClose: 8,
  /** 彈匣空了、敵人在這個距離內就切手槍（格） */
  pistolSwitch: 12,
  /** 換彈：沒看到敵人且彈匣低於這個比例 */
  reloadBelow: 0.4,
  /** 隊友擋線：隊友離彈道小於這個距離（座標單位）就不開火：discipline 0 → 100 */
  friendClear0: 700,
  friendClear100: 1200,
  /** 紀律高於這個值：守位中目標跑出射程不追 */
  holdFirm: 50,
  /**
   * 撤退：血量門檻；1 對多：看得到 ≥ N 個敵人（取整數部分）且 mateNear 格內沒有隊友。
   * 步驟 7 起不跟侵略連動（6-1 是 40→20 血、2→4 人）：侵略高的人殘血硬拚、以寡擊眾，抵銷了探頭與計畫的好處，鏡像裡侵略的梯度是平的
   */
  retreatHp0: 30,
  retreatHp100: 30,
  outnumber0: 3,
  outnumber100: 3,
  mateNear: 10,
  /** 掩體搜尋半徑（格） */
  coverRadius: 8,
  /** 目標消失後架槍幾秒（侵略 0 → 100） */
  holdAngle0: 2.6,
  holdAngle100: 0.4,
  /** 穿煙盲射（2.6）：開關（只有 CT 打；T 也打的 blindT 在 2.7 刪掉）、線索幾秒內有效、最多幾組、侵略多少以上打完前推一步 */
  blindFire: true,
  blindMemo: 2,
  blindGroups: 2,
  blindPush: 0.7,
  /** 盲射的友軍限制（2.6.1）：隊友在煙裡、或離我到目標點的線段這麼近（格）就不打 */
  blindMateGap: 3,
  /** 開火時蹲的最短距離（格） */
  crouchFireMin: 8,
  /** 停步開火的乾淨度：movement 0 → 100 時「這次先不停」的機率 */
  sloppyStop0: 0.5,
  sloppyStop100: 0,
  /** 道具自保：手雷／燃燒落點離自己幾格內要離開 */
  nadeAvoid: 4,

  // ── 戰術（6-2 團隊） ──
  /** CT 開局守 A 的人數（旋鈕 ctSplitA）；B 固定 ctB 人，其餘守中路 */
  ctSplitA: 2,
  ctB: 2,
  /** 下包時：看得到敵人就不下 */
  plantRequireClear: true,
  /** T 待命點：在包點入口外面這麼多格（距離場差） */
  stageBack: 9,
  /** 待命位找不到安全格時，往後多找幾次、每次退幾格 */
  stageRetreatSteps: 5,
  stageRetreat: 4,
  /** 進場間距：入口幾格內才排、前一人領先幾格才走、每回合最多等幾秒 */
  entryZone: 9,
  entryGap: 2.6,
  entryWaitMax: 2.5,
  /** split 第二組估路程用的移速（格／秒） */
  routeSpeed: 3.9,
  /** 閃光：組裡最前面的人離入口幾格內才丟（引信＋指令延遲約 1.7 秒，約走 7 格），炸開時他剛好到轉角 */
  flashLead: 10,
  /** T 閃光爆點候選：入口內幾格（2.5 第三批從 8 放寬，CT 深位離入口 16 格以上） */
  flashDeep: 12,
  /** 隊友的閃光：走到離閃光半徑這麼近（格）就先停 */
  flashEdge: 1.5,
  /** 輪到丟閃的人沒丟：幾秒後換誰有誰丟 */
  flashTurn: 0.8,
  /** 閃光去重（2.6）：瞄準時先喊 E:flashing，隊友把爆點當成已認領幾秒；入口判定放寬到 flashDeep；看得到飛行中的閃光也算；
   * 輪到的人沒丟時組內每人錯開 flashStagger 秒接手（false ＝ 2.5 的時間到誰有誰丟；只在喊過有閃光的組員之間輪的 flashHolders 在 2.7 刪掉） */
  flashClaim: true,
  flashClaimSec: 2,
  flashStagger: 0.5,
  /** 有效連閃（2.6.1）：同入口第一顆後 flashSecondAfter～flashSecondWin 秒內可以再丟一顆；非 rush 的爆點要離第一顆 flashSecondGap 格以上 */
  flashSecond: true,
  flashSecondAfter: 0.8,
  flashSecondWin: 3,
  flashSecondGap: 6,
  /** 收到隊友的 E:flashing 就先移動去躲（2.6.1） */
  flashClaimDodge: true,
  /** 2.6.3：躲閃光與停在轉角的人提前「反應延遲 − flashReleaseMargin」放行，炸開時剛好開始動（flashRelease）；
   * 入口被燒住時煙霧手先丟煙滅火（smokeFire）。2.7 刪掉預設關的 flashStill（原地背身）、flashSeeDodge（看飛行中的閃光推落點）、
   * flashHolders（E:fl 輪替）、flankCover（看側翼）、rotDeep、giveUpRun、probeRun、blindT，要回頭做從 git 取回 */
  flashRelease: true,
  flashReleaseMargin: 2,
  smokeFire: true,
  /** 守包：離炸彈至少幾格、彼此至少隔幾格 */
  postMin: 5,
  postGap: 6,
  /** 友軍淨空：每格距離多留的寬度（格），涵蓋散佈 */
  friendSpread: 0.05,
  /** 友軍淨空：沒打中的子彈會繼續飛，目標後方幾格內有隊友、寬度幾格內也算擋線 */
  friendBehind: 20,
  friendBehindClear: 0.7,
  /** 待命點附近每人分到的格彼此至少隔幾格 */
  stageGap: 1.6,
  /** split：等第二組到待命點最多幾秒（從開打算）；fake：佯攻組製造聲音後幾秒主力執行 */
  splitWait: 32,
  fakeDelay: 4,
  /** default：開打後幾秒執行（侵略 0 → 100），期間蒐集情報 */
  defaultExec0: 56,
  defaultExec100: 26,
  /** 剩這麼多秒還沒下包就強行執行最近的點 */
  forceExecLeft: 35,
  /** 事件廣播：同一區域的接觸最少隔幾秒再喊；收到的接觸記多久（秒） */
  contactEvery: 1.5,
  contactTtl: 12,
  /** 收到事件後幾次決策才反應（警覺 0 → 100） */
  eventDelay0: 4,
  eventDelay100: 0,
  /** CT 輪轉：某點估計敵人數達到這個值就輪轉（另一點只留錨點） */
  rotateHeat: 2,
  /** 回防：在待命點幾格內算到齊 */
  retakeGather: 3.5,
  /** 回防／保槍：時間不夠的裕度（秒）；保槍要離炸彈幾格 */
  saveMargin: 2,
  saveDist: 22,
  /** 保槍躲遠（2.6.1）：走到離炸彈與敵人（記得的、腳步聲）最遠的掩體格、每幾秒重找；false ＝ 2.5 的夠遠就原地 */
  saveHide: true,
  saveEvery: 2,
  /** 保槍看局勢（2.6.2）：對方賽點、半場最後一回合不保；1 對多時手上是狙擊槍或步槍才保 */
  saveSmart: true,
  /** 發槍（2.6.2）：全買／強起時，錢多又沒好槍的人幫買不起的人買（狙擊槍優先給狙擊手）；收的人開打後幾秒內去撿，撿不到就自己買 */
  gifts: true,
  giftWait: 5,
  /** 撿槍（2.6.2）：安全時撿幾格內比手上好的槍 */
  grab: true,
  grabRange: 5,
  /** 殘局：只剩自己、對方 ≤ 2 人時，侵略 ≥ 這個值（0～1）的 CT 會主動找人 */
  huntAggr: 0.65,
  /** 換血：隊友在這麼近（格）陣亡就朝他死的方向架槍幾秒 */
  tradeRange: 8,
  tradeHold: 1.5,
  /** 不追殘血：估計血量 ≤ 這個值、消失點在這麼近（格）內，紀律低的人會追幾秒 */
  chaseHp: 40,
  chaseRange: 15,
  chaseTime: 3,
  /** 閃光：隊友離爆點太近（格）就不丟 */
  flashMateClear: 4,
  /** 煙霧：放在入口往架點方向幾格 */
  smokeOff: 4.5,
  /** 同回合兩顆煙的落點至少隔幾格（2.2） */
  smokeGap: 6,
  /** 兩路進點（2.2）：主力在待命格等第二組到第二入口這麼近（格），最多等幾秒 */
  flankNear: 12,
  flankWait: 18,
  /** 已知槍線：隊友死後幾秒內算數、死亡點幾格內算走進火線、每次最多停幾秒、看過的狙擊手記幾秒 */
  lineMemo: 5,
  lineZone: 8,
  lineHold: 2,
  awpMemo: 20,
  /** 上回合的狙擊位仍當成威脅、躲開它的機率 */
  awpAvoid: 0.7,
  /** CT 道具：敵人離入口外側這麼近（格）算壓力 */
  pressNear: 16,
  /** CT 深位（2.5 第三批）：離 T 主要入口至少閃光半徑＋1 格、最多這麼遠（格） */
  deepMax: 32,
  /** CT 拖時間：敵方閃光炸在入口幾格內算壓到入口、記幾秒 */
  enemyFlashNear: 10,
  enemyFlashMemo: 4,
  /** CT 放棄點：估計這麼多 T 已經進點、自己點上不超過幾人就退到回防位 */
  giveUpIn: 3,
  giveUpMine: 2,
  /** 退到包點裡看不到的退守位（false ＝ 回防集結位） */
  fallHide: true,
  /** CT 看到對面在包點附近封煙：當成幾人的接觸（1 ＝ 只提高警覺，單獨不夠輪轉） */
  smokeAlarmN: 1,
  /** CT 開局探點：開打後幾秒內去看一眼；T 至少晚這麼多秒才會到那裡 */
  probeTime: 12,
  probeMargin: 4,
  /** 探點 2.6：站交界 CT 側貼牆的格、到位後最多停幾秒（沒有掩體格只停一半）、探到情報就縮回掩體（false ＝ 2.5 的交界中心、時間到才回） */
  probeCover: true,
  probeStay: 4.5,
  /** 手雷：兩個以上記得的敵人彼此在這麼近（格）內算聚集 */
  nadeCluster: 3.5,

  // ── 2.7 修正批：每項一個開關，false ＝ 2.6.3 的行為（審核對照用） ──
  /** 1-1：撿槍排在任務期限判定之後，commit 亮起就不撿（false ＝ 先撿槍，趕期限的拆包手也會轉去撿） */
  grabAfterTask: true,
  /** 1-2：「進過包點」按點記（false ＝ 進過任何一點都算，佯攻組踩進誘餌點也讓主力少等） */
  wentInSite: true,
  /** 1-3：聲音反應等待同一次決策只扣一次（false ＝ alert 與 look 各扣一次，等待只剩一半） */
  heardOnce: true,
  /** 1-3：同方向聲音合併成同一個扇形時不把等待歸零；停了 1 秒以上再響才重新等（false ＝ 連射期間永遠聽不到） */
  heardKeep: true,
  /** 1-4：撿槍照引擎規則模擬下一個會撿到什麼（同點的拆彈器、T 撿不到的東西不擋；同點排前面的是沒用的東西就放棄，不鎖死）；
   * false ＝ 2.6.3 只要有別的東西一樣近就不撿（槍與拆彈器同點永遠撿不到） */
  grabSim: true,
  /** 引擎撿取範圍（格） */
  pickReach: 1.2,
  /** 1-5：加時的對方賽點用加時段的門檻（false ＝ 2.6.3 固定用正規的 winRounds − 1，加時第一局就當成賽點） */
  otMatchPoint: true,
  /** 1-6：我方閃光以投擲者＋爆炸時間識別（宣告、已出手、已爆分開；同點兩次投擲算兩顆，飛行中的拋體只補已知之外的）；
   * false ＝ 2.6.3 以 3 格距離去重 */
  flashIdent: true,
  /** 1-6：關掉 flashRelease（或狙擊手）時躲閃光到 pop + 2 為止含等號（false ＝ 2.6.3 的 <，和 2.6.2 差一個決策） */
  flashOffEq: true,
  /** 1-7：閃光候選（看爆點的人依守點位、記得的敵人、聲音打分）的快取每幾秒依敵情重算（0 ＝ 2.6.3：只看包點、入口、煙數，同回合新接觸點不反應） */
  flashCacheSec: 1,
  /** 1-8：繞後者喊 E:lurk，隊友把他從原組的人數、順序、煙霧手、等第二組排除；剩不到 4 人就不繞後（含已決定的，回原組）；
   * false ＝ 2.6.3 繞後者仍算原組成員、決定快取後人數變少也照繞 */
  lurkOut: true,
  /** 1-10 A5：守位中 look() 不轉去看聲音，和 alert() 的「守位只看挨打」一致（false ＝ 架門的 CT 聽到另一點槍聲就轉去看牆 1 秒） */
  lookHoldQuiet: true,
  /** 1-10 A11：守包的拆包警報（每次看到在拆或聽到拆包聲推到拆包時間後）在警報後有 CT 陣亡就解除（拆包的人被殺了；別人再拆會有新的證據）；
   * false ＝ 2.6.3 鎖滿拆包時間，拆包手被殺後 T 仍以為在拆、站在爆炸半徑內不撤離 */
  defuseAlarmKill: true,
  /** 1-10 A12：等槍線的計時只在出現更新的隊友陣亡時歸零（false ＝ 兩個隊友 5 秒內陣亡時新舊兩筆來回切，每 tick 歸零，2 秒上限失效） */
  lineNewest: true,
  /** 1-10 A13：拆包、下包途中不換血架槍、不追殘血（false ＝ 拆包手 8 格內隊友陣亡就原地架 1.5 秒，低紀律還追殘血 3 秒） */
  tradeSkipTask: true,
  /** 1-10 A21：這次決策沒送出導航的移動（站著開槍、丟道具、架槍停步）就不算被擋（false ＝ 站著滿 1 秒就重算路徑、取消探頭、側移讓路） */
  navIdle: true,
  /** 1-10 A27：燒拆包、CT 燒入口和 T 燒回防入口一樣，落點 4 格內有隊友就不燒（false ＝ 燒到正在和拆包手交火的隊友、探點回程的自己人） */
  burnMateCheck: true,
  /** 1-10 A23：沒有下一回合（半場最後一回合、對方賽點）就 force，不管平均多少錢（false ＝ 平均不到甲＋衝鋒槍的八成就落到 eco，錢會被重置或比賽結束卻裸奔） */
  critForce: true,
  /** 1-10 A9：主武器空了也沒有備彈：不管敵人多遠都切手槍（false ＝ 敵人在 pistolSwitch 外時只標「換彈」、沒有任何指令） */
  emptySwitch: true,
  /** 1-10 A6：視錐掃描照引擎的矮牆規則（站著越過矮牆；蹲著時 2 格內的矮牆才擋；矮牆後 lowCoverRange＋1 格內蹲著的人看不到，不算清過）；
   * false ＝ 2.6.3 碰到矮牆就停，站在矮牆後看得到的格永遠「沒清過」 */
  scanLow: true,
  /** 1-12（H01）：守包時對方在拆（看到或 1 秒內聽到）而手上沒有燃燒／手雷：離炸彈最近的守包者當反拆責任人，轉向炸彈、走到看得到炸彈的位置開火
   *（煙裡照炸彈位置打）；證據過期（假拆）或來不及在最晚干預時間（開始拆＋不帶拆彈器的拆包時間）前到位就不去。false ＝ 2.6.3 站著不動 */
  antiDefuse: true,
  /** 反拆：離炸彈這麼近（格）而且看得到炸彈就停下開火 */
  antiDefuseRange: 12,

  /** 1-13（H02）：補槍人選先篩掉不能支援的人（看不到線索、致盲、持包、下包／拆包、自己在換彈）再依距離選（false ＝ 2.6.3 先按距離只准第一名，隔牆的最近隊友會占住名額） */
  coopEligible: true,

  /** 1-14（H03）：接觸熱度去重：同一點的接觸若在時間內走得到（可能是同一人移動）就合併取大，不相加；最後以敵方存活數為上限
   *（false ＝ 2.6.3 12 秒內各區的人數直接相加，同一敵人跨區出現算兩人） */
  heatDedupe: true,

  /** 1-15（H04）：用附近的曳光更新記得的敵人位置時，來源改成 tracer、信心用曳光的，最後目視時間（seenTick）不動；同一個 tick 已經目視就不覆蓋
   *（false ＝ 2.6.3 保留 see 與高信心，推測冒充新的目視） */
  tracerSrc: true,

  /** 1-9：收到隊友的 E:flash 時，把多近的「只收到宣告、估計爆炸時間」的躲避換成準確的（格；2.6.2 是 4、2.6.3 是 6）；
   * claimById：改成只換掉同一個人的宣告（不看距離；2.7 預設：兩組種子各 200 場與 m6 的被隊友閃到人次最少，見 PR） */
  claimClear: 6,
  claimById: true,
  // ── 2.7 批 2（Astra P2-2） ──
  /** 找要躲的閃光時先排除已進放行窗的那顆，多顆閃光時第一顆放行不會讓第二顆也不躲（false ＝ 2.6.3 先找第一顆、它放行就整個不躲） */
  flashMulti: true,
  // ── 2.7 批 2b（B1 重做）：補槍偏好換角度（成對進門兩次實測都沒有改善，未採用，見任務書） ──
  /** 補槍接替：站位看殺手的角度和陣亡隊友差不到 tradeAngle 度時扣分（越接近同一個角扣越多，最多 tradePen）；只是偏好，找不到別的角照樣補（0 ＝ 2.6.3） */
  tradeAngle: 25,
  tradePen: 2,

  // ── 2.8：戰術選擇的效用分數（M5 規格 3.4；score ＝ S ＋ Wp×星級 ＋ Wq×(q−0.5) − Wr×本半場用過次數 ＋ A） ──
  /** 星級、隊伍執行熟練度、本半場每用過一次的扣分；前兩名差這麼多以內用回合雜湊二選一；對手適應項的上限 */
  tacWp: 0.5,
  tacWq: 0.2,
  tacWr: 0.35,
  tacEps: 0.1,
  tacAmax: 0.3,

  // ── 2.8：執行品質（M5 規格 3.5；q＝本回合戰術的隊伍執行熟練度、p＝個人熟練度；q、p＝0.5 時和 2.7 相同，熟練度不改槍法） ──
  /** 兩組同步（split）：到位判定半徑 × (1 ＋ qSync×(0.5−q))；熟練度低時等第二組的上限 × (1 ＋ qSyncWait×(0.5−q)) */
  qSync: 0.6,
  qSyncWait: 0.8,
  /** 道具時序：閃光提前出發的路程估計 × (1 − qFlash×(0.5−q))（q 低出發晚）；q 高最多 × 1.1 */
  qFlash: 0.8,
  /** 個人：收到執行後晚 max(0, 0.5−p) × qLag 秒出發；佈置途中每半秒停下的機率 max(0, 0.5−p) × qPause */
  qLag: 0.8,
  qPause: 0.4,

  // ── 經濟（2.2） ──
  /** 輸手槍局後第二回合的買法（eco／force／half 各 200 場實測，force 整場勝率最高，見 2.2 報告） */
  afterPistol: 'force',
  /** 上回合 eco、這回合平均金錢還有這麼多就 force（連續 eco 最多一回合，2.5） */
  ecoFloor: 1500,
  /** 平均夠 force 時，若存一回合下回合就能全買，仍可 eco 一回合（不連續）；平均到這麼多就不存（差一點全買，force 勝率遠高於 eco） */
  ecoSave: true,
  ecoSaveMax: 3500,

  // ── 角色（2.1） ──
  /** T 執行：不是突破手的人離包點這麼近（格）就等突破手先進；每回合最多等幾秒 */
  yieldNear: 6,
  yieldMax: 3,
  /** 兩路同時進點時，近的一路最多等幾秒 */
  yieldMaxSplit: 7,
  /** 照計畫執行：其他人在待命格等突破手先走，執行後最多幾秒 */
  stageLead: 5,
  /** 開打時和突破手同組的人在出生區（離出生區這麼多格內）慢走讓突破手先走，最多幾秒 */
  spawnLead: 10,
  spawnLeadMax: 4,
  spawnStop: 1.5,
  /** 狙擊專長：狙擊手拿狙擊槍以外的槍時，瞄準屬性少這麼多（0～1） */
  awpOffAim: 0.35,
  /** CT 回防 go 之後，其他人等突破手先進點最多幾秒 */
  retakeLead: 1.2,
};

// ───────── 三角表與角度 ─────────

/** 整數度的 cos／sin：init 時由 helpers.offset 建表（選手禁用 Math.cos／sin） */
const COS = new Float64Array(360);
const SIN = new Float64Array(360);
/** @type {Helpers | null} */
let HELP = null;

/** @param {Helpers} h */
export function initTrig(h) {
  HELP = h;
  for (let d = 0; d < 360; d++) {
    const [x, y] = h.offset(0, 0, d, 1000000);
    COS[d] = x / 1000000;
    SIN[d] = y / 1000000;
  }
}

/** @param {number} d */
export function normDeg(d) {
  const r = Math.round(d) % 360;
  return r < 0 ? r + 360 : r;
}

/** @param {number} d */
export function cosd(d) {
  return COS[normDeg(d)];
}

/** @param {number} d */
export function sind(d) {
  return SIN[normDeg(d)];
}

/** 方位角（整數度 0～359；0 = 東、90 = 南） @param {number} ax @param {number} ay @param {number} bx @param {number} by */
export function angleTo(ax, ay, bx, by) {
  if (HELP === null || (ax === bx && ay === by)) return 0;
  return normDeg(HELP.angleTo(ax, ay, bx, by));
}

/** 有號角度差 a − b，範圍 (−180, 180] @param {number} a @param {number} b */
export function adiff(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** @param {number} ax @param {number} ay @param {number} bx @param {number} by */
export function dist(ax, ay, bx, by) {
  return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by));
}

/** @param {number} v @param {number} lo @param {number} hi */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 屬性線性插值：t = 屬性 / 100 @param {number} a @param {number} b @param {number} t */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 點到線段的距離與投影比例 t（0～1 在線段上） @param {number} px @param {number} py @param {number} ax @param {number} ay @param {number} bx @param {number} by */
export function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  const c = clamp(t, 0, 1);
  return { d: dist(px, py, ax + dx * c, ay + dy * c), t };
}

/** @param {Rect} r @param {number} cx @param {number} cy */
export function inRect(r, cx, cy) {
  return cx >= r.x0 && cx < r.x1 && cy >= r.y0 && cy < r.y1;
}

// ───────── 格子 ─────────

/** 8 方向（dx, dy, 成本 ×10） */
export const DIR8 = [
  [1, 0, 10],
  [-1, 0, 10],
  [0, 1, 10],
  [0, -1, 10],
  [1, 1, 14],
  [1, -1, 14],
  [-1, 1, 14],
  [-1, -1, 14],
];

export class Grid {
  /** @param {MapInfo} map */
  constructor(map) {
    this.W = map.width;
    this.H = map.height;
    this.N = this.W * this.H;
    /** 牆（擋視線、子彈） */
    this.wall = new Uint8Array(this.N);
    /** 擋移動（牆或矮牆） */
    this.block = new Uint8Array(this.N);
    /** 矮牆 */
    this.low = new Uint8Array(this.N);
    /** 斜切格的實心角（0 西北、1 東北、2 東南、3 西南），其他格 −1 */
    this.slope = new Int8Array(this.N);
    for (let i = 0; i < this.N; i++) {
      const v = map.solid[i];
      this.wall[i] = v === 1 || (v >= 3 && v <= 6) ? 1 : 0;
      this.block[i] = v !== 0 ? 1 : 0;
      this.low[i] = v === 2 || v >= 7 ? 1 : 0;
      this.slope[i] = v >= 3 ? (v - 3) % 4 : -1;
    }
  }

  /** 換到斜切格的本地座標：實心三角形是 u ≥ 0、v ≥ 0、u + v ≤ UNIT @param {number} i @param {number} x @param {number} y @returns {[number, number]} */
  slopeLocal(i, x, y) {
    const c = this.slope[i];
    const cx = (i % this.W) * UNIT;
    const cy = Math.floor(i / this.W) * UNIT;
    return [c === 0 || c === 3 ? x - cx : cx + UNIT - x, c === 0 || c === 1 ? y - cy : cy + UNIT - y];
  }

  /** 點落在這格的實心部分：斜切格只算實心三角形 @param {number} i 格索引 @param {number} x @param {number} y */
  filled(i, x, y) {
    if (this.slope[i] < 0) return true;
    const [u, v] = this.slopeLocal(i, x, y);
    return u + v <= UNIT;
  }

  /** 點落在牆裡 @param {number} i 格索引 @param {number} x @param {number} y */
  wallAt(i, x, y) {
    return this.wall[i] === 1 && this.filled(i, x, y);
  }

  /** 點到斜切格實心三角形的距離平方（同引擎） @param {number} i @param {number} x @param {number} y */
  slopeDistSq(i, x, y) {
    const [u, v] = this.slopeLocal(i, x, y);
    if (u >= 0 && v >= 0 && u + v <= UNIT) return 0;
    const cu = Math.max(0, Math.min(UNIT, u));
    const cv = Math.max(0, Math.min(UNIT, v));
    const s = Math.max(-UNIT, Math.min(UNIT, u - v));
    const du = u - (UNIT + s) / 2;
    const dv = v - (UNIT - s) / 2;
    return Math.min((u - cu) * (u - cu) + v * v, u * u + (v - cv) * (v - cv), du * du + dv * dv);
  }

  /** 線段碰到斜切格的實心三角形（同引擎，邊界算碰到） @param {number} i @param {number} ax @param {number} ay @param {number} bx @param {number} by */
  cutsSlope(i, ax, ay, bx, by) {
    const [ua, va] = this.slopeLocal(i, ax, ay);
    const [ub, vb] = this.slopeLocal(i, bx, by);
    let t0 = 0;
    let t1 = 1;
    for (const [g, d] of [[-ua, ua - ub], [-va, va - vb], [ua + va - UNIT, ub - ua + vb - va]]) {
      if (d === 0) {
        if (g > 0) return false;
      } else if (d < 0) t0 = Math.max(t0, g / -d);
      else t1 = Math.min(t1, -g / d);
    }
    return t0 <= t1;
  }

  /** 斜穿格角時的側格算不算牆：斜切格看線段有沒有碰到 @param {number} cx @param {number} cy @param {number} ax @param {number} ay @param {number} bx @param {number} by */
  sideWall(cx, cy, ax, ay, bx, by) {
    if (!this.isWall(cx, cy)) return false;
    if (cx < 0 || cy < 0 || cx >= this.W || cy >= this.H) return true;
    const i = cy * this.W + cx;
    return this.slope[i] < 0 || this.cutsSlope(i, ax, ay, bx, by);
  }

  /** 座標單位 → 格索引；出界 −1 @param {number} x @param {number} y */
  cellOf(x, y) {
    const cx = Math.floor(x / UNIT);
    const cy = Math.floor(y / UNIT);
    if (cx < 0 || cy < 0 || cx >= this.W || cy >= this.H) return -1;
    return cy * this.W + cx;
  }

  /** 格中心（座標單位） @param {number} i @returns {Pt} */
  center(i) {
    return { x: (i % this.W) * UNIT + UNIT / 2, y: Math.floor(i / this.W) * UNIT + UNIT / 2 };
  }

  /** @param {number} cx @param {number} cy */
  isWall(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.W || cy >= this.H) return true;
    return this.wall[cy * this.W + cx] === 1;
  }

  /** @param {number} cx @param {number} cy */
  isBlock(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.W || cy >= this.H) return true;
    return this.block[cy * this.W + cx] === 1;
  }

  /** @param {number} i */
  walkable(i) {
    return i >= 0 && i < this.N && this.block[i] === 0;
  }

  /**
   * 站姿視線（座標單位）：牆擋、矮牆不擋；斜穿格角時兩側都是牆才擋（同引擎）。起點與終點格不檢查，斜切格一律算實際形狀
   * @param {number} ax @param {number} ay @param {number} bx @param {number} by
   */
  los(ax, ay, bx, by) {
    const start = this.cellOf(ax, ay);
    if (start >= 0 && this.slope[start] >= 0 && this.wall[start] === 1 && this.cutsSlope(start, ax, ay, bx, by)) return false;
    const x0 = ax / UNIT;
    const y0 = ay / UNIT;
    const x1 = bx / UNIT;
    const y1 = by / UNIT;
    let cx = Math.floor(x0);
    let cy = Math.floor(y0);
    const ex = Math.floor(x1);
    const ey = Math.floor(y1);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const sx = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const sy = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const tdx = sx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = sy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = sx > 0 ? (cx + 1 - x0) * tdx : sx < 0 ? (x0 - cx) * tdx : Infinity;
    let tmy = sy > 0 ? (cy + 1 - y0) * tdy : sy < 0 ? (y0 - cy) * tdy : Infinity;
    let n = Math.abs(ex - cx) + Math.abs(ey - cy);
    while (n > 0) {
      if (Math.abs(tmx - tmy) < 1e-9) {
        if (this.sideWall(cx + sx, cy, ax, ay, bx, by) && this.sideWall(cx, cy + sy, ax, ay, bx, by)) return false;
        cx += sx;
        cy += sy;
        tmx += tdx;
        tmy += tdy;
        n -= 2;
      } else if (tmx < tmy) {
        cx += sx;
        tmx += tdx;
        n -= 1;
      } else {
        cy += sy;
        tmy += tdy;
        n -= 1;
      }
      const i = cx >= 0 && cy >= 0 && cx < this.W && cy < this.H ? cy * this.W + cx : -1;
      if (i >= 0 && this.slope[i] >= 0) {
        if (this.sideWall(cx, cy, ax, ay, bx, by)) return false;
        if (cx === ex && cy === ey) return true;
        continue;
      }
      if (cx === ex && cy === ey) return true;
      if (this.isWall(cx, cy)) return false;
    }
    return true;
  }

  /**
   * 射線：從 (x, y) 朝 deg 每半格走一步，最多 maxCells 格，碰牆停；每格呼叫 visit(格索引, 距離格數)，回傳 false 就停
   * @param {number} x @param {number} y @param {number} deg @param {number} maxCells
   * @param {(i: number, d: number) => boolean | void} visit
   */
  ray(x, y, deg, maxCells, visit) {
    const c = cosd(deg) * (UNIT / 2);
    const s = sind(deg) * (UNIT / 2);
    let last = -1;
    for (let k = 1; k <= maxCells * 2; k++) {
      const i = this.cellOf(x + c * k, y + s * k);
      if (i < 0 || this.wallAt(i, x + c * k, y + s * k)) return;
      if (i === last) continue;
      last = i;
      if (visit(i, k / 2) === false) return;
    }
  }

  /**
   * 直線走得過去（座標單位）：沿線每 1/4 格取樣，連同左右 0.4 格的平行線都不碰擋移動的格
   * @param {number} ax @param {number} ay @param {number} bx @param {number} by
   */
  walkLine(ax, ay, bx, by) {
    const len = dist(ax, ay, bx, by);
    if (len < 1) return true;
    const ux = (bx - ax) / len;
    const uy = (by - ay) / len;
    const px = -uy * 400;
    const py = ux * 400;
    const steps = Math.ceil(len / 250);
    for (let k = 0; k <= steps; k++) {
      const x = ax + ((bx - ax) * k) / steps;
      const y = ay + ((by - ay) * k) / steps;
      for (const o of [0, 1, -1]) {
        const i = this.cellOf(x + px * o, y + py * o);
        if (i < 0 || this.block[i] === 1) return false;
      }
    }
    return true;
  }
}

// ───────── 二元堆積與 Dijkstra ─────────

/** 最小堆積（允許重複推入，取出時由呼叫端略過過期的項目）；型別陣列重複使用，不足時加倍 */
export class Heap {
  constructor(cap = 4096) {
    this.node = new Int32Array(cap);
    this.key = new Float64Array(cap);
    this.size = 0;
    /** 上一次 pop 取出的鍵值 */
    this.lastKey = 0;
  }

  clear() {
    this.size = 0;
  }

  /** @param {number} n @param {number} k */
  push(n, k) {
    if (this.size === this.node.length) {
      const node = new Int32Array(this.size * 2);
      const key = new Float64Array(this.size * 2);
      node.set(this.node);
      key.set(this.key);
      this.node = node;
      this.key = key;
    }
    const node = this.node;
    const key = this.key;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (key[p] <= k) break;
      node[i] = node[p];
      key[i] = key[p];
      i = p;
    }
    node[i] = n;
    key[i] = k;
  }

  /** 取出最小的節點（呼叫前確認 size > 0）；最小鍵值放在 lastKey */
  pop() {
    const node = this.node;
    const key = this.key;
    const top = node[0];
    this.lastKey = key[0];
    const len = --this.size;
    if (len > 0) {
      const n = node[len];
      const k = key[len];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= len) break;
        const r = l + 1;
        const c = r < len && key[r] < key[l] ? r : l;
        if (key[c] >= k) break;
        node[i] = node[c];
        key[i] = key[c];
        i = c;
      }
      node[i] = n;
      key[i] = k;
    }
    return top;
  }
}

/**
 * 多源 Dijkstra（8 方向、不斜穿牆角；成本 ×10）：回傳每格到最近來源的路徑長（×10），走不到為 Infinity
 * @param {Grid} g @param {readonly number[]} sources @param {number} [limit]
 */
export function dijkstra(g, sources, limit = Infinity) {
  const d = new Float64Array(g.N).fill(Infinity);
  const heap = new Heap();
  for (const s of sources) {
    if (!g.walkable(s)) continue;
    d[s] = 0;
    heap.push(s, 0);
  }
  const W = g.W;
  while (heap.size > 0) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > d[i]) continue;
    const x = i % W;
    const y = (i - x) / W;
    for (const [dx, dy, c] of DIR8) {
      const nx = x + dx;
      const ny = y + dy;
      if (g.isBlock(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (g.isBlock(x + dx, y) || g.isBlock(x, y + dy))) continue;
      const j = ny * W + nx;
      const nd = di + c;
      if (nd <= limit && nd < d[j]) {
        d[j] = nd;
        heap.push(j, nd);
      }
    }
  }
  return d;
}

/** 矩形內所有可走格 @param {Grid} g @param {Rect} r */
export function rectCells(g, r) {
  /** @type {number[]} */
  const out = [];
  for (let y = Math.max(0, r.y0); y < Math.min(g.H, r.y1); y++) {
    for (let x = Math.max(0, r.x0); x < Math.min(g.W, r.x1); x++) {
      const i = y * g.W + x;
      if (g.block[i] === 0) out.push(i);
    }
  }
  return out;
}
