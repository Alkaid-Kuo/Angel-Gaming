// 觀戰畫面的繪製器介面：2D（LegionRenderer）與 3D（Legion3DView）都照這個介面，LegionScreen 與玩家操控換一個繪製器就能用。
import type { UnitKind } from '../../legion/config.ts';
import type { LegionFrame, RegFrame } from './protocol.ts';
import type { Camera, DrawOptions } from './render.ts';

export interface BattleView {
  /** 接滑鼠事件的畫布（3D 時是疊在 3D 畫面上的資訊層） */
  readonly canvas: HTMLCanvasElement;
  /** 鏡頭：畫面中心（格）與每格像素；3D 的縮放是鏡頭對準處的每格像素 */
  readonly cam: Camera;
  readonly kindOf: UnitKind[];
  readonly ownerOf: number[];
  readonly frame: LegionFrame | null;
  readonly fitScale: number;
  /** 鏡頭水平轉角（弧度，0 ＝ 北朝上；只有 3D 會轉）：平移、WASD 照畫面方向走 */
  readonly heading?: number;
  reg(id: number): RegFrame | undefined;
  push(f: LegionFrame, now: number): void;
  reset(): void;
  fit(): void;
  clamp(): void;
  toWorld(px: number, py: number): { x: number; y: number };
  toScreen(x: number, y: number): [number, number];
  regAt(id: number, alpha: number): { x: number; y: number; facing: number } | null;
  shown(id: number, viewer: number): boolean;
  pick(px: number, py: number, viewer: number, alpha: number): number;
  /** 點到的軍團旗標或畫面邊緣的殘兵箭頭（-1 ＝ 沒點到）；點到就把鏡頭帶過去。只有 3D 有 */
  bannerAt?(px: number, py: number): number;
  draw(alpha: number, now: number, opt: DrawOptions): void;
  ping(x: number, y: number, color: string): void;
}
