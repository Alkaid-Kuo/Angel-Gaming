// 材質族的介面：一個 theme＝themes/ 下一個檔，bake.ts 只透過這個介面畫世界。
import type { MapDecor } from '../../../shooter/map.ts';
import type { Zone } from '../materials.ts';
import type { BakeMap, CellRect, LowKind } from '../outline.ts';

/** theme 要給的世界色；個別畫法自己用的顏色留在 theme 檔 */
export interface ThemePalette {
  readonly table: string;
  readonly dirt: string;
  readonly paint: string;
  readonly curb: string;
  readonly curbEdge: string;
  readonly spawnLine: string;
  readonly label: string;
  readonly labelGlow: string;
  readonly shadow: string;
  readonly ao: string;
  readonly side: string;
  readonly sideLine: string;
  readonly roofMid: string;
  readonly roofOuter: string;
  readonly rim: string;
  readonly rimLine: string;
}

/** 一個材質族：調色盤、六類地面、屋頂、矮掩體道具組、牆邊道具、擺設圖樣（座標都是格） */
export interface MapTheme {
  readonly id: string;
  readonly pal: ThemePalette;
  paintZone(g: CanvasRenderingContext2D, z: Zone, r: CellRect, m: BakeMap, decor: MapDecor): void;
  paintRoof(g: CanvasRenderingContext2D, m: BakeMap): void;
  paintLowProp(g: CanvasRenderingContext2D, kind: LowKind, x: number, y: number, w: number, h: number): void;
  /** 一格大的矮牆面，呼叫端已裁成斜切形 */
  paintSlopeLow(g: CanvasRenderingContext2D, x: number, y: number): void;
  paintWallProp(g: CanvasRenderingContext2D, z: Zone, x: number, y: number): void;
  paintWell(g: CanvasRenderingContext2D, m: BakeMap, r: CellRect): void;
}
