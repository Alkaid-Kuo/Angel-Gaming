// 軍團戰數值總表：直接讀引擎的數值（config.ts），產生 docs/軍團戰 數值總表.md。改了數值就重跑一次，文件永遠和程式一致。
// 用法：node scripts/legion-datasheet.ts
import { writeFileSync } from 'node:fs';
import { DASH, FORMATION_NAMES, LEGION_ENGINE_VERSION, RULES, SPEED_SCALE, TPS, TERRAIN_NAMES, TILE, UNIT_KINDS, UNITS, VERSUS, type DashDef, type FormationKind, type UnitKind } from '../src/legion/config.ts';
import { formationShape } from '../src/legion/formation.ts';

const OUT = 'docs/軍團戰 數值總表.md';
const tiles = (u: number): string => `${+(u / TILE).toFixed(2)}`;
const sec = (t: number): string => `${+(t / TPS).toFixed(2)} 秒`;
/** 遊戲內速度（單位／tick）→ 規格刻度（格／秒，未乘全域速度倍率） */
const specSpeed = (v: number): string => `${+((v * TPS * 100) / TILE / SPEED_SCALE).toFixed(2)}`;
const pct = (v: number): string => `${v}%`;
const x100 = (v: number): string => `×${+(v / 100).toFixed(2)}`;
const SKILL_NAMES = { brace: '槍林', assault: '突擊', shield: '盾牆', volley: '齊射', infiltrate: '切入', charge: '衝鋒' } as const;

function formation(kind: UnitKind, f: FormationKind): string {
  const u = UNITS[kind];
  const depth = Math.max(2, Math.ceil(u.men / u.squareWidth));
  const s = formationShape(f, u.men, u.lineWidth, depth, u.spacingX, u.spacingY);
  let rows: string;
  if (f === 'wedge') {
    const r: number[] = [];
    for (let left = u.men, i = 0; left > 0; i++) {
      const c = Math.min(left, 2 * i + 1);
      r.push(c);
      left -= c;
    }
    rows = r.join('＋');
  } else if (f === 'circle') rows = `${s.ranks} 圈`;
  else {
    const full = Math.floor(u.men / s.files);
    const rest = u.men - full * s.files;
    rows = `${s.files} × ${full}${rest > 0 ? `＋${rest}` : ''}`;
  }
  return `${FORMATION_NAMES[f]} ${rows}（${tiles(s.halfW * 2)} × ${tiles(s.halfD * 2)} 格）`;
}

const L: string[] = [];
const p = (s = ''): number => L.push(s);
p('# 軍團戰 數值總表');
p();
p(`引擎版本 ${LEGION_ENGINE_VERSION}。**這份文件由 \`node scripts/legion-datasheet.ts\` 直接從引擎數值產生，請不要手改**；規則的設計理由見各版規格書。`);
p();
p(`單位：1 格 = ${TILE} 單位、每秒 ${TPS} tick。血量、攻擊為一般單位（引擎內部 ×10）。速度為規格刻度（格／秒），遊戲內實際速度 ＝ 規格刻度 × 全域速度倍率 ${SPEED_SCALE / 100}。`);
p();
p('## 一、兵種');
p();
p('| 兵種 | 點數 | 人數 | 單兵血量 | 攻擊／間隔 | 近戰觸及 | 射程 | 速度 | 視野 | 近戰減免 | 遠程減免 | 轉向 | 招牌技能 |');
p('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const k of UNIT_KINDS) {
  const u = UNITS[k];
  const atk = u.range > 0 ? `弓 ${u.attack / 10}、近戰 ${u.meleeAttack / 10}／${sec(u.cooldown)}` : `${u.attack / 10}／${sec(u.cooldown)}`;
  const speed = k === 'shield' ? `持盾 ${specSpeed(RULES.shield.carry.speed)}、舉盾 ${specSpeed(RULES.shield.raise.speed)}` : specSpeed(u.speed);
  const dr = k === 'shield' ? '依姿態' : null;
  p(`| ${u.name} | ${u.cost} | ${u.men} | ${u.hp / 10} | ${atk} | ${tiles(u.reach)} 格 | ${u.range > 0 ? `${tiles(u.range)} 格` : '—'} | ${speed} | ${tiles(u.sight)} 格 | ${dr ?? pct(u.meleeDR)} | ${dr ?? pct(u.rangedDR)} | ${u.turn * TPS}°／秒 | ${SKILL_NAMES[u.skill]} |`);
}
p();
p('**相剋加成**（攻擊方 → 目標，只有加成）：');
for (const k of UNIT_KINDS) {
  const v = Object.entries(VERSUS[k]);
  if (v.length > 0) p(`- ${UNITS[k].name} → ${v.map(([t, m]) => `${UNITS[t as UnitKind].name} ${x100(m!)}`).join('、')}`);
}
p();
p('**陣形**（第一個是預設；寬 × 深是隊形的外框）：');
p();
p('| 兵種 | 間距（橫 × 縱） | 陣形 |');
p('| --- | --- | --- |');
for (const k of UNIT_KINDS) {
  const u = UNITS[k];
  p(`| ${u.name} | ${tiles(u.spacingX)} × ${tiles(u.spacingY)} 格 | ${u.formations.map((f) => formation(k, f)).join('<br>')} |`);
}
p();
p(`換陣形要 ${sec(RULES.formationSwitchTicks)}，期間不能攻擊。人數變少時：橫陣保住寬度（最少 2 排才變窄）、方陣保住厚度（先變窄）、圓陣縮小、楔形陣等比例縮小。`);
p();
p('## 二、招牌技能');
p();
const B = RULES.brace;
p(`**槍林**（長槍）：架好 ${sec(B.setTicks)}、收起 ${sec(B.unsetTicks)}，期間不能移動、轉向。正面（±${RULES.flank.frontHalf}°）再減免 ${pct(B.frontDR)}、正面攻速 ${x100(B.attackSpeed)}。正面撞來的敵人速度超過 ${specSpeed(B.speedThreshold)}，每多 1（規格刻度）傷害 +${B.speedCoef}%。迎擊：衝刺中的敵人進入 ${tiles(B.counterReach)} 格內，不管冷卻都刺（每人每 ${sec(B.counterTicks)}一次），每刺中扣對方 ${B.stab / 100} 衝勁。圓陣的槍林：沒有迎擊，速度加成與扣衝勁 ${pct(B.circlePct)}。霸體：不會被擊倒、擠開、推擠。`);
p();
const S = RULES.shield;
p(`**盾兵姿態**：切換持盾／舉盾 ${sec(S.switchTicks)}；盾牆架起 ${sec(S.wallSetTicks)}、收起 ${sec(S.wallUnsetTicks)}，不能動。`);
p();
p('| 姿態 | 速度 | 自己近戰減免 | 自己遠程減免 | 掩護區遠程減免 | 掩護區近戰減免 |');
p('| --- | --- | --- | --- | --- | --- |');
p(`| 持盾 | ${specSpeed(S.carry.speed)} | ${pct(S.carry.meleeDR)} | ${pct(S.carry.rangedDR)} | ${pct(S.cover.carry.rangedDR)} | ${pct(S.cover.carry.meleeDR)} |`);
p(`| 舉盾 | ${specSpeed(S.raise.speed)} | ${pct(S.raise.meleeDR)} | ${pct(S.raise.rangedDR)} | ${pct(S.cover.raise.rangedDR)} | ${pct(S.cover.raise.meleeDR)} |`);
p(`| 盾牆 | 不能動 | 正面 ${pct(S.wall.meleeDR)} | 正面 ${pct(S.wall.rangedDR)} | ${pct(S.cover.wall.rangedDR)} | ${pct(S.cover.wall.meleeDR)} |`);
p();
p(`掩護區：盾兵隊形正後方、同寬、往後 ${tiles(S.cover.depth)} 格；攻擊來自盾兵正面 ±${S.cover.frontHalf}° 才減免，不疊加。盾牆正面霸體只擋步兵（突擊、切入、推擠），對騎兵的阻擋值 ${RULES.dash.wallBlockCavalry / 100}。`);
p();
const V = RULES.volley;
p(`**齊射**（弓兵）：射程內一塊半徑 ${tiles(V.radius)} 格的地面，持續 ${sec(V.duration)}，射擊間隔 ÷${V.rateDiv}；落點 ${tiles(V.hitRadius)} 格內的敵兵中箭（看不到也打得到）；期間不能移動；冷卻 ${sec(V.cooldown)}。`);
p();
p('**衝刺類技能**：');
p();
p('| 技能 | 最遠 | 衝刺速度 | 助跑 | 轉向上限 | 冷卻 | 衝勁 | 撞擊 | 衝擊力 | 霸體 |');
p('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
const dashRow = (name: string, d: DashDef): number => p(`| ${name} | ${tiles(d.dist)} 格 | ${specSpeed(d.speed)} | ${d.runup ? `${tiles(d.runup)} 格` : '—'} | ${d.turn * TPS}°／秒 | ${sec(d.cooldown)} | ${d.momentum / 100} | ${d.impact ? d.impact / 10 : '—'} | ${d.power / 10} | ${d.superArmor ? '有' : '—'} |`);
dashRow('突擊（劍士）', DASH.assault);
dashRow('切入（輕步兵）', DASH.infiltrate);
dashRow('衝鋒（輕騎兵）', DASH.lightCav);
dashRow('衝鋒（重騎兵）', DASH.heavyCav);
p();
const D = RULES.dash;
p('- 地形各自判定：衝刺中的人碰到擋衝刺的地形（騎兵：樹林、淺灘、河流、建築、城牆；步兵：河流、建築、城牆）就停在邊上，其他人照樣衝；全部停下或距離用完才結束，結束後軍團位置歸到士兵實際所在的中心。');
p(`- 楔形陣衝勁 ${x100(D.wedgeMomentum)}；每撞到一個士兵扣掉對方的阻擋值（一般 ${D.block / 100}、槍林正面 ${D.braceBlock / 100}）。`);
p(`- 突擊：把人往兩側擠開 ${tiles(D.pushAside)} 格、接觸後 ${sec(D.penetrateTicks)}內可以擠進敵陣、每人第一擊 ${x100(D.firstHit)}。`);
p(`- 騎兵撞到的人被擊倒 ${sec(RULES.knockdownTicks)}；輕騎兵衝鋒中 ${sec(D.interruptWindow)}內受到超過單兵血量 ${pct(D.interruptPct)} 的傷害就被打斷。`);
p(`- 切入中被箭射中的機率 ${pct(RULES.evadeHitChance)}（平常 ${pct(RULES.ranged.hitChance)}）。`);
p(`- 衝刺對撞：衝擊力相差 ${pct(D.clashTie)} 以內兩邊都停，否則弱的一方停下。`);
p();
p('## 三、戰鬥共通');
p();
p(`- 方向：正面 ±${RULES.flank.frontHalf}°（楔形陣 ±${RULES.flank.wedgeFrontHalf}°）、背面 ±${RULES.flank.rearHalf}°；側擊 ${x100(RULES.flank.side)}、背擊 ${x100(RULES.flank.rear)}；圓陣沒有側背。`);
p(`- 弓箭：命中率 ${pct(RULES.ranged.hitChance)}、箭速每秒 ${tiles(RULES.ranged.arrowSpeed * TPS)} 格；${tiles(RULES.ranged.pinned)} 格內有敵兵的弓兵拉不開弓，只能近戰。`);
p(`- 士兵間距下限：友軍 ${tiles(RULES.soldier.friendGap)} 格、敵軍 ${tiles(RULES.soldier.enemyGap)} 格。`);
p(`- 老兵：累積傷害達本團初始總血量的 ${RULES.veteran.levels.slice(1).map((l) => pct(l.threshold)).join('、')} 升級，攻擊與血量 ${RULES.veteran.levels.slice(1).map((l) => `+${l.attack - 100}%`).join('、')}。`);
p(`- 隱蔽：樹林中的軍團，敵人要在 ${tiles(RULES.vision.concealDetect)} 格內（輕步兵 ${tiles(RULES.vision.concealDetectLight)} 格）才看得到；主動攻擊後曝光 ${sec(RULES.vision.revealTicks)}。`);
p('- 沒有潰散：每一團打到最後一人。');
p();
p('## 四、地形與高度');
p();
p('| 地形 | 通行 | 移動 | 其他 |');
p('| --- | --- | --- | --- |');
p(`| ${TERRAIN_NAMES[0]} | 可 | ×1 | — |`);
p(`| ${TERRAIN_NAMES[1]}、${TERRAIN_NAMES[6]} | 可 | ×1.25 | — |`);
p(`| ${TERRAIN_NAMES[2]} | 可 | ×0.6（輕步兵 ×1） | 隱蔽；受到的遠程傷害 −${pct(RULES.terrain.forestRangedDR)}；擋下騎兵衝鋒 |`);
p(`| ${TERRAIN_NAMES[4]} | 可 | ×0.5 | 受到的近戰傷害 ${x100(RULES.terrain.shallowMeleeTaken)}；不能衝鋒 |`);
p(`| ${TERRAIN_NAMES[5]}、${TERRAIN_NAMES[7]}、${TERRAIN_NAMES[8]} | 不可 | — | 擋視線、擋衝鋒 |`);
p();
const H = RULES.height;
p(`高度（每差 1 階，上限 ±${H.clamp} 階）：所在高度每 1 階視野 +${tiles(H.sightPerLevel)} 格；比目標高射程 +${tiles(H.rangePerLevel)} 格；遠程傷害 ±${H.rangedPerLevel}%；近戰從高往下打 ±${H.meleePerLevel}%；上坡移動 ${x100(H.uphillSpeed)}、下坡 ${x100(H.downhillSpeed)}；衝刺每下降 1 階 +${H.dashDown}%、每上升 1 階 −${H.dashUp}%（${H.dashMin}～${H.dashMax}%）。`);
p();
p('## 五、比賽');
p();
p(`- 殲滅戰：${RULES.budget} 點；${RULES.timeLimitTicks / TPS / 60} 分鐘；打光對手獲勝，時間到比戰果（擊殺敵兵的點數價值）。`);
const C = RULES.capture;
p(`- 佔點：共 ${C.budget} 點、場上最多 ${C.fieldCap} 點；${C.timeLimitTicks / TPS / 60} 分鐘；旗圈半徑 ${tiles(C.radius)} 格、${sec(C.captureTicks)}佔滿；先到 ${C.scoreTarget} 分獲勝，時間到先比分數再比戰果。`);
p(`- 後備：入場準備 ${sec(C.enterTicks)}；出生點半徑 ${tiles(C.spawnRadius)} 格、補給站 ${tiles(C.supplyRadius)} 格；在範圍內 ${sec(C.healQuietTicks)}沒受傷，每秒回單兵血量上限的 ${pct(C.healPct)}。`);
p(`- 指令：每 ${sec(RULES.decisionInterval)}最多 ${RULES.commandsPerDecision} 個；布陣區寬 ${RULES.deployDepthTiles} 格。`);
p();
writeFileSync(OUT, L.join('\n'));
console.log(`寫入 ${OUT}（${L.length} 行）`);
