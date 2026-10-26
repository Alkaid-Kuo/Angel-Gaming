// 經營頁 v2 的程序化美術：圖示、隊徽、選手頭像、流派徽記、版本稀有度。
// 全部是內嵌 SVG 字串，不需要外部素材；同一個選手／戰隊每次畫出來都一樣（由代號雜湊決定）。

let uid = 0;
const nextId = (p: string): string => `${p}${++uid}`;

export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 由字串導出的小亂數（只給美術用，與遊戲結果無關） */
function rngOf(seed: string): () => number {
  let a = hashStr(seed);
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  a = Math.imul(a ^ (a >>> 16), 0x45d9f3b);
  a = (a ^ (a >>> 16)) | 1;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next();
  next();
  return next;
}

function pick<T>(r: () => number, arr: readonly T[]): T {
  return arr[Math.floor(r() * arr.length)];
}

// ───── 線條圖示（24 × 24） ─────
const ICONS = {
  home: 'M3 11 L12 3 L21 11 M5 9.5 V21 H19 V9.5 M10 21 V15 H14 V21',
  users: 'M9 11 A3.5 3.5 0 1 0 9.01 11 M2.5 20.5 C2.5 16.5 5.5 14.5 9 14.5 C12.5 14.5 15.5 16.5 15.5 20.5 M15.5 4.6 A3.2 3.2 0 0 1 15.5 10.9 M17.5 14.6 C20 15.2 21.5 17 21.5 20.5',
  contract: 'M6 3 H15 L19 7 V21 H6 Z M15 3 V7 H19 M9 11 H16 M9 14.5 H16 M9 18 H13',
  target: 'M12 3 A9 9 0 1 0 12.01 3 Z M12 7 A5 5 0 1 0 12.01 7 Z M12 11 A1 1 0 1 0 12.01 11 Z',
  trophy: 'M8 4 H16 V9 A4 4 0 0 1 8 9 Z M8 5.5 H4.5 C4.5 9 6 10.5 8.5 10.5 M16 5.5 H19.5 C19.5 9 18 10.5 15.5 10.5 M12 13 V17 M9.5 17 H14.5 V20.5 H9.5 Z',
  ticket: 'M3 7 H21 V10 A2 2 0 0 0 21 14 V17 H3 V14 A2 2 0 0 0 3 10 Z M14 7 V9 M14 11 V13 M14 15 V17',
  coins: 'M12 4 C16.4 4 20 5.3 20 7 C20 8.7 16.4 10 12 10 C7.6 10 4 8.7 4 7 C4 5.3 7.6 4 12 4 Z M4 7 V12 C4 13.7 7.6 15 12 15 C16.4 15 20 13.7 20 12 V7 M4 12 V17 C4 18.7 7.6 20 12 20 C16.4 20 20 18.7 20 17 V12',
  mail: 'M3 6 H21 V18 H3 Z M3 6 L12 13 L21 6',
  star: 'M12 3 L14.6 8.6 L20.6 9.3 L16.2 13.4 L17.4 19.4 L12 16.4 L6.6 19.4 L7.8 13.4 L3.4 9.3 L9.4 8.6 Z',
  hourglass: 'M6 3 H18 M6 21 H18 M7 3 C7 8 12 9.5 12 12 C12 14.5 7 16 7 21 M17 3 C17 8 12 9.5 12 12 C12 14.5 17 16 17 21',
  back: 'M19.5 12 H4.5 M10.5 6 L4.5 12 L10.5 18',
  menu: 'M4 7 H20 M4 12 H20 M4 17 H20',
  play: 'M7 4.5 L19 12 L7 19.5 Z',
  search: 'M10.5 4 A6.5 6.5 0 1 0 10.51 4 Z M15.5 15.5 L20.5 20.5',
  up: 'M12 19 V5 M6 11 L12 5 L18 11',
  down: 'M12 5 V19 M6 13 L12 19 L18 13',
  check: 'M5 12.5 L10 17.5 L19 7',
  close: 'M6 6 L18 18 M18 6 L6 18',
  chart: 'M4 20 V4 M4 20 H20 M8 16 V11 M12 16 V7 M16 16 V13',
  bolt: 'M13 2.5 L5 13.5 H11 L10 21.5 L19 9.5 H13 Z',
  building: 'M3 21 H21 M5 21 V8 L12 4 L19 8 V21 M9 21 V15 H15 V21 M9 11 H10 M14 11 H15',
  flask: 'M9 3 H15 M10 3 V9 L4.5 19 A1.5 1.5 0 0 0 6 21 H18 A1.5 1.5 0 0 0 19.5 19 L14 9 V3 M7 15 H17',
  swords: 'M5 19 L15.5 8.5 M14 4 L20 4 L20 10 Z M19 19 L8.5 8.5 M10 4 L4 4 L4 10 Z',
  warn: 'M12 3 L22 20 H2 Z M12 9.5 V14 M12 17 V17.2',
  crown: 'M3 8 L7.5 12 L12 5 L16.5 12 L21 8 L19 18 H5 Z',
  info: 'M12 3 A9 9 0 1 0 12.01 3 Z M12 11 V16.5 M12 7.6 V7.8',
  levelup: 'M6 13 L12 7 L18 13 M6 19 L12 13 L18 19',
  exit: 'M14 4 H19 V20 H14 M10 8 L6 12 L10 16 M6 12 H15',
  download: 'M12 4 V15 M7 10.5 L12 15.5 L17 10.5 M5 19.5 H19',
  upload: 'M12 15.5 V4.5 M7 9 L12 4 L17 9 M5 19.5 H19',
  calendar: 'M4 6 H20 V20 H4 Z M4 10 H20 M8 3.5 V7.5 M16 3.5 V7.5',
  shield: 'M12 3 L20 6 V12 C20 16.5 16.5 19.5 12 21 C7.5 19.5 4 16.5 4 12 V6 Z',
  swap: 'M4 8 H18 M14 4 L18 8 L14 12 M20 16 H6 M10 12 L6 16 L10 20',
  skip: 'M5 5 L13 12 L5 19 Z M13 5 L21 12 L13 19 Z',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 20, stroke = 1.8): string {
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name]}"/></svg>`;
}

// ───── 隊徽 ─────
const EMBLEMS = {
  wings:
    '<path d="M11.2 14 C9.6 9.6 6.4 6 1.5 4.2 C1.9 6.3 3 7.9 4.6 8.9 C3 9.2 2 10 1.7 11.2 C3.6 11 5.2 11.4 6.4 12.3 C5.1 12.9 4.4 14 4.4 15.3 C6.6 14.2 9 14.3 11.2 15.8 Z M12.8 14 C14.4 9.6 17.6 6 22.5 4.2 C22.1 6.3 21 7.9 19.4 8.9 C21 9.2 22 10 22.3 11.2 C20.4 11 18.8 11.4 17.6 12.3 C18.9 12.9 19.6 14 19.6 15.3 C17.4 14.2 15 14.3 12.8 15.8 Z M12 12.6 L13.7 16 L12 20.6 L10.3 16 Z"/><ellipse cx="12" cy="9.6" rx="3" ry="1.15" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  bolt: '<path d="M13.5 1.5 L4.5 13.5 H11 L9.5 22.5 L19.5 9.5 H13 Z"/>',
  star: '<path d="M12 2 L14.9 8.3 L21.8 9 L16.6 13.6 L18.1 20.4 L12 16.9 L5.9 20.4 L7.4 13.6 L2.2 9 L9.1 8.3 Z"/>',
  flame: '<path d="M12 1.5 C13.2 5.6 18 8 18 13.8 A6 6 0 0 1 6 13.8 C6 10.6 7.8 8.8 9.2 7 C9.6 9.4 10.8 10.4 11.4 10.8 C11.4 7.4 11.3 4.6 12 1.5 Z"/>',
  cloud: '<path d="M6.5 18.5 A4.5 4.5 0 0 1 6 9.6 A6 6 0 0 1 17.6 8.4 A5 5 0 0 1 18 18.5 Z"/>',
  mask: '<path fill-rule="evenodd" d="M2.5 7.5 C7 5.5 17 5.5 21.5 7.5 C21.5 13.5 18.5 17 15.2 17 C13.6 17 12.8 15.2 12 15.2 C11.2 15.2 10.4 17 8.8 17 C5.5 17 2.5 13.5 2.5 7.5 Z M6 10.5 C7 9.4 9.2 9.4 10 10.8 C8.8 12.2 6.9 12.1 6 10.5 Z M18 10.5 C17 9.4 14.8 9.4 14 10.8 C15.2 12.2 17.1 12.1 18 10.5 Z"/>',
  planet: '<circle cx="12" cy="12" r="6.2"/><ellipse cx="12" cy="12" rx="11" ry="3.6" fill="none" stroke="currentColor" stroke-width="1.6" transform="rotate(-22 12 12)"/>',
  tower: '<path d="M4.5 21.5 V8.5 H7.5 V5 H10 V8.5 H14 V5 H16.5 V8.5 H19.5 V21.5 H14.5 V16.5 A2.5 2.5 0 0 0 9.5 16.5 V21.5 Z"/>',
  crown: '<path d="M2.5 7 L7.5 12 L12 4 L16.5 12 L21.5 7 L19.5 19 H4.5 Z"/>',
  swords: '<path d="M4 20 L15 9 L14 6.5 L18.5 3 L21 5.5 L17.5 10 L15 9 M20 20 L9 9 L10 6.5 L5.5 3 L3 5.5 L6.5 10 L9 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
} as const;

export type EmblemName = keyof typeof EMBLEMS;
export const EMBLEM_NAMES = Object.keys(EMBLEMS) as EmblemName[];

const CREST_SHAPES = [
  'M50 4 L94 18 V52 C94 80 74 98 50 106 C26 98 6 80 6 52 V18 Z',
  'M50 4 A51 51 0 1 1 49.99 4 Z',
  'M50 3 L93 27 V81 L50 105 L7 81 V27 Z',
  'M8 5 H92 V77 L50 105 L8 77 Z',
];
export const CREST_SHAPE_COUNT = CREST_SHAPES.length;

export interface CrestSpec {
  shape: number;
  primary: string;
  secondary: string;
  emblem: EmblemName;
}

export function crestSvg(c: CrestSpec, size = 48): string {
  const g = nextId('cg');
  const s = nextId('cs');
  const d = CREST_SHAPES[c.shape % CREST_SHAPES.length];
  return `<svg class="crest" width="${size}" height="${Math.round(size * 1.1)}" viewBox="0 0 100 110" aria-hidden="true">
    <defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.primary}"/><stop offset="1" stop-color="${shade(c.primary, -0.45)}"/></linearGradient>
    <linearGradient id="${s}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
    <path d="${d}" fill="url(#${g})" stroke="${c.secondary}" stroke-width="5"/>
    <path d="${d}" fill="none" stroke="#000" stroke-opacity=".35" stroke-width="1.5" transform="translate(50 55) scale(.86) translate(-50 -55)"/>
    <g transform="translate(22 27) scale(2.35)" fill="${c.secondary}" color="${c.secondary}">${EMBLEMS[c.emblem]}</g>
    <path d="${d}" fill="url(#${s})" transform="translate(50 55) scale(.94) translate(-50 -55)"/>
  </svg>`;
}

/** NPC 戰隊的隊徽：依隊名關鍵字決定，其餘由雜湊決定 */
const TEAM_LOOKS: { key: string; primary: string; secondary: string; emblem: EmblemName; shape: number }[] = [
  { key: '雷霆', primary: '#f5c400', secondary: '#1a1a1a', emblem: 'bolt', shape: 0 },
  { key: '北辰', primary: '#1e3a8a', secondary: '#e2e8f0', emblem: 'star', shape: 2 },
  { key: '赤焰', primary: '#dc2626', secondary: '#fde047', emblem: 'flame', shape: 0 },
  { key: '蒼穹', primary: '#0ea5e9', secondary: '#f0f9ff', emblem: 'cloud', shape: 1 },
  { key: '暗影', primary: '#4c1d95', secondary: '#c4b5fd', emblem: 'mask', shape: 3 },
  { key: '星河', primary: '#0f766e', secondary: '#a5f3fc', emblem: 'planet', shape: 1 },
  { key: '鐵壁', primary: '#475569', secondary: '#f1f5f9', emblem: 'tower', shape: 3 },
];

export const PLAYER_COLORS = ['#e11d48', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#f8fafc', '#111827'];

export function npcCrest(name: string): CrestSpec {
  const hit = TEAM_LOOKS.find((t) => name.includes(t.key));
  if (hit) return { shape: hit.shape, primary: hit.primary, secondary: hit.secondary, emblem: hit.emblem };
  const r = rngOf(name);
  return { shape: Math.floor(r() * CREST_SHAPES.length), primary: pick(r, PLAYER_COLORS), secondary: '#f8fafc', emblem: pick(r, EMBLEM_NAMES) };
}

export function contrastOn(hex: string): string {
  const [r, g, b] = rgb(hex);
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#111827' : '#f8fafc';
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** 調亮（amt > 0）或調暗（amt < 0） */
export function shade(hex: string, amt: number): string {
  const c = rgb(hex).map((v) => Math.round(amt >= 0 ? v + (255 - v) * amt : v * (1 + amt)));
  return `#${c.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
}

// ───── 選手頭像 ─────
const SKINS = ['#f6d2b8', '#eac09f', '#d9a57f', '#b9825a', '#8a5a3b'];
const HAIR_COLORS = ['#1f1a17', '#1f1a17', '#3b2a20', '#5a3825', '#8a5a2b', '#d4a55a', '#c2412d', '#4f7cff', '#c0c6d0', '#7c3aed', '#16a34a'];
const HAIRS = [
  'M33 42 C32 28 41 22 50 22 C60 22 68 28 67 42 C64 34 58 31 50 31 C42 31 36 34 33 42 Z',
  'M32 42 L33 27 L39 31 L41 20 L47 28 L51 17 L55 28 L61 21 L62 31 L68 27 L68 42 C63 34 57 31 50 31 C43 31 37 34 32 42 Z',
  'M31 62 C27 40 33 21 50 21 C67 21 73 40 69 62 C67 52 66.5 41 63 35 C58 31 42 31 37 35 C33.5 41 33 52 31 62 Z',
  'M34 38 C35 27 43 24 50 24 C57 24 65 27 66 38 C61 32 56 30 50 30 C44 30 39 32 34 38 Z',
  'M32 44 C30 26 44 20 54 22 C64 24 70 32 68 44 C66 36 60 30 46 32 C40 33 35 37 32 44 Z',
  'M33 41 C32 28 41 22 50 22 C60 22 68 28 67 41 C64 34 58 31 50 31 C42 31 36 34 33 41 Z M50 9 A7 7 0 1 0 50.01 9 Z',
];

export function avatarSvg(seed: string, jersey: string, size = 96): string {
  const r = rngOf(seed);
  const skin = pick(r, SKINS);
  const hair = pick(r, HAIR_COLORS);
  const style = Math.floor(r() * (HAIRS.length + 1));
  const glasses = r() < 0.16;
  const mouth = pick(r, ['M44 55 Q50 59.5 56 55', 'M45 56 H55', 'M45 56 Q52 58 56.5 54']);
  const brow = pick(r, [0, 1.5, -1.5]);
  const cup = shade(jersey, -0.25);
  const g = nextId('av');
  const isCap = style === HAIRS.length;
  const hairPath = isCap
    ? `<path d="M32.5 40 C33 26 42 21 50 21 C58 21 67 26 67.5 40 Z" fill="${shade(jersey, -0.1)}"/><path d="M30 39.5 H50 V43 H30 Z" fill="${shade(jersey, -0.35)}"/>`
    : `<path d="${HAIRS[style]}" fill="${hair}"/>`;
  return `<svg class="avatar" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <defs><radialGradient id="${g}" cx=".5" cy=".35" r=".8"><stop offset="0" stop-color="${shade(jersey, 0.25)}"/><stop offset="1" stop-color="${shade(jersey, -0.65)}"/></radialGradient></defs>
    <rect width="100" height="100" fill="url(#${g})"/>
    <path d="M12 100 C14 80 30 71 50 71 C70 71 86 80 88 100 Z" fill="${jersey}"/>
    <path d="M12 100 C14 80 30 71 50 71 C70 71 86 80 88 100" fill="none" stroke="#000" stroke-opacity=".25" stroke-width="2"/>
    <path d="M39 72 L50 84 L61 72" fill="none" stroke="${contrastOn(jersey)}" stroke-opacity=".7" stroke-width="3"/>
    <rect x="43" y="58" width="14" height="16" rx="5" fill="${shade(skin, -0.12)}"/>
    <ellipse cx="32.5" cy="47" rx="3" ry="4.5" fill="${shade(skin, -0.06)}"/><ellipse cx="67.5" cy="47" rx="3" ry="4.5" fill="${shade(skin, -0.06)}"/>
    <ellipse cx="50" cy="45" rx="17" ry="20" fill="${skin}"/>
    ${hairPath}
    <path d="M40 ${40 + brow} L46.5 39" stroke="${shade(hair, -0.2)}" stroke-width="2.2" stroke-linecap="round"/><path d="M53.5 39 L60 ${40 + brow}" stroke="${shade(hair, -0.2)}" stroke-width="2.2" stroke-linecap="round"/>
    <ellipse cx="43.5" cy="46" rx="2" ry="2.4" fill="#1b1b1f"/><ellipse cx="56.5" cy="46" rx="2" ry="2.4" fill="#1b1b1f"/>
    <path d="M49.5 47.5 L48.5 51.5 H51" fill="none" stroke="${shade(skin, -0.25)}" stroke-width="1.4" stroke-linecap="round"/>
    <path d="${mouth}" fill="none" stroke="#7a3b2e" stroke-width="2" stroke-linecap="round"/>
    ${glasses ? '<rect x="37.5" y="42" width="11" height="8" rx="3" fill="none" stroke="#111" stroke-width="1.8"/><rect x="51.5" y="42" width="11" height="8" rx="3" fill="none" stroke="#111" stroke-width="1.8"/><path d="M48.5 45 H51.5" stroke="#111" stroke-width="1.6"/>' : ''}
    <path d="M30 46 C29 26 38 18 50 18 C62 18 71 26 70 46" fill="none" stroke="#16181d" stroke-width="4.5"/>
    <rect x="25.5" y="39" width="9" height="15" rx="4" fill="${cup}" stroke="#0b0c10" stroke-width="1.5"/><rect x="65.5" y="39" width="9" height="15" rx="4" fill="${cup}" stroke="#0b0c10" stroke-width="1.5"/>
    <path d="M30 53 C31 61 36 63 43 62" fill="none" stroke="#16181d" stroke-width="2.4" stroke-linecap="round"/><circle cx="43.5" cy="62" r="2" fill="#16181d"/>
  </svg>`;
}

// ───── 流派徽記 ─────
export const LINEAGE_LOOK: Record<string, { color: string; glyph: string }> = {
  ambush: { color: '#a855f7', glyph: '<path d="M2.5 12 C6 6.5 18 6.5 21.5 12 C18 17.5 6 17.5 2.5 12 Z" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.2"/>' },
  push: { color: '#ef4444', glyph: '<path d="M4 20 L14 10 L13 7 L17 3 L21 7 L17 11 L14 10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><path d="M3 15 L9 21" stroke="currentColor" stroke-width="2.4"/>' },
  ranged: { color: '#22c55e', glyph: '<path d="M7 3 C17 6 17 18 7 21" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7 3 V21 M4 12 H20 M16.5 9 L20 12 L16.5 15" fill="none" stroke="currentColor" stroke-width="2"/>' },
  shield: { color: '#3b82f6', glyph: '<path d="M12 2.5 L20.5 5.5 V12 C20.5 16.8 17 20 12 21.5 C7 20 3.5 16.8 3.5 12 V5.5 Z"/>' },
  cavalry: { color: '#f59e0b', glyph: '<path d="M6 3.5 V12 A6 6 0 0 0 18 12 V3.5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M4 5 H8 M16 5 H20" stroke="currentColor" stroke-width="2"/>' },
  swarm: { color: '#ec4899', glyph: '<circle cx="7" cy="8" r="3"/><circle cx="17" cy="8" r="3"/><circle cx="12" cy="15" r="3.4"/><circle cx="5" cy="17" r="2.3"/><circle cx="19" cy="17" r="2.3"/>' },
  turtle: { color: '#14b8a6', glyph: '<path d="M12 3 L19.5 7.5 V16.5 L12 21 L4.5 16.5 V7.5 Z"/><path d="M12 8 L15.5 10 V14 L12 16 L8.5 14 V10 Z" fill="#000" fill-opacity=".35"/>' },
  balance: { color: '#cbd5e1', glyph: '<path d="M12 3 V20 M7 20 H17 M4 7 H20" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 7 L1.8 13 H6.2 Z M20 7 L17.8 13 H22.2 Z"/>' },
};

export function lineageGlyph(id: string, size = 18): string {
  const l = LINEAGE_LOOK[id] ?? { color: '#94a3b8', glyph: '<circle cx="12" cy="12" r="6"/>' };
  return `<svg class="lg-glyph" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${l.color}" color="${l.color}" aria-hidden="true">${l.glyph}</svg>`;
}

export function lineageColor(id: string): string {
  return LINEAGE_LOOK[id]?.color ?? '#94a3b8';
}

// ───── 版本稀有度 ─────
export const TIERS = [
  { name: '青銅', color: '#c77b3f' },
  { name: '白銀', color: '#cbd5e1' },
  { name: '黃金', color: '#f5c542' },
  { name: '白金', color: '#5eead4' },
  { name: '鑽石', color: '#a78bfa' },
  { name: '傳奇', color: '#fb923c' },
];

export function tierOf(version: number): { idx: number; name: string; color: string } {
  const idx = Math.max(0, Math.min(TIERS.length - 1, version - 1));
  return { idx, ...TIERS[idx] };
}

/** 對位名稱：團體戰的先鋒、中堅、大將 */
export const SLOT_NAMES = ['先鋒', '中堅', '大將'];
