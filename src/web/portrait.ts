// 選手立繪與頭像：圖檔在 public/portraits/（scripts/portraits/export_web.py 產生），vite 原樣複製到建置產物根目錄。
// 頁面都在 web/ 底下，所以用往上一層的相對路徑，開發伺服器與 dist-web 都讀得到。
// 頭像輸出成 SVG（<image> 裁圓），沿用各畫面原本對 .avatar／svg 的尺寸與陣亡變灰規則。
// 融進介面的做法：頭像裁緊（臉佔滿圓）、墨色底；立繪不描白邊，改用隊色的單側邊光（web/game.css 的 .rim-*）。
import { PORTRAITS, type PortraitSpec } from '../manage/portraits.ts';

const BASE = '../portraits';

export const avatarUrl = (portraitId: string): string => `${BASE}/avatars/${portraitId}.webp`;
export const fullUrl = (portraitId: string): string => `${BASE}/full/${portraitId}.webp`;

/** 沒有立繪代號的場合（試玩的 Bot、舊觀戰票）：依種子與座位挑，同一場的座位不會撞圖（步長 37 與 120 互質） */
export function portraitOfSeat(seed: number, seat: number): string {
  const n = PORTRAITS.length;
  return PORTRAITS[(((Math.imul(seed, 2654435761) >>> 0) % n) + seat * 37) % n].id;
}

const SPEC = new Map<string, PortraitSpec>(PORTRAITS.map((p) => [p.id, p]));

let clipSeq = 0;

/** 頭像：頭像圖放大 1.3 倍讓臉佔滿，墨色漸層底（不比介面亮）；ring 有給就畫外框（攻防戰的隊色）；square＝方形（攻防戰頂部計分板） */
export function portraitSvg(portraitId: string, size = 96, ring?: string, square = false): string {
  const clip = `pfc${++clipSeq}`;
  const shape = square ? '<rect width="100" height="100"/>' : '<circle cx="50" cy="50" r="50"/>';
  const frame = square ? `<rect x="3" y="3" width="94" height="94" fill="none" stroke="${ring}" stroke-width="6"/>` : `<circle cx="50" cy="50" r="47" fill="none" stroke="${ring}" stroke-width="6"/>`;
  return `<svg class="avatar pf" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true"><defs><clipPath id="${clip}">${shape}</clipPath><radialGradient id="${clip}g" cx="50%" cy="35%" r="75%"><stop offset="0" stop-color="#3a4458"/><stop offset="1" stop-color="#151a24"/></radialGradient></defs><g clip-path="url(#${clip})"><rect width="100" height="100" fill="url(#${clip}g)"/><image href="${avatarUrl(portraitId)}" x="-15" y="-11" width="130" height="130" preserveAspectRatio="xMidYMid slice"/></g>${ring ? frame : ''}</svg>`;
}

/** 全身立繪（透明底）；cls 給邊光（rim-me／rim-foe／rim-other） */
export function portraitFull(portraitId: string, cls = ''): string {
  return `<img class="pfull ${cls}" src="${fullUrl(portraitId)}" alt="" draggable="false" decoding="async">`;
}

/**
 * 半身立繪：依頭像中心裁切，臉（頭像方框）佔框高 head、中心在框高 faceY 處、水平置中。
 * boxH 是框高（CSS 像素）；水平用 calc(50% − …)，框寬改了不用重算。回傳絕對定位的 <img>，框要 position: relative＋overflow: hidden。
 */
export function portraitBust(portraitId: string, boxH: number, cls = '', head = 0.6, faceY = 0.34): string {
  const f = SPEC.get(portraitId)?.face ?? [0.5, 0.12, 0.31];
  const w = (head * boxH) / f[2];
  const h = w * 1.5;
  const top = faceY * boxH - f[1] * h;
  return `<img class="pfull bust ${cls}" src="${fullUrl(portraitId)}" alt="" draggable="false" decoding="async" style="left:calc(50% - ${(f[0] * w).toFixed(1)}px);top:${top.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px">`;
}
