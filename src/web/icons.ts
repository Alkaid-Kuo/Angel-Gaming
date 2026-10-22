// 線條圖示（24 × 24）：介面用 SVG、地圖用 Canvas Path2D，兩邊共用同一份路徑資料，外觀一致。
import type { BuildingType, ResearchType, Stance, UnitType } from '../config/index.ts';

export type IconName =
  | UnitType
  | BuildingType
  | ResearchType
  | 'minerals'
  | 'population'
  | 'time'
  | 'move'
  | 'attackMove'
  | 'hold'
  | 'gather'
  | 'build'
  | 'upgrade'
  | 'cancel'
  | 'back'
  | 'watchtower'
  | 'flag'
  | 'tech'
  | 'income'
  | 'army'
  | `stance-${Stance}`;

const PATHS: Record<IconName, string> = {
  // 單位
  worker: 'M6 19 L15 10 M9 6 C13 3.5 18 6 19.5 10.5 C16.5 8.5 13.5 8.5 11 9.5',
  spear: 'M5 19 L17 7 M13 5 L19 5 L19 11 Z',
  archer: 'M8 3.5 C17.5 6 17.5 18 8 20.5 M8 3.5 L8 20.5 M5 12 L19.5 12 M16.5 9 L19.5 12 L16.5 15',
  cavalry: 'M6.5 4 V12.5 A5.5 5.5 0 0 0 17.5 12.5 V4 M6.5 7 H8.5 M15.5 7 H17.5 M6.5 10.5 H8.5 M15.5 10.5 H17.5',
  siege: 'M3.5 12 H20.5 V16 H3.5 Z M6 4.5 L17 12 M7.5 19.5 A2 2 0 1 0 7.51 19.5 M16.5 19.5 A2 2 0 1 0 16.51 19.5',
  // 建築
  base: 'M4 21 V9 H7 V5.5 H10 V9 H14 V5.5 H17 V9 H20 V21 Z M10 21 V16 A2 2 0 0 1 14 16 V21',
  depot: 'M4 8 L12 4 L20 8 V17 L12 21 L4 17 Z M4 8 L12 12 L20 8 M12 12 V21',
  supply: 'M3 20 L12 4 L21 20 Z M9 20 L12 14.5 L15 20',
  barracks: 'M4.5 4.5 L19.5 19.5 M19.5 4.5 L4.5 19.5 M6.5 15.5 L8.5 17.5 M15.5 17.5 L17.5 15.5 M4.5 4.5 L8 4.5 M4.5 4.5 L4.5 8 M19.5 4.5 L16 4.5 M19.5 4.5 L19.5 8',
  tower: 'M8 21 V10 H6 V4.5 H9 V7 H11 V4.5 H13 V7 H15 V4.5 H18 V10 H16 V21 Z M11 21 V17 H13 V21',
  forge: 'M3.5 7.5 H16.5 C16.5 10.5 18 11.5 21 11.5 V13.5 H15 L14 17 H17 V20 H7 V17 H10 L9 13.5 C5.5 13.5 3.5 11.5 3.5 7.5 Z',
  workshop: 'M12 8.5 A3.5 3.5 0 1 0 12.01 8.5 M12 2.5 V5.5 M12 18.5 V21.5 M2.5 12 H5.5 M18.5 12 H21.5 M5.3 5.3 L7.4 7.4 M16.6 16.6 L18.7 18.7 M18.7 5.3 L16.6 7.4 M5.3 18.7 L7.4 16.6',
  // 研究
  weapons: 'M5 19 L15.5 8.5 M14 4 L20 4 L20 10 Z M6.5 13.5 L10.5 17.5',
  armor: 'M12 3 L20 6 V12 C20 16.5 16.5 19.5 12 21 C7.5 19.5 4 16.5 4 12 V6 Z',
  // 資源與資訊
  minerals: 'M12 2.5 L19 9 L12 21.5 L5 9 Z M5 9 H19 M9 9 L12 21.5 L15 9 M9 9 L12 2.5 L15 9',
  population: 'M9 11 A3 3 0 1 0 9.01 11 M3.5 20 C3.5 16 6 14.5 9 14.5 C12 14.5 14.5 16 14.5 20 M16 10.5 A2.5 2.5 0 1 0 16.01 10.5 M15.5 14.5 C18.5 14.5 20.5 16 20.5 19.5',
  time: 'M12 3 A9 9 0 1 1 11.99 3 Z M12 7 V12 L15.5 14',
  income: 'M4 18 L10 12 L14 15 L20 7 M15 7 H20 V12',
  army: 'M5 19 L15.5 8.5 M14 4 L20 4 L20 10 Z M19 19 L8.5 8.5 M10 4 L4 4 L4 10 Z',
  tech: 'M6 13 L12 7 L18 13 M6 19 L12 13 L18 19',
  watchtower: 'M9 21 L10 10 H14 L15 21 Z M7.5 10 H16.5 L15.5 7 H8.5 Z M12 7 V2.5 L16.5 4.25 L12 6',
  flag: 'M6 21 V3.5 M6 4 H17 L14.5 8 L17 12 H6',
  // 指令
  move: 'M4.5 12 H19.5 M13.5 6 L19.5 12 L13.5 18',
  attackMove: 'M12 2.5 V7 M12 17 V21.5 M2.5 12 H7 M17 12 H21.5 M12 8 A4 4 0 1 0 12.01 8',
  hold: 'M12 3 L20 6 V12 C20 16.5 16.5 19.5 12 21 C7.5 19.5 4 16.5 4 12 V6 Z M9 12 H15',
  gather: 'M6 19 L15 10 M9 6 C13 3.5 18 6 19.5 10.5 C16.5 8.5 13.5 8.5 11 9.5',
  build: 'M13.5 3.5 L20.5 10.5 L17.5 13.5 L10.5 6.5 Z M12 8 L3.5 16.5 L7.5 20.5 L16 12',
  upgrade: 'M6 13 L12 7 L18 13 M6 19 L12 13 L18 19',
  cancel: 'M6 6 L18 18 M18 6 L6 18',
  back: 'M19.5 12 H4.5 M10.5 6 L4.5 12 L10.5 18',
  'stance-aggressive': 'M5 19 L15.5 8.5 M14 4 L20 4 L20 10 Z M6.5 13.5 L10.5 17.5',
  'stance-defensive': 'M12 3 L20 6 V12 C20 16.5 16.5 19.5 12 21 C7.5 19.5 4 16.5 4 12 V6 Z',
  'stance-hold': 'M12 3 V21 M7 7.5 H17 M6 17 C6 20 18 20 18 17',
  'stance-retreat': 'M19.5 12 H4.5 M10.5 6 L4.5 12 L10.5 18',
};

/** 介面用的 SVG 圖示 */
export function iconSvg(name: IconName, size = 20, color = 'currentColor', strokeWidth = 1.8): string {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`;
}

const cache = new Map<IconName, Path2D>();

/** 在 Canvas 上畫圖示（中心點、邊長為像素） */
export function drawIcon(ctx: CanvasRenderingContext2D, name: IconName, cx: number, cy: number, size: number, color: string, lineWidth = 1.8): void {
  let p = cache.get(name);
  if (p === undefined) {
    p = new Path2D(PATHS[name]);
    cache.set(name, p);
  }
  const k = size / 24;
  ctx.save();
  ctx.translate(cx - size / 2, cy - size / 2);
  ctx.scale(k, k);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth / k;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(p);
  ctx.restore();
}
