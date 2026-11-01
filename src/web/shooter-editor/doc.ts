// 地圖編輯器的文件：就是可改動的 MapLayout，存出去的 JSON 能直接餵給 buildMap。
import type { Team } from '../../shooter/config.ts';
import type { MapDecor, MapLayout, MapMaterial } from '../../shooter/map.ts';

export interface MRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
export interface MArea extends MRect {
  id: string;
  name: string;
  /** 地面材質（畫面用，引擎不讀） */
  material?: MapMaterial;
  /** 併進哪個區域；畫面與 Bot 喊話用那個區域的代號與名稱 */
  callout?: string;
}
export interface MSite extends MRect {
  id: 'A' | 'B';
}
export interface MPoly {
  mode: 'open' | 'wall' | 'low';
  /** 斜邊做成真斜線（只能 45°）；沒標的多邊形是鋸齒 */
  slope?: boolean;
  pts: [number, number][];
}
export interface MSpawn {
  x: number;
  y: number;
  facing: number;
}

export interface EditDoc {
  id: string;
  name: string;
  width: number;
  height: number;
  /** 材質族與擺設：編輯器不改，存檔照原樣帶著 */
  theme?: string;
  decor?: MapDecor;
  areas: MArea[];
  blocks: MRect[];
  polys: MPoly[];
  low: MRect[];
  sites: MSite[];
  spawnZones: Record<Team, MRect>;
  spawns: Record<Team, MSpawn[]>;
}

export type Ref =
  | { readonly kind: 'area' | 'block' | 'low' | 'poly' | 'site'; readonly i: number }
  | { readonly kind: 'zone'; readonly team: Team }
  | { readonly kind: 'spawn'; readonly team: Team; readonly i: number };

export const sameRef = (a: Ref, b: Ref): boolean => JSON.stringify(a) === JSON.stringify(b);

/** 引擎的地圖資料 → 可編輯的深拷貝 */
export function toDoc(layout: MapLayout): EditDoc {
  const d = JSON.parse(JSON.stringify(layout)) as EditDoc;
  d.polys ??= [];
  d.low ??= [];
  return d;
}

/** 正式地圖的檔名：預設不直接覆寫，存成副本 */
const OFFICIAL_FILES: readonly string[] = ['redrock'];

/** 地圖代號 → 存檔檔名（不含副檔名）；伺服器只收小寫英數與連字號 */
export const fileNameOf = (id: string): string => id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'map';

/** 這次存檔要寫到哪個檔：正式地圖預設存副本 <檔名>-edit，overwrite 才寫回正式檔 */
export function saveTarget(id: string, overwrite = false): { readonly file: string; readonly copy: boolean } {
  const file = fileNameOf(id);
  const copy = OFFICIAL_FILES.includes(file) && !overwrite;
  return { file: copy ? `${file}-edit` : file, copy };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRect = (v: unknown): v is MRect => {
  const r = v as MRect | null;
  return typeof r === 'object' && r !== null && isNum(r.x0) && isNum(r.y0) && isNum(r.x1) && isNum(r.y1);
};

/** 匯入的 JSON → 文件；格式不對就丟錯，訊息直接給使用者看 */
export function parseDoc(raw: unknown): EditDoc {
  const d = raw as Partial<EditDoc> | null;
  if (typeof d !== 'object' || d === null) throw new Error('不是地圖資料');
  if (typeof d.id !== 'string' || typeof d.name !== 'string') throw new Error('缺 id 或 name');
  if (!isNum(d.width) || !isNum(d.height)) throw new Error('缺地圖尺寸');
  if (!Array.isArray(d.areas) || !d.areas.every(isRect)) throw new Error('areas 格式不對');
  if (!Array.isArray(d.blocks) || !d.blocks.every(isRect)) throw new Error('blocks 格式不對');
  if (!Array.isArray(d.sites) || !d.sites.every(isRect)) throw new Error('sites 格式不對');
  if (!isRect(d.spawnZones?.T) || !isRect(d.spawnZones?.CT)) throw new Error('spawnZones 格式不對');
  if (!Array.isArray(d.spawns?.T) || !Array.isArray(d.spawns?.CT)) throw new Error('spawns 格式不對');
  return toDoc(d as unknown as MapLayout);
}

/** 存檔格式：一個物件一行，改地圖時 diff 才看得懂 */
export function formatDoc(d: EditDoc): string {
  const line = (v: unknown): string => JSON.stringify(v);
  const list = (items: readonly unknown[]): string => (items.length === 0 ? '[]' : `[\n${items.map((v) => `    ${line(v)}`).join(',\n')}\n  ]`);
  return `{
  "id": ${line(d.id)},
  "name": ${line(d.name)},
  "width": ${d.width},
  "height": ${d.height},${d.theme !== undefined ? `\n  "theme": ${line(d.theme)},` : ''}${d.decor !== undefined ? `\n  "decor": ${line(d.decor)},` : ''}
  "areas": ${list(d.areas)},
  "blocks": ${list(d.blocks)},
  "polys": ${list(d.polys)},
  "low": ${list(d.low)},
  "sites": ${list(d.sites)},
  "spawnZones": ${line(d.spawnZones)},
  "spawns": ${line(d.spawns)}
}
`;
}
