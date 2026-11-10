// @ts-check
// 戰術層（回合開始＋每次決策檢查事件）：隊內計畫、經濟、道具、輪轉、回防、殘局。
// 協調只靠 say：活著的最小 playerId 當指揮，凍結時間廣播計畫，計畫有變（執行、輪轉、回防）就重喊；指揮死了下一個接手重喊。
// 計畫格式（parsePlan／planText）：
//   T  「P:go A 0」（直接去，6-1 格式）「P:rushA 0」（五人一條路、不探頭、閃先行）
//      「P:splitA 0 2[ go]」（兩組兩條路線到待命點，第二組到了才喊 go）
//      「P:default A 0 1[ >B]」（主力 3 人到 A 路線 0 的待命點、2 人到 B 路線 1 控圖；>B 表示執行 B）
//      「P:fake B 0 1[ >B]」（主力去 B、佯攻組去 A 製造聲音後主力執行）
//      2.2 兩路進點：split 兩組走入口不同的路線；default／fake 執行時在點外的那組繞第二入口（flankOf），待命格的那組等他們到了（或逾時）才一起進
//   CT 「P:hold A=2 M=1 B=2[ rot=B][ go]」（開局配置；rot＝輪轉到哪個點；go＝回防集結完畢一起進）
// 事件（感知輸出產生，隊友據此更新）：「E:contact <區域> <人數>」「E:dead <區域>」「E:planted <點>」「E:flash x y tick」「E:smoke x y」「E:kit」「E:awp x y」（看到狙擊手）。
// 角色（2.1，roles.js）：每回合第一次決策喊「R:<代碼>」；分組、突破手與煙霧手、進點順序、CT 守位、錨點、回防先後都先看角色，
// 角色重複或缺角時退回隊內序號。
// 經濟「B:full／force／half／eco」見 economy.js；道具的彈道見 utility.js。全部由地圖資料與觀察資料算，不寫死座標或區域代號。
import { P, UNIT, adiff, angleTo, clamp, cosd, dijkstra, dist, expd, inRect, lerp, segDist, sind } from './base.js';
import { Economy, parseBuy, parseGift } from './economy.js';
import { Utility } from './utility.js';
import { ANCHOR, AWP, ENTRY, LURK, Roles, SUPPORT, parseRole } from './roles.js';
import { Cooperation } from './cooperation.js';
import { Adaptation } from './adaptation.js';
import { Resources, allocate, buyOrders, buyText, codeOf, holdText, kindOf, needsOf, itemsText } from './resources.js';

/** T 主力組的優先順序（索引＝角色代碼）：突破、支援、錨點、無、游擊、狙擊 */
const MAIN_PRI = [3, 0, 1, 2, 5, 4];
/** T 的煙霧手：支援優先，其次錨點、游擊、無、突破、狙擊 */
const SMOKE_PREF = [SUPPORT, ANCHOR, LURK, 0, ENTRY, AWP];

/** @typedef {'A' | 'B'} SiteId */
/** T 計畫：site 主力的點、r1／r2 兩組的路線序號、exec 執行哪個點（null = 還在佈置） @typedef {{ kind: 'go' | 'default' | 'rush' | 'split' | 'fake', site: SiteId, r1: number, r2: number, exec: SiteId | null }} TPlan */
/** CT 計畫：A／中路／B 人數、輪轉目標、回防開始 @typedef {{ kind: 'hold', a: number, m: number, b: number, rot: SiteId | null, go: boolean, push?: boolean }} CTPlan */
/** @typedef {TPlan | CTPlan} Plan */
/** @typedef {{ kind: 'contact', region: string, n: number } | { kind: 'dead', region: string } | { kind: 'planted', site: SiteId } | { kind: 'flash', x: number, y: number, pop: number } | { kind: 'claim', x: number, y: number } | { kind: 'smoke', x: number, y: number } | { kind: 'burn', x: number, y: number, until: number } | { kind: 'awp', x: number, y: number } | { kind: 'kit' | 'smoker' | 'lurk' }} TeamEvent */
/**
 * 戰術輸出：goal 目標點、route 偏好路線、hold 守位（到了要看哪裡）、objective 正在下包／拆包、allowPeek 可以探頭、cmds 購買／喊話／丟雷／下包／拆包；
 * look 沒交戰時看哪裡（urgent：躲閃光，連「目標剛消失的架槍」也蓋過；hard：閃光快爆了，交戰中也轉身、停火）、stop 站住、walk 靜步（null = 導航決定）、noise 佯攻開槍
 * @typedef {{ goal: import('./base.js').Pt | null, route: import('./analysis.js').Route | null, hold: import('./analysis.js').Spot | null, objective: boolean, allowPeek: boolean, cmds: import('./base.js').Command[], role: string, look: import('./base.js').Pt | null, urgent: boolean, hard: boolean, stop: boolean, walk: boolean | null, noise: boolean, escape: boolean, task?: 'hold' | 'execute' | 'retrieve' | 'plant' | 'defuse' | 'retake' | 'cover' | 'save', commit?: boolean }} TacOut
 */

const SITES = /** @type {const} */ (['A', 'B']);
/** @param {SiteId} s @returns {SiteId} */
const other = (s) => (s === 'A' ? 'B' : 'A');

/** 戰術手冊（M5 規格 3.1）的代號：T 六個、CT 四個（2.8） */
const T_TACTICS = /** @type {const} */ (['rushA', 'rushB', 'default', 'splitA', 'splitB', 'fake']);
const CT_TACTICS = /** @type {const} */ (['ct212', 'stackA', 'stackB', 'ctPush']);

/**
 * 計畫 → 戰術代號（2.8，喊 K: 用）。eco 的 go（集中直走）視為 rush；CT 一點 3 人以上是疊點、push 是激進探點
 * @param {Plan} p @returns {string}
 */
export function tacticOf(p) {
  if (p.kind === 'hold') return p.push ? 'ctPush' : p.a >= 3 ? 'stackA' : p.b >= 3 ? 'stackB' : 'ct212';
  if (p.kind === 'go' || p.kind === 'rush') return `rush${p.site}`;
  if (p.kind === 'split') return `split${p.site}`;
  return p.kind;
}

/** 回合數算出的固定亂數（全隊相同） @param {number} round @param {number} salt */
// 例外（使用者 2026-11-05 明文允許）：以公開回合資訊做種子的確定性雜湊，當全隊一致的平手打破器與抽選；不算違反「亂數只能用 helpers」，不改成 helpers 抽樣
const rollOf = (round, salt) => {
  const a = Math.imul(round + 1, 2654435761) ^ Math.imul(salt + 1, 40503);
  return (a ^ (a >>> 15)) >>> 0;
};

/** 解析計畫字串 @param {string} text @returns {Plan | null} */
export function parsePlan(text) {
  let m = /^P:go ([AB]) (\d+)$/.exec(text);
  if (m !== null) {
    const site = /** @type {SiteId} */ (m[1]);
    return { kind: 'go', site, r1: Number(m[2]), r2: Number(m[2]), exec: site };
  }
  m = /^P:(rush|split)([AB]) (\d+)(?: (\d+))?( go)?$/.exec(text);
  if (m !== null) {
    const site = /** @type {SiteId} */ (m[2]);
    const kind = /** @type {'rush' | 'split'} */ (m[1]);
    const r1 = Number(m[3]);
    return { kind, site, r1, r2: m[4] !== undefined ? Number(m[4]) : r1, exec: kind === 'rush' || m[5] !== undefined ? site : null };
  }
  m = /^P:(default|fake) ([AB]) (\d+) (\d+)(?: >([AB]))?$/.exec(text);
  if (m !== null) return { kind: /** @type {'default' | 'fake'} */ (m[1]), site: /** @type {SiteId} */ (m[2]), r1: Number(m[3]), r2: Number(m[4]), exec: m[5] !== undefined ? /** @type {SiteId} */ (m[5]) : null };
  m = /^P:hold A=(\d) (?:M=(\d) )?B=(\d)( push)?(?: rot=([AB]))?( go)?$/.exec(text);
  if (m !== null) return { kind: 'hold', a: Number(m[1]), m: m[2] !== undefined ? Number(m[2]) : 0, b: Number(m[3]), rot: m[5] !== undefined ? /** @type {SiteId} */ (m[5]) : null, go: m[6] !== undefined, push: m[4] !== undefined };
  return null;
}

/** @param {Plan} p */
export function planText(p) {
  switch (p.kind) {
    case 'go':
      return `P:go ${p.site} ${p.r1}`;
    case 'rush':
      return `P:rush${p.site} ${p.r1}`;
    case 'split':
      return `P:split${p.site} ${p.r1} ${p.r2}${p.exec !== null ? ' go' : ''}`;
    case 'default':
    case 'fake':
      return `P:${p.kind} ${p.site} ${p.r1} ${p.r2}${p.exec !== null ? ` >${p.exec}` : ''}`;
    default:
      return `P:hold A=${p.a}${p.m > 0 ? ` M=${p.m}` : ''} B=${p.b}${p.push ? ' push' : ''}${p.rot !== null ? ` rot=${p.rot}` : ''}${p.go ? ' go' : ''}`;
  }
}

/** 解析事件 @param {string} text @returns {TeamEvent | null} */
export function parseEvent(text) {
  let m = /^E:contact (\S+) (\d+)$/.exec(text);
  if (m !== null) return { kind: 'contact', region: m[1], n: Number(m[2]) };
  m = /^E:dead (\S+)$/.exec(text);
  if (m !== null) return { kind: 'dead', region: m[1] };
  m = /^E:planted ([AB])$/.exec(text);
  if (m !== null) return { kind: 'planted', site: /** @type {SiteId} */ (m[1]) };
  m = /^E:flash (\d+) (\d+) (\d+)$/.exec(text);
  if (m !== null) return { kind: 'flash', x: Number(m[1]) * 100, y: Number(m[2]) * 100, pop: Number(m[3]) };
  m = /^E:flashing (\d+) (\d+)$/.exec(text);
  if (m !== null) return { kind: 'claim', x: Number(m[1]) * 100, y: Number(m[2]) * 100 };
  m = /^E:smoke (\d+) (\d+)$/.exec(text);
  if (m !== null) return { kind: 'smoke', x: Number(m[1]) * 100, y: Number(m[2]) * 100 };
  m = /^E:burn (\d+) (\d+) (\d+)$/.exec(text);
  if (m !== null) return { kind: 'burn', x: Number(m[1]) * 100, y: Number(m[2]) * 100, until: Number(m[3]) };
  m = /^E:awp (\d+) (\d+)$/.exec(text);
  if (m !== null) return { kind: 'awp', x: Number(m[1]) * 100, y: Number(m[2]) * 100 };
  if (text === 'E:kit') return { kind: 'kit' };
  if (text === 'E:smoker') return { kind: 'smoker' };
  if (text === 'E:lurk') return { kind: 'lurk' };
  return null;
}

export class Tactics {
  /**
   * @param {import('./base.js').Grid} g @param {import('./analysis.js').MapIntel} intel @param {import('./memory.js').Perception} perc
   * @param {import('./base.js').InitData} data @param {import('./base.js').Helpers} h
   * @param {{ awpSlot: number, role: number, economy: number, ctSplitA: number, plan: number }} opts
   * @param {{ aim: number, reaction: number, awareness: number, aggression: number, discipline: number, movement: number }} attrs
   */
  constructor(g, intel, perc, data, h, opts, attrs) {
    this.g = g;
    this.intel = intel;
    this.perc = perc;
    this.data = data;
    this.h = h;
    this.opts = opts;
    this.attrs = attrs;
    this.tps = data.rules.ticksPerSecond;
    /** 2.8：戰術熟練度（init.tactics，整場不變；null＝沒有資料，一律當 50） */
    this.prof = data.tactics ?? null;
    /** 2.8：本回合的教練指令（obs.coach，整回合不變；null＝沒有教練） @type {import('./base.js').Observation['coach']} */
    this.coach = null;
    /** 2.8：本半場每個戰術用過幾次（自己喊的＋聽到隊友喊的 K:；換邊清空） @type {Map<string, number>} */
    this.used = new Map();
    this.usedTeam = '';
    /** 2.8：本回合已經喊過／聽到 K:（一回合只算一次）；指揮本回合選的戰術代號 */
    this.tagSaid = false;
    /** @type {string | null} */
    this.tagPick = null;
    /** 2.8：本回合打的戰術代號（自己喊的或聽到的 K:；執行品質用它的熟練度） @type {string | null} */
    this.tagNow = null;
    /** 3.0：這一步停下來的原因碼（不影響行為）：spawn 出生區讓位、yield 等突破手、awp 狙擊到位、line 架槍線、q* 執行品質（熟練度）。
     * 效用層只讀 q*（指揮層的合法等待，經 PlanIntent）；spawn、yield、awp、line 只給量測工具分類不一致原因，不當特徵 */
    this.waitTag = '';
    /** 3.0：這一步實際要丟的道具（影子模式讀；不影響行為） @type {import('./utility.js').ThrowWish | null} */
    this.lastWish = null;
    /** 3.0 視線頭影子模式讀：這一步的看向是丟道具的瞄準 */
    this.utilLook = false;
    /**
     * 3.0 效用層影子模式讀（第 5 步）：這一步指揮層／資源層的丟道具觸發條件（鍵 → 種類與可用的用途）。
     * 只是紀錄，不影響行為；落點與要不要丟由效用層自己算 @type {Map<string, { kind: string, purposes: string[] }>}
     */
    this.trig = new Map();
    /** 3.0 PlanIntent 的入口（效用層讀）：這次執行我這組走的入口（execute 每步更新，其他時候 null） @type {import('./analysis.js').Entrance | null} */
    this.planEnt = null;
    /**
     * 3.0 影子模式讀：這一步丟出的道具與它丟出前的資源層狀態（丟出那一步，指揮層已把它記進煙／火／閃光紀錄、資源層已標成用掉；
     * 影子要看丟出前的狀態才不會把 r7l 正在丟的落點當成已經有了） @type {{ kind: string, it: import('./resources.js').UtilItem | null, state: string } | null}
     */
    this.thrownNow = null;
    /** 2.8：split 執行時離入口近的那組要晚出發幾秒（syncAt＝算的時候的 execTick） */
    this.syncAt = -1;
    this.syncWait = 0;
    // 公開 reactionTicks 是四捨五入值；由公開屬性／公式推得可能區間，不預知本批的隨機進位。
    const reaction = clamp(data.attributes.reaction, 0, 100);
    const nominal = 5 + Math.max(0, 70 - reaction) / 8;
    const exact = 5 + Math.max(0, 70 - Math.round(reaction)) / 8;
    const declared = data.rules.reactionTicks;
    const attributed = Math.round(nominal) === declared;
    this.delayMin = attributed ? Math.min(declared, Math.floor(exact)) : declared;
    this.delayMax = attributed ? Math.max(declared, Math.ceil(exact)) : declared;
    this.econ = new Economy(data, h, { economy: opts.economy, discipline: attrs.discipline });
    this.util = new Utility(g, data);
    /** 全隊 id（排序）：隊內序號 = 名次 */
    this.ids = [data.playerId, ...data.teammateIds].sort((a, b) => a - b);
    /** 全隊的角色分工（整場） */
    this.roles = new Roles(this.ids, data.playerId, opts.role, opts.awpSlot);
    this.roleSaid = false;
    /** 本回合讓突破手先進已經停了幾 tick；回防 go 的 tick */
    this.yielded = 0;
    this.slow = false;
    this.spawnHeld = 0;
    this.goTick = -1;
    this.readyAt = -1;
    this.eventDelay = Math.round(lerp(P.eventDelay0, P.eventDelay100, attrs.awareness) * data.rules.decisionInterval);
    /** 地圖算出來的位置（第一次用到才算） @type {Map<string, import('./analysis.js').Spot[]>} */
    this.spotCache = new Map();
    /** 附近沒有掩體格的探點（停留減半） @type {Set<number>} */
    this.probeBare = new Set();
    /** 戰鬥層（估計對手血量用）與導航層（躲閃光用）；由入口接上 @type {import('./combat.js').Combat | null} */
    this.combat = null;
    /** @type {import('./nav.js').Navigator | null} */
    this.nav = null;
    /** @type {import('./judgment.js').Judgment | null} */
    this.judge = null;
    /** @type {import('./mission.js').Mission | null} */
    this.mission = null;
    this.coop = new Cooperation(g, intel, perc, data);
    this.adapt = new Adaptation();
    /** 3.0 資源層（每人一份副本，喊話同步） */
    this.res = new Resources(this.ids, data.playerId);
    /** 本次決策 claim 到的項目（種類 → 項目；丟出時喊 U:u 用） @type {Map<string, import('./resources.js').UtilItem>} */
    this.claimed = new Map();
    /** 自己這回合的購買單（指揮者自己算的、其他人聽到的） @type {import('./base.js').GrenadeId[]} */
    this.myOrders = [];
    this.boughtAt = -1;
    /** 3.0：entryFlash 找不到點的起始 tick；本回合已放棄的序號；flashPoint 這次有沒有因為隊友安全剔掉候選 */
    this.noFlashSince = -1;
    /** @type {Set<number>} */
    this.gaveUp = new Set();
    this.flashUnsafe = false;
    this.lastThrow = '';
    /** 3.0：回防走的 CT 路線（-1＝還沒定）；自己丟出回防道具的 tick */
    this.retakeRoute = -1;
    this.retakeThrown = -1;
    /** 3.0（r7k）：這次決策自己持有入口還沒丟的計畫進點閃（不讓位給突破手） */
    /** @type {import('./base.js').Observation | null} */
    this.curObs = null;
    this.flashOwner = false;
    this.rotSince = -1;
    /** @type {Map<number, number>} */
    this.defuseStarted = new Map();
    this.defuseIssued = -1;
    this.fakeProbe = false;
    /** @type {{ x: number, y: number, until: number }[]} */
    this.burns = [];
    this.defuseAlarm = -1;
    this.alarmAlive = 5;
    /** 這一波拆包證據第一次出現的 tick（反拆的最晚干預時間從這裡算）、最後一次看到／聽到的 tick */
    this.defuseSince = -1;
    this.defuseLast = -1000000;
    this.postSaid = false;
    /** @type {Set<number>} */
    this.postSmokers = new Set();
    /** 躲閃光的格（對應哪一顆閃光） @type {import('./base.js').Pt | null} */
    this.hide = null;
    this.hideFor = -1;
    // ── 整場的記憶 ──
    /** 當 T 時每個點最近的結果（+1 勝、−1 敗） */
    this.siteScore = { A: 0, B: 0 };
    this.lastKind = '';
    this.lastSite = /** @type {SiteId | null} */ (null);
    this.enemiesAlive = 5;
    /** 狙擊位（第一次用到才算） @type {{ spot: import('./analysis.js').Spot, site: SiteId, len: number } | null | undefined} */
    this.sniper = undefined;
    /** @type {Plan | null} */
    this.plan = null;
    this.commander = -1;
    this.saidAs = -1;
    this.saidText = '';
    this.bought = false;
    /** @type {import('./economy.js').BuyCall | null} */
    this.buyCall = null;
    this.routeOverride = -1;
    /** 兩路進點：地圖算的快取 @type {Map<string, { near: number, main: import('./analysis.js').Entrance, second: import('./analysis.js').Entrance, wait: number } | null>} */
    this.flankCache = new Map();
    /** @type {Map<SiteId, import('./analysis.js').Route>} */
    this.aroundCache = new Map();
    /** @type {Map<string, import('./base.js').Pt[]>} */
    this.smokeCache = new Map();
    /** 本回合：開始等第二組的 tick、第二組到了、自己已繞到第二入口 */
    this.flankStart = -1;
    this.flankGo = false;
    this.flanked = false;
    /** 本回合的繞後決定（依計畫快取） @type {{ route: import('./analysis.js').Route, wait: import('./analysis.js').Route, stage: import('./analysis.js').Spot | null } | null} */
    this.lurkPick = null;
    this.lurkKey = '';
    /** 本回合喊過 E:lurk 的隊友（2.7，含自己） @type {Set<number>} */
    this.lurkers = new Set();
    this.steppedIn = false;
    this.rushReady = false;
    this.queueHeld = 0;
    /** 收到但還沒處理的喊話（警覺低的晚一點反應） @type {{ ready: number, from: number, text: string }[]} */
    this.inbox = [];
    /** 收到的接觸：區域 → 人數、時間、位置（2.7：去重用；不知道是 NaN）；接觸 → 所屬包點 @type {Map<string, { n: number, tick: number, x: number, y: number }>} */
    this.contacts = new Map();
    /** @type {Map<string, SiteId | null>} */
    this.contactSite = new Map();
    /** 自己喊過的接觸 @type {Map<string, { n: number, tick: number }>} */
    this.saidContact = new Map();
    /** 看過的敵方煙 @type {import('./base.js').Pt[]} */
    this.smokeSeen = [];
    /** 分組（T）：id → 0 主力／1 第二組 @type {Map<number, number> | null} */
    this.groups = null;
    this.groupKey = '';
    this.execTick = -1;
    this.stageArrive = -1;
    this.noiseLeft = 0;
    /** 隊友的閃光：躲或轉身到爆完（claim：只收到宣告、爆炸時間是估的；by：宣告的人） @type {{ x: number, y: number, pop: number, claim?: boolean, by?: number }[]} */
    this.mateFlash = [];
    this.flashHeard = -1;
    this.smokeHeard = -1;
    /** 最前面的人走到丟閃距離的 tick；我方閃光最近一次炸開的 tick；本回合我方閃光的落點 */
    this.flashCue = -1;
    this.flashPop = -1000000;
    /** by＝投擲者、pop＝爆炸 tick（2.7：同一個 by＋pop 是同一顆） @type {{ x: number, y: number, tick: number, by: number, pop: number }[]} */
    this.flashSpots = [];
    /** 隊友宣告要丟的閃光（E:flashing，2.6）；by＝宣告的人、at＝收到的 tick；自己最近一次宣告 @type {{ x: number, y: number, until: number, by: number, at: number }[]} */
    this.flashClaims = [];
    /** @type {{ x: number, y: number, until: number } | null} */
    this.myClaim = null;
    /** 發槍（2.6.2）：本回合的發槍計畫、我要去撿的槍（到期就自己買）、撿不到要補買 @type {{ from: number, to: number, w: import('./base.js').WeaponId }[]} */
    this.gifts = [];
    /** @type {{ w: import('./base.js').WeaponId, until: number } | null} */
    this.giftWant = null;
    this.giftMiss = false;
    this.reBought = false;
    this.pickAt = -1000000;
    /** 本回合進過包點的隊友（等突破手、狙擊手等人用）：`${點}${id}` @type {Set<string>} */
    this.wentIn = new Set();
    /** 本回合我方煙霧的位置（自己丟的與隊友喊的） @type {import('./base.js').Pt[]} */
    this.smokes = [];
    /** 閃光爆點候選（依入口與煙霧數快取） */
    this.flashKey = '';
    /** @type {{ x: number, y: number, sc: number }[]} */
    this.flashList = [];
    /** 有拆彈器的隊友 @type {Set<number>} */
    this.kits = new Set();
    this.kitSaid = false;
    /** 本回合最後知道的狙擊手位置；上幾回合的狙擊位（整場，換邊清掉） @type {{ x: number, y: number, tick: number } | null} */
    this.awp = null;
    this.awpSaid = -1000000;
    /** @type {import('./base.js').Pt[]} */
    this.awpHist = [];
    this.awpTeam = '';
    /** CT：最近看到（或被閃推估）的敵方閃光；放棄的點；探點結束了 @type {{ x: number, y: number, tick: number } | null} */
    this.enemyFlash = null;
    /** @type {SiteId | null} */
    this.fallback = null;
    this.probed = false;
    /** 探點：到位的 tick；探到情報後要縮回的掩體 */
    this.probeAt = -1;
    /** @type {{ spot: import('./analysis.js').Spot, until: number } | null} */
    this.probeOut = null;
    /** 本回合換過路了（躲槍線）；等槍線已經停了幾 tick、對應哪一次隊友陣亡 */
    this.dodged = false;
    this.lineHeld = 0;
    this.lineDeath = -1;
    /** 換血：朝隊友陣亡的方向架槍 @type {{ x: number, y: number, until: number } | null} */
    this.trade = null;
    /** 追殘血 @type {{ x: number, y: number, until: number } | null} */
    this.chase = null;
    /** 對每個敵人打出的傷害 @type {Map<number, number>} */
    this.dealt = new Map();
    /** @type {Map<number, boolean>} */
    this.mateAlive = new Map();
    /** 隊友最近一次開火的 tick @type {Map<number, number>} */
    this.mateFired = new Map();
    this.liveStart = -1;
    this.plantedSaid = false;
    this.saving = false;
    /** 狙擊手（開打時手上拿狙擊槍的人）；開打後固定 */
    this.awper = -1;
    this.awperFixed = false;
    /** @type {Map<number, { spot: import('./analysis.js').Spot, site: SiteId | null }> | null} */
    this.layout = null;
    this.layoutKey = '';
    /** @type {import('./base.js').Pt | null} */
    this.saveCache = null;
    this.saveAt = -1000000;
  }

  /** 新回合（obs 為 null 時只清狀態） @param {import('./base.js').Observation | null} obs */
  reset(obs) {
    this.res.reset();
    if (obs !== null) this.res.team = obs.me.team;
    this.myOrders = [];
    this.boughtAt = -1;
    this.noFlashSince = -1;
    this.gaveUp.clear();
    this.retakeRoute = -1;
    this.retakeThrown = -1;
    this.tagSaid = false;
    this.tagPick = null;
    this.tagNow = null;
    if (obs !== null) {
      // 2.8：教練指令整回合不變；經濟風格取代旋鈕 economy（沒有教練照旋鈕）
      this.coach = obs.coach ?? null;
      this.econ.opts.economy = this.coach !== null ? this.coach.economy : this.opts.economy;
      if (obs.me.team !== this.usedTeam) {
        this.used = new Map();
        this.usedTeam = obs.me.team;
      }
      this.econ.roundStart(obs);
      this.adapt.begin(obs, this.econ.lastWon);
      // 上回合的結果記進整場記憶
      const won = this.econ.lastWon;
      if (won !== null && this.lastKind !== '' && this.lastSite !== null) this.siteScore[this.lastSite] = clamp(this.siteScore[this.lastSite] + (won ? 1 : -1), -2, 2);
    }
    if (this.awp !== null) {
      this.awpHist.push({ x: this.awp.x, y: this.awp.y });
      if (this.awpHist.length > 3) this.awpHist.shift();
    }
    this.awp = null;
    this.awpSaid = -1000000;
    this.enemyFlash = null;
    this.fallback = null;
    this.probed = false;
    this.probeAt = -1;
    this.probeOut = null;
    this.dodged = false;
    this.lineHeld = 0;
    this.lineDeath = -1;
    this.lastKind = '';
    this.lastSite = null;
    this.plan = null;
    this.commander = -1;
    this.saidAs = -1;
    this.saidText = '';
    this.bought = false;
    this.buyCall = null;
    this.routeOverride = -1;
    this.flankStart = -1;
    this.flankGo = false;
    this.flanked = false;
    this.lurkPick = null;
    this.lurkKey = '';
    /** 本回合喊過 E:lurk 的隊友（2.7，含自己） @type {Set<number>} */
    this.lurkers = new Set();
    this.steppedIn = false;
    this.rushReady = false;
    this.queueHeld = 0;
    this.inbox = [];
    this.contacts = new Map();
    this.contactSite = new Map();
    this.saidContact = new Map();
    this.smokeSeen = [];
    this.groups = null;
    this.groupKey = '';
    this.execTick = -1;
    this.stageArrive = -1;
    this.noiseLeft = 0;
    this.mateFlash = [];
    this.flashHeard = -1;
    this.smokeHeard = -1;
    this.flashCue = -1;
    this.flashPop = -1000000;
    this.flashSpots = [];
    this.flashClaims = [];
    this.myClaim = null;
    this.gifts = [];
    this.giftWant = null;
    this.giftMiss = false;
    this.reBought = false;
    this.pickAt = -1000000;
    /** 本回合進過包點的隊友（等突破手、狙擊手等人用）：`${點}${id}` @type {Set<string>} */
    this.wentIn = new Set();
    /** 本回合我方煙霧的位置（自己丟的與隊友喊的） @type {import('./base.js').Pt[]} */
    this.smokes = [];
    /** 閃光爆點候選（依入口與煙霧數快取） */
    this.flashKey = '';
    /** @type {{ x: number, y: number, sc: number }[]} */
    this.flashList = [];
    this.kits = new Set();
    this.kitSaid = false;
    this.trade = null;
    this.chase = null;
    this.dealt = new Map();
    this.mateAlive = new Map();
    this.mateFired = new Map();
    this.liveStart = -1;
    this.plantedSaid = false;
    this.saving = false;
    this.awper = -1;
    this.awperFixed = false;
    this.layout = null;
    this.layoutKey = '';
    this.saveCache = null;
    this.saveAt = -1000000;
    this.roleSaid = false;
    this.yielded = 0;
    this.slow = false;
    this.spawnHeld = 0;
    this.goTick = -1;
    this.readyAt = -1;
    this.util.reset();
    this.burns = [];
    this.defuseAlarm = -1;
    this.alarmAlive = 5;
    /** 這一波拆包證據第一次出現的 tick（反拆的最晚干預時間從這裡算）、最後一次看到／聽到的 tick */
    this.defuseSince = -1;
    this.defuseLast = -1000000;
    this.postSaid = false;
    this.postSmokers.clear();
    this.coop.reset();
    this.rotSince = -1;
    this.defuseStarted.clear();
    this.defuseIssued = -1;
    this.fakeProbe = false;
  }

  /** 活著的最小 playerId（含自己） @param {import('./base.js').Observation} obs */
  commanderOf(obs) {
    let c = obs.me.alive ? obs.me.id : Infinity;
    for (const m of obs.teammates) if (m.alive && m.id < c) c = m.id;
    return Number.isFinite(c) ? c : -1;
  }

  /** 隊內序號 @param {number} id */
  slotOf(id) {
    return this.ids.indexOf(id);
  }

  /** 活著的隊員（含自己）：{ id, x, y } @param {import('./base.js').Observation} obs */
  alive(obs) {
    const me = obs.me;
    const out = obs.teammates.filter((m) => m.alive).map((m) => ({ id: m.id, x: m.x, y: m.y }));
    if (me.alive) out.push({ id: me.id, x: me.x, y: me.y });
    return out.sort((a, b) => a.id - b.id);
  }

  /** 區域代號 → 該區域中心格 @param {string} id */
  regionCell(id) {
    const r = this.intel.map.regions.find((x) => x.id === id);
    if (r === undefined) return -1;
    return this.intel.nearestOpen(Math.floor((r.x0 + r.x1) / 2), Math.floor((r.y0 + r.y1) / 2));
  }

  /** 格屬於哪個包點附近（路徑 ≤ 25 格且比另一點近 5 格以上）；都不是回傳 null @param {number} c @returns {SiteId | null} */
  siteNear(c) {
    if (c < 0) return null;
    const a = this.intel.distSite.A[c] / 10;
    const b = this.intel.distSite.B[c] / 10;
    if (a <= 25 && a < b - 5) return 'A';
    if (b <= 25 && b < a - 5) return 'B';
    return null;
  }

  // ───────── 每次決策 ─────────

  /**
   * @param {import('./base.js').Observation} obs
   * @returns {TacOut}
   */
  update(obs) {
    const me = obs.me;
    const t = obs.tick;
    this.flashOwner = false;
    this.waitTag = '';
    this.utilLook = false;
    this.trig.clear();
    this.planEnt = null;
    this.thrownNow = null;
    /** @type {TacOut} */
    const out = { goal: null, route: null, hold: null, objective: me.plantTicks > 0 || me.defuseTicks > 0, allowPeek: false, cmds: [], role: '', look: null, urgent: false, hard: false, stop: false, walk: null, noise: false, escape: false };
    if (this.liveStart < 0 && obs.round.phase !== 'freeze') this.liveStart = t;
    this.util.now = t;
    /** 這次決策的觀察（can() 判斷 entryFlash 入口分組用） */
    this.curObs = obs;
    this.claimed.clear();
    this.enemiesAlive = obs.enemiesAlive;
    if (obs.enemiesAlive === 0) {
      this.trade = null;
      this.chase = null;
      this.saving = false;
    }
    if (!this.roleSaid) {
      this.roleSaid = true;
      out.cmds.push({ type: 'say', text: `R:${this.opts.role}` });
    }
    this.trackTeam(obs, out);
    this.trackAwp(obs, out);
    if (me.team === 'CT') this.trackEnemyFlash(obs);
    this.coop.observe(obs);
    this.readChat(obs);
    this.res.read(obs.chat);
    this.util.countMode = P.resLayer && this.res.active;
    this.adapt.observe(obs, this.perc, (c) => this.siteNear(c));
    const cmd = this.commanderOf(obs);
    this.commander = cmd;
    if (cmd === me.id) this.lead(obs, out);
    else if (this.plan === null && obs.round.phase !== 'freeze' && t - this.liveStart > this.tps) this.plan = this.choosePlan(obs);
    this.buy(obs, out, cmd === me.id);
    this.resStep(obs, out, cmd === me.id);
    this.report(obs, out);
    const live = obs.round.phase === 'live';
    out.allowPeek = live && obs.round.phaseTicksLeft > 25 * this.tps;
    this.slow = false;
    /** @type {import('./utility.js').ThrowWish | null} */
    let wish = me.team === 'T' ? this.tGoal(obs, out) : this.ctGoal(obs, out);
    if (this.slow) {
      out.walk = true;
      out.role += '・讓突破手先走';
    }
    if (P.resLayer && this.res.active) this.waitFlash(obs, out);
    if (this.settle(obs, out)) {
      wish = null;
      this.trig.clear();
    }
    if (wish === null && !out.commit) wish = this.anyNade(obs);
    this.overlay(obs, out);
    if (wish === null) {
      this.coop.apply(obs, out);
      if (!this.coop.acted) wish = this.lineCheck(obs, out);
    }
    /** @type {Set<number>} */
    const busy = new Set();
    for (const [id, tk] of this.mateFired) if (t - tk < 1.5 * this.tps) busy.add(id);
    // 正在躲隊友的閃光、或隊友的閃光還沒爆：不轉頭去丟自己的道具
    if (out.commit || out.urgent || this.mateFlash.some((x) => t <= x.pop)) {
      wish = null;
      this.trig.clear();
    }
    // 3.0 效用層影子模式讀：這一步實際要丟的道具（資源層／指揮層的觸發條件成立）
    this.lastWish = wish;
    const u = this.util.step(obs, wish, busy);
    // 宣告再丟（2.6）：開始轉向瞄準閃光就先喊，丟出要再等一次以上的決策；隊友聽到就把爆點當成已認領
    if (P.flashClaim && wish !== null && wish.kind === 'flash' && u.look !== null && u.thrown === null && this.util.away === null) {
      const c = this.myClaim;
      if (c === null || t > c.until || dist(c.x, c.y, wish.x, wish.y) > 3 * UNIT) {
        this.myClaim = { x: wish.x, y: wish.y, until: t + P.flashClaimSec * this.tps };
        out.cmds.push({ type: 'say', text: `E:flashing ${Math.round(wish.x / 100)} ${Math.round(wish.y / 100)}` });
      }
    }
    // 最後一次丟出的理由（量測工具讀）
    if (u.thrown !== null) this.lastThrow = u.thrown.why;
    if (u.thrown !== null) {
      const it = this.claimed.get(u.thrown.kind) ?? null;
      this.thrownNow = { kind: u.thrown.kind, it, state: it?.state ?? 'free' };
    }
    if (u.thrown !== null && this.res.active) {
      const it = this.claimed.get(u.thrown.kind);
      out.cmds.push({ type: 'say', text: it !== undefined ? this.res.usedText(it) : `U:u ${codeOf(u.thrown.kind)}` });
      if (it !== undefined && (it.purpose === 'retakeFlash' || it.purpose === 'retakeSmoke') && it.idx >= 0) this.retakeThrown = t;
    }
    if (u.thrown !== null && u.thrown.kind === 'smoke') this.smokes.push({ x: u.thrown.x, y: u.thrown.y });
    if (u.thrown !== null && u.thrown.kind === 'flash' && this.util.away !== null) {
      this.flashPop = this.util.away.until - 3;
      this.flashSpots.push({ x: u.thrown.x, y: u.thrown.y, tick: t, by: me.id, pop: this.flashPop });
    }
    if (u.thrown !== null && (u.thrown.kind === 'molotov' || u.thrown.kind === 'incendiary')) this.burns.push({ x: u.thrown.x, y: u.thrown.y, until: t + 8 * this.tps });
    out.cmds.push(...u.cmds);
    // 3.0 視線頭影子模式讀：這一步的看向是丟道具的瞄準（不歸視線頭管）
    this.utilLook = u.look !== null;
    if (u.look !== null) {
      out.look = u.look;
      if (this.util.away !== null) out.urgent = true;
    }
    if (u.stop) out.stop = true;
    if (this.plan !== null) {
      this.lastKind = this.plan.kind === 'hold' ? '' : this.plan.kind;
      if (this.plan.kind !== 'hold') this.lastSite = this.plan.exec ?? this.plan.site;
      if (this.adapt.sample !== null) this.adapt.sample.plan = this.lastKind;
    }
    // 3.0：引擎不把自己的喊話回給自己；自己喊的 U: 直接吃進自己的副本
    if (P.resLayer) this.res.read(out.cmds.filter((c) => c.type === 'say' && c.text.startsWith('U:')).map((c) => ({ from: me.id, text: /** @type {{ text: string }} */ (c).text })));
    if (out.cmds.some((c) => c.type === 'defuse')) this.defuseIssued = t;
    else if (!out.objective || me.defuseTicks > 0 || t > this.defuseIssued + this.delayMax + this.data.rules.decisionInterval) this.defuseIssued = -1;
    return out;
  }

  /**
   * 隊友狀態：陣亡（換血、指揮喊 E:dead）、對敵人打出的傷害
   * @param {import('./base.js').Observation} obs @param {TacOut} out
   */
  trackTeam(obs, out) {
    const me = obs.me;
    const t = obs.tick;
    const tid = this.combat?.targetId ?? -1;
    for (const s of me.shots) if (s.hit === 'enemy' && tid >= 0) this.dealt.set(tid, (this.dealt.get(tid) ?? 0) + s.damage);
    for (const m of obs.teammates) {
      if (m.alive) for (const s of SITES) if (this.inRectSite(m.x, m.y, s)) this.wentIn.add(`${s}${m.id}`);
      if (!m.alive) this.kits.delete(m.id);
      if (m.alive && m.defusing) { if (!this.defuseStarted.has(m.id)) this.defuseStarted.set(m.id, t); }
      else this.defuseStarted.delete(m.id);
      if (m.firing) this.mateFired.set(m.id, t);
      if (this.mateAlive.get(m.id) === true && !m.alive) {
        // 換血：隊友在附近陣亡，朝他面對的方向架槍
        if (me.alive && dist(m.x, m.y, me.x, me.y) <= P.tradeRange * UNIT) this.trade = { x: m.x + cosd(m.facing) * 10 * UNIT, y: m.y + sind(m.facing) * 10 * UNIT, until: t + Math.round(P.tradeHold * this.tps) };
        if (this.commanderOf(obs) === me.id) {
          const r = this.intel.region[this.g.cellOf(m.x, m.y)];
          if (r >= 0) out.cmds.push({ type: 'say', text: `E:dead ${this.intel.map.regions[r].id}` });
        }
        // 隊友在某點附近陣亡：當作那裡有接觸（CT 輪轉用）
        const near = this.siteNear(this.g.cellOf(m.x, m.y));
        if (near !== null) this.noteContact(`#dead${m.id}`, 1, t, near, m.x, m.y);
      }
      this.mateAlive.set(m.id, m.alive);
    }
  }

  /** 狙擊手：親眼看到就喊 E:awp；聽到敵方狙擊槍聲時，還不知道位置就用聲音方向估 @param {import('./base.js').Observation} obs @param {TacOut} out */
  trackAwp(obs, out) {
    const me = obs.me;
    const t = obs.tick;
    if (this.awpTeam !== me.team) {
      this.awpTeam = me.team;
      this.awpHist = [];
    }
    const e = obs.enemies.find((q) => q.weapon === 'awp');
    if (e !== undefined) {
      this.awp = { x: e.x, y: e.y, tick: t };
      if (t - this.awpSaid >= 3 * this.tps) {
        this.awpSaid = t;
        out.cmds.push({ type: 'say', text: `E:awp ${Math.round(e.x / 100)} ${Math.round(e.y / 100)}` });
      }
      return;
    }
    if (this.awp !== null && t - this.awp.tick < P.awpMemo * this.tps) return;
    const s = obs.sounds.find((q) => q.kind === 'shot' && q.weapon === 'awp' && !q.friendly);
    if (s === undefined) return;
    const r = (s.range === 'near' ? 6 : s.range === 'mid' ? 20 : 40) * UNIT;
    const c = this.intel.nearestOpen(Math.floor((me.x + cosd(s.dirDeg) * r) / UNIT), Math.floor((me.y + sind(s.dirDeg) * r) / UNIT));
    if (c >= 0) this.awp = { ...this.g.center(c), tick: t };
  }

  /**
   * CT 記敵方閃光：看到飛行中的閃光而不是我方丟的（自己的、隊友喊過的）；沒看到但自己或隊友被閃、我方最近沒丟閃時，
   * 算在被閃的人最近的包點入口
   * @param {import('./base.js').Observation} obs
   */
  trackEnemyFlash(obs) {
    const me = obs.me;
    const t = obs.tick;
    const away = this.util.away;
    /** @param {number} x @param {number} y */
    const ours = (x, y) => this.mateFlash.some((f) => dist(f.x, f.y, x, y) < 8 * UNIT) || (away !== null && dist(away.tx, away.ty, x, y) < 8 * UNIT);
    for (const q of obs.projectiles) if (q.kind === 'flash' && !ours(q.x, q.y)) this.enemyFlash = { x: q.x, y: q.y, tick: t };
    if (this.enemyFlash !== null && t - this.enemyFlash.tick <= this.tps) return;
    if (t - this.flashPop <= 2 * this.tps || t - this.flashHeard <= 3 * this.tps) return;
    const blind = me.blindTicks > 0 ? me : obs.teammates.find((m) => m.alive && m.blind);
    if (blind === undefined) return;
    let best = null;
    let bestD = 25 * UNIT;
    for (const s of SITES) {
      for (const e of this.intel.sites[s].entrances) {
        const d = dist(blind.x, blind.y, e.x, e.y);
        if (d < bestD) {
          bestD = d;
          best = e;
        }
      }
    }
    if (best !== null) this.enemyFlash = { x: best.x, y: best.y, tick: t };
  }

  /** 敵方閃光最近炸在（飛向）這個入口 @param {import('./base.js').Observation} obs @param {import('./analysis.js').Entrance} e */
  flashAt(obs, e) {
    const f = this.enemyFlash;
    return f !== null && obs.tick - f.tick <= P.enemyFlashMemo * this.tps && Math.min(dist(f.x, f.y, e.x, e.y), dist(f.x, f.y, e.ox, e.oy)) < P.enemyFlashNear * UNIT;
  }

  /** @param {string} key @param {number} n @param {number} t @param {SiteId | null} site @param {number} [x] @param {number} [y] 接觸的位置（2.7） */
  noteContact(key, n, t, site, x = NaN, y = NaN) {
    this.contacts.set(key, { n, tick: t, x, y });
    this.contactSite.set(key, site);
  }

  /** 收喊話：計畫、買法、事件（事件延遲 eventDelay 才處理） @param {import('./base.js').Observation} obs */
  readChat(obs) {
    const me = obs.me;
    const t = obs.tick;
    for (const c of obs.chat) {
      if (c.from === me.id) continue;
      // 2.8：隊友喊的戰術標籤：累計本半場用過次數（指揮換人時新指揮也知道）
      if (c.text.startsWith('K:')) {
        if (!this.tagSaid) this.used.set(c.text.slice(2), (this.used.get(c.text.slice(2)) ?? 0) + 1);
        this.tagSaid = true;
        if (this.tagNow === null) this.tagNow = c.text.slice(2);
        continue;
      }
      const r = parseRole(c.text);
      if (r > 0) {
        this.roles.hear(c.from, r);
        continue;
      }
      // 第一個計畫與買法立刻處理（凍結時間）；之後的變更與事件依警覺延遲；游擊對計畫變更（輪轉）不延遲
      const first = (this.plan === null || this.roles.of(me.id) === LURK) && c.text.startsWith('P:');
      // 3.0：資源層有計畫時，閃光的宣告與爆炸時間是事先講好的，不吃警覺延遲（隊友才來得及停步、轉身）
      const now = first || c.text.startsWith('B:') || (P.resLayer && this.res.active && (c.text.startsWith('E:flash ') || c.text.startsWith('E:flashing ')));
      this.inbox.push({ ready: now ? t : t + this.eventDelay, from: c.from, text: c.text });
    }
    const keep = [];
    for (const msg of this.inbox) {
      if (msg.ready > t) {
        keep.push(msg);
        continue;
      }
      const text = msg.text;
      const p = parsePlan(text);
      if (p !== null) {
        // 只接受 id 比自己小的人（指揮或剛陣亡的指揮）的計畫；陣營要對
        if (msg.from < me.id && (p.kind === 'hold') === (me.team === 'CT')) this.setPlan(p, obs);
        continue;
      }
      const gift = parseGift(text);
      if (gift !== null) {
        if (msg.from < me.id && this.gifts.every((q) => q.from !== gift.from)) this.gifts.push(gift);
        continue;
      }
      const b = parseBuy(text);
      if (b !== null) {
        if (msg.from < me.id) this.buyCall = b;
        continue;
      }
      const e = parseEvent(text);
      if (e === null) continue;
      if (e.kind === 'contact') {
        const c = this.regionCell(e.region);
        const p = c >= 0 ? this.g.center(c) : { x: NaN, y: NaN };
        this.noteContact(e.region, e.n, t, this.siteNear(c), p.x, p.y);
      } else if (e.kind === 'flash') {
        // 宣告時估的、自己看到推算的爆炸時間換成準確的
        this.mateFlash = this.mateFlash.filter((f) => !f.claim || (P.claimById ? f.by !== msg.from : dist(f.x, f.y, e.x, e.y) > P.claimClear * UNIT));
        this.mateFlash.push({ x: e.x, y: e.y, pop: e.pop });
      }
      else if (e.kind === 'claim') {
        this.flashClaims.push({ x: e.x, y: e.y, until: t + P.flashClaimSec * this.tps, by: msg.from, at: t });
        // 2.6.1：宣告比 E:flash 早一個決策以上，先當成要炸了來躲（估計爆炸時間；E:flash 到了會補上準確的）
        // 估計值偏晚（對方還要轉向、停步才丟）：太早結束躲避會回頭吃到真的那顆
        if (P.flashClaimDodge) this.mateFlash.push({ x: e.x, y: e.y, pop: t + (this.util.fuse.get('flash') ?? 45) + 2 * this.data.rules.reactionTicks + this.tps, claim: true, by: msg.from });
      }
      else if (e.kind === 'smoke') {
        this.smokeHeard = t;
        this.smokes.push({ x: e.x, y: e.y });
      }
      else if (e.kind === 'kit' && this.isAlive(obs, msg.from)) this.kits.add(msg.from);
      else if (e.kind === 'burn') this.burns.push(e);
      else if (e.kind === 'awp') this.awp = { x: e.x, y: e.y, tick: t };
      else if (e.kind === 'smoker') this.postSmokers.add(msg.from);
      else if (e.kind === 'lurk') this.lurkers.add(msg.from);
      if (e.kind === 'flash') {
        this.flashHeard = t;
        this.flashPop = e.pop;
        if (!P.flashIdent || !this.flashSpots.some((f) => f.by === msg.from && f.pop === e.pop)) this.flashSpots.push({ x: e.x, y: e.y, tick: t, by: msg.from, pop: e.pop });
      }
    }
    this.inbox = keep;
  }

  /** @param {Plan} p @param {import('./base.js').Observation} obs */
  setPlan(p, obs) {
    const prev = this.plan;
    this.plan = p;
    if (p.kind === 'hold' && (prev === null || prev.kind !== 'hold' || p.rot !== prev.rot)) this.rotSince = obs.tick;
    if (p.kind !== 'hold' && p.exec !== null && (prev === null || prev.kind === 'hold' || prev.exec === null)) this.execTick = obs.tick;
    if (prev !== null && prev.kind !== 'hold' && p.kind !== 'hold' && prev.r1 !== p.r1) this.routeOverride = -1;
  }

  // ───────── 指揮 ─────────

  /** 指揮：決定、更新、廣播計畫 @param {import('./base.js').Observation} obs @param {TacOut} out */
  lead(obs, out) {
    if (this.plan === null) this.setPlan(this.choosePlan(obs), obs);
    // 2.8：每回合第一次決策喊本回合的戰術（K:<代號>），一回合一次
    if (!this.tagSaid && this.plan !== null) {
      this.tagSaid = true;
      const k = this.tagPick ?? tacticOf(this.plan);
      this.tagNow = k;
      this.used.set(k, (this.used.get(k) ?? 0) + 1);
      out.cmds.push({ type: 'say', text: `K:${k}` });
    }
    const p = /** @type {Plan} */ (this.plan);
    const next = p.kind === 'hold' ? this.leadCT(obs, p) : this.dodgeLine(obs, this.leadT(obs, p));
    if (next !== p) this.setPlan(next, obs);
    const text = planText(/** @type {Plan} */ (this.plan));
    if (this.saidAs !== obs.me.id || this.saidText !== text) {
      out.cmds.push({ type: 'say', text });
      this.saidAs = obs.me.id;
      this.saidText = text;
    }
    const b = obs.bomb;
    if (!this.plantedSaid && b.state === 'planted' && b.site !== null) {
      this.plantedSaid = true;
      out.cmds.push({ type: 'say', text: `E:planted ${b.site}` });
    }
  }

  /** @param {import('./base.js').Observation} obs @returns {Plan} */
  choosePlan(obs) {
    if (obs.me.team === 'CT') return this.chooseCT(obs);
    return this.chooseT(obs);
  }

  /** 2.8：隊伍執行熟練度 q（0～1；沒資料 0.5） @param {string} id */
  qOf(id) {
    return clamp((this.prof?.team?.[id] ?? 50) / 100, 0, 1);
  }

  /** 2.8：個人熟練度 p（0～1；沒資料 0.5） @param {string} id */
  pOf(id) {
    return clamp((this.prof?.personal?.[id] ?? 50) / 100, 0, 1);
  }

  /** 2.8：本回合戰術的隊伍執行品質偏離 0.5 多少（q＝0 → +0.5、q＝1 → −0.5；不知道戰術時 0） */
  qGap() {
    return this.tagNow === null ? 0 : 0.5 - this.qOf(this.tagNow);
  }

  /** 2.8：本回合戰術的個人熟練度不到 0.5 的部分（0～0.5；不知道戰術時 0） */
  pLow() {
    return this.tagNow === null ? 0 : Math.max(0, 0.5 - this.pOf(this.tagNow));
  }

  /** 2.8：有沒有教練或熟練度資料（試玩、基準 v1～v5 都沒有；沒有時戰術選擇和 2.7 逐位元相同） */
  hasData() {
    return this.coach !== null || this.prof !== null;
  }

  /**
   * 2.8：戰術的教練項 c(id)（M5 規格 3.4，對數空間）＝ Wp×星級 ＋ Wq×(q−0.5) − Wr×本半場用過次數；禁用（星級 −1）回傳 null。
   * 只在有資料時用（沒資料時不算，2.7 每回合獨立抽選，沒有「用過」這一項）
   * @param {string} id @param {boolean} [ignoreBan] @returns {number | null}
   */
  coachTerm(id, ignoreBan = false) {
    const pref = this.coach?.pref?.[id] ?? 0;
    if (pref < 0 && !ignoreBan) return null;
    const wr = /** @type {readonly string[]} */ (CT_TACTICS).includes(id) ? P.tacWrCT : P.tacWr;
    return P.tacWp * Math.max(0, pref) + P.tacWq * (this.qOf(id) - 0.5) - wr * (this.used.get(id) ?? 0);
  }

  /**
   * T（2.8，選法 B）：兩段 logit 抽選，沿用 2.7 的亂數流。先抽點、再抽打法，權重＝2.7 的狀態權重 × 對手適應（2.7 的乘法）× e^{c}；
   * 有資料時點的權重乘上 Z(s)＝Σ w·e^{c} ／ Σ w，聯合機率等於 8 個（打法，點）組合一起做 logit。
   * 沒資料時 c 不乘、Z 不算，和 2.7 是同一個式子、同樣次數的 h.random()（逐位元相同）。教練命令直接採用、不抽。路線序號照 2.7 抽
   * @param {import('./base.js').Observation} obs @returns {TPlan}
   */
  chooseT(obs) {
    const h = this.h;
    const ag = this.attrs.aggression;
    const data = this.hasData();
    const call = this.coach?.call?.buy ?? this.buyCall ?? this.econ.teamCall(obs);
    const learned = this.adapt.advice('T');
    const wA = Math.max(0.2, 1 + 0.35 * this.siteScore.A);
    const wB = Math.max(0.2, 1 + 0.35 * this.siteScore.B);
    const forced = ['', 'default', 'rush', 'split', 'fake'][this.opts.plan] ?? '';
    const KINDS = /** @type {const} */ (['default', 'rush', 'split', 'fake']);
    /** @param {string} k @param {SiteId} st */
    const tacId = (k, st) => (k === 'rush' || k === 'split' ? k + st : k);
    const cmd = this.coach?.call?.tactic ?? null;
    /** @type {SiteId} */
    let site;
    /** @type {string} */
    let kind;
    if (cmd !== null && /** @type {readonly string[]} */ (T_TACTICS).includes(cmd)) {
      // 教練命令：直接採用（default／fake 的主力點取點權重高的）
      kind = cmd.replace(/[AB]$/, '');
      site = cmd.endsWith('A') ? 'A' : cmd.endsWith('B') ? 'B' : wA >= wB ? 'A' : 'B';
    } else {
      // 狀態權重（2.7）：我方 eco 不打兩點分兵的 default／fake；對方多半在 eco 不打慢的 default。有資料時贏手槍局後的 half 也當 eco（規格 3.4：狀態蓋過星級）
      const eco = call === 'eco' || (data && call === 'half');
      /** @type {Record<string, number>} */
      const w = eco ? { default: 0, rush: 0.65, split: 0.35, fake: 0 } : this.enemyEco() ? { default: 0.1, rush: 0.35 + 0.2 * ag, split: 0.4, fake: 0.1 } : { default: 0.22, rush: 0.12 + 0.2 * ag, split: 0.4, fake: 0.18 };
      // 對手適應 A（2.7 的乘法；倍率 0.75～1.25、fake 再乘 0.75～1.25，|ln| ≤ 0.575，不需要夾限）
      for (const k of KINDS) w[k] *= learned.plans[k] ?? 1;
      w.fake *= 0.75 + learned.rotation * 0.5;
      /** 有資料時每個（打法，點）的權重 w·e^{c}；禁用的是 0，全部被禁用時放寬禁用 @type {Record<SiteId, Record<string, number>> | null} */
      let m = null;
      if (data) {
        /** @param {boolean} ignoreBan */
        const build = (ignoreBan) => {
          /** @type {Record<SiteId, Record<string, number>>} */
          const o = { A: {}, B: {} };
          for (const st of /** @type {const} */ (['A', 'B'])) {
            for (const k of KINDS) {
              const c = this.coachTerm(tacId(k, st), ignoreBan);
              // 打法被旋鈕固定時不看狀態權重（2.7 固定時不抽打法）
              const base = forced !== '' ? (k === forced ? 1 : 0) : w[k];
              o[st][k] = c === null ? 0 : base * expd(c);
            }
          }
          return o;
        };
        m = build(false);
        const mm = m;
        if (!(KINDS.reduce((a, k) => a + mm.A[k] + mm.B[k], 0) > 0)) m = build(true);
      }
      // 第 1 段：抽點。沒資料時 mA＝wA、mB＝wB（同 2.7）；有資料時乘上 Z(s)
      let mA = wA;
      let mB = wB;
      if (m !== null) {
        const mm = m;
        const den = forced !== '' ? 1 : w.default + w.rush + w.split + w.fake;
        const z = (/** @type {SiteId} */ st) => (mm[st].default + mm[st].rush + mm[st].split + mm[st].fake) / den;
        mA = wA * z('A');
        mB = wB * z('B');
      }
      site = h.random() * (mA + mB) < mA ? 'A' : 'B';
      kind = forced;
      if (kind === '') {
        // 第 2 段：在抽到的點抽打法（default、rush、split 依序扣減，剩下的是 fake；同 2.7）
        const v = m === null ? w : m[site];
        let r = h.random() * (v.default + v.rush + v.split + v.fake);
        kind = 'fake';
        for (const k of /** @type {const} */ (['default', 'rush', 'split'])) {
          if ((r -= v[k]) < 0) {
            kind = k;
            break;
          }
        }
        // 有資料時浮點誤差落到權重 0 的 fake：改取最後一個權重 > 0 的（沒資料時照 2.7 不處理）
        if (m !== null && kind === 'fake' && !(v.fake > 0)) kind = ['split', 'rush', 'default'].find((k) => v[k] > 0) ?? 'split';
      }
    }
    this.tagPick = tacId(kind, site);
    const routes = this.intel.routes.T[site];
    const n = Math.max(1, routes.length);
    if (kind === 'rush') return { kind: 'rush', site, r1: Math.floor(h.random() * Math.min(2, n)), r2: 0, exec: site };
    if (kind === 'split') {
      const r1 = 0;
      const entrance1 = routes[r1]?.portals[routes[r1].portals.length - 1];
      // 第二組走入口不同的路線，有多條就抽一條
      const others = routes.map((_, i) => i).filter((i) => i !== r1 && routes[i].portals[routes[i].portals.length - 1] !== entrance1);
      const r2 = others.length > 0 ? others[Math.floor(h.random() * others.length)] : 0;
      return { kind: 'split', site, r1, r2, exec: null };
    }
    const nOther = Math.max(1, this.intel.routes.T[other(site)].length);
    if (kind === 'fake') return { kind: 'fake', site, r1: 0, r2: Math.floor(h.random() * Math.min(2, nOther)), exec: null };
    return { kind: 'default', site, r1: Math.floor(h.random() * Math.min(2, n)), r2: Math.floor(h.random() * Math.min(2, nOther)), exec: null };
  }

  /**
   * CT（2.8，選法 B）：效用分數取最高（CT 是確定性規則，不抽亂數）。狀態分＝2.7 規則選中的那個 +1、ctPush −0.1、其他 0，有資料時再加教練項 c。
   * 2.7 規則：對面一直打同一點（證據 ≥ 5、偏向 > 0.9、快攻 > 0.6）疊 4 人、另一點留 1 人；最近常打同一點（證據 ≥ 3、偏向 > 0.5）中路調 1 人過去；其他 ct212。
   * 沒資料時取的就是 2.7 規則選的（站位也和 2.7 相同）。ct212＝A＝旋鈕、中路、B＝P.ctB；ctPush＝ct212 加第二個探點的人
   * @param {import('./base.js').Observation | null} obs null＝不是指揮、還沒收到計畫時的暫用站位（照 2.7 規則） @returns {CTPlan}
   */
  chooseCT(obs = null) {
    const a0 = clamp(this.opts.ctSplitA, 0, 5);
    const b0 = Math.min(P.ctB, 5 - a0);
    const m0 = 5 - a0 - b0;
    const learned = this.adapt.advice('CT');
    const bias = learned.A - learned.B;
    const strong = learned.evidence >= 5 && Math.abs(bias) > 0.9 && learned.fast > 0.6;
    const lean = learned.evidence >= 3 && m0 > 0 && Math.abs(bias) > 0.5;
    const rule = strong || lean ? (bias > 0 ? 'stackA' : 'stackB') : 'ct212';
    let id = rule;
    if (obs !== null && this.hasData()) {
      const cmd = this.coach?.call?.tactic ?? null;
      if (cmd !== null && /** @type {readonly string[]} */ (CT_TACTICS).includes(cmd)) id = cmd;
      else {
        /** @param {boolean} ignoreBan @returns {string | null} */
        const best = (ignoreBan) => {
          let pick = null;
          let top = -Infinity;
          for (const t of CT_TACTICS) {
            const c = this.coachTerm(t, ignoreBan);
            if (c === null) continue;
            const score = (t === rule ? 1 : 0) + (t === 'ctPush' ? -0.1 : 0) + c;
            if (score > top) {
              top = score;
              pick = t;
            }
          }
          return pick;
        };
        id = best(false) ?? best(true) ?? rule;
      }
    }
    if (obs !== null) this.tagPick = id;
    /** @type {CTPlan} */
    const base = { kind: 'hold', a: a0, m: m0, b: b0, rot: null, go: false };
    if (id === 'ctPush') return { ...base, push: true };
    if (id === 'stackA' || id === 'stackB') {
      const toA = id === 'stackA';
      if (strong) return { ...base, a: toA ? 4 : 1, m: 0, b: toA ? 1 : 4 };
      if (m0 > 0) return toA ? { ...base, a: a0 + 1, m: m0 - 1 } : { ...base, b: b0 + 1, m: m0 - 1 };
      // 教練指定疊點、中路沒人可調：從另一點調 1 人（另一點至少留 1 人）
      if (toA && b0 > 1) return { ...base, a: a0 + 1, b: b0 - 1 };
      if (!toA && a0 > 1) return { ...base, a: a0 - 1, b: b0 + 1 };
    }
    return base;
  }

  /**
   * T 指揮：佈置完成或時間到就執行；剩 P.forceExecLeft 秒強行執行最近的點
   * @param {import('./base.js').Observation} obs @param {TPlan} p @returns {TPlan}
   */
  leadT(obs, p) {
    if (obs.round.phase !== 'live' || p.exec !== null) return p;
    const t = obs.tick;
    const el = (t - this.liveStart) / this.tps;
    const left = obs.round.phaseTicksLeft / this.tps;
    if (left <= P.forceExecLeft) return { ...p, exec: this.nearestSite(obs) };
    if (p.kind === 'split') {
      const ready = this.alive(obs).every((m) => {
        const s = this.memberStage(obs, m.id, p);
        // 2.8（P.qSync）：隊伍執行熟練度低，到位判定鬆（兩組常各打各的）；q ≥ 0.5 時 4.5 格同 2.7（收緊會站不到、等到逾時）
        return s === null || dist(m.x, m.y, s.x, s.y) < 4.5 * (1 + P.qSync * Math.max(0, this.qGap())) * UNIT;
      });
      // 兩組都到了再等 1.5 秒（狙擊手站定開鏡、隊友站好）
      if (!ready) this.readyAt = -1;
      else if (this.readyAt < 0) this.readyAt = t;
      // 長路線走不到 P.splitWait：等到估計抵達（第二組沒到就喊 go 等於兩路各打各的）
      const far = Math.max(this.tRoute(p.site, p.r1)?.length ?? 0, this.tRoute(p.site, p.r2)?.length ?? 0);
      // 2.8（P.qSyncWait）：熟練度低，等第二組的上限長
      if ((ready && t - this.readyAt >= 1.5 * this.tps) || el >= Math.max(P.splitWait, far / P.routeSpeed) * (1 + P.qSyncWait * Math.max(0, this.qGap()))) return { ...p, exec: p.site };
    }
    if (p.kind === 'fake') {
      const fakers = this.alive(obs).filter((m) => this.inGroup(obs, m.id, p, 1));
      const there = fakers.some((m) => {
        const s = this.memberStage(obs, m.id, p);
        return s !== null && dist(m.x, m.y, s.x, s.y) < 4 * UNIT;
      });
      if (there && this.stageArrive < 0) this.stageArrive = t;
      if (there) {
        const bait = other(p.site);
        const probed = fakers.some((m) => this.inRectSite(m.x, m.y, bait));
        const response = this.adapt.fake(obs, this.perc, p, probed);
        if (response !== null) return { ...p, exec: response };
      }
      if ((this.stageArrive >= 0 && t - this.stageArrive >= P.fakeDelay * this.tps) || el >= P.splitWait + 6) return { ...p, exec: p.site };
    }
    if (p.kind === 'default') {
      const at = lerp(P.defaultExec0, P.defaultExec100, this.attrs.aggression) * (this.enemyEco() ? 0.6 : 1);
      const heat = this.heat(obs);
      // 情報：一點確認 ≥ 2 人、另一點沒有 → 提早打另一點
      const early = el >= at * 0.5 && Math.abs(heat.A - heat.B) >= 2;
      if (el >= at || early) return { ...p, exec: heat.A < heat.B ? 'A' : heat.B < heat.A ? 'B' : p.site };
    }
    return p;
  }

  /** 這個點（敵人）看得到入口 @param {import('./base.js').Pt} q @param {import('./analysis.js').Entrance | null} e */
  covers(q, e) {
    return e !== null && dist(q.x, q.y, e.ox, e.oy) < 45 * UNIT && (this.g.los(q.x, q.y, e.ox, e.oy) || this.g.los(q.x, q.y, e.ix, e.iy));
  }

  /**
   * 已知狙擊線蓋住主力的入口、另一條路線沒有：全隊換路（一回合一次；已經到入口附近就不換）。
   * 上回合的狙擊位也算，但有 P.awpAvoid 的機率才理會（對面可能換位）
   * @param {import('./base.js').Observation} obs @param {TPlan} p @returns {TPlan}
   */
  dodgeLine(obs, p) {
    if (this.dodged || p.kind === 'go' || (p.exec !== null && p.exec !== p.site)) return p;
    const last = this.awpHist[this.awpHist.length - 1];
    const q = this.awp ?? last;
    if (q === undefined) return p;
    const ent = this.entranceOf(p.site, p.r1);
    if (!this.covers(q, ent) || ent === null) return p;
    this.dodged = true;
    if (this.awp === null && this.h.random() >= P.awpAvoid) return p;
    if (this.alive(obs).some((m) => dist(m.x, m.y, ent.ox, ent.oy) < 12 * UNIT)) return p;
    const n = this.intel.routes.T[p.site].length;
    for (let i = 0; i < n; i++) {
      const e = this.entranceOf(p.site, i);
      if (i !== p.r2 && e !== null && e.portal !== ent.portal && !this.covers(q, e)) return { ...p, r1: i };
    }
    return p;
  }

  /** 對方多半在 eco：上回合我方贏，而且對方連敗補償 ≥ 2 階 */
  enemyEco() {
    return this.econ.lastWon === true && this.econ.enemyLevel >= 2;
  }

  /** 離持彈者（或自己）最近的點 @param {import('./base.js').Observation} obs @returns {SiteId} */
  nearestSite(obs) {
    const c = obs.teammates.find((m) => m.alive && m.hasBomb) ?? obs.me;
    const cell = this.g.cellOf(c.x, c.y);
    if (cell < 0) return 'A';
    return this.intel.distSite.A[cell] <= this.intel.distSite.B[cell] ? 'A' : 'B';
  }

  /**
   * 兩個包點附近估計的敵人數：自己記得的敵人、收到的接觸（同一區域取最新）、隊友陣亡
   * @param {import('./base.js').Observation} obs
   */
  heat(obs) {
    const t = obs.tick;
    const out = { A: 0, B: 0 };
    const seen = { A: 0, B: 0 };
    for (const k of this.perc.known.values()) {
      if (k.conf < 50) continue;
      const s = this.siteNear(this.g.cellOf(k.x, k.y));
      if (s !== null) seen[s]++;
    }
    const heard = { A: 0, B: 0 };
    /** 2.7（P.heatDedupe）：每點依時間排，走得到（可能是同一人移動）的接觸併成同一條軌跡、人數取大 @type {Record<SiteId, { n: number, tick: number, x: number, y: number }[]>} */
    const tracks = { A: [], B: [] };
    const list = [...this.contacts].sort((a, b) => a[1].tick - b[1].tick || (a[0] < b[0] ? -1 : 1));
    for (const [key, c] of list) {
      if (t - c.tick > P.contactTtl * this.tps) {
        this.contacts.delete(key);
        continue;
      }
      const s = this.contactSite.get(key) ?? null;
      if (s === null) continue;
      if (!P.heatDedupe) {
        heard[s] += c.n;
        continue;
      }
      const reach = (/** @type {{ tick: number, x: number, y: number }} */ q) => Number.isFinite(c.x) && Number.isFinite(q.x) && dist(q.x, q.y, c.x, c.y) <= (P.routeSpeed * 1.5 * (c.tick - q.tick) / this.tps + 3) * UNIT;
      const tr = tracks[s].find((q) => q.tick < c.tick && reach(q)) ?? tracks[s].find((q) => q.tick === c.tick && reach(q) && dist(q.x, q.y, c.x, c.y) < 3 * UNIT);
      if (tr === undefined) tracks[s].push({ n: c.n, tick: c.tick, x: c.x, y: c.y });
      else Object.assign(tr, { n: Math.max(tr.n, c.n), tick: c.tick, x: c.x, y: c.y });
    }
    if (P.heatDedupe) for (const s of SITES) heard[s] = tracks[s].reduce((v, q) => v + q.n, 0);
    for (const s of SITES) out[s] = P.heatDedupe ? Math.min(Math.max(seen[s], heard[s]), obs.enemiesAlive) : Math.max(seen[s], heard[s]);
    return out;
  }

  /**
   * CT 指揮：某點估計 ≥ P.rotateHeat 人就輪轉；炸彈下了輪轉到炸彈的點，集結完畢（或時間不多）喊 go
   * @param {import('./base.js').Observation} obs @param {CTPlan} p @returns {CTPlan}
   */
  leadCT(obs, p) {
    if (obs.round.phase === 'freeze') return p;
    const b = obs.bomb;
    if ((b.state === 'planted' || b.state === 'defusing') && b.site !== null) {
      // 敵人全滅就不用集結
      const clear = obs.enemiesAlive === 0;
      if (p.rot !== b.site) return { ...p, rot: b.site, go: clear };
      if (!p.go && (clear || this.retakeReady(obs, b.site))) return { ...p, go: true };
      return p;
    }
    const heat = this.heat(obs);
    if (p.rot === null) {
      for (const s of SITES) if (heat[s] >= P.rotateHeat && heat[s] > heat[other(s)]) { this.rotSince = obs.tick; return { ...p, rot: s }; }
    } else if (obs.tick - this.rotSince >= 4 * this.tps) {
      const next = other(p.rot);
      if (heat[next] >= P.rotateHeat && heat[next] > heat[p.rot] + 1) { this.rotSince = obs.tick; return { ...p, rot: next }; }
      if (heat.A === 0 && heat.B === 0 && obs.tick - this.rotSince >= 7 * this.tps) {
        let n = 0, seen = 0;
        for (let i = 0; i < this.g.N; i++) if (this.intel.sites[p.rot].regions.has(this.intel.region[i])) {
          n++; if (this.perc.seenTick[i] >= Math.max(this.rotSince, obs.tick - this.tps)) seen++;
        }
        if (n > 0 && seen / n >= 0.65) { this.rotSince = obs.tick; return { ...p, rot: null }; }
      }
    }
    return p;
  }

  /** 回防集結完畢：點外的人都到了待命點；或時間只夠現在進 @param {import('./base.js').Observation} obs @param {SiteId} s */
  retakeReady(obs, s) {
    const b = obs.bomb;
    const bx = b.x ?? this.intel.sites[s].cx;
    const by = b.y ?? this.intel.sites[s].cy;
    const stage = this.stageSpots('CT', s, 0);
    if (stage.length === 0) return true;
    const left = (b.ticksLeft ?? 0) / this.tps;
    const feasible = this.defuseTeam(obs, bx, by).filter((m) => m.eta <= left);
    // 已在拆、僅剩機率性機會、或裕度不足：不再為集結耗掉機會。
    if (feasible.length === 0 || feasible.some((m) => m.defusing || m.pending || m.cautious > left) || left <= Math.min(...feasible.map((m) => m.cautious)) + P.saveMargin + 2) return true;
    return feasible.every((m) => this.inSite(m.x, m.y, s, bx, by) || stage.some((sp) => dist(m.x, m.y, sp.x, sp.y) < P.retakeGather * UNIT));
  }

  /** 集結與拆包分工共用：只評估存活者及各自 kit；隊友延遲沿用本人區間作估計，並非保證。
   * eta 是最早可能完成；cautious 用較慢延遲，沒有穩定餘裕時立即嘗試。
   * @param {import('./base.js').Observation} obs @param {number} bx @param {number} by
   */
  defuseTeam(obs, bx, by) {
    const me = obs.me;
    const r = this.data.rules;
    const field = this.judge?.field(bx, by);
    const pending = this.defuseIssued >= 0 && obs.tick <= this.defuseIssued + this.delayMax + r.decisionInterval;
    const team = this.alive(obs).map((m) => ({ ...m, weapon: m.id === me.id ? me.weapon : obs.teammates.find((q) => q.id === m.id)?.weapon, kit: m.id === me.id ? me.loadout.kit : this.kits.has(m.id), d: field === undefined ? dist(m.x, m.y, bx, by) : field[this.g.cellOf(m.x, m.y)] / 10 * UNIT, defusing: m.id === me.id ? me.defuseTicks > 0 : obs.teammates.some((q) => q.id === m.id && q.defusing), pending: m.id === me.id && pending }));
    return team.map((m) => {
      const duration = m.kit ? r.defuseKitTicks : r.defuseTicks;
      const walking = dist(m.x, m.y, bx, by) < 1300 ? 0 : this.judge !== null ? Math.max(0, this.judge.travel(m, bx, by) * this.tps - r.reactionTicks) : m.d / 4.6 / UNIT * this.tps;
      const finish = (/** @type {number} */ delay) => {
        if (m.defusing) {
          const progress = m.id === me.id ? me.defuseTicks : 1 + obs.tick - (this.defuseStarted.get(m.id) ?? obs.tick);
          return Math.max(0, duration - progress) / this.tps;
        }
        if (m.pending) return Math.max(0, this.defuseIssued + delay + duration - 1 - obs.tick) / this.tps;
        const ready = walking === 0 ? 0 : Math.ceil((walking + delay) / r.decisionInterval) * r.decisionInterval;
        const handoff = team.some((q) => q.defusing) ? Math.ceil(delay / r.decisionInterval) * r.decisionInterval : 0;
        return (Math.max(ready, handoff) + delay + duration - 1) / this.tps;
      };
      return { ...m, eta: finish(this.delayMin), cautious: finish(this.delayMax) };
    });
  }

  /** 在包點裡（包點區域內或離炸彈 8 格內） @param {number} x @param {number} y @param {SiteId} s @param {number} bx @param {number} by */
  inSite(x, y, s, bx, by) {
    const c = this.g.cellOf(x, y);
    return (c >= 0 && this.intel.sites[s].regions.has(this.intel.region[c])) || dist(x, y, bx, by) < 8 * UNIT;
  }

  // ───────── 購買、事件廣播 ─────────

  /** 指揮先決定買法並廣播；其他人等指揮的買法（最多 1 秒）再買 @param {import('./base.js').Observation} obs @param {TacOut} out @param {boolean} isCmd */
  buy(obs, out, isCmd) {
    const me = obs.me;
    // 等不到隊友送的槍：還能買就自己補買一次
    if (this.bought && this.giftMiss && !this.reBought && obs.round.canBuy) {
      this.reBought = true;
      const items = this.econ.items(obs, this.econ.call ?? 'force', this.roles.of(me.id), this.roles.awper() === me.id);
      if (items.length > 0) out.cmds.push({ type: 'buy', items });
      return;
    }
    if (!obs.round.canBuy || this.bought) {
      if (!this.kitSaid && me.loadout.kit && obs.round.phase !== 'freeze') {
        this.kitSaid = true;
        out.cmds.push({ type: 'say', text: 'E:kit' });
      }
      return;
    }
    if (isCmd && this.buyCall === null) {
      // 2.8：教練命令的買法蓋過隊內買法
      this.buyCall = this.coach?.call?.buy ?? this.econ.teamCall(obs);
      out.cmds.push({ type: 'say', text: `B:${this.buyCall}` });
      // 發槍計畫（2.6.2）：隊友的金錢公開、主武器只看得到手上拿的
      const awper = this.roles.awper();
      const people = [{ id: me.id, money: me.money, good: this.econ.hasGood(me.loadout.primary), awp: me.loadout.primary === 'awp', awper: awper === me.id }, ...obs.teammates.filter((m) => m.alive).map((m) => ({ id: m.id, money: m.money, good: this.econ.hasGood(m.weapon), awp: m.weapon === 'awp', awper: awper === m.id }))];
      this.gifts = this.econ.giftPlan(people, me.team, this.buyCall);
      for (const g of this.gifts) out.cmds.push({ type: 'say', text: `B:gift ${g.from} ${g.to} ${g.w}` });
      // 3.0 資源層：照需求表下購買單（隊友在下一次決策聽到才買）
      if (P.resLayer && this.plan !== null) {
        const r = this.data.rules;
        const price = (/** @type {import('./resources.js').KindCode} */ k) => this.econ.cost(kindOf(k, me.team));
        const carry = (/** @type {import('./resources.js').KindCode} */ k) => this.data.grenades.find((x) => x.id === kindOf(k, me.team))?.maxCarry ?? 1;
        const orders = buyOrders(this.needs(obs), this.buyCall, people.map((q) => ({ id: q.id, money: q.money, good: q.good, role: this.roles.of(q.id) })), { team: me.team, rifle: this.econ.cost(me.team === 'T' ? 'ak' : 'm4'), armor: r.armorPrice, kit: r.kitPrice, price, carry, slots: r.grenadeSlots });
        out.cmds.push({ type: 'say', text: buyText(orders) });
        this.myOrders = (orders.get(me.id) ?? []).map((k) => kindOf(k, me.team));
      }
    } else if (P.resLayer && this.res.orders !== null && this.myOrders.length === 0) this.myOrders = (this.res.orders.get(me.id) ?? []).map((k) => kindOf(k, me.team));
    const waited = obs.round.phase !== 'freeze' || this.data.rules.freezeTicks - obs.round.phaseTicksLeft >= this.tps;
    if (this.buyCall === null && !waited) return;
    const call = this.buyCall ?? this.econ.teamCall(obs);
    this.econ.call = call;
    const give = this.gifts.find((g) => g.from === me.id)?.w ?? null;
    const get = this.gifts.find((g) => g.to === me.id);
    if (get !== undefined) this.giftWant = { w: get.w, until: obs.tick + (obs.round.phase === 'freeze' ? obs.round.phaseTicksLeft : 0) + P.giftWait * this.tps };
    const items = this.econ.items(obs, call, this.roles.of(me.id), this.roles.awper() === me.id, give, get !== undefined, this.myOrders);
    if (items.length > 0) out.cmds.push({ type: 'buy', items });
    this.bought = true;
    this.boughtAt = obs.tick;
  }

  /**
   * 3.0（r7k）：這個隊員走不走這個目標入口（T 照計畫分組：主組 r1、第二組 r2；rush／go 全隊同一路）；CT、守點、沒指定入口都算符合
   * @param {import('./base.js').Observation} obs @returns {import('./resources.js').Fits}
   */
  fits(obs) {
    const p = this.plan;
    return (id, tg) => {
      if (p === null || p.kind === 'hold' || tg.site === null || tg.ent < 0) return true;
      const st = this.setupOf(obs, id, p);
      const e = this.entranceOf(st.site, st.route);
      return st.site === tg.site && e !== null && this.intel.sites[st.site].entrances.indexOf(e) === tg.ent;
    };
  }

  /** 3.0：這回合計畫的需求表 @param {import('./base.js').Observation} obs */
  needs(obs) {
    const p = /** @type {Plan} */ (this.plan);
    const ent = (/** @type {SiteId} */ site, /** @type {number} */ route) => {
      const e = this.entranceOf(site, route);
      return e === null ? -2 : this.intel.sites[site].entrances.indexOf(e);
    };
    let choke = /** @type {SiteId} */ ('A');
    if (p.kind === 'hold') {
      const adv = this.adapt.advice('CT');
      choke = adv.evidence >= 3 && adv.A !== adv.B ? (adv.A > adv.B ? 'A' : 'B') : p.b > p.a ? 'B' : 'A';
    }
    void obs;
    return needsOf(p, { ent, choke });
  }

  /**
   * 3.0 資源層的喊話：買完喊持有（U:h）；指揮者收齊持有（或凍結剩 1 秒）就喊道具計畫（U:p）；之後每次決策重分配（U:r）；
   * 各副本在同樣的公開條件下讓過期的用途轉 free
   * @param {import('./base.js').Observation} obs @param {TacOut} out @param {boolean} isCmd
   */
  resStep(obs, out, isCmd) {
    if (!P.resLayer) return;
    const me = obs.me;
    const t = obs.tick;
    const res = this.res;
    const freeze = obs.round.phase === 'freeze';
    // 購買指令要等反應延遲才生效：過了延遲上限再喊持有
    if (!res.saidHold && me.alive && ((this.bought && t > this.boughtAt + this.delayMax) || !freeze || !obs.round.canBuy)) {
      res.saidHold = true;
      out.cmds.push({ type: 'say', text: `U:h ${holdText(me.loadout.grenades)}` });
    }
    if (!isCmd || this.plan === null) {
      this.resRelease(obs);
      return;
    }
    if (!res.active && !res.saidPlan && freeze) {
      const alive = this.alive(obs);
      if (alive.every((q) => res.holds.has(q.id)) || obs.round.phaseTicksLeft <= this.tps) {
        res.saidPlan = true;
        out.cmds.push({ type: 'say', text: itemsText(allocate(this.needs(obs), res.holds, (id) => this.roles.of(id), this.fits(obs))) });
      }
    }
    if (res.active) {
      const people = this.alive(obs).map((q) => ({ ...q, alive: true }));
      const planted = me.team === 'CT' && obs.bomb.state === 'planted' && obs.bomb.site !== null ? obs.bomb.site : null;
      const pointOf = (/** @type {import('./resources.js').Target} */ tg) => {
        if (tg.site === null) return null;
        const site = this.intel.sites[tg.site];
        const e = tg.ent >= 0 ? site.entrances[tg.ent] : undefined;
        return e !== undefined ? { x: e.ox, y: e.oy } : { x: site.cx, y: site.cy };
      };
      for (const text of res.upkeep(people, pointOf, planted, this.fits(obs))) out.cmds.push({ type: 'say', text });
      // （審查 (a)，r7k）執行中：有隊友走到那個包點任一入口的觸發距離內（split 兩組走不同入口）、擁有者離自己那筆的入口超過 2N，指揮者喊 U:f 讓它轉自由
      if (me.team === 'T' && this.execTick >= 0 && obs.bomb.state !== 'planted') {
        const leadN = P.routeSpeed * ((this.util.fuse.get('flash') ?? 45) + this.data.rules.reactionTicks) / this.tps + 1;
        for (const it of res.items) {
          if (it.purpose !== 'entryFlash' || it.state !== 'plan' || it.target.site === null || it.target.ent < 0) continue;
          const e = this.intel.sites[it.target.site].entrances[it.target.ent];
          const o = people.find((q) => q.id === it.owner);
          if (e === undefined || o === undefined) continue;
          const ents = this.intel.sites[it.target.site].entrances;
          if (dist(o.x, o.y, e.ox, e.oy) > 2 * leadN * UNIT && people.some((q) => q.id !== it.owner && ents.some((x) => dist(q.x, q.y, x.ox, x.oy) < leadN * UNIT))) out.cmds.push({ type: 'say', text: `U:f ${it.idx}` });
        }
      }
    }
    this.resRelease(obs);
  }

  /** 3.0：用途到期轉 free（設計第五節「到期」欄） @param {import('./base.js').Observation} obs */
  resRelease(obs) {
    const res = this.res;
    if (!res.active || this.plan === null) return;
    const t = obs.tick;
    const planted = obs.bomb.state === 'planted';
    if (obs.me.team === 'CT') {
      if (planted) res.release(['chokeMolotov']);
      return;
    }
    if (planted) {
      res.release(['entryFlash', 'entrySmoke', 'holdSmoke', 'fireBackup', 'fakeUtil']);
      return;
    }
    const p = this.plan;
    if (p.kind === 'fake' && p.exec !== null) res.release(['fakeUtil']);
    if (this.execTick < 0) return;
    const since = (t - this.execTick) / this.tps;
    if (since > 7) res.release(['entrySmoke', 'holdSmoke']);
    if (since > 15) res.release(['entryFlash']);
    const site = p.kind !== 'hold' ? (p.exec ?? p.site) : null;
    const inSite = site !== null && this.alive(obs).some((q) => this.inRectSite(q.x, q.y, site));
    if (since > 20 || inSite) res.release(['fireBackup']);
  }

  /**
   * 3.0：身上有、而且資源層允許這個用途；允許就記下項目（丟出時喊 U:u）
   * @param {import('./base.js').Observation['me']} me @param {import('./base.js').GrenadeId} kind @param {(import('./resources.js').Purpose | 'free')[]} purposes
   */
  can(me, kind, purposes) {
    if (!this.util.has(me, kind)) return false;
    if (!P.resLayer) return true;
    // 3.0（r7k，T22）：自己問時用實際持有數算計畫外的餘量（U:h 之後撿到、被換掉的道具副本不知道）
    const it = this.res.claim(me.id, kind, purposes, me.loadout.grenades.filter((g) => g === kind).length, this.curObs === null ? undefined : this.fits(this.curObs));
    if (it === null) return false;
    this.claimed.set(kind, it);
    return true;
  }

  /**
   * 3.0：CT 燒入口用哪種燃燒：計畫的 chokeMolotov 目標就是這個入口（或這個點）才用它，否則只用 free
   * @param {import('./base.js').Observation['me']} me @param {SiteId} s @param {import('./analysis.js').Entrance} e
   * @returns {import('./base.js').GrenadeId | null}
   */
  chokeBurn(me, s, e) {
    const kind = me.team === 'CT' ? 'incendiary' : 'molotov';
    if (!this.util.has(me, kind)) return null;
    if (!P.resLayer || !this.res.active) return kind;
    const it = this.res.claim(me.id, kind, ['chokeMolotov']);
    const ei = this.intel.sites[s].entrances.indexOf(e);
    if (it !== null && it.target.site === s && (it.target.ent < 0 || it.target.ent === ei)) {
      this.claimed.set(kind, it);
      return kind;
    }
    return this.can(me, kind, ['free']) ? kind : null;
  }

  /** 3.0：第一個 can 的種類 @param {import('./base.js').Observation['me']} me @param {import('./base.js').GrenadeId[]} kinds @param {(import('./resources.js').Purpose | 'free')[]} purposes */
  pickFor(me, kinds, purposes) {
    return kinds.find((k) => this.can(me, k, purposes)) ?? null;
  }

  /** 槍的價值（撿槍用）：狙擊槍給狙擊手最高，步槍其次 @param {string | null} w */
  gunValue(w) {
    if (w === 'awp') return this.roles.of(this.data.playerId) === AWP ? 4 : 2.5;
    return w === 'ak' || w === 'm4' ? 3 : w === 'smg' || w === 'shotgun' ? 2 : 0;
  }

  /**
   * 撿槍（2.6.2）：隊友送的槍（開打後 P.giftWait 秒內去撿，撿不到就自己補買）；或附近 P.grabRange 格內比手上好的槍，
   * 看不到敵人、15 格內沒有記得的敵人、血 40 以上才撿。下包、拆包、撤離、衝點中不撿
   * @param {import('./base.js').Observation} obs @param {TacOut} out
   */
  grab(obs, out) {
    const me = obs.me;
    const t = obs.tick;
    const gw = this.giftWant;
    if (gw !== null && (t > gw.until || me.loadout.primary === gw.w)) {
      this.giftWant = null;
      if (me.loadout.primary !== gw.w) this.giftMiss = true;
    }
    if (!P.grab || obs.round.phase === 'freeze' || out.objective || out.commit || out.escape || me.plantTicks > 0 || me.defuseTicks > 0) return;
    const want = this.giftWant;
    const mine = this.gunValue(me.loadout.primary);
    let best = null;
    let bv = mine;
    let bd = Infinity;
    for (const it of obs.items) {
      if (it.kind !== 'weapon' || it.weapon === null) continue;
      const v = want !== null && it.weapon === want.w ? 9 : this.gunValue(it.weapon);
      const d = dist(me.x, me.y, it.x, it.y);
      if (d > (want !== null ? 12 : P.grabRange) * UNIT || v <= mine || v < bv || (v === bv && d >= bd)) continue;
      best = it;
      bv = v;
      bd = d;
    }
    if (best === null) return;
    if (want === null && (obs.enemies.length > 0 || me.hp < 40 || this.perc.threats(me.x, me.y, 50).some((k) => dist(k.x, k.y, me.x, me.y) < 15 * UNIT))) return;
    /** 撿到它也不虧：目標那把、拆彈器（canPick 已排除撿不到的）、比手上好的槍（之後再換目標那把） @param {import('./base.js').Observation['items'][number]} it */
    const useful = (it) => it === best || it.kind === 'kit' || (it.kind === 'weapon' && it.weapon !== null && (want !== null && it.weapon === want.w ? 9 : this.gunValue(it.weapon)) > mine);
    // 同一點排在前面、引擎會先撿到的沒用東西：走過去也只會撿到它，放棄（不把目標鎖在那裡）
    if (P.grabSim) {
      const k = obs.items.indexOf(best);
      if (obs.items.some((it, i) => i < k && this.canPick(me, it) && dist(it.x, it.y, best.x, best.y) < 50 && !useful(it))) return;
    }
    out.goal = { x: best.x, y: best.y };
    out.hold = null;
    out.route = null;
    out.stop = false;
    out.role += '・撿槍';
    // 引擎撿的是 1.2 格內最近的掉落物（一樣近取排前面的；隊伍撿不到的不算）：下一個會撿到的有用才撿，不然再走近一點
    const next = P.grabSim ? this.nextPick(obs) : null;
    const near = P.grabSim ? next === null || !useful(next) : obs.items.some((it) => it !== best && dist(me.x, me.y, it.x, it.y) <= bd);
    // 指令要等反應延遲才生效：剛下過就不再下（第二次會把剛掉在腳邊的舊槍撿回來）
    if (bd < UNIT && !near && t - this.pickAt > this.data.rules.reactionTicks + 2 * this.data.rules.decisionInterval) {
      this.pickAt = t;
      out.cmds.push({ type: 'pickup' });
    }
    else if (near) out.goal = { x: best.x, y: best.y };
  }

  /** 引擎規則下這個人撿得到的掉落物（炸彈只有 T、拆彈器只有身上沒有的 CT） @param {import('./base.js').Observation['me']} me @param {import('./base.js').Observation['items'][number]} it */
  canPick(me, it) {
    return !(it.kind === 'bomb' && me.team !== 'T') && !(it.kind === 'kit' && (me.team !== 'CT' || me.loadout.kit));
  }

  /** 現在下撿取會撿到哪一個（照引擎：撿取範圍內最近、一樣近取排前面的） @param {import('./base.js').Observation} obs */
  nextPick(obs) {
    const me = obs.me;
    let pick = null;
    let bd = P.pickReach * UNIT + 1;
    for (const it of obs.items) {
      if (!this.canPick(me, it)) continue;
      const d = dist(me.x, me.y, it.x, it.y);
      if (d < bd) {
        bd = d;
        pick = it;
      }
    }
    return pick;
  }

  /**
   * 任務收尾：避火、期限判定（設 commit）、撿槍。2.7（P.grabAfterTask）起撿槍排在期限判定之後：撿槍只是可中斷的順路選項，
   * 趕期限（commit）時不能蓋掉任務目標。回傳 true ＝ 因為避火取消這次的道具
   * @param {import('./base.js').Observation} obs @param {TacOut} out @returns {boolean}
   */
  settle(obs, out) {
    if (!P.grabAfterTask) this.grab(obs, out);
    const fire = this.mission?.avoidFire(obs, out, this.combat?.fires, this.nav) ?? false;
    this.mission?.assess(obs, out);
    if (P.grabAfterTask) this.grab(obs, out);
    return fire;
  }

  /**
   * 事件廣播：看到敵人 → 「E:contact <區域> <人數>」（同一區域人數變了或隔 P.contactEvery 秒才再喊）
   * @param {import('./base.js').Observation} obs @param {TacOut} out
   */
  report(obs, out) {
    if (obs.round.phase === 'freeze') return;
    const t = obs.tick;
    if (obs.me.team === 'CT' && this.smokeAlarm(obs, out)) return;
    if (obs.enemies.length === 0) return;
    /** @type {Map<number, number>} */
    const byRegion = new Map();
    for (const e of obs.enemies) {
      const r = this.intel.region[this.g.cellOf(e.x, e.y)];
      if (r >= 0) byRegion.set(r, (byRegion.get(r) ?? 0) + 1);
    }
    for (const [r, n] of byRegion) {
      const id = this.intel.map.regions[r].id;
      const last = this.saidContact.get(id);
      if (last !== undefined && (last.n >= n || t - last.tick < P.contactEvery * this.tps) && t - last.tick < 4 * P.contactEvery * this.tps) continue;
      this.saidContact.set(id, { n, tick: t });
      const c = this.regionCell(id);
      const p = c >= 0 ? this.g.center(c) : { x: NaN, y: NaN };
      this.noteContact(id, n, t, this.siteNear(c), p.x, p.y);
      out.cmds.push({ type: 'say', text: `E:contact ${id} ${n}` });
      return;
    }
  }

  /**
   * CT 看到對面丟在包點附近的煙：只提高警覺，喊 1 人的接觸（單獨不夠輪轉，煙可能是佯攻），要再有別的接觸才輪轉
   * @param {import('./base.js').Observation} obs @param {TacOut} out @returns {boolean}
   */
  smokeAlarm(obs, out) {
    for (const q of obs.effects) {
      if (q.kind !== 'smoke' || this.smokes.some((m) => dist(m.x, m.y, q.x, q.y) < 2 * UNIT) || this.smokeSeen.some((m) => dist(m.x, m.y, q.x, q.y) < 2 * UNIT)) continue;
      this.smokeSeen.push({ x: q.x, y: q.y });
      const s = this.siteNear(this.g.cellOf(q.x, q.y));
      if (s === null) continue;
      const id = this.intel.map.regions[/** @type {number} */ ([...this.intel.sites[s].regions][0])].id;
      this.noteContact(id, P.smokeAlarmN, obs.tick, s, q.x, q.y);
      out.cmds.push({ type: 'say', text: `E:contact ${id} ${P.smokeAlarmN}` });
      return true;
    }
    return false;
  }

  // ───────── T ─────────

  /** 主力組優先順序（小的先）：角色，其次隊內序號 @param {number} id */
  mainPri(id) {
    return MAIN_PRI[this.roles.of(id)] * 10 + this.slotOf(id);
  }

  /**
   * 分組：主力 3 人（持彈者＋突破手、支援優先）＝ 0、第二組 2 人（游擊、狙擊）＝ 1；rush／go 全隊同組。路線固定，組內職責依存活重排。
   * @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p
   */
  groupOf(obs, id, p) {
    if (p.kind === 'rush' || p.kind === 'go') return 0;
    const key = `${p.kind}${p.site}${this.roles.key}`;
    if (this.groups === null || this.groupKey !== key) {
      const carrier = obs.me.hasBomb ? obs.me.id : (obs.teammates.find((m) => m.hasBomb)?.id ?? -1);
      const others = this.ids.filter((x) => x !== carrier).sort((a, b) => this.mainPri(a) - this.mainPri(b));
      const main = carrier >= 0 ? [carrier, ...others.slice(0, 2)] : others.slice(0, 3);
      this.groups = new Map(this.ids.map((x) => [x, main.includes(x) ? 0 : 1]));
      this.groupKey = key;
    }
    return this.groups.get(id) ?? 0;
  }

  /** 組內名次（持彈者排最後；其餘依角色：突破手是第 0 個） @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p */
  memberIndex(obs, id, p) {
    const gid = this.groupOf(obs, id, p);
    const carrier = obs.me.hasBomb ? obs.me.id : (obs.teammates.find((m) => m.hasBomb)?.id ?? -1);
    // 突破手帶炸彈時還是排最前（他要先進點）
    const last = this.roles.of(carrier) === ENTRY ? -1 : carrier;
    const list = this.ids.filter((x) => this.isAlive(obs, x) && this.inGroup(obs, x, p, gid)).sort((a, b) => (a === last ? 1 : 0) - (b === last ? 1 : 0) || this.mainPri(a) - this.mainPri(b));
    return Math.max(0, list.indexOf(id));
  }

  /** 這個隊員現在算在 gid 這組（2.7：繞後中的隊友不算，自己除外） @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p @param {number} gid */
  inGroup(obs, id, p, gid) {
    return this.groupOf(obs, id, p) === gid && !this.lurking(obs, id);
  }

  /** 隊友正在繞後（喊過 E:lurk、全隊還有 4 人以上） @param {import('./base.js').Observation} obs @param {number} id */
  lurking(obs, id) {
    return P.lurkOut && id !== obs.me.id && this.lurkers.has(id) && this.alive(obs).length >= 4;
  }

  /** 某隊員佈置時要去的點與路線 @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p @returns {{ site: SiteId, route: number }} */
  setupOf(obs, id, p) {
    const gid = this.groupOf(obs, id, p);
    if (gid === 0) return { site: p.site, route: p.r1 };
    if (p.kind === 'split') return { site: p.site, route: p.r2 };
    return { site: other(p.site), route: p.r2 };
  }

  /** 某隊員的待命格 @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p */
  memberStage(obs, id, p) {
    if (p.kind === 'rush' || p.kind === 'go') return null;
    const s = this.setupOf(obs, id, p);
    const spots = this.stageSpots('T', s.site, s.route);
    if (spots.length === 0) return null;
    return spots[this.memberIndex(obs, id, p) % spots.length];
  }

  /** @param {SiteId} site @param {number} idx */
  tRoute(site, idx) {
    const routes = this.intel.routes.T[site];
    return routes.length === 0 ? null : routes[Math.min(idx, routes.length - 1)];
  }

  /**
   * @param {import('./base.js').Observation} obs @param {TacOut} out
   * @returns {import('./utility.js').ThrowWish | null}
   */
  tGoal(obs, out) {
    const me = obs.me;
    const t = obs.tick;
    const b = obs.bomb;
    out.task = me.hasBomb ? 'plant' : 'execute';
    // 下包後：守包（下包者與一人在點內，其餘看回防入口）
    if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) return this.postPlant(obs, out, b.x, b.y, b.site ?? 'A');
    // 炸彈掉了：最近的 T 去撿
    if (b.state === 'dropped' && b.x !== null && b.y !== null) {
      const bx = b.x;
      const by = b.y;
      const myD = dist(me.x, me.y, bx, by);
      const retriever = this.judge?.retriever(obs, bx, by);
      if (retriever !== undefined ? retriever === me.id : !obs.teammates.some((m) => m.alive && dist(m.x, m.y, bx, by) < myD)) {
        out.goal = { x: bx, y: by };
        out.role = '撿炸彈';
        out.task = 'retrieve';
        return null;
      }
    }
    const p = this.plan !== null && this.plan.kind !== 'hold' ? this.plan : null;
    if (p === null) return null;
    // 剩 P.forceExecLeft 秒還沒執行（指揮沒喊）：自己也照最近的點執行
    let exec = p.exec;
    if (exec === null && obs.round.phase === 'live' && obs.round.phaseTicksLeft <= (P.forceExecLeft - 3) * this.tps) exec = this.nearestSite(obs);
    const setup = this.setupOf(obs, me.id, p);
    // 出生區裡先讓突破手走到前面（慢走讓他超過；出生區空間大，進了路線就是一列，突破手自然在最前）
    this.slow = obs.round.phase === 'live' && p.kind !== 'go' && this.spawnWait(obs, p, exec ?? setup.site);
    if (this.slow && this.spawnHeld <= P.spawnStop * this.tps) {
      out.stop = true;
      this.waitTag = 'spawn';
      out.role = '讓突破手先走';
      return null;
    }
    // 繞後（2.6）：游擊這回合走繞後路線，先在另一點外等；主力喊執行後 P.lurkDelay 秒沿對方輪轉路徑從背後進點
    const lk = this.lurkOf(obs, p);
    if (P.lurkOut && lk !== null && !this.lurkers.has(me.id)) {
      this.lurkers.add(me.id);
      out.cmds.push({ type: 'say', text: 'E:lurk' });
    }
    if (lk !== null && (exec === null || exec === lk.route.site) && !this.inRectSite(me.x, me.y, lk.route.site)) {
      if (exec !== null && this.execTick >= 0 && t - this.execTick >= P.lurkDelay * this.tps) {
        const s = this.intel.sites[lk.route.site];
        out.route = lk.route;
        out.goal = { x: s.cx, y: s.cy };
        out.role = '繞後・進點';
        return null;
      }
      if (lk.stage !== null) {
        out.route = lk.wait;
        out.goal = { x: lk.stage.x, y: lk.stage.y };
        out.hold = lk.stage;
        out.role = '繞後';
        if (dist(me.x, me.y, lk.stage.x, lk.stage.y) < 10 * UNIT) out.walk = true;
        return null;
      }
    }
    if (exec === null) {
      // ── 佈置：走自己組的路線到待命格，看入口；靠近了靜步 ──
      const st = this.memberStage(obs, me.id, p);
      out.route = this.pickRoute(obs, setup.site, setup.route);
      if (st === null) return null;
      out.goal = { x: st.x, y: st.y };
      out.hold = st;
      const d = dist(me.x, me.y, st.x, st.y);
      out.role = p.kind === 'fake' && this.groupOf(obs, me.id, p) === 1 ? '佯攻' : '待命';
      if (out.role === '佯攻') {
        if (obs.enemies.length > 0 || this.heat(obs)[setup.site] >= 2) this.fakeProbe = false;
        else if (this.stageArrive >= 0 && t - this.stageArrive >= 1.5 * this.tps) this.fakeProbe = true;
        if (this.fakeProbe) {
          const e = this.entranceOf(setup.site, setup.route);
          if (e !== null) {
            out.goal = this.intel.sites[setup.site].plants[0]; out.hold = null; out.role = '佯攻試探';
            out.walk = true; out.look = { x: e.ix, y: e.iy };
            return null;
          }
        }
      }
      this.awpSettle(obs, out, st);
      if (d < 10 * UNIT && this.attrs.movement >= 0.3) out.walk = true;
      // 2.8（P.qPause）：個人熟練度低，佈置途中偶爾停半秒（只在去待命格的路上、沒看到也沒聽到敵人、站在有掩護的格；個人＋回合＋時間的確定性雜湊）
      const lowP = this.pLow();
      if (lowP > 0 && d > 3 * UNIT && obs.enemies.length === 0 && (this.perc.lastSound === null || t - this.perc.lastSound.tick > 2 * this.tps)) {
        const c = this.g.cellOf(me.x, me.y);
        if (c >= 0 && this.intel.cover[c] > 0 && rollOf(obs.round.number * 16 + me.id, Math.floor(t / (this.tps / 2))) % 1000 < lowP * P.qPause * 1000) {
          out.stop = true;
          this.waitTag = 'qpause';
          out.role = '跟上隊形';
        }
      }
      // 佯攻：到了待命格就開幾槍、丟道具進點製造聲音
      if (out.role === '佯攻' && d < 2.5 * UNIT) {
        if (this.noiseLeft === 0 && this.stageArrive < 0) {
          this.stageArrive = t;
          this.noiseLeft = 4;
        }
        if (this.noiseLeft > 0) {
          this.noiseLeft--;
          out.noise = true;
          out.look = { x: st.fx, y: st.fy };
        }
        const site = this.intel.sites[setup.site];
        const kind = this.pickFor(me, ['he', 'flash', 'molotov'], ['fakeUtil', 'free']);
        if (kind !== null && kind !== 'flash') return this.fired('fakeUtil', ['fakeUtil', 'free'], { kind, x: site.cx, y: site.cy, why: '佯攻' });
      }
      return null;
    }
    // 2.8（P.qLag）：個人熟練度低，收到執行後晚一點出發（max(0, 0.5−p) × qLag 秒；p ≥ 0.5 時不等，同 2.7）
    const lag = this.pLow() * P.qLag * this.tps;
    if (lag > 0 && p.kind !== 'go' && this.execTick >= 0 && t - this.execTick < lag && obs.enemies.length === 0 && !this.inRectSite(me.x, me.y, exec)) {
      out.stop = true;
      this.waitTag = 'qlag';
      out.role = '跟上';
      return null;
    }
    // 2.8（P.qSyncLag）：split 隊伍執行熟練度低，離入口遠的那組還晚出發（(0.5−q) × qSyncLag 秒，兩組各打各的）；q ≥ 0.5 同 2.7
    const qgs = this.qGap();
    if (p.kind === 'split' && qgs > 0 && this.execTick >= 0 && obs.enemies.length === 0 && !this.inRectSite(me.x, me.y, exec)) {
      if (this.syncAt !== this.execTick) {
        this.syncAt = this.execTick;
        this.syncWait = this.splitBehind(obs, p, exec) ? qgs * P.qSyncLag : 0;
      }
      if (t - this.execTick < this.syncWait * this.tps) {
        out.stop = true;
        this.waitTag = 'qsync';
        out.role = '慢了一步';
        return null;
      }
    }
    // 2.8（P.qFlashLate）：隊伍執行熟練度低，隊友的閃光炸開後慢半拍才跟進（(0.5−q) × qFlashLate 秒）；q ≥ 0.5 同 2.7
    if (qgs > 0 && p.kind !== 'go' && t >= this.flashPop && t - this.flashPop < qgs * P.qFlashLate * this.tps && obs.enemies.length === 0 && !this.inRectSite(me.x, me.y, exec)) {
      out.stop = true;
      this.waitTag = 'qflash';
      out.role = '慢半拍';
      return null;
    }
    // ── 執行（go 是 6-1 的直接進點：照常探頭）──
    if (p.kind !== 'go') {
      out.allowPeek = false;
      out.walk = false;
    }
    const site = this.intel.sites[exec];
    const mine = setup.site === exec;
    out.route = mine ? this.pickRoute(obs, exec, setup.route) : null;
    const flank = this.flankOf(p, exec);
    // 兩路進點：待命格那組等第二組就位；點外那組先繞到第二入口外
    if (flank !== null && mine && this.flankHold(obs, p, exec, flank)) {
      const st = this.memberStage(obs, me.id, p);
      if (st !== null) {
        this.execTick = t;
        out.goal = { x: st.x, y: st.y };
        out.hold = st;
        out.role = '等第二組';
        this.awpSettle(obs, out, st);
        return null;
      }
    }
    const ent = mine ? this.entranceOf(exec, setup.route) : flank?.second ?? null;
    this.planEnt = ent;
    if (flank !== null && !mine && !this.flanked) {
      if (dist(me.x, me.y, flank.second.ox, flank.second.oy) < 3 * UNIT || this.inRectSite(me.x, me.y, exec)) this.flanked = true;
      else {
        out.goal = { x: flank.second.ox, y: flank.second.oy };
        out.route = this.aroundSite(exec);
        out.role = `繞第二入口 ${exec}`;
        return null;
      }
    }
    // 進點前的道具：支援先煙、突破手（組內第 0 個）再閃，2.5 秒還沒人閃就誰有誰閃；其他人等閃光（最多 3 秒）
    /** @type {import('./utility.js').ThrowWish | null} */
    let wish = null;
    const sinceExec = this.execTick >= 0 ? (t - this.execTick) / this.tps : 99;
    if (ent !== null && !this.inSite(me.x, me.y, exec, site.cx, site.cy) && dist(me.x, me.y, ent.ox, ent.oy) < 22 * UNIT) {
      const idx = this.memberIndex(obs, me.id, p);
      const role = this.roles.of(me.id);
      const smokeFirst = p.kind !== 'rush' && p.kind !== 'go';
      // 閃光的時機看組裡最前面的人：快到入口才丟，丟的人排第二（突破手不用停下來）
      // 2.8（P.qFlash）：隊伍執行熟練度低，前面的人還遠就丟（炸開後很久才進點）；q ≥ 0.5 同 2.7
      // 3.0：資源層有計畫時，閃光綁跟進者（組裡最前面的人）到入口外點 N 格：N＝routeSpeed ×（引信＋反應）＋1，炸開時他剛好在入口外
      const act = P.resLayer && this.res.active;
      const leadN = act ? P.routeSpeed * ((this.util.fuse.get('flash') ?? 45) + this.data.rules.reactionTicks) / this.tps + 1 : P.flashLead;
      const cue = this.leadDist(obs, p, ent) < leadN * (1 + P.qFlash * Math.max(0, this.qGap())) * UNIT;
      if (!cue) this.flashCue = -1;
      else if (this.flashCue < 0) this.flashCue = t;
      // 2.6：時間到了依組內順序每人錯開 P.flashStagger 秒接手（前一個人宣告了後面的人才聽得到）；
      // 2.5 是時間到誰有誰丟，同一個決策窗口幾個人一起丟
      const size = Math.max(1, this.groupSize(obs, p));
      const first = Math.min(1, size - 1);
      const since = this.flashCue >= 0 ? t - this.flashCue : -1;
      let flashTurn;
      // 3.0：擁有這個入口的 entryFlash 項目就是自己的回合（第二顆由 flashNext 控制間隔）
      // （審查 (a)）跟進者到觸發距離時，擁有者離入口超過 2N：這筆提早轉自由使用（各副本看公開位置，同條件）
      // （審查 (a)）擁有者離入口太遠時提早轉自由：r7k 起由指揮者在 resStep 判定、喊 U:f，各副本只讀（協定原則：指揮者寫、所有副本讀）
      const planned = act && this.can(me, 'flash', ['entryFlash']);
      // 計畫外的閃（審查 (a)）：計畫的 entryFlash 用完或沒人拿時照 2.8 的順序規則丟；這個入口已經有閃丟出時當第二顆（間隔由 flashNext 控）
      // （r7k）只看同一個入口的計畫閃：split 另一組入口的計畫閃不擋這組的自由閃
      const entIdx = this.intel.sites[exec].entrances.indexOf(ent);
      const plannedLeft = act && this.res.items.some((it) => it.purpose === 'entryFlash' && it.state === 'plan' && this.isAlive(obs, it.owner) && it.owner !== me.id && (it.target.site !== exec || it.target.ent < 0 || it.target.ent === entIdx));
      const thrownHere = this.flashSpots.some((f) => this.flashOf(ent, f));
      const myFlash = planned || (act && (!plannedLeft || thrownHere) && this.can(me, 'flash', ['free']));
      if (planned) flashTurn = true;
      else if (P.flashClaim) {
        const order = (idx - first + size) % size;
        flashTurn = order === 0 || (since >= 0 && since > (P.flashTurn + (order - 1) * P.flashStagger) * this.tps);
      } else flashTurn = idx === first || (since >= 0 && since > P.flashTurn * this.tps);
      const gs = Math.max(1, this.groupSize(obs, p));
      const next = this.flashNext(obs, ent, p.kind === 'rush', (idx - Math.min(1, gs - 1) + gs) % gs);
      const st = this.memberStage(obs, me.id, p);
      const near = st !== null && dist(me.x, me.y, st.x, st.y) < 6 * UNIT;
      // 第一顆煙給支援丟：支援活著、還沒人丟煙、執行不到 8 秒時，其他人先不丟
      const supportFirst = role !== SUPPORT && this.isAlive(obs, this.roles.who(SUPPORT)) && this.smokeHeard < 0 && sinceExec < 8;
      // 2.6.3：入口被燒住（還要燒 2 秒以上、我方還沒丟煙在上面）：煙霧手先丟煙滅火（煙和火重疊整團火熄滅）
      // 火在計畫入口旁，或擋在自己往包點的路上（20 格內；實際走的入口可能不是計畫的那個）
      const onWay = (/** @type {{ x: number, y: number, radius: number }} */ q) => Math.min(dist(q.x, q.y, ent.ox, ent.oy), dist(q.x, q.y, ent.ix, ent.iy)) < q.radius + 3 * UNIT || (dist(me.x, me.y, q.x, q.y) < 20 * UNIT && segDist(q.x, q.y, me.x, me.y, site.cx, site.cy).d < q.radius + 2 * UNIT);
      const burning = P.smokeFire ? obs.effects.find((q) => q.kind === 'fire' && q.ticksLeft > 2 * this.tps && onWay(q) && this.smokes.every((m) => dist(m.x, m.y, q.x, q.y) > q.radius + 2 * UNIT)) : undefined;
      // 煙霧手丟（或他離火超過投擲距離時，組裡離火最近的人丟；看不到隊友身上有沒有煙，沒有就沒人丟）
      const reach = this.data.rules.grenadeRules.maxThrowRange * UNIT;
      const gid = this.groupOf(obs, me.id, p);
      const smokerId = this.ids.find((x) => this.isAlive(obs, x) && this.inGroup(obs, x, p, gid) && this.memberIndex(obs, x, p) === this.smokerIndex(obs, me.id, p));
      const sm = smokerId === undefined ? undefined : smokerId === me.id ? me : obs.teammates.find((m) => m.id === smokerId);
      const closest = burning === undefined ? -1 : [me, ...obs.teammates.filter((m) => m.alive && this.inGroup(obs, m.id, p, gid))].sort((a, b) => dist(a.x, a.y, burning.x, burning.y) - dist(b.x, b.y, burning.x, burning.y) || a.id - b.id)[0].id;
      // 3.0：滅火先找 fireBackup 的擁有者；沒有（用掉、作廢）才由封架點的煙或 free 的煙補
      const backup = act && burning !== undefined && this.can(me, 'smoke', ['fireBackup']);
      const noBackup = act && !this.res.items.some((it) => it.purpose === 'fireBackup' && it.state === 'plan' && this.isAlive(obs, it.owner));
      const mine = burning !== undefined && (backup || ((!act || noBackup) && (idx === this.smokerIndex(obs, me.id, p) || ((sm === undefined || dist(sm.x, sm.y, burning.x, burning.y) > reach) && closest === me.id))));
      // 3.0 效用層影子模式：三種進點道具的時機（落點、丟得到與否由效用層自己算）
      if (burning !== undefined && mine) this.hint('fireBackup', 'smoke', backup ? ['fireBackup'] : ['entrySmoke', 'holdSmoke', 'free']);
      if (smokeFirst && !supportFirst) this.hint('entrySmoke', 'smoke', act ? ['entrySmoke', 'holdSmoke'] : idx === this.smokerIndex(obs, me.id, p) ? ['free'] : []);
      if (cue && flashTurn && next.ok && (!smokeFirst || this.smokeHeard >= 0 || this.util.used.has('smoke') || sinceExec > (this.isAlive(obs, this.roles.who(SUPPORT)) ? 4 : 1.5))) this.hint('entryFlash', 'flash', act ? (planned ? ['entryFlash'] : myFlash ? ['free'] : []) : ['free']);
      if (burning !== undefined && mine && (backup || this.can(me, 'smoke', ['entrySmoke', 'holdSmoke', 'free'])) && this.util.solve(me.x, me.y, burning.x, burning.y) !== null) {
        wish = { kind: 'smoke', x: burning.x, y: burning.y, why: '煙滅火' };
      } else if (smokeFirst && (act ? this.can(me, 'smoke', ['entrySmoke', 'holdSmoke']) : this.util.has(me, 'smoke') && idx === this.smokerIndex(obs, me.id, p))) {
        // 封架點；從這裡丟不到就改封入口內側
        const sp = supportFirst ? null : this.smokeTarget(obs, p, exec, ent);
        if (sp !== null) wish = { kind: 'smoke', x: sp.x, y: sp.y, why: '封架點' };
      } else if ((act ? myFlash : this.util.has(me, 'flash')) && cue && flashTurn && next.ok && (!smokeFirst || this.smokeHeard >= 0 || this.util.used.has('smoke') || sinceExec > (this.isAlive(obs, this.roles.who(SUPPORT)) ? 4 : 1.5))) {
        // 第二顆炸開時隊友多半已經往裡衝：不算「隊友躲得掉」
        let fp = this.flashPoint(obs, exec, ent, smokeFirst && !next.second ? 2 : 5, next.avoid, act ? ent : null);
        if (act) this.flashGiveUp(obs, out, fp === null);
        // 3.0：沒有情報（爆點附近沒有記得的敵人、這個點 5 秒內沒人喊接觸）就先不閃：無情報的進點閃幾乎都閃到 0 人；留著到期轉 free，見到人再用
        if (act && fp !== null && P.flashNeedInfo && !this.flashInfo(obs, fp, exec)) fp = null;
        // 照計畫執行（隊友在待命格等）照例先閃；其他時候（rush）要可能有人看得到爆點才丟
        if (fp !== null && (smokeFirst || this.viewer(fp, exec))) wish = { kind: 'flash', x: fp.x, y: fp.y, why: '閃進點' };
      }
      // 待命格丟不到（轉角後面）：往入口走到丟得到為止，別帶著道具直接進點
      const smoker = smokeFirst && (act ? this.can(me, 'smoke', ['entrySmoke', 'holdSmoke']) : this.util.has(me, 'smoke') && idx === this.smokerIndex(obs, me.id, p) && !supportFirst);
      if (wish === null && smoker && sinceExec < 7 && dist(me.x, me.y, ent.ox, ent.oy) > 3 * UNIT) {
        out.goal = { x: ent.ox, y: ent.oy };
        out.walk = true;
        out.role = '找丟道具的位置';
        return null;
      }
      // 等閃光：還在待命格附近、閃光還沒丟、執行不到 3 秒
      // 閃光：照到入口的路程提前出發，炸開時人剛好到
      const travel = (dist(me.x, me.y, ent.ox, ent.oy) / UNIT / P.routeSpeed) * this.tps;
      const pending = this.mateFlash.some((x) => t <= x.pop - travel);
      // 待命位離入口遠就不等閃光（閃光改到入口附近才丟）
      const flashHere = st !== null && dist(st.x, st.y, ent.ox, ent.oy) < P.flashLead * UNIT;
      // 站在待命格就丟得到：留下來等前面的人走到位再丟（掩護突破手）
      const cover = smokeFirst && near && wish === null && !cue && flashTurn && idx > 0 && sinceExec < P.stageLead + 3 && next.ok && (act ? myFlash : this.util.has(me, 'flash')) && this.flashPoint(obs, exec, ent, 2, next.avoid, act ? ent : null) !== null;
      const waiting = cover || (smokeFirst && near && wish === null && (pending || (flashHere && sinceExec < 3 && this.flashHeard < 0 && !this.util.used.has('flash'))));
      // 等突破手先走（狙擊手等兩個人進點）：執行後最多 P.stageLead 秒
      // 3.0（r7k，T4 死結）：持有這個入口還沒丟的計畫進點閃的人不等突破手先走，先到投擲位（突破手等的是閃光出手）
      this.flashOwner = planned && !thrownHere;
      const lead = smokeFirst && near && wish === null && sinceExec < P.stageLead && !this.flashOwner && this.waitEntry(obs, exec);
      // 正在準備丟煙／閃的人也留在待命格（最多到執行後 4 秒，丟不出去就照樣進）
      if ((waiting || lead || (smokeFirst && near && wish !== null && sinceExec < 4)) && st !== null) {
        out.goal = { x: st.x, y: st.y };
        out.hold = st;
        out.role = wish !== null ? '丟道具' : lead && !waiting ? '等突破手先走' : '等閃光';
        this.awpSettle(obs, out, st);
        return wish;
      }
    }
    out.role = `執行 ${exec}`;
    // 閃光剛炸開：直接衝，不讓位也不拉間距（對面最多瞎 2 秒）
    const flashed = t >= this.flashPop && t < this.flashPop + 2 * this.tps;
    // 狙擊手不跟著衝（2.6.1：閃光一炸開就先進點，R2 的反例）
    if (p.kind !== 'go' && (!flashed || this.roles.of(me.id) === AWP) && !this.flashOwner && this.yieldTo(obs, exec)) {
      out.stop = true;
      this.waitTag = 'yield';
      out.look = { x: site.cx, y: site.cy };
      out.role = this.roles.of(me.id) === AWP ? '等隊友先進' : '等突破手先進';
      const st = this.memberStage(obs, me.id, p);
      if (this.roles.of(me.id) === AWP && st !== null) out.hold = { ...st, x: me.x, y: me.y };
      return wish;
    }
    // 進場間距：前一個人還沒拉開就等一下，不排成一條線給對面掃
    if (p.kind !== 'go' && !flashed && ent !== null && obs.enemies.length === 0 && this.tooClose(obs, exec, ent)) {
      out.walk = true;
      out.role = '拉開間距';
    }
    // rush 先通過共同入口再分配各自的下包／守位；路線偏好本身不能保證入口一致。
    if (p.kind === 'rush' && ent !== null && !this.rushReady) {
      if (this.inRectSite(me.x, me.y, exec) || dist(me.x, me.y, ent.ix, ent.iy) < 900) this.rushReady = true;
      else {
        out.goal = dist(me.x, me.y, ent.ox, ent.oy) > 2 * UNIT ? { x: ent.ox, y: ent.oy } : { x: ent.ix, y: ent.iy };
        return wish;
      }
    }
    if (me.hasBomb) {
      const spot = site.plants[0];
      out.goal = { x: spot.x, y: spot.y };
      out.role = '持彈';
      out.task = 'plant';
      const cx = Math.floor(me.x / UNIT);
      const cy = Math.floor(me.y / UNIT);
      const r = site.rect;
      const inside = inRect({ x0: r.x0 + 1, y0: r.y0 + 1, x1: r.x1 - 1, y1: r.y1 - 1 }, cx, cy);
      const atSpot = dist(me.x, me.y, spot.x, spot.y) < 1500;
      const hurry = obs.round.phaseTicksLeft < 20 * this.tps;
      if (obs.round.phase === 'live' && inside && (atSpot || hurry) && (!P.plantRequireClear || obs.enemies.length === 0) && me.plantTicks === 0) {
        out.cmds.push({ type: 'plant' });
        out.objective = true;
      }
      return wish;
    }
    const k = this.rank(obs, (id) => id !== this.carrierId(obs));
    const holds = this.postSpots(exec, site.cx, site.cy);
    const spot = holds.length > 0 ? holds[k % holds.length] : site.plants[0];
    // 突破手先踩進包點（守位可能在矩形外，別人在等他進點）
    if (this.roles.of(me.id) === ENTRY && !this.inRectSite(me.x, me.y, exec) && !this.steppedIn) {
      out.goal = { x: site.cx, y: site.cy };
      return wish;
    }
    this.steppedIn = true;
    out.goal = { x: spot.x, y: spot.y };
    out.hold = spot;
    return wish;
  }

  /**
   * 入口外 P.entryZone 格內，前面最近的隊友領先不到 P.entryGap 格：該等。每回合累計最多 P.entryWaitMax 秒（別卡死）
   * @param {import('./base.js').Observation} obs @param {SiteId} exec @param {import('./analysis.js').Entrance} ent
   */
  tooClose(obs, exec, ent) {
    const me = obs.me;
    if (this.roles.of(me.id) === ENTRY || this.queueHeld >= P.entryWaitMax * this.tps || this.inRectSite(me.x, me.y, exec)) return false;
    const mine = dist(me.x, me.y, ent.ix, ent.iy);
    if (mine > P.entryZone * UNIT) return false;
    // 突破手還在我後面就不放慢（窄處會擋住他）
    const entry = obs.teammates.find((m) => m.alive && m.id === this.roles.who(ENTRY));
    if (entry !== undefined && !this.inRectSite(entry.x, entry.y, exec) && dist(entry.x, entry.y, ent.ix, ent.iy) > mine) return false;
    const held = obs.teammates.some((m) => m.alive && !this.inRectSite(m.x, m.y, exec) && dist(m.x, m.y, me.x, me.y) < P.entryGap * UNIT && dist(m.x, m.y, ent.ix, ent.iy) < mine);
    if (held) this.queueHeld += this.data.rules.decisionInterval;
    return held;
  }

  /**
   * 這個入口已經有我方閃光了：丟過、喊過、隊友宣告要丟（認領 P.flashClaimSec 秒內）、或看得到飛行中的閃光（2.6 起）。
   * 爆點離入口內側 12 格內，或 P.flashDeep + 4 格內而且這是最近的入口，都算這個入口的
   * @param {import('./base.js').Observation} obs @param {import('./analysis.js').Entrance} ent
   */
  flashDone(obs, ent) {
    /** @param {import('./base.js').Pt} f */
    const at = (f) => this.flashOf(ent, f);
    return this.flashSpots.some(at) || (P.flashClaim && (this.flashClaims.some((c) => obs.tick <= c.until && at(c)) || obs.projectiles.some((q) => q.kind === 'flash' && at(q))));
  }

  /** 這個爆點算這個入口的閃光：離入口內側 12 格內，或 P.flashDeep + 4 格內而且這是最近的入口 @param {import('./analysis.js').Entrance} ent @param {import('./base.js').Pt} f */
  flashOf(ent, f) {
    const d = dist(f.x, f.y, ent.ix, ent.iy);
    if (d < 12 * UNIT) return true;
    if (!P.flashClaim || d >= (P.flashDeep + 4) * UNIT) return false;
    return SITES.every((s) => this.intel.sites[s].entrances.every((e) => dist(f.x, f.y, e.ix, e.iy) >= d));
  }

  /**
   * 進點閃能不能再丟一顆（2.6.1 有效連閃）：這個入口還沒有我方閃光、也沒人宣告就可以；已經確定丟出一顆、沒有別人宣告、過了 P.flashSecondAfter 秒、
   * 還在第一顆後 P.flashSecondWin 秒內，可以丟第二顆——rush 不限位置，其他要離第一顆 P.flashSecondGap 格以上（avoid）。兩顆以上就不再丟
   * 第二顆也依組內順序 order 錯開 P.flashStagger 秒（同時符合條件的人不會一起丟）
   * @param {import('./base.js').Observation} obs @param {import('./analysis.js').Entrance} ent @param {boolean} rush @param {number} order
   * @returns {{ ok: boolean, avoid: import('./base.js').Pt | null, second: boolean }}
   */
  flashNext(obs, ent, rush, order) {
    const t = obs.tick;
    /** @type {{ x: number, y: number, tick: number }[]} */
    const list = [];
    /** @param {number} x @param {number} y @param {number} tick */
    const add = (x, y, tick) => {
      if (!this.flashOf(ent, { x, y })) return;
      const o = list.find((q) => dist(q.x, q.y, x, y) < 3 * UNIT);
      if (o === undefined) list.push({ x, y, tick });
      else o.tick = Math.min(o.tick, tick);
    };
    // 確定丟出的（丟過、喊了 E:flash、看得到飛行中）；只宣告還沒丟的另外算：有人宣告中就不再丟（第二顆要等第一顆真的出手）
    /** @type {boolean} */
    let claimed;
    if (P.flashIdent) {
      // 2.7：每次投擲（投擲者＋爆炸時間）各算一顆，不用距離合併；看到的拋體不知道是誰丟的，只補「比已知還在飛的多出來的」
      const mine = this.flashSpots.filter((f) => this.flashOf(ent, f));
      for (const f of mine) list.push({ x: f.x, y: f.y, tick: f.tick });
      list.sort((a, b) => a.tick - b.tick);
      const flying = P.flashClaim ? obs.projectiles.filter((q) => q.kind === 'flash' && this.flashOf(ent, q)) : [];
      const known = mine.filter((f) => f.pop > t).length;
      for (const q of flying.slice(known)) list.push({ x: q.x, y: q.y, tick: t });
      // 宣告的人之後丟出來了就不算還在宣告（落點和宣告可以不同）
      claimed = P.flashClaim && this.flashClaims.some((c) => t <= c.until && this.flashOf(ent, c) && !this.flashSpots.some((f) => f.by === c.by && f.tick >= c.at));
    } else {
      for (const f of this.flashSpots) add(f.x, f.y, f.tick);
      if (P.flashClaim) for (const q of obs.projectiles) if (q.kind === 'flash') add(q.x, q.y, t);
      claimed = P.flashClaim && this.flashClaims.some((c) => t <= c.until && this.flashOf(ent, c) && list.every((q) => dist(q.x, q.y, c.x, c.y) > 3 * UNIT));
    }
    if (claimed) return { ok: false, avoid: null, second: false };
    if (list.length === 0) return { ok: true, avoid: null, second: false };
    if (!P.flashClaim || !P.flashSecond || list.length >= 2) return { ok: false, avoid: null, second: false };
    const first = list[0];
    const age = t - first.tick;
    if (age < (P.flashSecondAfter + order * P.flashStagger) * this.tps || age > P.flashSecondWin * this.tps) return { ok: false, avoid: null, second: false };
    return { ok: true, avoid: rush ? null : { x: first.x, y: first.y }, second: true };
  }

  /** 這一點附近 3 秒內有我方閃光（丟過、認領、飛行中）：回防閃、閃槍線用 @param {import('./base.js').Observation} obs @param {import('./base.js').Pt} c */
  flashTaken(obs, c) {
    if (!P.flashClaim) return false;
    const r = 8 * UNIT;
    return this.flashSpots.some((f) => obs.tick - f.tick <= 3 * this.tps && dist(f.x, f.y, c.x, c.y) < r) || this.flashClaims.some((f) => obs.tick <= f.until && dist(f.x, f.y, c.x, c.y) < r) || obs.projectiles.some((q) => q.kind === 'flash' && dist(q.x, q.y, c.x, c.y) < r);
  }

  /** @param {import('./base.js').Observation} obs @param {TPlan} p */
  groupSize(obs, p) {
    const gid = this.groupOf(obs, obs.me.id, p);
    return this.alive(obs).filter((m) => this.inGroup(obs, m.id, p, gid)).length;
  }

  /** 組裡最前面的人離入口外側多遠 @param {import('./base.js').Observation} obs @param {TPlan} p @param {import('./analysis.js').Entrance} ent */
  leadDist(obs, p, ent) {
    const gid = this.groupOf(obs, obs.me.id, p);
    let best = Infinity;
    for (const m of this.alive(obs)) if (this.inGroup(obs, m.id, p, gid)) best = Math.min(best, dist(m.x, m.y, ent.ox, ent.oy));
    return best;
  }

  /** 煙霧手：組內的支援優先，其次錨點、游擊…（同角色看隊內序號） @param {import('./base.js').Observation} obs @param {number} id @param {TPlan} p */
  smokerIndex(obs, id, p) {
    const gid = this.groupOf(obs, id, p);
    const members = this.ids.filter((x) => this.inGroup(obs, x, p, gid) && obs.teammates.every((m) => m.id !== x || m.alive));
    for (const r of SMOKE_PREF) {
      const who = members.find((x) => this.roles.of(x) === r);
      if (who !== undefined) return this.memberIndex(obs, who, p);
    }
    return -1;
  }

  /**
   * 兩路進點：default／fake 執行時，待命格在執行點的那組走路線的入口，另一組走離自己待命格最近的另一個入口；其他計畫（已經兩路或全隊一路）回傳 null
   * @param {TPlan} p @param {SiteId} exec @returns {{ near: number, main: import('./analysis.js').Entrance, second: import('./analysis.js').Entrance, wait: number } | null}
   */
  flankOf(p, exec) {
    if (p.kind !== 'default' && p.kind !== 'fake') return null;
    const key = `flank${p.site}${exec}${p.r1}${p.r2}`;
    const hit = this.flankCache.get(key);
    if (hit !== undefined) return hit;
    const near = exec === p.site ? 0 : 1;
    const main = this.entranceOf(exec, near === 0 ? p.r1 : p.r2);
    const farSite = near === 0 ? other(p.site) : p.site;
    const farRoute = near === 0 ? p.r2 : p.r1;
    const from = this.stageSpots('T', farSite, farRoute)[0];
    let out = null;
    if (main !== null && from !== undefined) {
      let best = Infinity;
      for (const e of this.intel.sites[exec].entrances) {
        if (e.portal === main.portal) continue;
        const d = dijkstra(this.g, [this.g.cellOf(e.ox, e.oy)])[from.cell];
        // 離主力入口太近的（同一片走道的兩個口）不算第二路，排到最後
        const sc = d + (dist(e.ox, e.oy, main.ox, main.oy) < 10 * UNIT ? 100000 : 0);
        if (sc < best) {
          best = sc;
          out = { near, main, second: e, wait: Math.min(P.flankWait, d / 10 / 4.5) };
        }
      }
    }
    this.flankCache.set(key, out);
    return out;
  }

  /**
   * 這回合要不要繞後（2.6，每回合依計畫決定一次）：default／fake、我是游擊、還有 4 人以上、不是 eco、有繞後路線，
   * 機率 P.lurkProb ×（0.6～1.4 依侵略）。wait＝走到另一點外為止的那段（路線不經過另一點就是整條），stage＝等的位置
   * @param {import('./base.js').Observation} obs @param {TPlan} p
   * @returns {{ route: import('./analysis.js').Route, wait: import('./analysis.js').Route, stage: import('./analysis.js').Spot | null } | null}
   */
  lurkOf(obs, p) {
    // 2.7：人數每次都查（決定有快取，原本人數變少也照繞）
    if (P.lurkOut && this.alive(obs).length < 4) return null;
    const key = `${p.kind}${p.site}`;
    if (this.lurkKey === key) return this.lurkPick;
    this.lurkKey = key;
    this.lurkPick = null;
    const route = this.intel.lurk[p.site];
    const call = this.buyCall ?? this.econ.call;
    if (route === null || (p.kind !== 'default' && p.kind !== 'fake') || this.roles.of(obs.me.id) !== LURK || this.alive(obs).length < 4 || call === 'eco') return null;
    if (rollOf(obs.round.number, 13) % 100 >= 100 * P.lurkProb * (0.6 + 0.8 * this.attrs.aggression)) return null;
    const far = this.intel.sites[other(p.site)];
    const k = route.regions.findIndex((r) => far.regions.has(r));
    /** @type {import('./analysis.js').Route} */
    const wait = k > 0 ? { ...route, site: far.id, regions: route.regions.slice(0, k + 1), regionSet: new Set(route.regions.slice(0, k + 1)), portals: route.portals.slice(0, k), points: [...route.points.slice(0, k), { x: far.cx, y: far.cy }] } : route;
    const stage = this.stageSpots('T', wait.site, -1, wait)[0] ?? null;
    this.lurkPick = { route, wait, stage };
    return this.lurkPick;
  }

  /** 待命格那組還要不要等：第二組還有人活著、都還沒到第二入口附近、沒逾時、回合時間還夠 @param {import('./base.js').Observation} obs @param {TPlan} p @param {SiteId} exec @param {{ near: number, main: import('./analysis.js').Entrance, second: import('./analysis.js').Entrance, wait: number }} f */
  flankHold(obs, p, exec, f) {
    if (this.flankStart < 0) this.flankStart = obs.tick;
    if ((obs.tick - this.flankStart) / this.tps >= f.wait || obs.round.phaseTicksLeft <= P.forceExecLeft * this.tps || this.flankGo) return false;
    const far = obs.teammates.filter((m) => m.alive && this.groupOf(obs, m.id, p) !== f.near && !this.lurking(obs, m.id));
    // 2.8（P.qSync）：隊伍執行熟練度低，第二組「到了」的判定鬆（待命格那組先衝、各打各的）；q ≥ 0.5 同 2.7
    const near = P.flankNear * (1 + P.qSync * Math.max(0, this.qGap()));
    const done = far.length === 0 || far.some((m) => dist(m.x, m.y, f.second.ox, f.second.oy) < near * UNIT || this.inRectSite(m.x, m.y, exec));
    if (done) this.flankGo = true;
    return !done;
  }

  /** 繞路用的「路線」：包點區域以外都算路線內，導航就不會穿過包點 @param {SiteId} s @returns {import('./analysis.js').Route} */
  aroundSite(s) {
    let r = this.aroundCache.get(s);
    if (r === undefined) {
      const site = this.intel.sites[s];
      const regionSet = new Set(this.intel.map.regions.map((_, i) => i).filter((i) => !site.regions.has(i)));
      r = /** @type {import('./analysis.js').Route} */ ({ site: s, team: 'T', regions: [...regionSet], regionSet, portals: [], points: [], length: 0 });
      this.aroundCache.set(s, r);
    }
    return r;
  }

  /** 在包點矩形裡 @param {number} x @param {number} y @param {SiteId} s */
  inRectSite(x, y, s) {
    return inRect(this.intel.sites[s].rect, Math.floor(x / UNIT), Math.floor(y / UNIT));
  }

  /**
   * 進點順序：突破手先進——不是突破手的人離包點 P.yieldNear 格內、突破手還沒進點而且沒有明顯在前面，就停住等；
   * 狙擊手等到兩個隊友進點才進。每回合最多停 P.yieldMax 秒
   * @param {import('./base.js').Observation} obs @param {SiteId} s
   */
  yieldTo(obs, s) {
    const me = obs.me;
    const c = this.g.cellOf(me.x, me.y);
    const cap = this.plan?.kind === 'rush' ? P.yieldMax : P.yieldMaxSplit;
    if (c < 0 || this.intel.distSite[s][c] > P.yieldNear * 10 || this.yielded >= cap * this.tps) return false;
    const wait = this.waitEntry(obs, s);
    if (wait) this.yielded += this.data.rules.decisionInterval;
    return wait;
  }

  /**
   * 出生區讓位：和突破手同一組（rush 全隊同組）、還在出生區附近（P.spawnLead 格內）、突破手沒有比我靠近目標點 1 格以上 → 先停 P.spawnStop 秒、之後慢走；每回合最多 P.spawnLeadMax 秒
   * @param {import('./base.js').Observation} obs @param {TPlan} p @param {SiteId} s
   */
  spawnWait(obs, p, s) {
    const me = obs.me;
    const e = obs.teammates.find((m) => m.alive && m.id === this.roles.who(ENTRY));
    const c = this.g.cellOf(me.x, me.y);
    if (e === undefined || c < 0 || this.spawnHeld >= P.spawnLeadMax * this.tps || this.intel.distSpawn.T[c] > P.spawnLead * 10) return false;
    if (this.groupOf(obs, e.id, p) !== this.groupOf(obs, me.id, p)) return false;
    const ce = this.g.cellOf(e.x, e.y);
    const dS = this.intel.distSite[s];
    const wait = ce >= 0 && dS[ce] >= dS[c] - 10;
    if (wait) this.spawnHeld += this.data.rules.decisionInterval;
    return wait;
  }

  /** 拿狙擊槍的狙擊手到了待命格 4 格內就站定（守位改成站的地方），讓戰鬥層開鏡架入口 @param {import('./base.js').Observation} obs @param {TacOut} out @param {import('./analysis.js').Spot} st */
  awpSettle(obs, out, st) {
    const me = obs.me;
    if (this.roles.of(me.id) !== AWP || me.loadout.primary !== 'awp' || dist(me.x, me.y, st.x, st.y) >= 4 * UNIT) return;
    out.stop = true;
    this.waitTag = 'awp';
    out.hold = { ...st, x: me.x, y: me.y };
  }

  /** 該不該等：我不是突破手、還沒進點，突破手活著、沒進點、沒有明顯在我前面；狙擊手等到兩個隊友進點 @param {import('./base.js').Observation} obs @param {SiteId} s */
  waitEntry(obs, s) {
    const me = obs.me;
    const role = this.roles.of(me.id);
    const dS = this.intel.distSite[s];
    const c = this.g.cellOf(me.x, me.y);
    if (role === ENTRY || c < 0 || this.inRectSite(me.x, me.y, s)) return false;
    const mates = obs.teammates.filter((m) => m.alive);
    // 進過包點就算（2.6.3：守位可能在矩形外，進去再退出來的人不能讓大家一直等；每個決策在 trackTeam 記）
    /** @param {number} id */
    const went = (id) => this.wentIn.has(`${s}${id}`) || (!P.wentInSite && this.wentIn.has(`${other(s)}${id}`));
    if (role === AWP) return mates.filter((m) => went(m.id)).length < Math.min(2, mates.length);
    const e = mates.find((m) => m.id === this.roles.who(ENTRY));
    const ce = e === undefined ? -1 : this.g.cellOf(e.x, e.y);
    return e !== undefined && ce >= 0 && !went(e.id) && dS[ce] >= dS[c] - 10;
  }

  /**
   * 2.8：split 兩組各自離入口（外側）最近的人估計走幾秒，自己這組比較晚到（或一樣）＝ true
   * @param {import('./base.js').Observation} obs @param {TPlan} p @param {SiteId} exec
   */
  splitBehind(obs, p, exec) {
    const g = this.groupOf(obs, obs.me.id, p);
    const all = [obs.me, ...obs.teammates.filter((m) => m.alive && !this.lurking(obs, m.id))];
    /** @param {number} k */
    const eta = (k) => {
      const e = this.entranceOf(exec, k === 0 ? p.r1 : p.r2);
      const ms = all.filter((m) => this.groupOf(obs, m.id, p) === k);
      if (e === null || ms.length === 0) return null;
      return Math.min(...ms.map((m) => dist(m.x, m.y, e.ox, e.oy))) / UNIT / P.routeSpeed;
    };
    const mine = eta(g), theirs = eta(1 - g);
    return mine !== null && theirs !== null && mine >= theirs;
  }

  /** 路線的包點入口 @param {SiteId} site @param {number} routeIdx */
  entranceOf(site, routeIdx) {
    const r = this.tRoute(site, routeIdx);
    if (r === null) return null;
    const pid = r.portals[r.portals.length - 1];
    return this.intel.sites[site].entrances.find((e) => e.portal === pid) ?? null;
  }

  /**
   * 煙霧落點：入口內側往「最可能架這個入口的位置」P.smokeOff 格（記得的敵人優先，否則包點守點位中看得到入口、最遠的）
   * @param {SiteId} s @param {import('./analysis.js').Entrance} e
   */
  smokePoint(s, e) {
    const g = this.g;
    let best = null;
    let bestS = -Infinity;
    if (this.awp !== null && dist(this.awp.x, this.awp.y, e.ix, e.iy) <= 40 * UNIT && g.los(this.awp.x, this.awp.y, e.ix, e.iy)) {
      best = { x: this.awp.x, y: this.awp.y };
      bestS = Infinity;
    }
    for (const k of this.perc.known.values()) {
      if (k.conf < 50 || dist(k.x, k.y, e.ix, e.iy) > 25 * UNIT || !g.los(k.x, k.y, e.ix, e.iy)) continue;
      const sc = 100 + k.conf;
      if (sc > bestS) {
        bestS = sc;
        best = { x: k.x, y: k.y };
      }
    }
    if (best === null) {
      for (const hs of this.intel.sites[s].holds) {
        const d = dist(hs.x, hs.y, e.ix, e.iy);
        if (d > 25 * UNIT || !g.los(hs.x, hs.y, e.ix, e.iy)) continue;
        if (d > bestS) {
          bestS = d;
          best = { x: hs.x, y: hs.y };
        }
      }
    }
    if (best === null) return null;
    const d = dist(best.x, best.y, e.ix, e.iy);
    const f = Math.min(0.6, (P.smokeOff * UNIT) / Math.max(d, 1));
    return { x: e.ix + (best.x - e.ix) * f, y: e.iy + (best.y - e.iy) * f };
  }

  /** 這個入口可以封的點：包點守點位中看得到入口的，遠的先（最可能架這個入口），最後是入口內側 @param {SiteId} s @param {import('./analysis.js').Entrance} e @returns {import('./base.js').Pt[]} */
  smokeSpots(s, e) {
    const key = `${s}${e.portal}`;
    const hit = this.smokeCache.get(key);
    if (hit !== undefined) return hit;
    /** @type {import('./base.js').Pt[]} */
    const out = [];
    const holds = this.intel.sites[s].holds.filter((h) => dist(h.x, h.y, e.ix, e.iy) <= 25 * UNIT && this.g.los(h.x, h.y, e.ix, e.iy)).sort((a, b) => dist(b.x, b.y, e.ix, e.iy) - dist(a.x, a.y, e.ix, e.iy) || a.cell - b.cell);
    for (const h of holds) {
      const f = Math.min(0.6, (P.smokeOff * UNIT) / Math.max(dist(h.x, h.y, e.ix, e.iy), 1));
      out.push({ x: e.ix + (h.x - e.ix) * f, y: e.iy + (h.y - e.iy) * f });
    }
    out.push({ x: e.ix, y: e.iy });
    this.smokeCache.set(key, out);
    return out;
  }

  /**
   * 這個煙霧手封哪裡：主力組的煙封第一優先的架槍位，第二組的煙封離它 P.smokeGap 格以上的次優先位（只靠地圖算，兩人不用溝通也不會重疊）；
   * 已知的煙 P.smokeGap 格內不丟；主力組記得有敵人就優先封他；丟不到就換下一個，都不行就不丟
   * @param {import('./base.js').Observation} obs @param {TPlan} p @param {SiteId} exec @param {import('./analysis.js').Entrance} ent @returns {import('./base.js').Pt | null}
   */
  smokeTarget(obs, p, exec, ent) {
    const me = obs.me;
    const gap = P.smokeGap * UNIT;
    const rank = this.groupOf(obs, me.id, p) === 0 ? 0 : 1;
    const flank = this.flankOf(p, exec);
    const mine = this.smokeSpots(exec, ent);
    /** 另一組的入口 @type {import('./analysis.js').Entrance | null} */
    let peer = null;
    if (p.kind === 'split') peer = this.entranceOf(exec, rank === 0 ? p.r2 : p.r1);
    else if (flank !== null) peer = ent.portal === flank.main.portal ? flank.second : flank.main;
    const peerSpots = peer !== null ? this.smokeSpots(exec, peer) : [];
    /** @type {import('./base.js').Pt[]} */
    let list;
    if (rank === 0) {
      const second = peerSpots.find((q) => dist(q.x, q.y, mine[0].x, mine[0].y) >= gap);
      const known = this.smokePoint(exec, ent);
      list = [...(known !== null ? [known] : []), ...mine].filter((q) => second === undefined || dist(q.x, q.y, second.x, second.y) >= gap);
    } else {
      const first = peerSpots[0];
      list = mine.filter((q) => first === undefined || dist(q.x, q.y, first.x, first.y) >= gap);
    }
    return list.find((q) => this.smokes.every((m) => dist(m.x, m.y, q.x, q.y) >= gap) && this.util.solve(me.x, me.y, q.x, q.y) !== null) ?? null;
  }

  /**
   * 3.0：can 的純粹版（不記 claimed；效用層的觸發時機與輸入用）
   * @param {import('./base.js').Observation['me']} me @param {import('./base.js').GrenadeId} kind @param {(import('./resources.js').Purpose | 'free')[]} purposes
   */
  may(me, kind, purposes) {
    return this.util.has(me, kind) && (!P.resLayer || this.res.claim(me.id, kind, purposes, me.loadout.grenades.filter((g) => g === kind).length) !== null);
  }

  /**
   * 3.0：下包後封回防入口的分工（隊伍協調，和 postUtility 同一套：有煙的人照 id 排，一人一個入口；效用層當輸入讀，不自己重做）
   * @param {import('./base.js').Observation} obs @param {SiteId} s @returns {import('./analysis.js').Entrance | null}
   */
  postEnt(obs, s) {
    const me = obs.me;
    const entrances = [...this.intel.sites[s].entrances].sort((a, b) => a.ctDist - b.ctDist || a.portal - b.portal);
    const smokers = [...new Set([...this.postSmokers, ...(this.may(me, 'smoke', ['free']) ? [me.id] : [])])].filter((id) => this.isAlive(obs, id)).sort((a, b) => a - b);
    /** @type {import('./analysis.js').Entrance[]} */
    const entries = [];
    for (const q of entrances) if (entries.every((p) => dist(p.ox, p.oy, q.ox, q.oy) >= (P.smokeGap + 2) * UNIT)) entries.push(q);
    return entries[smokers.indexOf(me.id)] ?? null;
  }

  /** 3.0 影子模式：記一筆丟道具觸發（只是紀錄） @param {string} key @param {string} kind @param {string[]} purposes */
  hint(key, kind, purposes) {
    if (purposes.length > 0) this.trig.set(key, { kind, purposes });
  }

  /**
   * 3.0 影子模式：規則成立（含落點）時記觸發，原樣回傳 wish（行為不變）。
   * 第 6 步準備：只剩佯攻用（落點固定是包點中心）；其他規則改在時機成立處記（hint），落點由效用層算
   * @param {string} key @param {string[]} purposes @param {import('./utility.js').ThrowWish} w @returns {import('./utility.js').ThrowWish}
   */
  fired(key, purposes, w) {
    this.hint(key, w.kind, purposes);
    return w;
  }

  /** (x, y) 走 depth 步內有沒有看不到爆點 c 的格（BFS） @param {number} x @param {number} y @param {import('./base.js').Pt} c @param {number} depth */
  canHide(x, y, c, depth) {
    const g = this.g;
    const start = g.cellOf(x, y);
    if (start < 0) return false;
    let frontier = [start];
    const seen = new Set(frontier);
    for (let d = 0; d <= depth; d++) {
      /** @type {number[]} */
      const next = [];
      for (const i of frontier) {
        const q = g.center(i);
        if (!g.los(q.x, q.y, c.x, c.y)) return true;
        const cx = i % g.W;
        const cy = (i - cx) / g.W;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const j = (cy + dy) * g.W + cx + dx;
          if (g.isBlock(cx + dx, cy + dy) || seen.has(j)) continue;
          seen.add(j);
          next.push(j);
        }
      }
      frontier = next;
    }
    return false;
  }

  /**
   * 爆點附近可能有敵人看得到：記得的敵人在閃光範圍內有視線、最近聽到的敵方聲音（扇形）經過爆點附近、
   * 或還有下落不明的敵人而包點有沒清過的守點位看得到爆點；都不是就不丟閃光（免得只閃到自己人）
   * @param {import('./base.js').Pt} p @param {SiteId | null} site
   */
  viewer(p, site) {
    const R = this.util.flashRadius;
    if (this.perc.threats(p.x, p.y, 30).some((k) => dist(k.x, k.y, p.x, p.y) < R && this.g.los(k.x, k.y, p.x, p.y))) return true;
    const heard = this.perc.sectors.some((s) => {
      if (s.conf < 25 || s.kind === 'hurt') return false;
      const r = clamp(dist(s.ox, s.oy, p.x, p.y) / UNIT, s.r0, s.r1) * UNIT;
      return dist(s.ox + cosd(s.dir) * r, s.oy + sind(s.dir) * r, p.x, p.y) < R * 0.6;
    });
    if (heard) return true;
    if (site === null) return false;
    // 還有下落不明的敵人，而且包點有守點位（或深位）看得到爆點、最近沒被我方看過（敵人可能守在那）
    let far = 0;
    for (const k of this.perc.known.values()) if (k.conf >= 30 && dist(k.x, k.y, p.x, p.y) > R * 1.5) far++;
    if (far >= this.enemiesAlive) return false;
    const t = this.perc.lastTick;
    return [...this.intel.sites[site].holds, ...this.deepSpots(site)].some((h) => dist(h.x, h.y, p.x, p.y) < R && !this.perc.cleared(h.cell, t) && this.g.los(h.x, h.y, p.x, p.y));
  }

  /**
   * 閃光爆點：包點區域內、入口內側 8 格內的格，依「看得到它的沒清過的守點位、記得的敵人、聽到聲音的位置」排序（中間隔著我方煙霧的不算），
   * 取第一個從自己的位置丟得到的；排序每回合每個入口算一次
   * @param {import('./base.js').Observation} obs @param {SiteId} s @param {import('./analysis.js').Entrance} e @param {number} ratio
   * @param {import('./base.js').Pt | null} [avoid] 第二顆（2.6.1）：離第一顆爆點 P.flashSecondGap 格內的候選不要
   * @param {import('./analysis.js').Entrance | null} [pred] 3.0：照這個入口預測炸開時隊友位置（資源層有計畫時）
   */
  flashPoint(obs, s, e, ratio, avoid = null, pred = null) {
    const g = this.g;
    const site = this.intel.sites[s];
    const R = this.util.flashRadius;
    // 2.7：敵情（記得的敵人、聲音）每 P.flashCacheSec 秒換一次版本，候選跟著重算
    const era = P.flashCacheSec > 0 ? Math.floor(this.perc.lastTick / (P.flashCacheSec * this.tps)) : 0;
    const key = `${s}${e.portal}:${this.smokes.length}:${era}`;
    if (this.flashKey !== key) {
      this.flashKey = key;
      const t = this.perc.lastTick;
      // 守點位與深位（2.5 第三批 CT 預設退到深位）都是地圖推導的可能位置
      const seers = [...site.holds, ...this.deepSpots(s)].filter((h) => !this.perc.cleared(h.cell, t)).map((h) => ({ x: h.x, y: h.y, w: 1 }));
      seers.push( ...this.perc.threats(e.ix, e.iy, 30).map((k) => ({ x: k.x, y: k.y, w: 2 })));
      // 聽到的敵方聲音：扇形上離入口一樣遠的那一點
      for (const sc of this.perc.sectors) {
        if (sc.conf < 25 || sc.kind === 'hurt') continue;
        const r = clamp(dist(sc.ox, sc.oy, e.ix, e.iy) / UNIT, sc.r0, sc.r1) * UNIT;
        const q = { x: sc.ox + cosd(sc.dir) * r, y: sc.oy + sind(sc.dir) * r };
        const qc = g.cellOf(q.x, q.y);
        if (qc >= 0 && !g.isWall(qc % g.W, Math.floor(qc / g.W)) && site.regions.has(this.intel.region[qc])) seers.push({ x: q.x, y: q.y, w: 1 });
      }
      /** @type {{ x: number, y: number, sc: number }[]} */
      const list = [];
      const cx = Math.floor(e.ix / UNIT);
      const cy = Math.floor(e.iy / UNIT);
      // 深位離入口 16 格以上：爆點候選要放到入口內 P.flashDeep 格才閃得到
      const reach = P.flashDeep;
      for (let y = cy - reach; y <= cy + reach; y++) {
        for (let x = cx - reach; x <= cx + reach; x++) {
          if (g.isWall(x, y)) continue;
          const i = y * g.W + x;
          if (!site.regions.has(this.intel.region[i])) continue;
          const c = g.center(i);
          const de = dist(c.x, c.y, e.ix, e.iy);
          if (de > reach * UNIT || de < 1.5 * UNIT) continue;
          let sc = 0;
          for (const v of seers) {
            if (dist(v.x, v.y, c.x, c.y) > R || !g.los(v.x, v.y, c.x, c.y)) continue;
            if (this.smokes.some((m) => segDist(m.x, m.y, v.x, v.y, c.x, c.y).d < 3 * UNIT)) continue;
            sc += v.w;
          }
          if (sc > 0) list.push({ x: c.x, y: c.y, sc: sc - de / (20 * UNIT) });
        }
      }
      list.sort((a, b) => b.sc - a.sc);
      this.flashList = list.slice(0, 12);
      // 後面接預設：入口內側 2～8 格、從入口外側看得到的格，離「入口往包點中心 4 格」近的先（照常執行時的預設閃）
      {
        const d = Math.max(1, dist(e.ix, e.iy, site.cx, site.cy));
        const f = Math.min(1, (4 * UNIT) / d);
        const ax = e.ix + (site.cx - e.ix) * f;
        const ay = e.iy + (site.cy - e.iy) * f;
        /** @type {{ x: number, y: number, sc: number }[]} */
        const def = [];
        for (let y = cy - 8; y <= cy + 8; y++) {
          for (let x = cx - 8; x <= cx + 8; x++) {
            if (g.isWall(x, y)) continue;
            const i = y * g.W + x;
            const c = g.center(i);
            const de = dist(c.x, c.y, e.ix, e.iy);
            if (!site.regions.has(this.intel.region[i]) || de > 8 * UNIT || de < 2 * UNIT || !g.los(e.ox, e.oy, c.x, c.y)) continue;
            def.push({ x: c.x, y: c.y, sc: 1 - dist(c.x, c.y, ax, ay) / (40 * UNIT) });
          }
        }
        def.sort((a, b) => b.sc - a.sc);
        this.flashList.push(...def.slice(0, 12));
      }
    }
    // 丟得到的候選中取「預期閃到敵人 ÷ 閃到自己人」最好的：敵方算正閃（×6）、己方看得到爆點的人算背閃，
    // 都乘距離係數 1 − d／(2R)；自己丟完 6 步內有看不到爆點的格可以躲就不算自己。比值不到 ratio 就不丟
    // （照計畫執行時隊友在待命格等閃光、收到 E:flash 會躲，用 2；其他時候用 5）
    const me = obs.me;
    const B = this.util.blindRange;
    // 3.0（pred＝這次執行的入口）：預測炸開那一刻隊友的位置——入口附近、還沒進點的人在入口外的等閃線，其他人在原地；
    // 任一個預測位置看得到爆點（半徑內）就不選這個點（硬條件，不打折）
    // 炸開前還沒看得到爆點的隊友由 waitFlash 擋在視線外。
    // r7k（審查決定，和 r7i 的轉開同一套假設）：沒看到敵人、沒在交火的隊友出手時會轉開（只剩背對殘餘），不排除；
    // 硬性排除只留「交火中（1.5 秒內開過槍，或記得的敵人看得到他）、在爆點半徑內有視線、4 步內躲不掉」的隊友（他不會轉開）
    const hard = pred !== null;
    const mates = obs.teammates.filter((m) => m.alive);
    const t = obs.tick;
    const fighting = (/** @type {typeof mates[number]} */ m) => t - (this.mateFired.get(m.id) ?? -1e9) < 1.5 * this.tps || this.perc.threats(m.x, m.y, 30).some((k) => dist(k.x, k.y, m.x, m.y) < 30 * UNIT && g.los(k.x, k.y, m.x, m.y));
    // r7l（T9）：先用 r7i 的嚴格版（面向爆點或交火中都排除）；嚴格版把候選全排除了才退到只排除交火中的（乙），兩輪都沒有才放棄
    // （只用乙時，面向爆點、會轉開的隊友吃的背對殘餘讓 T9 的含背對總量超過 20%）
    const facing = (/** @type {typeof mates[number]} */ m, /** @type {{ x: number, y: number }} */ c) => Math.abs(adiff(angleTo(m.x, m.y, c.x, c.y), m.facing)) <= this.data.rules.grenadeRules.flashSideDeg;
    const pick = (/** @type {boolean} */ strict) => {
    this.flashUnsafe = false;
    let best = null;
    let bestS = 0;
    let tries = 0;
    for (const c of this.flashList) {
      if (avoid !== null && dist(c.x, c.y, avoid.x, avoid.y) < P.flashSecondGap * UNIT) continue;
      if (++tries > 12) break;
      if (this.util.solve(me.x, me.y, c.x, c.y) === null) continue;
      if (hard && mates.some((m) => dist(m.x, m.y, c.x, c.y) < B && g.los(m.x, m.y, c.x, c.y) && (fighting(m) || (strict && facing(m, c))) && !this.canHide(m.x, m.y, c, 4))) {
        this.flashUnsafe = true;
        continue;
      }
      let cost = 0;
      for (const m of mates) {
        const d = dist(m.x, m.y, c.x, c.y);
        // 照計畫執行時隊友收到 E:flash 會躲：4 步內躲得到的不算
        if (d < B && g.los(m.x, m.y, c.x, c.y) && !(ratio < 5 && this.canHide(m.x, m.y, c, 4))) cost += 1 - d / B;
      }
      const hide = this.nav?.escape(obs, (i) => {
        const q = g.center(i);
        return dist(q.x, q.y, c.x, c.y) < B && g.los(q.x, q.y, c.x, c.y);
      }, 6);
      if (hide === null || hide === undefined) cost += 1 - dist(me.x, me.y, c.x, c.y) / B;
      const gain = 6 * c.sc * 0.5;
      if (gain >= ratio * cost && gain - cost > bestS) {
        bestS = gain - cost;
        best = c;
      }
    }
    return best;
    };
    const best = pick(true);
    return best !== null || !hard || !this.flashUnsafe ? best : pick(false);
  }

  /**
   * 3.0：等閃（跟進者觸發的另一半）：隊友（或自己）的閃光還沒炸開、自己現在看不到爆點，但往目標再走 1～3 格就看得到（半徑內）——站住等它炸開
   * @param {import('./base.js').Observation} obs @param {TacOut} out
   */
  waitFlash(obs, out) {
    const me = obs.me;
    const t = obs.tick;
    if (out.goal === null || obs.enemies.length > 0) return;
    const B = this.util.blindRange;
    const d = dist(me.x, me.y, out.goal.x, out.goal.y);
    if (d < UNIT) return;
    // 停步指令要等反應延遲才生效：看 1～3 格外（含延遲中會多走的距離）
    const at = (/** @type {number} */ k) => ({ x: me.x + ((out.goal?.x ?? me.x) - me.x) / d * k * UNIT, y: me.y + ((out.goal?.y ?? me.y) - me.y) / d * k * UNIT });
    // （審查 (b)）自己丟的閃也算：炸開前不走進爆點視線（自閃占隊友致盲一半以上）；隊友的閃只有 T 等
    const own = this.util.away;
    const list = [...(own !== null ? [{ x: own.x, y: own.y, pop: own.until - 3 }] : []), ...(me.team === 'T' ? this.mateFlash : [])];
    for (const f of list) {
      if (t > f.pop || this.g.los(me.x, me.y, f.x, f.y)) continue;
      if (![1, 2, 3].some((k) => { const q = at(Math.min(k, d / UNIT)); return dist(q.x, q.y, f.x, f.y) < B && this.g.los(q.x, q.y, f.x, f.y); })) continue;
      out.stop = true;
      out.role += '・等閃';
      return;
    }
  }

  /**
   * 3.0：這顆閃光有沒有情報支撐：爆點半徑內有記得的敵人（信心 ≥ 30），或 5 秒內在爆點附近有人喊接觸
   * @param {import('./base.js').Observation} obs @param {import('./base.js').Pt} c @param {SiteId} s
   */
  flashInfo(obs, c, s) {
    const R = this.util.blindRange;
    if (this.perc.threats(c.x, c.y, 30).some((k) => dist(k.x, k.y, c.x, c.y) < R)) return true;
    // 3.0（r7k，T4）：聲音也是情報：還記得的敵方聲音扇形（時效＝聽覺記憶：扇形信心衰減到 0 才忘）經過目標包點附近（矩形外擴 8 格）
    // 聲音只有方向和距離帶，落不到爆點上；守點的人多半在包點矩形外的角落，所以用包點附近而不是爆點半徑
    // （viewer 用信心 ≥ 25；這裡不設門檻：槍聲每秒一次時信心在 19～34 間擺盪，門檻 25 會讓同一段聲音時有時無）
    const rc = this.intel.sites[s].rect;
    if (this.perc.sectors.some((q) => {
      if (q.conf <= 0 || q.kind === 'hurt') return false;
      for (let r = q.r0; r <= q.r1; r += 2) {
        const x = Math.floor((q.ox + cosd(q.dir) * r * UNIT) / UNIT), y = Math.floor((q.oy + sind(q.dir) * r * UNIT) / UNIT);
        if (x >= rc.x0 - 8 && x <= rc.x1 + 8 && y >= rc.y0 - 8 && y <= rc.y1 + 8) return true;
      }
      return false;
    })) return true;
    // 接觸要在爆點附近（喊話的區域中心在半徑＋5 格內）才算；只說「包點有人」的接觸閃到 0 人的比例太高
    for (const [key, q] of this.contacts) if (this.contactSite.get(key) === s && obs.tick - q.tick < 5 * this.tps && Number.isFinite(q.x) && dist(q.x, q.y, c.x, c.y) < R + 5 * UNIT) return true;
    return false;
  }

  /**
   * 3.0（補充 C）：entryFlash 觸發後一直找不到點，3 秒後放棄（U:x 序號 原因：s 找不到安全點、r 其他）
   * @param {import('./base.js').Observation} obs @param {TacOut} out @param {boolean} none
   */
  flashGiveUp(obs, out, none) {
    const it = this.claimed.get('flash');
    if (it === undefined || it.idx < 0) return;
    if (!none) {
      this.noFlashSince = -1;
      return;
    }
    if (this.noFlashSince < 0) this.noFlashSince = obs.tick;
    if (obs.tick - this.noFlashSince >= 3 * this.tps && !this.gaveUp.has(it.idx)) {
      this.gaveUp.add(it.idx);
      out.cmds.push({ type: 'say', text: `U:x ${it.idx} ${this.flashUnsafe ? 's' : 'r'}` });
    }
  }

  /**
   * 下包後：下包者與一人守點內，其餘看回防入口（CT 最近的入口優先）；不衝出去找人。
   * 對方拆包（看見或聽到）就把燃燒／手雷丟到炸彈上
   * @param {import('./base.js').Observation} obs @param {TacOut} out @param {number} bx @param {number} by @param {SiteId} s
   * @returns {import('./utility.js').ThrowWish | null}
   */
  postPlant(obs, out, bx, by, s) {
    out.task = 'hold';
    const me = obs.me;
    const t = obs.tick;
    if (!this.postSaid) {
      this.postSaid = true;
      if (this.can(me, 'smoke', ['free'])) {
        this.postSmokers.add(me.id);
        out.cmds.push({ type: 'say', text: 'E:smoker' });
      }
    }
    const spots = this.postSpots(s, bx, by, true);
    // 錨點拿第一個守包位（看 CT 最近的入口）
    const anchor = this.roles.who(ANCHOR);
    const ids = [me.id, ...obs.teammates.filter((m) => m.alive).map((m) => m.id)].sort((a, b) => (a === anchor ? -1 : 0) - (b === anchor ? -1 : 0) || a - b);
    const k = Math.max(0, ids.indexOf(me.id));
    out.hold = spots.length > 0 ? spots[k % spots.length] : null;
    out.goal = out.hold ?? { x: bx, y: by };
    out.role = '守包';
    out.allowPeek = false;
    const escape = this.judge?.evacuation(obs, bx, by);
    const left = (obs.bomb.ticksLeft ?? this.data.rules.bombTicks) / this.tps;
    const defusing = this.defuseNow(obs);
    const guard = [...this.alive(obs)].sort((a, b) => dist(a.x, a.y, bx, by) - dist(b.x, b.y, bx, by) || a.id - b.id)[0];
    const covered = guard.id !== me.id && dist(guard.x, guard.y, bx, by) < 16 * UNIT && this.g.los(guard.x, guard.y, bx, by);
    const cannotStart = left < this.data.rules.defuseKitTicks / this.tps;
    // 分批撤離：最後一人守到來不及新開拆；已在拆的人不能用「剩不到 5 秒」當作安全。
    if (escape !== undefined && escape !== null && (left <= escape.seconds + 1.5 || cannotStart) && !defusing && (cannotStart || covered || obs.enemiesAlive === 0)) {
      out.goal = escape;
      out.hold = null;
      out.walk = false;
      out.escape = true;
      out.task = 'save';
      out.role = '炸彈撤離';
      if (me.scoped) out.cmds.push({ type: 'scope', on: false });
      return null;
    }
    // 最後守包者先往仍看得到炸彈的出口側站位移動，避免等到剩 5 秒才發現路程太長。
    if (escape?.guard !== undefined && escape.guard !== null && !defusing && !covered && left <= escape.seconds + 3) {
      out.goal = escape.guard;
      out.hold = null;
      out.look = { x: bx, y: by };
      out.urgent = true;
      out.walk = false;
      out.role = '撤離前守線';
    }
    // 敵人全滅：守著等爆炸，不追不丟
    if (obs.enemiesAlive === 0) return null;
    if (defusing) {
      const kind = this.pickFor(me, ['molotov', 'he'], ['free']);
      // 3.0 觸發拆成時機與落點：時機＝有人在拆、手上有燃燒或手雷（落點由效用層算）
      if (kind !== null) this.hint('postDefuse', kind, ['free']);
      if (kind !== null && !this.burns.some((p) => p.until > t && dist(p.x, p.y, bx, by) < 3 * UNIT) && !this.burnsMate(obs, bx, by)) return { kind, x: bx, y: by, why: '燒拆包' };
      if (this.antiDefuse(obs, out, bx, by)) return null;
    }
    return this.postUtility(obs, bx, by, s);
  }

  /** 從 CT 的回防入口思考：煙封入口，燃燒攔住已接近的敵人；留下最後一顆燃燒反拆。 @param {import('./base.js').Observation} obs @param {number} bx @param {number} by @param {SiteId} s @returns {import('./utility.js').ThrowWish | null} */
  postUtility(obs, bx, by, s) {
    const me = obs.me;
    const left = (obs.bomb.ticksLeft ?? 0) / this.tps;
    if (left < 8 || this.data.rules.bombTicks / this.tps - left < 2 || me.blindTicks > 0) return null;
    const enemies = this.perc.threats(me.x, me.y, 40);
    const entrances = [...this.intel.sites[s].entrances].sort((a, b) => a.ctDist - b.ctDist || a.portal - b.portal);
    const alive = this.ids.filter((id) => this.isAlive(obs, id));
    const slot = Math.max(0, alive.indexOf(me.id));
    const e = entrances[slot % entrances.length];
    if (e === undefined) return null;
    const near = enemies.some((p) => dist(p.x, p.y, e.ox, e.oy) < 10 * UNIT);
    // 煙不直接罩包；兩煙距離與進點階段同樣受約束，避免給 CT 免費掩護。
    const target = { x: e.ox, y: e.oy };
    const smokers = [...new Set([...this.postSmokers, ...(this.can(me, 'smoke', ['free']) ? [me.id] : [])])].filter((id) => this.isAlive(obs, id)).sort((a, b) => a - b);
    /** @type {import('./analysis.js').Entrance[]} */
    const entries = [];
    for (const q of entrances) if (entries.every((p) => dist(p.ox, p.oy, q.ox, q.oy) >= (P.smokeGap + 2) * UNIT)) entries.push(q);
    const smoke = entries[smokers.indexOf(me.id)];
    // 3.0 觸發時機：分到入口、敵人接近那個入口（或剛下包）、沒看到敵人
    if (smoke !== undefined && (enemies.some((p) => dist(p.x, p.y, smoke.ox, smoke.oy) < 10 * UNIT) || this.data.rules.bombTicks / this.tps - left < 4) && obs.enemies.length === 0 && this.may(me, 'smoke', ['free'])) this.hint('postSmoke', 'smoke', ['free']);
    // 下包頭兩秒先交換剩餘煙資訊，之後一個人負責一個入口，連同時準備投擲也不重複。
    if (smoke !== undefined && (enemies.some((p) => dist(p.x, p.y, smoke.ox, smoke.oy) < 10 * UNIT) || this.data.rules.bombTicks / this.tps - left < 4) && dist(smoke.ox, smoke.oy, bx, by) > 5 * UNIT && this.can(me, 'smoke', ['free']) && obs.enemies.length === 0 && this.smokes.every((p) => dist(p.x, p.y, smoke.ox, smoke.oy) >= P.smokeGap * UNIT) && this.util.solve(me.x, me.y, smoke.ox, smoke.oy) !== null) return { kind: 'smoke', x: smoke.ox, y: smoke.oy, why: '封回防入口' };
    const burners = alive.filter((id) => this.roles.of(id) === ANCHOR || this.roles.of(id) === SUPPORT);
    const reserve = burners[0] ?? alive[0];
    if (near && me.id !== reserve && this.may(me, 'molotov', ['free'])) this.hint('postBurn', 'molotov', ['free']);
    if (near && me.id !== reserve && this.can(me, 'molotov', ['free']) && this.burns.every((p) => p.until <= obs.tick || dist(p.x, p.y, target.x, target.y) >= 6 * UNIT) && this.util.solve(me.x, me.y, target.x, target.y) !== null && !obs.teammates.some((m) => m.alive && dist(m.x, m.y, target.x, target.y) < 4 * UNIT)) return { kind: 'molotov', ...target, why: '燒回防入口' };
    return null;
  }

  /**
   * 反拆（2.7 批 1-12，Astra H01）：沒有道具可丟時，離炸彈最近的守包者轉向炸彈、走到看得到炸彈的位置、照炸彈位置開火（煙裡也打）。
   * 證據（看到在拆、1 秒內的拆包聲）過期就不去（假拆不送掉優勢）；最晚干預時間＝這波開始拆＋不帶拆彈器的拆包時間，到位前就來不及也不去。回傳 true ＝ 接手了
   * @param {import('./base.js').Observation} obs @param {TacOut} out @param {number} bx @param {number} by
   */
  antiDefuse(obs, out, bx, by) {
    if (!P.antiDefuse) return false;
    const me = obs.me;
    const t = obs.tick;
    if (t - this.defuseLast > this.tps) return false;
    const guard = [...this.alive(obs)].sort((a, b) => dist(a.x, a.y, bx, by) - dist(b.x, b.y, bx, by) || a.id - b.id)[0];
    if (guard === undefined || guard.id !== me.id) return false;
    const d = dist(me.x, me.y, bx, by);
    const sees = d < P.antiDefuseRange * UNIT && this.g.los(me.x, me.y, bx, by);
    const deadline = this.defuseSince + this.data.rules.defuseTicks;
    if (!sees && t + (this.judge?.travel(me, bx, by) ?? 0) * this.tps > deadline) return false;
    out.goal = sees ? null : { x: bx, y: by };
    out.hold = null;
    out.route = null;
    out.look = { x: bx, y: by };
    out.urgent = true;
    out.walk = false;
    out.allowPeek = false;
    out.stop = sees;
    out.noise = sees;
    out.role = '守包・反拆';
    return true;
  }

  /** 燃燒落點 4 格內有活著的隊友（2.7，P.burnMateCheck；關掉時永遠 false） @param {import('./base.js').Observation} obs @param {number} x @param {number} y */
  burnsMate(obs, x, y) {
    return P.burnMateCheck && obs.teammates.some((m) => m.alive && dist(m.x, m.y, x, y) < 4 * UNIT);
  }

  /**
   * 守包：CT 是不是正在拆（看到炸彈在拆、或 1 秒內聽到拆包聲；之後記拆包時間那麼久）。
   * 2.7（P.defuseAlarmKill）：警報後 CT 人數變少就解除
   * @param {import('./base.js').Observation} obs
   */
  defuseNow(obs) {
    const t = obs.tick;
    if (obs.bomb.state === 'defusing' || (this.perc.lastSound?.kind === 'defuse' && t - this.perc.lastSound.tick < this.tps)) {
      if (t - this.defuseLast > 2 * this.tps) this.defuseSince = t;
      this.defuseLast = t;
      this.defuseAlarm = t + this.data.rules.defuseTicks;
      this.alarmAlive = obs.enemiesAlive;
    } else if (P.defuseAlarmKill && obs.enemiesAlive < this.alarmAlive) this.defuseAlarm = -1;
    return obs.enemiesAlive > 0 && this.defuseAlarm > t;
  }

  /** 守包位：包點守點位（看 CT 最近的入口的先）＋下包位，離炸彈 14 格內 @param {SiteId} s @param {number} bx @param {number} by */
  postSpots(s, bx, by, spread = false) {
    const site = this.intel.sites[s];
    const holds = site.holds.filter((h) => dist(h.x, h.y, bx, by) < 14 * UNIT).sort((a, b) => (site.entrances[a.entrance]?.ctDist ?? 0) - (site.entrances[b.entrance]?.ctDist ?? 0));
    const plants = site.plants.filter((h) => dist(h.x, h.y, bx, by) < 12 * UNIT && dist(h.x, h.y, bx, by) > 1500).map((h) => ({ ...h, fx: bx, fy: by }));
    const all = [...holds, ...plants];
    if (!spread) return all;
    // 拉開：離炸彈至少 P.postMin 格、彼此至少 P.postGap 格；不夠的才用近的補
    /** @type {typeof all} */
    const out = [];
    for (const h of all) if (dist(h.x, h.y, bx, by) >= P.postMin * UNIT && out.every((o) => dist(o.x, o.y, h.x, h.y) >= P.postGap * UNIT)) out.push(h);
    for (const h of all) if (!out.includes(h)) out.push(h);
    return out;
  }

  /**
   * 路線：照計畫；還在出生區附近而路線上有危險（交界點的危險格成本高），就換最安全的另一條（本回合記住）
   * @param {import('./base.js').Observation} obs @param {SiteId} site @param {number} idx0
   */
  pickRoute(obs, site, idx0) {
    const all = this.intel.routes.T[site];
    if (all.length === 0) return null;
    const idx = this.routeOverride >= 0 ? this.routeOverride : Math.min(idx0, all.length - 1);
    // 補回的遠入口只有計畫指定才走；臨時換路不換到它（整隊會散到不同入口）
    const routes = all.slice(0, Math.max(P.routeMax, idx + 1));
    const me = obs.me;
    const c = this.g.cellOf(me.x, me.y);
    // 不在路線上（計畫改了、被打亂）：換一條經過這裡的路線，都沒有就直接走，不繞回路線起點
    if (c >= 0 && !routes[idx].regionSet.has(this.intel.region[c])) return routes.find((r) => r.regionSet.has(this.intel.region[c])) ?? null;
    if (c < 0 || this.intel.distSpawn.T[c] / 10 > P.routeSwitchNear) return routes[idx];
    /** @param {import('./analysis.js').Route} r */
    const risk = (r) => {
      let v = 0;
      for (const p of r.points) v = Math.max(v, this.perc.danger[this.g.cellOf(p.x, p.y)] ?? 0);
      return v;
    };
    const cur = risk(routes[idx]);
    if (cur < P.routeSwitchRisk) return routes[idx];
    let best = idx;
    for (let i = 0; i < routes.length; i++) if (risk(routes[i]) < risk(routes[best])) best = i;
    if (best !== idx && risk(routes[best]) < cur / 2) this.routeOverride = best;
    // 換了還是危險（幾條路線共用一段）：不跟路線，讓 A* 依危險格自己繞
    const r = routes[this.routeOverride >= 0 ? this.routeOverride : idx];
    return risk(r) >= P.routeSwitchRisk ? null : r;
  }

  /** @param {import('./base.js').Observation} obs */
  carrierId(obs) {
    if (obs.me.hasBomb) return obs.me.id;
    const c = obs.teammates.find((m) => m.alive && m.hasBomb);
    return c === undefined ? -1 : c.id;
  }

  /** 同陣營活人依 id 排序後自己的名次 @param {import('./base.js').Observation} obs @param {(id: number) => boolean} [filter] */
  rank(obs, filter = () => true) {
    const ids = [obs.me.id, ...obs.teammates.filter((m) => m.alive).map((m) => m.id)].filter(filter).sort((a, b) => a - b);
    return Math.max(0, ids.indexOf(obs.me.id));
  }

  // ───────── CT ─────────

  /**
   * CT 守位分配：A 的守點位（a 個）、中路（m 個）、B 的守點位（b 個）；狙擊手（拿狙擊槍的人）拿長對線位。
   * 角色先挑：錨點拿沒有狙擊手的點的第一個位、支援拿第二個位（疊點看主入口）、游擊拿中路、突破手拿狙擊手那一點的第一個位；其餘依隊內序號補
   * @param {import('./base.js').Observation} obs @param {CTPlan} p @returns {Map<number, { spot: import('./analysis.js').Spot, site: SiteId | null }>}
   */
  ctLayout(obs, p) {
    const key = `${p.a}${p.m}${p.b}${this.awper}${this.roles.key}`;
    if (this.layout !== null && this.layoutKey === key) return this.layout;
    /** 位置：k ＝ 該點的第幾個（中路 −1） @type {{ spot: import('./analysis.js').Spot, site: SiteId | null, k: number }[]} */
    const pos = [];
    const mids = this.midSpots();
    let m = p.m;
    if (mids.length === 0) m = 0;
    const a = p.a + (mids.length === 0 ? Math.ceil(p.m / 2) : 0);
    const b = 5 - a - m;
    const round = obs.round.number;
    // 深位本身已依回合換位置，不再小幅變化（變化後未必同時看得到兩個入口）
    /** @param {import('./analysis.js').Spot} spot @param {SiteId} s */
    const vary = (spot, s) => (this.deepSpots(s).includes(spot) ? spot : this.varySpot(spot, round));
    this.pickHolds('A', a, round).forEach((spot, k) => pos.push({ spot: vary(spot, 'A'), site: 'A', k }));
    for (let i = 0; i < m; i++) pos.push({ spot: this.varySpot(mids[i % mids.length], round), site: null, k: -1 });
    this.pickHolds('B', b, round).forEach((spot, k) => pos.push({ spot: vary(spot, 'B'), site: 'B', k }));
    /** @type {Map<number, { spot: import('./analysis.js').Spot, site: SiteId | null }>} */
    const out = new Map();
    let ids = [...this.ids];
    /** @type {SiteId | null} */
    let snSite = null;
    if (this.awper >= 0) {
      const sn = this.sniperSpot();
      if (sn !== null) {
        // 狙擊位所在點的最後一個位置換成狙擊位（那個點只有一人時就是錨點自己）
        let idx = -1;
        for (let i = 0; i < pos.length; i++) if (pos[i].site === sn.site) idx = i;
        if (idx < 0) idx = pos.length - 1;
        pos.splice(idx, 1);
        out.set(this.awper, { spot: sn.spot, site: sn.site });
        ids = ids.filter((x) => x !== this.awper);
        snSite = sn.site;
      }
    }
    /** 角色對位置的偏好（小的好） @type {Record<number, (q: { site: SiteId | null, k: number }) => number>} */
    const pref = {
      [ANCHOR]: (q) => (q.site === null ? 9 : q.k === 0 ? (q.site !== snSite ? 0 : 1) : 2 + q.k),
      [SUPPORT]: (q) => (q.site === null ? 5 : q.k === 1 ? (q.site !== snSite ? 0 : 1) : q.k >= 2 ? 2 : 4),
      [LURK]: (q) => (q.site === null ? 0 : q.k >= 2 ? 1 : q.k === 1 ? 2 : 3),
      [ENTRY]: (q) => (q.site === null ? 3 : q.k === 0 ? (q.site === snSite ? 0 : 1) : 2),
    };
    const free = pos.map(() => true);
    const order = [ANCHOR, SUPPORT, LURK, ENTRY].map((r) => this.roles.who(r)).filter((id) => ids.includes(id));
    for (const id of [...order, ...ids.filter((x) => !order.includes(x))]) {
      const f = pref[this.roles.of(id)] ?? (() => 0);
      let best = -1;
      for (let i = 0; i < pos.length; i++) if (free[i] && (best < 0 || f(pos[i]) < f(pos[best]))) best = i;
      if (best < 0) best = ids.indexOf(id) % Math.max(1, pos.length);
      else free[best] = false;
      const q = pos[best];
      if (q !== undefined) out.set(id, { spot: q.spot, site: q.site });
    }
    this.layout = out;
    this.layoutKey = key;
    return out;
  }

  /** 錨點：點上的錨點角色，否則分到這個點的第一個人 @param {import('./base.js').Observation} obs @param {CTPlan} p @param {SiteId} s */
  anchorOf(obs, p, s) {
    const lay = this.ctLayout(obs, p);
    const an = this.roles.who(ANCHOR);
    if (an >= 0 && lay.get(an)?.site === s && this.isAlive(obs, an)) return an;
    for (const id of this.ids) if (lay.get(id)?.site === s && this.isAlive(obs, id)) return id;
    return -1;
  }

  /** 輪轉時留守：另一點的錨點，或守在點上的錨點角色 @param {import('./base.js').Observation} obs @param {CTPlan} p @param {number} id */
  stays(obs, p, id) {
    if (p.rot === null) return false;
    const site = this.ctLayout(obs, p).get(id)?.site ?? null;
    return this.anchorOf(obs, p, other(p.rot)) === id || (this.roles.of(id) === ANCHOR && site !== null);
  }

  /** @param {import('./base.js').Observation} obs @param {number} id */
  isAlive(obs, id) {
    if (id === obs.me.id) return obs.me.alive;
    return obs.teammates.some((m) => m.id === id && m.alive);
  }

  /**
   * @param {import('./base.js').Observation} obs @param {TacOut} out
   * @returns {import('./utility.js').ThrowWish | null}
   */
  ctGoal(obs, out) {
    const me = obs.me;
    const b = obs.bomb;
    out.task = 'hold';
    const p = this.plan !== null && this.plan.kind === 'hold' ? this.plan : this.chooseCT();
    // 狙擊手：開打時手上拿狙擊槍的人（全隊看到的一樣）
    if (!this.awperFixed) {
      this.awper = me.loadout.primary === 'awp' ? me.id : (obs.teammates.find((m) => m.weapon === 'awp')?.id ?? -1);
      this.awperFixed = obs.round.phase === 'live';
    }
    if ((b.state === 'planted' || b.state === 'defusing') && b.x !== null && b.y !== null) {
      return this.retake(obs, out, p, b.x, b.y, b.site ?? 'A');
    }
    const lay = this.ctLayout(obs, p).get(me.id);
    if (lay === undefined) return null;
    let spot = lay.spot;
    out.role = lay.site === null ? '中路' : `守 ${lay.site}`;
    // 輪轉：另一點的錨點（與守點的錨點角色）以外全部去輪轉點的待命位（本來就守那點的不動）
    if (p.rot !== null && lay.site !== p.rot && !this.stays(obs, p, me.id)) {
      const stage = this.stageSpots('CT', p.rot, 0);
      const rotators = this.ids.filter((id) => this.isAlive(obs, id) && this.ctLayout(obs, p).get(id)?.site !== p.rot && !this.stays(obs, p, id));
      if (stage.length > 0) {
        spot = stage[Math.max(0, rotators.indexOf(me.id)) % stage.length];
        out.role = `輪轉 ${p.rot}`;
        out.task = 'retake';
      }
      // 輪轉要快：路上的窄口不停下來探頭
      out.allowPeek = false;
      // 中路的人（游擊）離那一點最近：直接去疊點看主入口（第三個守位），不在待命位等
      if (lay.site === null) {
        const stack = this.siteSpots(p.rot, 3)[2];
        if (stack !== undefined) {
          spot = stack;
          out.role = `輪轉疊點 ${p.rot}`;
        }
      }
    }
    // 放棄點：已經 3 人以上進點（或敵方閃光炸在入口而估計 3 人以上）、點上不超過 2 人：退到回防位等人齊，不打 2 對 5
    const fall = this.giveUp(obs, p, lay.site ?? p.rot);
    if (fall !== null) {
      const stage = P.fallHide ? this.fallSpots(fall) : this.stageSpots('CT', fall, 0);
      const others = this.ids.filter((id) => this.isAlive(obs, id));
      const sp = stage.length > 0 ? stage[Math.max(0, others.indexOf(me.id)) % stage.length] : null;
      if (sp !== null) {
        spot = sp;
        out.role = `退守 ${fall}`;
        out.task = 'retake';
        out.allowPeek = false;
        // 不用撤離模式：轉身跑會被背後打死；看得到人照常交火，看不到才往後退
        out.escape = false;
      }
    }
    // 開局探點：游擊（或突破手）去看一眼 T 的待命方向，看到或聽到人、時間到就回來
    const probe = fall === null ? this.probeSpot(obs, p, out) : null;
    if (probe !== null) {
      spot = probe;
      out.allowPeek = false;
    }
    out.goal = { x: spot.x, y: spot.y };
    out.hold = spot;
    // 殘局：只剩自己、對方 ≤ 2 人、侵略高 → 主動去最後知道敵人的地方找人（侵略低的守位打時間）
    if (obs.round.phase === 'live' && obs.teammates.every((m) => !m.alive) && obs.enemiesAlive <= 2 && this.attrs.aggression >= P.huntAggr) {
      const th = this.perc.threats(me.x, me.y, 30)[0];
      if (th !== undefined) {
        out.goal = { x: th.x, y: th.y };
        out.hold = null;
        out.role = '殘局找人';
      }
    }
    const s = lay.site ?? p.rot;
    return s === null ? null : this.ctUtility(obs, p, s);
  }

  /**
   * 要放棄的點（下包前、守這點或往這點輪轉的人）：看到 P.giveUpIn 人以上在點裡，或敵方閃光炸在這點入口而估計人數達標；
   * 點上的人不超過 P.giveUpMine。決定後本回合不再回頭（下包後交給回防）
   * @param {import('./base.js').Observation} obs @param {CTPlan} p @param {SiteId | null} s @returns {SiteId | null}
   */
  giveUp(obs, p, s) {
    const b = obs.bomb.state;
    if (b === 'planted' || b === 'defusing' || obs.round.phase !== 'live') return null;
    if (this.fallback !== null) return this.fallback;
    if (s === null) return null;
    const t = obs.tick;
    const site = this.intel.sites[s];
    let inside = 0;
    for (const k of this.perc.known.values()) if (k.conf >= 50 && t - k.tick <= 2 * this.tps && site.regions.has(this.intel.region[this.g.cellOf(k.x, k.y)])) inside++;
    const flashed = site.entrances.some((e) => this.flashAt(obs, e));
    const est = Math.min(obs.enemiesAlive, flashed ? Math.max(inside, this.heat(obs)[s]) : inside);
    if (est < P.giveUpIn) return null;
    const lay = this.ctLayout(obs, p);
    const mine = this.alive(obs).filter((m) => lay.get(m.id)?.site === s && dist(m.x, m.y, site.cx, site.cy) < 20 * UNIT).length;
    if (mine > P.giveUpMine) return null;
    this.fallback = s;
    return s;
  }

  /**
   * 退守位（地圖算，快取）：CT 離這點最近的入口外、沿 CT 這側 6～14 格、包點裡看不到（入口內側與包點中心都沒有視線）、暴露少；
   * 每人一格。回防集結位看得到入口（要準備衝），退守時站那裡會被已經進點的 T 打
   * @param {SiteId} s @returns {import('./analysis.js').Spot[]}
   */
  fallSpots(s) {
    const key = `fall${s}`;
    const hit = this.spotCache.get(key);
    if (hit !== undefined) return hit;
    const g = this.g;
    const intel = this.intel;
    const site = intel.sites[s];
    const ent = [...site.entrances].sort((a, b) => a.ctDist - b.ctDist)[0];
    /** @type {import('./analysis.js').Spot[]} */
    const ranked = [];
    if (ent !== undefined) {
      const field = intel.distSite[s];
      const d0 = field[g.cellOf(ent.ox, ent.oy)];
      const ctAt = intel.distSpawn.CT[g.cellOf(ent.ox, ent.oy)];
      for (let i = 0; i < g.N; i++) {
        if (g.block[i] === 1 || site.regions.has(intel.region[i]) || field[i] < d0 + 60 || field[i] > d0 + 140 || intel.distSpawn.CT[i] >= ctAt) continue;
        const c = g.center(i);
        if (g.los(c.x, c.y, ent.ix, ent.iy) || g.los(c.x, c.y, site.cx, site.cy) || g.los(c.x, c.y, ent.x, ent.y)) continue;
        ranked.push({ x: c.x, y: c.y, cell: i, fx: ent.ox, fy: ent.oy, score: -3 * intel.exposure[i] - Math.abs(field[i] - d0 - 90) / 10 + (intel.cover[i] !== 0 ? 2 : 0), entrance: site.entrances.indexOf(ent) });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.cell - b.cell);
    /** @type {import('./analysis.js').Spot[]} */
    const out = [];
    for (const q of ranked) {
      if (out.length >= 5) break;
      if (out.every((o) => dist(o.x, o.y, q.x, q.y) >= P.stageGap * UNIT)) out.push(q);
    }
    const res = out.length > 0 ? out : this.stageSpots('CT', s, 0);
    this.spotCache.set(key, res);
    return res;
  }

  /**
   * 開局探點：中路的游擊（沒有就突破手）在開打 P.probeTime 秒內去看一眼；看到人、聽到近處腳步或槍聲、被打、或到位停留 P.probeStay 秒就結束，
   * 探到情報就先縮回看不到來向的掩體再回守位（2.6）
   * @param {import('./base.js').Observation} obs @param {CTPlan} p @param {TacOut} out @returns {import('./analysis.js').Spot | null}
   */
  probeSpot(obs, p, out) {
    const me = obs.me;
    const t = obs.tick;
    // 探到情報後縮回掩體（2.6）：到了或 2 秒後回守位
    const back = this.probeOut;
    if (back !== null) {
      if (t > back.until || dist(me.x, me.y, back.spot.x, back.spot.y) < 400) {
        this.probeOut = null;
        return null;
      }
      out.escape = false;
      out.role = '探點・縮回';
      return back.spot;
    }
    // 人手不夠（不到 4 人）不派人出去
    if (this.probed || obs.round.phase !== 'live' || p.rot !== null || this.alive(obs).length < 4) return null;
    const lay = this.ctLayout(obs, p);
    const lurk = this.roles.who(LURK);
    const who = lurk >= 0 && this.isAlive(obs, lurk) && lay.get(lurk)?.site === null ? lurk : this.roles.who(ENTRY);
    // 2.8：激進探點（ctPush）多派一個人（突破手，或游擊探了就換突破手以外的支援）去另一個探點
    const who2 = p.push ? [this.roles.who(ENTRY), this.roles.who(SUPPORT)].find((x) => x >= 0 && x !== who && this.isAlive(obs, x)) ?? -1 : -1;
    if (who !== me.id && who2 !== me.id) return null;
    const list = this.probeSpots();
    if (list.length === 0) return null;
    const sp = list[(rollOf(obs.round.number, 7) + (me.id === who2 ? 1 : 0)) % list.length];
    if (this.probeAt < 0 && dist(me.x, me.y, sp.x, sp.y) < 1.5 * UNIT) this.probeAt = t;
    const stay = (this.probeBare.has(sp.cell) ? 0.5 : 1) * P.probeStay * this.tps;
    const late = t - this.liveStart > P.probeTime * this.tps || (P.probeCover && this.probeAt >= 0 && t - this.probeAt > stay);
    const hit = this.perc.lastHurt;
    const hurt = hit !== null && t - hit.tick < this.tps;
    const heard = obs.sounds.some((q) => !q.friendly && ((q.kind === 'footstep' && q.range === 'near') || (q.kind === 'shot' && q.range !== 'far')));
    const info = this.perc.known.size > 0 || heard || (P.probeCover && hurt);
    if (late || info) {
      this.probed = true;
      // 探到就縮：看到人才縮到掩體（只聽到就照 2.5 直接回守位）；一對一而且隊友在 6 格內才留下交火
      if (!P.probeCover || obs.enemies.length === 0 || (obs.enemies.length === 1 && obs.teammates.some((m) => m.alive && dist(m.x, m.y, me.x, me.y) < 6 * UNIT))) return null;
      const th = obs.enemies.map((e) => ({ x: e.x, y: e.y }));
      // 只往 CT 這側找（往前找會撞上衝過來的人）
      const ct = this.intel.distSpawn.CT;
      const here = ct[this.g.cellOf(me.x, me.y)];
      const c = this.nav?.findCover(obs, th, (i) => ct[i] <= here) ?? null;
      if (c === null) return null;
      this.probeOut = { spot: { ...sp, x: c.x, y: c.y, cell: this.g.cellOf(c.x, c.y), fx: th[0].x, fy: th[0].y }, until: t + 2 * this.tps };
      out.escape = false;
      out.role = '探點・縮回';
      return this.probeOut.spot;
    }
    // 最後 6 格用走的（腳步聲小）
    if (P.probeCover && dist(me.x, me.y, sp.x, sp.y) < 6 * UNIT) out.walk = true;
    out.role = '探點';
    return sp;
  }

  /**
   * 探點位置（地圖算，快取）：T 路線上的交界（不是包點入口），CT 在 P.probeTime 秒前 3 秒到得了、T 最快也晚 P.probeMargin 秒；
   * 站在交界的 CT 側，看往路線上 T 來的方向。經過的路線多、離 T 近（情報多）的在前，取 2 個
   * @returns {import('./analysis.js').Spot[]}
   */
  probeSpots() {
    const hit = this.spotCache.get('probe');
    if (hit !== undefined) return hit;
    const g = this.g;
    const intel = this.intel;
    const v = P.routeSpeed;
    const entrancePortals = new Set([...intel.sites.A.entrances, ...intel.sites.B.entrances].map((e) => e.portal));
    /** @type {Map<number, { n: number, from: import('./base.js').Pt }>} */
    const uses = new Map();
    for (const s of SITES) {
      for (const r of intel.routes.T[s]) {
        r.portals.forEach((pid, k) => {
          const u = uses.get(pid);
          if (u !== undefined) u.n++;
          else uses.set(pid, { n: 1, from: k > 0 ? r.points[k - 1] : this.spawnCenter('T') });
        });
      }
    }
    /** @type {import('./analysis.js').Spot[]} */
    const ranked = [];
    for (const [pid, u] of uses) {
      if (entrancePortals.has(pid)) continue;
      const q = intel.portals[pid];
      const ca = g.cellOf(q.ax, q.ay);
      const cb = g.cellOf(q.bx, q.by);
      if (ca < 0 || cb < 0) continue;
      // CT 側＝離 CT 出生較近的那一端
      const c = intel.distSpawn.CT[ca] <= intel.distSpawn.CT[cb] ? ca : cb;
      const ct = intel.distSpawn.CT[c] / 10 / v;
      const tt = Math.min(intel.distSpawn.T[ca], intel.distSpawn.T[cb]) / 10 / v;
      if (ct > P.probeTime - 3 || tt < P.probeTime + P.probeMargin) continue;
      const at = g.center(c);
      if (!g.los(at.x, at.y, u.from.x, u.from.y)) continue;
      // 2.6：交界 CT 側 4 格內、不比交界更靠 T、看得到來向、貼牆（或矮牆）暴露少的格；沒有就站中心（停留減半）
      let cell = c;
      let best = -Infinity;
      if (P.probeCover) {
        const t0 = Math.min(intel.distSpawn.T[ca], intel.distSpawn.T[cb]);
        const x0 = c % g.W;
        const y0 = (c - x0) / g.W;
        for (let dy = -4; dy <= 4; dy++) {
          for (let dx = -4; dx <= 4; dx++) {
            const i = (y0 + dy) * g.W + x0 + dx;
            if (x0 + dx < 0 || x0 + dx >= g.W || y0 + dy < 0 || y0 + dy >= g.H || !g.walkable(i) || intel.cover[i] === 0 || intel.distSpawn.T[i] < t0) continue;
            const w = g.center(i);
            if (dx * dx + dy * dy > 16 || !g.los(w.x, w.y, u.from.x, u.from.y)) continue;
            const sc = ((intel.cover[i] & 1) !== 0 ? 6 : 0) + ((intel.cover[i] & 2) !== 0 ? 4 : 0) - 2 * intel.exposure[i] - Math.sqrt(dx * dx + dy * dy);
            if (sc > best) {
              best = sc;
              cell = i;
            }
          }
        }
        if (best === -Infinity) this.probeBare.add(c);
      }
      const w = g.center(cell);
      ranked.push({ x: w.x, y: w.y, cell, fx: u.from.x, fy: u.from.y, score: 10 * u.n - tt, entrance: -1 });
    }
    ranked.sort((a, b) => b.score - a.score || a.cell - b.cell);
    const out = ranked.slice(0, 2);
    this.spotCache.set('probe', out);
    return out;
  }

  /** 有隊友在閃光半徑內看得到這個爆點（CT 不躲閃光，丟之前要先確認） @param {import('./base.js').Observation} obs @param {import('./base.js').Pt} c */
  mateSees(obs, c) {
    return obs.teammates.some((m) => m.alive && dist(m.x, m.y, c.x, c.y) < this.util.blindRange && this.g.los(m.x, m.y, c.x, c.y));
  }

  /**
   * 某入口的壓力：看到或回報的敵人數（n）；徵兆（sign）是近處的敵方聲音、對面丟在入口附近的煙
   * @param {import('./base.js').Observation} obs @param {SiteId} s @param {import('./analysis.js').Entrance} e
   */
  pressure(obs, s, e) {
    const site = this.intel.sites[s];
    let n = 0;
    let sign = 0;
    for (const k of this.perc.known.values()) {
      if (k.conf < 50 || obs.tick - k.tick > 2 * this.tps) continue;
      if (dist(k.x, k.y, e.ox, e.oy) < P.pressNear * UNIT && !site.regions.has(this.intel.region[this.g.cellOf(k.x, k.y)])) n++;
    }
    for (const c of this.perc.sectors) {
      if (c.conf < 15 || c.kind === 'hurt' || c.kind === 'reload') continue;
      const d = dist(c.ox, c.oy, e.ox, e.oy) / UNIT;
      if (d >= c.r0 - 2 && d <= c.r1 + 2 && Math.abs(adiff(angleTo(c.ox, c.oy, e.ox, e.oy), c.dir)) <= P.sectorHalfDeg + 5) sign++;
    }
    for (const q of obs.effects) if (q.kind === 'smoke' && dist(q.x, q.y, e.ox, e.oy) < 8 * UNIT && this.smokes.every((m) => dist(m.x, m.y, q.x, q.y) > 2 * UNIT)) sign++;
    return { n, sign };
  }

  /**
   * CT 道具先拖時間再對槍：入口有腳步聲、看到人、或敵方閃光炸在入口，就先燒入口外側；
   * 兩人以上、敵方閃光、或火快熄了再封煙，目標撐到輪轉到場。
   * 閃光只配對使用：知道入口外有人、而且有隊友正看著那個入口（炸開後由他接著打）才丟；看得到敵人時手放在槍上
   * @param {import('./base.js').Observation} obs @param {CTPlan} p @param {SiteId} s @returns {import('./utility.js').ThrowWish | null}
   */
  ctUtility(obs, p, s) {
    const me = obs.me;
    const t = obs.tick;
    if (obs.round.phase !== 'live' || me.blindTicks > 0 || obs.enemies.length > 0) return null;
    let best = null;
    let top = { n: 0, sign: 0, fl: false };
    // 單一個聲音不算（可能只是路過）：要看到人、兩個以上聲音、或敵方閃光
    let bestS = 1;
    for (const e of this.intel.sites[s].entrances) {
      const q = this.pressure(obs, s, e);
      const fl = this.flashAt(obs, e);
      const sc = 2 * q.n + Math.min(2, q.sign) + (fl ? 3 : 0);
      if (sc > bestS) {
        bestS = sc;
        best = e;
        top = { ...q, fl };
      }
    }
    if (best === null) return null;
    const e = best;
    const outer = { x: e.ox + (e.ox - e.ix) * 0.3, y: e.oy + (e.oy - e.iy) * 0.3 };
    const fire = this.burns.find((b) => t <= b.until && dist(b.x, b.y, outer.x, outer.y) < 4 * UNIT);
    const smoked = this.smokes.some((m) => dist(m.x, m.y, e.ox, e.oy) < P.smokeGap * UNIT);
    const burn = this.chokeBurn(me, s, e);
    const fading = fire !== undefined && fire.until - t < 3 * this.tps;
    // 3.0 觸發時機（落點由效用層算）
    if (burn !== null && fire === undefined && !smoked) this.hint('chokeTime', burn, ['chokeMolotov', 'free']);
    if (!smoked && (top.n >= 2 || top.fl || fading) && this.may(me, 'smoke', ['free'])) this.hint('holdTime', 'smoke', ['holdSmoke', 'free']);
    if (burn !== null && fire === undefined && !smoked && !this.burnsMate(obs, outer.x, outer.y) && this.util.solve(me.x, me.y, outer.x, outer.y) !== null) return { kind: burn, ...outer, why: '燒入口' };
    if (this.can(me, 'smoke', ['free']) && !smoked && (top.n >= 2 || top.fl || fading) && this.util.solve(me.x, me.y, e.ox, e.oy) !== null) return { kind: 'smoke', x: e.ox, y: e.oy, why: '封入口' };
    if (top.n >= 1 && this.can(me, 'flash', ['free']) && !this.flashDone(obs, e)) {
      const th = this.perc.threats(e.ox, e.oy, 50).find((k) => dist(k.x, k.y, e.ox, e.oy) < 10 * UNIT);
      const lay = this.ctLayout(obs, p);
      const partner = obs.teammates.some((m) => m.alive && !m.blind && lay.get(m.id)?.site === s && dist(m.x, m.y, e.x, e.y) < P.deepMax * UNIT && this.g.los(m.x, m.y, e.x, e.y));
      // 時機：記得入口附近有敵人、有搭檔、還沒有隊友看得到他（看得到＝已經開打，來不及閃）
      if (th !== undefined && partner && !this.mateSees(obs, th)) this.hint('pairTime', 'flash', ['free']);
      if (th !== undefined && partner && this.util.solve(me.x, me.y, th.x, th.y) !== null && !this.mateSees(obs, th)) return { kind: 'flash', x: th.x, y: th.y, why: '配對閃' };
    }
    return null;
  }

  /**
   * 回防：點外的人到待命位集結，go 了一起進（先閃）；拆彈器的人優先拆，其他人守炸彈附近看入口；時間不夠就保槍
   * @param {import('./base.js').Observation} obs @param {TacOut} out @param {CTPlan} p @param {number} bx @param {number} by @param {SiteId} s
   * @returns {import('./utility.js').ThrowWish | null}
   */
  retake(obs, out, p, bx, by, s) {
    const me = obs.me;
    const b = obs.bomb;
    out.task = 'retake';
    out.allowPeek = false;
    const left = (b.ticksLeft ?? 0) / this.tps;
    const team = this.defuseTeam(obs, bx, by);
    const feasible = team.filter((m) => m.eta <= left).sort((a, c) => (a.cautious > left ? 1 : 0) - (c.cautious > left ? 1 : 0) || a.eta - c.eta || a.id - c.id);
    const defuser = feasible.find((m) => m.defusing) ?? feasible[0];
    // 保槍：全隊都拆不完；或尚未開始、1 對 3 以上且下回合買不起。
    // 2.6.2（P.saveSmart）：沒有下一回合可存（對方賽點、半場最後一回合）就不保；1 對多時手上是狙擊槍或步槍才保
    const last = P.saveSmart && this.econ.lastChance(obs);
    const worth = !P.saveSmart || this.econ.hasGood(me.loadout.primary);
    // 「下回合買不買得起」要用死了沒槍來算（2.5 用手上的槍算：拿著好槍時永遠算得起，反而不保）
    const outnumbered = !last && worth && team.length === 1 && obs.enemiesAlive >= 3 && this.attrs.discipline >= 0.5 && this.attrs.aggression < 0.6 && this.econ.shortOf(me.money + 1400, P.saveSmart ? null : me.loadout.primary, 'CT') > 0;
    // 隊友已經在拆（而且拆得完）就不保槍，留下來掩護
    if ((defuser === undefined && !last) || (defuser !== undefined && !defuser.defusing && outnumbered)) {
      this.saving = true;
      const away = this.saveSpot(obs, bx, by);
      if (away !== null) out.goal = away;
      out.role = '保槍';
      out.task = 'save';
      out.escape = true;
      out.objective = false;
      if (me.scoped) out.cmds.push({ type: 'scope', on: false });
      return null;
    }
    this.saving = false;
    // 沒有下一回合、又沒人拆得完：照樣去拆（賭對方守包的人不在）
    if (defuser === undefined) {
      const g = team[0];
      if (g === undefined) return null;
      return this.retakeAs(obs, out, p, bx, by, s, g, team);
    }
    return this.retakeAs(obs, out, p, bx, by, s, defuser, feasible);
  }

  /**
   * 回防（定好拆包的人之後）
   * @param {import('./base.js').Observation} obs @param {TacOut} out @param {CTPlan} p @param {number} bx @param {number} by @param {SiteId} s
   * @param {ReturnType<Tactics['defuseTeam']>[number]} defuser @param {ReturnType<Tactics['defuseTeam']>} feasible
   * @returns {import('./utility.js').ThrowWish | null}
   */
  retakeAs(obs, out, p, bx, by, s, defuser, feasible) {
    const me = obs.me;
    const t = obs.tick;
    const b = obs.bomb;
    const myD = dist(me.x, me.y, bx, by);
    const pending = this.defuseTeam(obs, bx, by).some((m) => m.id === me.id && m.pending);
    const clear = obs.enemiesAlive === 0;
    if (me.defuseTicks > 0 && defuser.id !== me.id) {
      out.objective = false;
      out.cmds.push({ type: 'move', x: me.x, y: me.y }); // 明確交接；stop 不會取消引擎拆包。
    }
    const inside = this.inSite(me.x, me.y, s, bx, by);
    const act = P.resLayer && this.res.active;
    // 3.0（驗證清單 a）：回防入口被敵方的煙蓋住就換另一條 CT 路線；go 之後不再換
    if (act && (!(p.go || this.plan === null) || this.retakeRoute < 0)) this.retakeRoute = this.retakeRouteOf(obs, s);
    const stage = this.stageSpots('CT', s, act ? Math.max(0, this.retakeRoute) : 0);
    // 敵人全滅不等指揮的 go（喊話有延遲），也不等突破手
    const go = p.go || this.plan === null || clear;
    if (go && this.goTick < 0) this.goTick = t;
    // go 之後突破手先進：其他還在待命位的人等他進點（最多 P.retakeLead 秒）
    const entry = obs.teammates.find((m) => m.alive && m.id === this.roles.who(ENTRY));
    const lead = go && !clear && entry !== undefined && feasible.some((m) => m.id === entry.id) && !this.inSite(entry.x, entry.y, s, bx, by) && t - this.goTick < P.retakeLead * this.tps;
    if ((!go || lead) && !inside && stage.length > 0) {
      const others = this.ids.filter((id) => this.isAlive(obs, id));
      const sp = stage[Math.max(0, others.indexOf(me.id)) % stage.length];
      out.goal = { x: sp.x, y: sp.y };
      out.hold = sp;
      out.role = lead ? '等突破手先進' : '回防集結';
      if (dist(me.x, me.y, sp.x, sp.y) < 10 * UNIT) out.walk = true;
      return null;
    }
    // go：第一個到的人（離炸彈最近、還在點外）先閃
    /** @type {import('./utility.js').ThrowWish | null} */
    let wish = null;
    const ownRF = act && this.res.claim(me.id, 'flash', ['retakeFlash']) !== null;
    if (!inside && this.can(me, 'flash', ['retakeFlash', 'free']) && (defuser.id !== me.id || ownRF) && t - this.flashHeard > 3 * this.tps) {
      const th = this.perc.threats(bx, by, 30).find((k) => dist(k.x, k.y, bx, by) < 12 * UNIT);
      // 不知道人在哪就閃炸彈：守包的人都在附近。2.6.1：拆包的人正往炸彈走，還沒離炸彈夠遠就不閃炸彈（爆的時候他剛好到）
      const c = th ?? { x: bx, y: by };
      const dm = obs.teammates.find((m) => m.alive && m.id === defuser.id);
      const walking = th === undefined && dm !== undefined && dist(dm.x, dm.y, bx, by) < this.util.blindRange + 8 * UNIT;
      // 時機：拆包的人不在走向炸彈、沒有隊友已經看得到目標、沒有人已經在閃這裡
      if (!walking && !this.mateSees(obs, c) && !this.flashTaken(obs, c)) this.hint('retakeFlashTime', 'flash', ['retakeFlash', 'free']);
      if (!walking && this.util.solve(me.x, me.y, c.x, c.y) !== null && !this.mateSees(obs, c) && !this.flashTaken(obs, c)) wish = { kind: 'flash', x: c.x, y: c.y, why: '回防閃' };
    }
    // 3.0：retakeSmoke 封另一個入口（不是自己這條路進的那個）
    if (wish === null && act && go && !inside && obs.enemies.length === 0 && this.can(me, 'smoke', ['retakeSmoke'])) {
      const mine = this.ctEntrance(s, Math.max(0, this.retakeRoute));
      const e2 = this.intel.sites[s].entrances.filter((e) => e !== mine).sort((a, b) => dist(a.ix, a.iy, bx, by) - dist(b.ix, b.iy, bx, by))[0];
      if (e2 !== undefined) this.hint('retakeSmokeTime', 'smoke', ['retakeSmoke']);
      if (e2 !== undefined && this.smokes.every((m) => dist(m.x, m.y, e2.ix, e2.iy) >= P.smokeGap * UNIT) && this.util.solve(me.x, me.y, e2.ix, e2.iy) !== null) wish = { kind: 'smoke', x: e2.ix, y: e2.iy, why: '回防煙封另一入口' };
    }
    if (wish === null && go && !inside && this.can(me, 'smoke', ['retakeSmoke', 'free']) && obs.enemies.length === 0) {
      const th = this.perc.threats(bx, by, 40).find((k) => dist(k.x, k.y, bx, by) >= 6 * UNIT && dist(k.x, k.y, bx, by) < 20 * UNIT);
      if (th !== undefined) this.hint('retakeSmokeTime2', 'smoke', ['retakeSmoke', 'free']);
      if (th !== undefined && this.smokes.every((m) => dist(m.x, m.y, th.x, th.y) >= P.smokeGap * UNIT) && this.util.solve(me.x, me.y, th.x, th.y) !== null) wish = { kind: 'smoke', x: th.x, y: th.y, why: '回防煙' };
    }
    // 3.0 回防閘門：回防道具的擁有者還活著、還沒有任何回防道具炸開／散開時，點外的人在集結位等（go 後最多 4 秒；剩不到 12 秒不等）
    if (act && go && !inside && !clear && stage.length > 0 && this.retakeGate(obs, (b.ticksLeft ?? 0) / this.tps)) {
      const others = this.ids.filter((id) => this.isAlive(obs, id));
      const sp = stage[Math.max(0, others.indexOf(me.id)) % stage.length];
      out.goal = { x: sp.x, y: sp.y };
      out.hold = sp;
      out.role = wish !== null ? '回防丟道具' : '回防等道具';
      return wish;
    }
    if (defuser.id === me.id) {
      out.goal = { x: bx, y: by };
      out.role = '拆包';
      out.task = 'defuse';
      if (pending) out.objective = true;
      const clear = obs.enemies.length === 0;
      if (myD < 1300 && b.state === 'planted' && me.defuseTicks === 0 && clear && !pending) {
        out.cmds.push({ type: 'defuse' });
        out.objective = true;
      }
      return wish;
    }
    // 掩護：炸彈附近的守點位，看入口；優先 12 格內、看出去的方向不經過炸彈的位置（背對拆包的人）
    const others = this.ids.filter((id) => this.isAlive(obs, id) && id !== defuser.id);
    const k = Math.max(0, others.indexOf(me.id));
    const all = this.postSpots(s, bx, by);
    const away = all.filter((q) => dist(q.x, q.y, bx, by) < 12 * UNIT && Math.abs(adiff(angleTo(q.x, q.y, q.fx, q.fy), angleTo(q.x, q.y, bx, by))) > 70);
    const spots = away.length > 0 ? [...away, ...all.filter((q) => !away.includes(q))] : all;
    const sp = spots.length > 0 ? spots[k % spots.length] : null;
    out.hold = sp;
    out.goal = sp ?? { x: bx, y: by };
    out.role = '回防掩護';
    out.task = 'cover';
    return wish;
  }

  /** 3.0：CT 路線 i 進包點的入口 @param {SiteId} s @param {number} i */
  ctEntrance(s, i) {
    const routes = this.intel.routes.CT[s];
    const r = routes.length === 0 ? null : routes[Math.min(i, routes.length - 1)];
    const pid = r?.portals[r.portals.length - 1];
    return this.intel.sites[s].entrances.find((e) => e.portal === pid) ?? null;
  }

  /**
   * 3.0（驗證清單 a）：回防走哪條 CT 路線：路線 0 的入口被看得到、不是我方丟的煙蓋住，而另一條沒被蓋住，就走另一條
   * @param {import('./base.js').Observation} obs @param {SiteId} s
   */
  retakeRouteOf(obs, s) {
    const n = this.intel.routes.CT[s].length;
    const smoked = (/** @type {number} */ i) => {
      const e = this.ctEntrance(s, i);
      return e !== null && obs.effects.some((q) => q.kind === 'smoke' && Math.min(dist(q.x, q.y, e.ox, e.oy), dist(q.x, q.y, e.ix, e.iy)) < q.radius + UNIT && this.smokes.every((m) => dist(m.x, m.y, q.x, q.y) > 2 * UNIT));
    };
    if (!smoked(0)) return 0;
    for (let i = 1; i < n; i++) if (this.ctEntrance(s, i) !== this.ctEntrance(s, 0) && !smoked(i)) return i;
    return 0;
  }

  /**
   * 3.0：回防閘門要不要等：有活著的回防道具擁有者、go 之後還沒聽到我方閃光或煙、go 不到 4 秒、炸彈還有 12 秒以上
   * @param {import('./base.js').Observation} obs @param {number} left
   */
  retakeGate(obs, left) {
    const t = obs.tick;
    if (left < 12 || t - this.goTick > 4 * this.tps) return false;
    if (this.flashHeard >= this.goTick || this.smokeHeard >= this.goTick || this.retakeThrown >= this.goTick) return false;
    return this.res.items.some((it) => (it.purpose === 'retakeFlash' || it.purpose === 'retakeSmoke') && it.state === 'plan' && this.isAlive(obs, it.owner));
  }

  /**
   * 保槍點：離炸彈 P.saveDist 格以上、走得到的最近格。2.6.1（P.saveHide）：改成 40 步內、離炸彈與敵人（記得的位置、3 秒內的腳步聲方向）
   * 最遠、他們看不到的掩體格，每 P.saveEvery 秒重找（持續拉開，不站在原地）
   * @param {import('./base.js').Observation} obs @param {number} bx @param {number} by
   */
  saveSpot(obs, bx, by) {
    const me = obs.me;
    if (P.saveHide) {
      const t = obs.tick;
      if (this.saveCache !== null && t - this.saveAt < P.saveEvery * this.tps) return this.saveCache;
      const g = this.g;
      const start = g.cellOf(me.x, me.y);
      if (start >= 0) {
        const from = dijkstra(g, [start]);
        /** @type {import('./base.js').Pt[]} */
        const th = this.perc.threats(me.x, me.y, 30).map((k) => ({ x: k.x, y: k.y }));
        for (const q of this.perc.sectors) if (q.kind === 'footstep' && t - q.tick < 3 * this.tps) th.push({ x: q.ox + cosd(q.dir) * ((q.r0 + q.r1) / 2) * UNIT, y: q.oy + sind(q.dir) * ((q.r0 + q.r1) / 2) * UNIT });
        const pts = [{ x: bx, y: by }, ...th];
        let best = -Infinity;
        for (let i = 0; i < g.N; i++) {
          if (!Number.isFinite(from[i]) || from[i] > 400 || this.intel.cover[i] === 0) continue;
          const c = g.center(i);
          if (dist(c.x, c.y, bx, by) < P.saveDist * UNIT) continue;
          let near = Infinity;
          for (const q of pts) near = Math.min(near, dist(c.x, c.y, q.x, q.y));
          const seen = th.some((q) => g.los(q.x, q.y, c.x, c.y)) || g.los(bx, by, c.x, c.y);
          const sc = near / UNIT - (seen ? 15 : 0) - from[i] / 40 - 2 * this.intel.exposure[i];
          if (sc > best) {
            best = sc;
            this.saveCache = c;
          }
        }
        this.saveAt = t;
        if (best > -Infinity && this.saveCache !== null) return this.saveCache;
      }
    }
    if (dist(me.x, me.y, bx, by) >= P.saveDist * UNIT) return { x: me.x, y: me.y };
    const escape = this.judge?.evacuation(obs, bx, by);
    if (escape !== undefined && escape !== null) return escape;
    if (this.saveCache !== null && dist(this.saveCache.x, this.saveCache.y, bx, by) >= P.saveDist * UNIT) return this.saveCache;
    const g = this.g;
    // BFS 太遠的話改走 CT 出生區（多半離包點遠）
    const zone = this.intel.map.spawnZones.CT;
    const c = this.intel.nearestOpen(Math.floor((zone.x0 + zone.x1) / 2), Math.floor((zone.y0 + zone.y1) / 2));
    const z = g.center(c);
    const far = dist(z.x, z.y, bx, by) >= P.saveDist * UNIT ? z : null;
    this.saveCache = far ?? { x: me.x + (me.x - bx), y: me.y + (me.y - by) };
    return this.saveCache;
  }

  // ───────── 共通：換血、追殘血、隊友閃光、手雷 ─────────

  /**
   * 疊在目標之上的小行為：隊友閃光（看得到爆點就轉身）、換血（朝隊友陣亡方向架槍）、紀律低的人追殘血
   * @param {import('./base.js').Observation} obs @param {TacOut} out
   */
  overlay(obs, out) {
    const me = obs.me;
    const t = obs.tick;
    if (out.escape) return;
    // 閃光（自己丟的或隊友喊的）：致盲距離內看得到爆點就躲到最近看不到的格（7 步內），沒有就轉身
    const own = this.util.away !== null && t >= this.util.away.from ? this.util.away : null;
    this.mateFlash = this.mateFlash.filter((x) => t <= x.pop + 2);
    const edge = P.flashEdge * UNIT;
    // 2.6.3：隊友的閃光提前一個反應延遲放行（指令生效時剛好炸開；爆炸時間只會估晚，不會早放）
    // 狙擊手不提早放行（他要等兩個隊友先進點）
    const release = P.flashRelease && this.roles.of(me.id) !== AWP ? this.data.rules.reactionTicks - P.flashReleaseMargin : -2;
    // 不提早放行（release ＝ −2）時到 pop + 2 為止都要躲，含等號（2.6.2 的判定）
    const threat = (/** @type {{ pop: number }} */ x) => (P.flashOffEq && release < 0 ? t <= x.pop + 2 : t < x.pop - release);
    // 2.7（P.flashMulti）：先排除已經放行的那顆再找，第一顆放行不會遮住還要躲的第二顆
    const mf = this.mateFlash.find((x) => dist(me.x, me.y, x.x, x.y) < this.util.blindRange + edge && this.g.los(me.x, me.y, x.x, x.y) && (!P.flashMulti || threat(x)));
    const open = mf !== undefined && threat(mf);
    const f = own !== null ? own : open && mf !== undefined ? { x: mf.x, y: mf.y, until: mf.pop + 2 } : null;
    if (f !== null && t <= f.until && !out.objective) {
      const R = this.util.blindRange;
      const g = this.g;
      const d = dist(me.x, me.y, f.x, f.y);
      // 半徑外不會致盲：停在半徑外等炸開，不用躲
      if (d >= R && d < R + edge && mf !== undefined && g.los(me.x, me.y, f.x, f.y)) {
        out.stop = true;
        // 3.0（r7i）：停步指令要等反應延遲，這段時間會滑進半徑（default 剩下的正對隊友致盲幾乎都是這種）：沒看到敵人就也轉開，只改朝向
        if (P.flashEdgeTurn && obs.enemies.length === 0) {
          out.look = { x: me.x + (me.x - f.x) * 2, y: me.y + (me.y - f.y) * 2 };
          out.urgent = true;
        }
        return;
      }
      // CT 在守位：閃光是對著外面丟的，離開崗位比被閃一下更虧
      if (d < R && g.los(me.x, me.y, f.x, f.y) && me.team === 'T') {
        if (this.hideFor !== f.until) {
          this.hideFor = f.until;
          this.hide = this.nav?.escape(obs, (i) => {
            const c = g.center(i);
            return dist(c.x, c.y, f.x, f.y) < R && g.los(c.x, c.y, f.x, f.y);
          }, 7) ?? null;
        }
        if (this.hide !== null) {
          out.goal = this.hide;
          out.hold = null;
          out.route = null;
          out.allowPeek = false;
          out.stop = false;
          out.walk = false;
        }
        out.look = { x: me.x + (me.x - f.x) * 2, y: me.y + (me.y - f.y) * 2 };
        out.urgent = true;
        // 快爆了（反應延遲＋轉身 180° 的時間內）：交戰中也先轉身
        out.hard = f.until - t <= this.data.rules.reactionTicks + 12;
        return;
      }
    }
    // 3.0（r7i）：只轉朝向、不改位置路線：上面沒躲到的隊友閃光（下包拆包中；或爆點偏了一點、自己算的視線說看不到但其實看得到）
    // 沒看到敵人、在半徑＋邊緣內、爆點附近（±1 格）有視線就背對它；轉向不會打斷下包拆包
    let turned = false;
    if (P.flashEdgeTurn && me.team === 'T' && obs.enemies.length === 0 && own === null) {
      const near = (/** @type {{ x: number, y: number }} */ x) => [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => this.g.los(me.x, me.y, x.x + a * UNIT, x.y + b * UNIT));
      const tf = this.mateFlash.find((x) => threat(x) && dist(me.x, me.y, x.x, x.y) < this.util.blindRange + edge && near(x));
      if (tf !== undefined) {
        out.look = { x: me.x + (me.x - tf.x) * 2, y: me.y + (me.y - tf.y) * 2 };
        out.urgent = true;
        turned = true;
      }
    }
    // 自己或隊友的閃光還沒爆、自己看不到爆點：再走會進視線才停在轉角，否則繼續走（炸開時人才在入口）
    const ownPending = this.util.away !== null && t < this.util.away.until - 3 ? this.util.away : null;
    const pending = ownPending ?? this.mateFlash.find((x) => t < x.pop - Math.max(0, release) && dist(me.x, me.y, x.x, x.y) < this.util.blindRange + ((x.pop - t) / this.tps) * P.routeSpeed * UNIT);
    if (!out.objective && pending !== undefined && this.entersView(obs, pending)) {
      out.stop = true;
      return;
    }
    if (turned) return;
    // 2.7：拆包、下包途中不停（P.tradeSkipTask；defuseTeam 的 eta 沒算這些停頓）
    const busy = P.tradeSkipTask && (out.task === 'defuse' || out.task === 'plant');
    if (this.trade !== null) {
      if (t > this.trade.until) this.trade = null;
      else if (!busy && !out.objective && !out.commit && out.task !== 'execute' && out.task !== 'retake') {
        out.look = { x: this.trade.x, y: this.trade.y };
        out.stop = true;
        return;
      }
    }
    // 不追殘血：紀律低的人，剛丟失的目標估計血量很低而且不遠，就追過去
    const c = this.combat;
    if (c !== null && !busy && this.attrs.discipline < 0.5 && !out.objective && !out.commit && out.task !== 'cover' && obs.enemies.length === 0) {
      if (this.chase === null && c.lostPos !== null && t - c.lostTick < this.tps / 2 && c.targetId >= 0) {
        const hp = 100 - (this.dealt.get(c.targetId) ?? 0);
        if (hp <= P.chaseHp && dist(me.x, me.y, c.lostPos.x, c.lostPos.y) < P.chaseRange * UNIT) this.chase = { x: c.lostPos.x, y: c.lostPos.y, until: t + P.chaseTime * this.tps };
      }
      if (this.chase !== null) {
        if (t > this.chase.until) this.chase = null;
        else {
          out.goal = { x: this.chase.x, y: this.chase.y };
          out.hold = null;
          out.role += '・追殘血';
        }
      }
    }
  }

  /**
   * 前面的已知槍線：隊友剛死（看到殺手就是殺手的位置，否則是死亡點，那裡敵人看得到）、或狙擊手。
   * soon＝再走幾格的位置；只有「現在還沒露出來、再走就露出來」才算
   * @param {import('./base.js').Observation} obs @param {import('./base.js').Pt} soon @returns {(import('./base.js').Pt & { awp: boolean }) | null}
   */
  gunLine(obs, soon) {
    const me = obs.me;
    const g = this.g;
    const t = obs.tick;
    /** @param {import('./base.js').Pt} q */
    const opens = (q) => !g.los(me.x, me.y, q.x, q.y) && g.los(soon.x, soon.y, q.x, q.y);
    for (let i = this.perc.anon.length - 1; i >= 0; i--) {
      const a = this.perc.anon[i];
      if (a.src !== 'death' || t - a.tick >= P.lineMemo * this.tps) continue;
      if (P.lineNewest ? a.tick > this.lineDeath : this.lineDeath !== a.tick) {
        this.lineDeath = a.tick;
        this.lineHeld = 0;
      }
      const th = this.perc.threats(a.x, a.y, 30).find((q) => dist(q.x, q.y, a.x, a.y) < 30 * UNIT && g.los(q.x, q.y, a.x, a.y));
      if (th !== undefined) {
        if (opens(th)) return { x: th.x, y: th.y, awp: false };
      } else {
        const d = dist(me.x, me.y, a.x, a.y);
        if (d > 2 * UNIT && d < P.lineZone * UNIT && dist(soon.x, soon.y, a.x, a.y) < d) return { x: a.x, y: a.y, awp: false };
      }
    }
    const q = this.awp;
    return q !== null && t - q.tick < P.awpMemo * this.tps && dist(me.x, me.y, q.x, q.y) < 45 * UNIT && opens(q) ? { x: q.x, y: q.y, awp: true } : null;
  }

  /**
   * 不走進已知槍線：停在掩體後看著那條線，有煙封煙、有閃閃它，隊友到身邊（狙擊線）或停夠久就一起出去。
   * 補槍由 Cooperation 先處理；這裡是補不到的情況。任務趕時間時不停
   * @param {import('./base.js').Observation} obs @param {TacOut} out @returns {import('./utility.js').ThrowWish | null}
   */
  lineCheck(obs, out) {
    const me = obs.me;
    // CT 不用：下包前的輪轉停了就趕不上；下包後階段不是 live（第二批的回防分支實際上從沒觸發，第三批拿掉）
    if (me.team === 'CT' || out.goal === null || out.stop || out.urgent || out.commit || out.objective || out.escape || obs.enemies.length > 0 || obs.round.phase !== 'live' || obs.enemiesAlive === 0) return null;
    if (obs.round.phaseTicksLeft < 15 * this.tps) return null;
    const w = this.nav?.wps[this.nav.wpIdx];
    if (w === undefined || dist(me.x, me.y, out.goal.x, out.goal.y) < 2 * UNIT) return null;
    const k = Math.min(1, (3 * UNIT) / Math.max(dist(me.x, me.y, w.x, w.y), 1));
    const soon = { x: me.x + (w.x - me.x) * k, y: me.y + (w.y - me.y) * k };
    const q = this.gunLine(obs, soon);
    if (q === null || this.lineHeld >= P.lineHold * this.tps) return null;
    if (q.awp && obs.teammates.some((m) => m.alive && dist(m.x, m.y, me.x, me.y) < 3.5 * UNIT)) return null;
    if (this.smokes.some((s) => segDist(s.x, s.y, soon.x, soon.y, q.x, q.y).d < 3 * UNIT)) return null;
    this.lineHeld += this.data.rules.decisionInterval;
    out.stop = true;
    this.waitTag = 'line';
    out.look = { x: q.x, y: q.y };
    out.role += '・等槍線';
    const d = Math.max(dist(soon.x, soon.y, q.x, q.y), 1);
    const f = Math.min(0.6, (6 * UNIT) / d);
    const sm = { x: soon.x + (q.x - soon.x) * f, y: soon.y + (q.y - soon.y) * f };
    // 3.0 觸發時機：停下來等槍線（落點由效用層算）
    if (this.may(me, 'smoke', ['free'])) this.hint('lineTime', 'smoke', ['free']);
    if (this.may(me, 'flash', ['free']) && d < this.util.flashRadius) this.hint('lineTime2', 'flash', ['free']);
    if (this.can(me, 'smoke', ['free']) && this.util.solve(me.x, me.y, sm.x, sm.y) !== null) return { kind: 'smoke', x: sm.x, y: sm.y, why: '封槍線' };
    if (this.can(me, 'flash', ['free']) && d < this.util.flashRadius && this.util.solve(me.x, me.y, q.x, q.y) !== null && !this.flashTaken(obs, q)) return { kind: 'flash', x: q.x, y: q.y, why: '閃槍線' };
    return null;
  }

  /** 照路徑再走 3 格會看得到 c @param {import('./base.js').Observation} obs @param {import('./base.js').Pt} c */
  entersView(obs, c) {
    const me = obs.me;
    const w = this.nav?.wps[this.nav.wpIdx];
    if (w === undefined) return true;
    const k = Math.min(1, (3 * UNIT) / Math.max(dist(me.x, me.y, w.x, w.y), 1));
    return this.g.los(me.x + (w.x - me.x) * k, me.y + (w.y - me.y) * k, c.x, c.y);
  }

  /**
   * 手雷：記得兩個以上的敵人聚在一起（P.nadeCluster 格內、最近 1 秒看到）就丟過去
   * @param {import('./base.js').Observation} obs @returns {import('./utility.js').ThrowWish | null}
   */
  anyNade(obs) {
    const me = obs.me;
    if (obs.round.phase === 'freeze' || !this.can(me, 'he', ['free'])) return null;
    const list = [...this.perc.known.values()].filter((k) => k.conf >= 70 && obs.tick - k.tick <= this.tps && Math.abs(k.vx) + Math.abs(k.vy) < 40);
    for (const a of list) {
      const near = list.filter((k) => dist(k.x, k.y, a.x, a.y) < P.nadeCluster * UNIT);
      if (near.length < 2) continue;
      this.hint('heTime', 'he', ['free']);
      const x = near.reduce((s, k) => s + k.x, 0) / near.length;
      const y = near.reduce((s, k) => s + k.y, 0) / near.length;
      if (dist(me.x, me.y, x, y) < 6 * UNIT) continue;
      if (obs.teammates.some((m) => m.alive && dist(m.x, m.y, x, y) < 4 * UNIT)) continue;
      return { kind: 'he', x, y, why: '手雷' };
    }
    return null;
  }

  // ───────── 地圖算出的位置（快取） ─────────

  /**
   * 待命格：包點入口外 P.stageBack 格（距離場差）、在路線上、包點守點位看不到的格；附近每人一格（彼此隔 P.stageGap 格）
   * team = T 用 T 路線（佈置）；CT 用 CT 路線（輪轉、回防集結）
   * @param {'T' | 'CT'} team @param {SiteId} s @param {number} routeIdx @param {import('./analysis.js').Route} [over] 指定路線（繞後用，不在路線集裡）
   * @returns {import('./analysis.js').Spot[]}
   */
  stageSpots(team, s, routeIdx, over) {
    const key = `${team}${s}${routeIdx}${over !== undefined ? `L${over.portals.join(',')}` : ''}`;
    const hit = this.spotCache.get(key);
    if (hit !== undefined) return hit;
    const g = this.g;
    const intel = this.intel;
    const routes = intel.routes[team][s];
    const route = over ?? (routes.length === 0 ? null : routes[Math.min(routeIdx, routes.length - 1)]);
    const site = intel.sites[s];
    /** @type {import('./analysis.js').Spot[]} */
    const out = [];
    const pid = route?.portals[route.portals.length - 1];
    const ent = site.entrances.find((e) => e.portal === pid) ?? (team === 'T' ? site.entrances[0] : [...site.entrances].sort((a, b) => a.ctDist - b.ctDist)[0]);
    if (ent === undefined) {
      this.spotCache.set(key, out);
      return out;
    }
    const field = intel.distSite[s];
    const d0 = field[g.cellOf(ent.ox, ent.oy)];
    const want = d0 + P.stageBack * 10;
    const prev = route !== null && route.points.length >= 3 ? route.points[route.points.length - 3] : this.spawnCenter(team);
    // 守位（地圖推導，不是對手實際位置）看得到的格不能當待命位
    const enemyHolds = team === 'T' ? [...site.holds, ...this.midSpots()] : [];
    /** @param {import('./base.js').Pt} c */
    const seenBy = (c) => {
      let n = 0;
      for (const hs of enemyHolds) if (dist(hs.x, hs.y, c.x, c.y) < 30 * UNIT && g.los(hs.x, hs.y, c.x, c.y)) n++;
      return n;
    };
    let best = -1;
    let bestS = -Infinity;
    const R = team === 'T' ? 18 + P.stageRetreatSteps * P.stageRetreat : 18;
    // T 的待命位要在自己路線上（只比到包點的距離，會挑到地圖另一側）；站得到丟煙的格加分
    const onRoute = (/** @type {number} */ i) => team !== 'T' || route === null || route.regionSet.has(intel.region[i]);
    const smokes = team === 'T' ? this.smokeSpots(s, ent) : [];
    const cx0 = Math.floor(ent.ox / UNIT);
    const cy0 = Math.floor(ent.oy / UNIT);
    /** @param {number} target @param {boolean} safe */
    const scan = (target, safe) => {
      for (let y = cy0 - R; y <= cy0 + R; y++) {
        for (let x = cx0 - R; x <= cx0 + R; x++) {
          if (g.isBlock(x, y)) continue;
          const i = y * g.W + x;
          if (site.regions.has(intel.region[i]) || !onRoute(i) || !Number.isFinite(field[i]) || Math.abs(field[i] - target) > 30) continue;
          const c = g.center(i);
          const seen = seenBy(c);
          if (safe && seen > 0) continue;
          const reach = smokes.some((q) => this.util.solve(c.x, c.y, q.x, q.y) !== null) ? 6 : 0;
          const off = segDist(c.x, c.y, prev.x, prev.y, ent.ox, ent.oy).d / UNIT;
          const sc = reach - Math.abs(field[i] - target) / 5 - 1.5 * off - 8 * seen - intel.exposure[i] + (intel.cover[i] !== 0 ? 2 : 0) + (team === 'CT' && g.los(c.x, c.y, ent.x, ent.y) ? 4 : 0);
          if (sc > bestS) {
            bestS = sc;
            best = i;
          }
        }
      }
    };
    // T 先找看不到的格，沒有就往後退；都沒有才用暴露最少的（不無限等待）
    if (team === 'T') for (let k = 0; k <= P.stageRetreatSteps && best < 0; k++) scan(want + k * P.stageRetreat * 10, true);
    const safe = best >= 0;
    if (best < 0) scan(want, false);
    if (best < 0) {
      this.spotCache.set(key, out);
      return out;
    }
    // 每人一格：從待命格 BFS 數步內、不比入口近、彼此隔開，安全待命位展開時逐格驗
    /** @type {number[]} */
    const queue = [best];
    const depth = new Map([[best, 0]]);
    for (let q = 0; q < queue.length && out.length < 5; q++) {
      const i = queue[q];
      const c = g.center(i);
      if (field[i] >= d0 + 40 && !site.regions.has(intel.region[i]) && onRoute(i) && (!safe || seenBy(c) === 0) && out.every((o) => dist(o.x, o.y, c.x, c.y) >= P.stageGap * UNIT)) out.push({ x: c.x, y: c.y, cell: i, fx: ent.x, fy: ent.y, score: 0, entrance: site.entrances.indexOf(ent) });
      const dd = /** @type {number} */ (depth.get(i));
      if (dd >= (safe ? 9 : 4)) continue;
      const x = i % g.W;
      const y = (i - x) / g.W;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const j = (y + dy) * g.W + x + dx;
        if (g.isBlock(x + dx, y + dy) || depth.has(j)) continue;
        depth.set(j, dd + 1);
        queue.push(j);
      }
    }
    // 待命位多半看不到入口：看往入口方向的路最遠看得到的地方（敵人從那裡出來），不對著牆發呆
    if (team === 'T') {
      for (const o of out) {
        let i = o.cell;
        for (let n = 0; n < 60; n++) {
          const x = i % g.W;
          const y = (i - x) / g.W;
          let next = -1;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            if (g.isBlock(x + dx, y + dy)) continue;
            const j = (y + dy) * g.W + x + dx;
            if (field[j] < field[next < 0 ? i : next]) next = j;
          }
          if (next < 0) break;
          const c = g.center(next);
          if (!g.los(o.x, o.y, c.x, c.y)) break;
          i = next;
        }
        const c = g.center(i);
        if (dist(c.x, c.y, o.x, o.y) >= 3 * UNIT) {
          o.fx = c.x;
          o.fy = c.y;
        }
      }
    }
    // 離入口近的在前（組內第 0 個＝突破手站最前面，進點不用穿過隊友）
    if (team === 'T') out.sort((a, b) => dist(a.x, a.y, ent.ox, ent.oy) - dist(b.x, b.y, ent.ox, ent.oy) || a.cell - b.cell);
    this.spotCache.set(key, out);
    return out;
  }

  /** @param {'T' | 'CT'} team */
  spawnCenter(team) {
    const z = this.intel.map.spawnZones[team];
    return this.g.center(this.intel.nearestOpen(Math.floor((z.x0 + z.x1) / 2), Math.floor((z.y0 + z.y1) / 2)));
  }

  /**
   * 中路位：T 路線經過的交界（不是包點入口、離兩個包點都 ≥ 15 格、CT 比 T 早 5 格以上到、不在 CT 出生區）中，
   * 經過的 T 路線最多、到兩點距離接近、CT 領先多的那個；守位在它的 CT 側 8～20 格、看得到它、暴露少（最多 2 個）
   * @returns {import('./analysis.js').Spot[]}
   */
  midSpots() {
    const hit = this.spotCache.get('mid');
    if (hit !== undefined) return hit;
    const g = this.g;
    const intel = this.intel;
    const entrancePortals = new Set([...intel.sites.A.entrances, ...intel.sites.B.entrances].map((e) => e.portal));
    /** @type {Map<number, number>} */
    const uses = new Map();
    for (const s of SITES) for (const r of intel.routes.T[s]) for (const pid of r.portals) uses.set(pid, (uses.get(pid) ?? 0) + 1);
    let pick = null;
    let pickS = -Infinity;
    for (const [pid, n] of uses) {
      if (entrancePortals.has(pid)) continue;
      const p = intel.portals[pid];
      const c = g.cellOf(p.x, p.y);
      if (c < 0) continue;
      const dA = intel.distSite.A[c] / 10;
      const dB = intel.distSite.B[c] / 10;
      const ct = intel.distSpawn.CT[c] / 10;
      const tt = intel.distSpawn.T[c] / 10;
      if (dA < 15 || dB < 15 || ct < 12 || ct + 5 > tt) continue;
      const sc = 10 * n - Math.abs(dA - dB) / 5 + (tt - ct) / 10;
      if (sc > pickS) {
        pickS = sc;
        pick = p;
      }
    }
    /** @type {import('./analysis.js').Spot[]} */
    const out = [];
    if (pick !== null) {
      const ctAt = intel.distSpawn.CT[g.cellOf(pick.x, pick.y)];
      out.push(...this.watchSpots(pick.x, pick.y, (i) => intel.distSpawn.CT[i] < ctAt, 2, [], -1));
    }
    this.spotCache.set('mid', out);
    return out;
  }

  /**
   * 看守位：離 (px, py) P.holdMin～P.holdMax 格、看得到它、ok(格) 為真、暴露少、貼牆或矮牆加分；
   * 取 n 個彼此隔 4 格以上、也離 avoid 4 格以上的
   * @param {number} px @param {number} py @param {(i: number) => boolean} ok @param {number} n @param {import('./analysis.js').Spot[]} avoid @param {number} entrance
   * @returns {import('./analysis.js').Spot[]}
   */
  watchSpots(px, py, ok, n, avoid, entrance) {
    const g = this.g;
    const intel = this.intel;
    /** @type {import('./analysis.js').Spot[]} */
    const ranked = [];
    const R = P.holdMax;
    const cx0 = Math.floor(px / UNIT);
    const cy0 = Math.floor(py / UNIT);
    for (let y = cy0 - R; y <= cy0 + R; y++) {
      for (let x = cx0 - R; x <= cx0 + R; x++) {
        if (g.isBlock(x, y)) continue;
        const i = y * g.W + x;
        if (!ok(i)) continue;
        const c = g.center(i);
        const d = dist(c.x, c.y, px, py) / UNIT;
        if (d < P.holdMin || d > P.holdMax || !g.los(c.x, c.y, px, py)) continue;
        const sc = 100 - 6 * intel.exposure[i] + ((intel.cover[i] & 1) !== 0 ? 8 : 0) + ((intel.cover[i] & 2) !== 0 ? 6 : 0) - Math.abs(d - 13);
        ranked.push({ x: c.x, y: c.y, cell: i, fx: px, fy: py, score: sc, entrance });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.cell - b.cell);
    /** @type {import('./analysis.js').Spot[]} */
    const out = [];
    for (const s of ranked) {
      if (out.length >= n) break;
      if ([...out, ...avoid].every((o) => dist(o.x, o.y, s.x, s.y) >= 4 * UNIT)) out.push(s);
    }
    return out;
  }

  /**
   * 某點的 CT 守位：前兩個用守點位（最可能來的入口的兩個）；疊到 3 人以上時，多出來的人也看那個入口（看守位另外算）
   * @param {SiteId} s @param {number} n @returns {import('./analysis.js').Spot[]}
   */
  siteSpots(s, n) {
    const key = `site${s}${n}`;
    const hit = this.spotCache.get(key);
    if (hit !== undefined) return hit;
    const site = this.intel.sites[s];
    const holds = site.holds;
    /** @type {import('./analysis.js').Spot[]} */
    let out = holds.slice(0, Math.min(2, n));
    if (n > 2 && holds.length > 0) {
      const ei = Math.max(0, holds[0].entrance);
      const e = site.entrances[ei];
      const field = this.intel.distSite[s];
      out = [...out, ...this.watchSpots(e.x, e.y, (i) => field[i] <= P.holdSiteRadius * 10, n - out.length, out, ei)];
    }
    for (let i = 0; out.length < n && holds.length > 0; i++) out.push(holds[i % holds.length]);
    this.spotCache.set(key, out);
    return out;
  }

  /**
   * 這回合守哪幾個位：一到兩人時在前幾個守點位裡輪，不同入口或夠遠才算一組（交叉火力）。
   * 全隊用回合數算，選的一樣，不用喊話
   * @param {SiteId} s @param {number} n @param {number} round @returns {import('./analysis.js').Spot[]}
   */
  pickHolds(s, n, round) {
    const deep = this.deepSpots(s);
    if (n < 1 || deep.length === 0) return this.siteSpots(s, n);
    const roll = rollOf(round, s === 'A' ? 1 : 2);
    if (n === 1 || deep.length === 1) return [deep[roll % Math.min(3, deep.length)], ...this.siteSpots(s, n).slice(0, n - 1)];
    // 兩人都在深位、各自看得到兩個入口（交叉火力），第三人以上補前面的守點位（層次）
    /** @type {import('./analysis.js').Spot[][]} */
    const pairs = [];
    for (let i = 0; i < deep.length; i++) for (let j = i + 1; j < deep.length; j++) pairs.push([deep[i], deep[j]]);
    return [...pairs[roll % pairs.length], ...this.siteSpots(s, n).slice(0, n - 2)];
  }

  /**
   * 深位：包點附近、看得到 T 最可能來的兩個入口（同時在視野內）、離它們都在閃光半徑外（入口的閃光照不到）、暴露少。
   * 取彼此隔 4 格以上的前 4 個；沒有兩個都看得到的格就只看第一個入口
   * @param {SiteId} s @returns {import('./analysis.js').Spot[]}
   */
  deepSpots(s) {
    const key = `deep${s}`;
    const hit = this.spotCache.get(key);
    if (hit !== undefined) return hit;
    const g = this.g;
    const intel = this.intel;
    const site = intel.sites[s];
    const field = intel.distSite[s];
    const R = this.util.flashRadius / UNIT;
    const top = site.entrances.filter((e) => Number.isFinite(e.tDist)).slice(0, 2);
    const fov = this.data.rules.fovDeg;
    /** @type {import('./analysis.js').Spot[]} */
    const ranked = [];
    for (const need of [top.length, 1]) {
      const es = top.slice(0, need);
      for (let i = 0; i < g.N && es.length > 0; i++) {
        if (g.block[i] === 1 || field[i] > P.holdSiteRadius * 10) continue;
        const c = g.center(i);
        let near = Infinity;
        let ok = true;
        for (const e of es) {
          const d = dist(c.x, c.y, e.x, e.y) / UNIT;
          if (d < R + 1 || d > P.deepMax || !g.los(c.x, c.y, e.x, e.y)) ok = false;
          near = Math.min(near, d);
        }
        if (!ok) continue;
        const fx = es.reduce((v, e) => v + e.x, 0) / es.length;
        const fy = es.reduce((v, e) => v + e.y, 0) / es.length;
        if (es.some((e) => Math.abs(adiff(angleTo(c.x, c.y, e.x, e.y), angleTo(c.x, c.y, fx, fy))) > fov * 0.4)) continue;
        const sc = 100 - 6 * intel.exposure[i] + ((intel.cover[i] & 1) !== 0 ? 8 : 0) + ((intel.cover[i] & 2) !== 0 ? 6 : 0) - Math.abs(near - (R + 6)) + (site.regions.has(intel.region[i]) ? 4 : 0);
        ranked.push({ x: c.x, y: c.y, cell: i, fx, fy, score: sc, entrance: site.entrances.indexOf(es[0]) });
      }
      if (ranked.length > 0) break;
    }
    ranked.sort((a, b) => b.score - a.score || a.cell - b.cell);
    /** @type {import('./analysis.js').Spot[]} */
    const out = [];
    for (const q of ranked) {
      if (out.length >= 4) break;
      if (out.every((o) => dist(o.x, o.y, q.x, q.y) >= 4 * UNIT)) out.push(q);
    }
    this.spotCache.set(key, out);
    return out;
  }

  /**
   * 同一個守位每回合小幅變化：3 格內、看得到同一個目標、暴露不比原位多 1 的格，依回合抽
   * @param {import('./analysis.js').Spot} spot @param {number} round @returns {import('./analysis.js').Spot}
   */
  varySpot(spot, round) {
    const key = `vary${spot.cell}`;
    let list = this.spotCache.get(key);
    if (list === undefined) {
      const g = this.g;
      list = [spot];
      const cx = spot.cell % g.W;
      const cy = (spot.cell - cx) / g.W;
      for (let y = cy - 3; y <= cy + 3; y++) {
        for (let x = cx - 3; x <= cx + 3; x++) {
          if (g.isBlock(x, y)) continue;
          const i = y * g.W + x;
          const c = g.center(i);
          const d = dist(c.x, c.y, spot.x, spot.y);
          if (d >= 1.5 * UNIT && d <= 3 * UNIT && g.walkLine(spot.x, spot.y, c.x, c.y) && g.los(c.x, c.y, spot.fx, spot.fy) && this.intel.exposure[i] <= this.intel.exposure[spot.cell] + 1) list.push({ ...spot, x: c.x, y: c.y, cell: i });
        }
      }
      this.spotCache.set(key, list);
    }
    return list[rollOf(round, spot.cell) % list.length];
  }

  /**
   * 狙擊位（長對線）：包點 10 格內、看得到某個入口而且距離 16～28 格、看得到的其他入口少、暴露少；兩個點取分數高的
   * @returns {{ spot: import('./analysis.js').Spot, site: SiteId, len: number } | null}
   */
  sniperSpot() {
    if (this.sniper !== undefined) return this.sniper;
    const g = this.g;
    const intel = this.intel;
    /** @type {{ spot: import('./analysis.js').Spot, site: SiteId, len: number } | null} */
    let best = null;
    let bestS = -Infinity;
    for (const s of SITES) {
      const site = intel.sites[s];
      const field = intel.distSite[s];
      for (let i = 0; i < g.N; i++) {
        if (g.block[i] === 1 || field[i] > 100) continue;
        const c = g.center(i);
        let others = 0;
        let lenBest = 0;
        let ei = -1;
        site.entrances.forEach((e, k) => {
          const d = dist(c.x, c.y, e.x, e.y) / UNIT;
          if (d > 30 || !g.los(c.x, c.y, e.x, e.y)) return;
          if (d >= 16 && d <= 28 && d > lenBest) {
            if (lenBest > 0) others++;
            lenBest = d;
            ei = k;
          } else others++;
        });
        if (ei < 0) continue;
        const sc = 2 * lenBest - 20 * others - 6 * intel.exposure[i] + ((intel.cover[i] & 1) !== 0 ? 6 : 0);
        if (sc > bestS) {
          bestS = sc;
          const e = site.entrances[ei];
          best = { spot: { x: c.x, y: c.y, cell: i, fx: e.x, fy: e.y, score: sc, entrance: ei }, site: s, len: lenBest };
        }
      }
    }
    this.sniper = best;
    return best;
  }
}
