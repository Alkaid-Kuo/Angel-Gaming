// 軍團戰的兵種線條圖示（24 × 24）：介面用 SVG、地圖用 Canvas，共用同一份路徑。
import type { UnitKind } from '../../legion/config.ts';

const PATHS: Record<UnitKind, string> = {
  spear: 'M5 19 L17 7 M13 5 L19 5 L19 11 Z',
  sword: 'M6.5 17.5 L18 6 L18 9.5 M18 6 L14.5 6 M7 12.5 L11.5 17 M4.5 19.5 L7.5 16.5',
  shield: 'M12 3 L20 6 V12 C20 16.5 16.5 19.5 12 21 C7.5 19.5 4 16.5 4 12 V6 Z M12 7 V17',
  archer: 'M8 3.5 C17.5 6 17.5 18 8 20.5 M8 3.5 L8 20.5 M5 12 L19.5 12 M16.5 9 L19.5 12 L16.5 15',
  light: 'M4.5 19 C9 18.5 12 15 14 9.5 L20 5 C19.5 10 17 14.5 13.5 16.5 C10.5 18.5 7.5 19.5 4.5 19 Z M9 15 L13 11',
  lightCav: 'M7 20.5 L9.5 13.5 C8 10 9.5 5.5 14 4 L17.5 5.5 L20 9.5 L17 10.5 L15.5 13.5 L17.5 20.5',
  heavyCav: 'M7 20.5 L9.5 13.5 C8 10 9.5 5.5 14 4 L17.5 5.5 L20 9.5 L17 10.5 L15.5 13.5 L17.5 20.5 M14 4 L13 1.5 M10 9.5 L15.5 9.5 M3 21 L9 15',
};

export function unitSvg(kind: UnitKind, size = 18, color = 'currentColor', strokeWidth = 1.9): string {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[kind]}"/></svg>`;
}

const cache = new Map<UnitKind, Path2D>();

export function drawUnitIcon(ctx: CanvasRenderingContext2D, kind: UnitKind, cx: number, cy: number, size: number, color: string, lineWidth = 1.8): void {
  let p = cache.get(kind);
  if (p === undefined) {
    p = new Path2D(PATHS[kind]);
    cache.set(kind, p);
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
