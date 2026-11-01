// 商店的資料與換算（純函式，不碰 DOM，測試可以直接跑）：商品清單由開局規則組成，數值全部從 WeaponInfo／GrenadeInfo 換算，不寫死。
// 對甲傷害照引擎 armorSplit（src/shooter/sim.ts）：護甲吸收 (100 − 穿甲)%（無條件捨去，以剩餘甲值為上限），每顆彈丸各算一次；test/shooter-ux.test.ts 拿引擎的函式對照。
// 精度條：spread 越小越滿 ＝ 同類別最小站定散佈 ÷ 這個散佈；移動精度用同一個基準，站定與移動的長度可以直接比。
import type { BuyItem, GrenadeId, GrenadeInfo, RoundInfo, RulesInfo, ShooterObservation, Team, WeaponId, WeaponInfo } from '../../shooter/api.ts';

/** 計算商店要用到的 meta 欄位（開局規則） */
export interface ShopData {
  readonly rules: RulesInfo;
  readonly weapons: readonly WeaponInfo[];
  readonly grenades: readonly GrenadeInfo[];
  /** 開鏡的移動速度（WeaponInfo 沒有這欄，見 protocol.ts） */
  readonly scopedSpeeds?: Readonly<Partial<Record<WeaponId, number>>>;
}

export type ShopCat = 'pistol' | 'primary' | 'gear' | 'nade';
export const SHOP_CATS: readonly { readonly id: ShopCat; readonly name: string; readonly en: string }[] = [
  { id: 'pistol', name: '手槍', en: 'PISTOL' },
  { id: 'primary', name: '主武器', en: 'PRIMARY' },
  { id: 'gear', name: '護甲與裝備', en: 'GEAR' },
  { id: 'nade', name: '道具', en: 'GRENADE' },
];

export interface ShopEntry {
  /** 不可購買的配發武器也是一張卡（比較用），id 就是武器 id */
  readonly id: BuyItem;
  readonly cat: ShopCat;
  readonly name: string;
  readonly price: number;
  readonly teams: readonly Team[];
  readonly weapon: WeaponInfo | null;
  readonly grenade: GrenadeInfo | null;
}

/** 目前能不能買：可買、錢不夠、已持有（或已滿）、陣營限定（或開局配發）、不在購買時間 */
export type ShopState = 'ok' | 'poor' | 'owned' | 'locked' | 'closed';

export function shopEntries(d: ShopData): ShopEntry[] {
  const gun = (w: WeaponInfo, cat: ShopCat): ShopEntry => ({ id: w.id, cat, name: w.name, price: w.price, teams: w.teams, weapon: w, grenade: null });
  const gear = (id: BuyItem, name: string, price: number, teams: readonly Team[]): ShopEntry => ({ id, cat: 'gear', name, price, teams, weapon: null, grenade: null });
  return [
    ...d.weapons.filter((w) => w.slot === 'secondary').map((w) => gun(w, 'pistol')),
    ...d.weapons.filter((w) => w.slot === 'primary').map((w) => gun(w, 'primary')),
    gear('armor', '護甲', d.rules.armorPrice, ['T', 'CT']),
    // 彈藥不會在回合間自動補；買一次補滿主武器與手槍的備彈（都滿就不扣錢）
    gear('ammo', '補滿彈藥', d.rules.ammoPrice, ['T', 'CT']),
    gear('kit', '拆彈器', d.rules.kitPrice, ['CT']),
    ...d.grenades.map((g) => ({ id: g.id, cat: 'nade' as const, name: g.name, price: g.price, teams: g.teams, weapon: null, grenade: g })),
  ];
}

/** 開局配發：買不到，只留卡片給人比較 */
export const isIssued = (e: ShopEntry): boolean => e.teams.length === 0;

/** 彈藥：看得到的只有手上那把的備彈，手上那把滿了而且沒有別的槍才算「已滿」 */
function ammoFull(d: ShopData, s: ShooterObservation): boolean {
  const active = d.weapons.find((w) => w.id === s.me.weapon);
  return active !== undefined && s.me.ammoReserve >= active.reserve && (s.me.loadout.primary === null || s.me.loadout.secondary === null);
}

export function isOwned(d: ShopData, e: ShopEntry, s: ShooterObservation): boolean {
  const lo = s.me.loadout;
  if (e.id === 'ammo') return ammoFull(d, s);
  if (e.id === 'armor') return lo.armor >= d.rules.maxArmor;
  if (e.id === 'kit') return lo.kit;
  if (e.grenade !== null) return lo.grenades.filter((x) => x === e.id).length >= e.grenade.maxCarry || lo.grenades.length >= d.rules.grenadeSlots;
  return lo.primary === e.id || lo.secondary === e.id;
}

export function shopState(d: ShopData, e: ShopEntry, s: ShooterObservation): ShopState {
  if (isOwned(d, e, s)) return 'owned';
  if (!e.teams.includes(s.me.team)) return 'locked';
  if (!s.round.canBuy) return 'closed';
  return s.me.money >= e.price ? 'ok' : 'poor';
}

/** 點了買不了時的說明 */
export function stateNote(e: ShopEntry, st: ShopState, money: number): string {
  if (st === 'poor') return `${e.name}：還差 $${e.price - money}`;
  if (st === 'owned') return e.grenade !== null ? `${e.name}：已達攜帶上限` : e.id === 'armor' || e.id === 'ammo' ? `${e.name}：已經是滿的` : `${e.name}：已持有`;
  if (st === 'locked') return isIssued(e) ? `${e.name}：開局配發，不能購買` : `${e.name}：限 ${e.teams.join('／')} 購買`;
  if (st === 'closed') return '不在購買時間或出生區';
  return '';
}

/** 剩餘購買時間（tick）：購買時間從凍結開始算；回合階段算得出來，不讀引擎 */
export function buyTicksLeft(round: RoundInfo, rules: RulesInfo): number {
  if (round.phase === 'freeze') return Math.max(0, rules.buyTicks - (rules.freezeTicks - round.phaseTicksLeft));
  if (round.phase === 'live') return Math.max(0, rules.buyTicks - rules.freezeTicks - (rules.roundTicks - round.phaseTicksLeft));
  return 0;
}

export const rpmOf = (w: WeaponInfo, tps: number): number => Math.round((60 * tps) / w.fireTicks);
export const reloadSeconds = (w: WeaponInfo, tps: number): number => w.reloadTicks / tps;
export const cellsPerSecond = (speed: number, tps: number, unit: number): number => (speed * tps) / unit;
export const speedPercent = (speed: number, knife: WeaponInfo): number => Math.round((speed / knife.speed) * 100);

/** 打滿一發（霰彈全部彈丸中）對 armor 點護甲的目標扣多少血：逐顆照引擎 armorSplit，甲值打完後全額 */
export function bodyDamage(w: WeaponInfo, armor: number): number {
  let left = armor;
  let hp = 0;
  for (let i = 0; i < w.pellets; i++) {
    const absorbed = left <= 0 ? 0 : Math.min(left, Math.floor((w.damage * (100 - w.armorPen)) / 100));
    hp += w.damage - absorbed;
    left -= absorbed;
  }
  return hp;
}

/** 精度：best／spread，0～1 */
export const accuracyFrac = (spread: number, best: number): number => (spread <= 0 ? 1 : Math.min(1, best / spread));

/** 散佈 → 顯示字（度 ×100 → ±度） */
const degText = (spread: number): string => `±${(spread / 100).toFixed(2)}°`;
const fix1 = (v: number): string => v.toFixed(1);

export interface StatRow {
  readonly key: string;
  readonly label: string;
  /** 顯示的字 */
  readonly text: string;
  /** 比較用的數值；沒有比較意義為 null（自動／點放） */
  readonly value: number | null;
  /** 1＝越大越好、−1＝越小越好、0＝不比 */
  readonly better: 1 | -1 | 0;
  /** 長條 0～1（同類別內正規化）；null＝不畫 */
  readonly frac: number | null;
  /** 差值的字（單位同 text） */
  readonly unit: string;
}

interface Metric {
  readonly key: string;
  readonly label: string;
  readonly better: 1 | -1;
  readonly unit: string;
  readonly get: (w: WeaponInfo) => number;
  readonly text: (w: WeaponInfo) => string;
  /** 長條的基準：同類別的極值用另一個量（站定、移動精度共用站定最小值） */
  readonly basis?: (w: WeaponInfo) => number;
}

function metrics(d: ShopData): readonly Metric[] {
  const tps = d.rules.ticksPerSecond;
  const unit = d.rules.unit;
  const knife = d.weapons.find((w) => w.id === 'knife') as WeaponInfo;
  const total = (w: WeaponInfo): number => w.damage * w.pellets;
  return [
    { key: 'damage', label: '傷害', better: 1, unit: '', get: total, text: (w) => (w.pellets > 1 ? `${w.damage} × ${w.pellets}` : `${w.damage}`) },
    { key: 'armored', label: '對 100 甲', better: 1, unit: '', get: (w) => bodyDamage(w, 100), text: (w) => `${bodyDamage(w, 100)}` },
    { key: 'rpm', label: '射速', better: 1, unit: '', get: (w) => rpmOf(w, tps), text: (w) => `${rpmOf(w, tps)} 發／分` },
    { key: 'mag', label: '彈匣／備彈', better: 1, unit: ' 發', get: (w) => w.magazine, text: (w) => `${w.magazine}／${w.reserve}` },
    { key: 'reload', label: '換彈', better: -1, unit: ' 秒', get: (w) => reloadSeconds(w, tps), text: (w) => `${fix1(reloadSeconds(w, tps))} 秒` },
    { key: 'pen', label: '穿甲', better: 1, unit: '%', get: (w) => w.armorPen, text: (w) => `${w.armorPen}%` },
    { key: 'range', label: '有效射程', better: 1, unit: ' 格', get: (w) => w.range, text: (w) => `${w.range} 格` },
    { key: 'falloff', label: '每 10 格衰減', better: -1, unit: '%', get: (w) => w.falloffPer10, text: (w) => `${w.falloffPer10}%` },
    { key: 'speed', label: '移動速度', better: 1, unit: '%', get: (w) => speedPercent(w.speed, knife), text: (w) => `${fix1(cellsPerSecond(w.speed, tps, unit))} 格／秒（${speedPercent(w.speed, knife)}%）` },
    { key: 'stand', label: '站定精度', better: -1, unit: '°', get: (w) => w.spread / 100, text: (w) => degText(w.spread), basis: (w) => w.spread / 100 },
    { key: 'move', label: '移動精度', better: -1, unit: '°', get: (w) => (w.spread * w.movingMul) / 100, text: (w) => degText(w.spread * w.movingMul), basis: (w) => w.spread / 100 },
    { key: 'reward', label: '擊殺獎金', better: 1, unit: '', get: (w) => w.killReward, text: (w) => `$${w.killReward}` },
  ];
}

/** 武器的數值列；長條在 pool（同類別，含配發）內正規化 */
export function weaponRows(d: ShopData, w: WeaponInfo, pool: readonly WeaponInfo[]): StatRow[] {
  const tps = d.rules.ticksPerSecond;
  const knife = d.weapons.find((x) => x.id === 'knife') as WeaponInfo;
  const rows: StatRow[] = [];
  for (const m of metrics(d)) {
    const v = m.get(w);
    const basis = pool.map(m.basis ?? m.get).filter((x) => x > 0);
    const frac = m.better > 0 ? v / Math.max(...basis) : v <= 0 ? 1 : Math.min(1, Math.min(...basis) / v);
    rows.push({ key: m.key, label: m.label, text: m.text(w), value: v, better: m.better, frac, unit: m.unit });
    if (m.key === 'rpm') rows.push({ key: 'auto', label: '射擊方式', text: w.automatic ? '自動' : '點放', value: null, better: 0, frac: null, unit: '' });
  }
  if (w.scoped) {
    const sp = d.scopedSpeeds?.[w.id];
    if (sp !== undefined) rows.push({ key: 'scopeSpeed', label: '開鏡移速', text: `${fix1(cellsPerSecond(sp, tps, d.rules.unit))} 格／秒（${speedPercent(sp, knife)}%）`, value: null, better: 0, frac: sp / knife.speed, unit: '' });
    const spread = w.scopedSpread;
    if (spread !== null) rows.push({ key: 'scopeSpread', label: '開鏡精度', text: degText(spread), value: null, better: 0, frac: accuracyFrac(spread, Math.min(...pool.map((x) => x.spread))), unit: '' });
  }
  return rows;
}

/** 和參考的槍比：1＝這把比較好、−1＝比較差、0＝相同或不比 */
export function compareRow(row: StatRow, ref: readonly StatRow[]): { readonly sign: 1 | -1 | 0; readonly delta: string } {
  const r = ref.find((x) => x.key === row.key);
  if (row.value === null || r === undefined || r.value === null || row.better === 0) return { sign: 0, delta: '' };
  const diff = row.value - r.value;
  if (Math.abs(diff) < 1e-9) return { sign: 0, delta: '' };
  const n = Number.isInteger(diff) ? `${Math.abs(diff)}` : Math.abs(diff).toFixed(Math.abs(diff) < 0.1 ? 2 : 1);
  return { sign: (diff > 0 ? 1 : -1) * row.better > 0 ? 1 : -1, delta: `${diff > 0 ? '+' : '−'}${n}${row.unit}` };
}

/** 比較對象：身上同槽位的槍；那一槽沒有就比手上的槍；刀不比 */
export function compareTarget(d: ShopData, w: WeaponInfo, s: ShooterObservation): WeaponInfo | null {
  const same = w.slot === 'primary' ? s.me.loadout.primary : s.me.loadout.secondary;
  const id = same ?? s.me.weapon;
  if (id === w.id || id === 'knife') return null;
  return d.weapons.find((x) => x.id === id) ?? null;
}

const TEAM_TEXT = (teams: readonly Team[]): string => (teams.length === 2 ? 'T／CT' : teams.join('／'));

/** 道具的數值列 */
export function grenadeRows(d: ShopData, g: GrenadeInfo): { readonly label: string; readonly text: string }[] {
  const tps = d.rules.ticksPerSecond;
  const fire = g.id === 'molotov' || g.id === 'incendiary';
  return [
    { label: '最多攜帶', text: `${g.maxCarry} 顆` },
    { label: '效果半徑', text: `${fix1(g.radius / d.rules.unit)} 格` },
    { label: '持續', text: g.durationTicks > 0 ? `${fix1(g.durationTicks / tps)} 秒` : '瞬間' },
    { label: '引信', text: `${fix1(g.fuseTicks / tps)} 秒` },
    { label: '傷害', text: g.damage === 0 ? '無' : fire ? `每秒 ${g.damage}（不吃護甲）` : `中心 ${g.damage}，往外遞減` },
    { label: '陣營', text: TEAM_TEXT(g.teams) },
  ];
}

/** 道具的一句效果 */
export function grenadeNote(d: ShopData, id: GrenadeId): string {
  const r = d.rules.grenadeRules;
  const tps = d.rules.ticksPerSecond;
  if (id === 'flash') return `朝向爆點最長致盲 ${fix1(r.flashFrontTicks / tps)} 秒、側向 ${fix1(r.flashSideTicks / tps)} 秒；牆與煙擋得住`;
  if (id === 'smoke') return `${fix1(r.smokeBloomTicks / tps)} 秒內擴散完成，擋視線與閃光`;
  if (id === 'he') return `護甲吸收 ${r.heArmorPct}%；牆擋得住，煙擋不住`;
  return '落地起火封路，牆擋火；一路燒到持續時間結束';
}

/** 裝備的一句效果 */
export function gearNote(d: ShopData, id: BuyItem): string {
  const r = d.rules;
  const tps = r.ticksPerSecond;
  if (id === 'armor') return `補滿到 ${r.maxArmor} 點；吸收子彈傷害（100 − 穿甲 %），已滿不扣錢`;
  if (id === 'kit') return `拆彈時間 ${fix1(r.defuseTicks / tps)} 秒縮短成 ${fix1(r.defuseKitTicks / tps)} 秒；限 CT`;
  return '補滿主武器與手槍的備彈，回合間不會自動補；都滿就不扣錢';
}
