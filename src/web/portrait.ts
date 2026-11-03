// 選手立繪與頭像：圖檔在 public/portraits/（scripts/portraits/export_web.py 產生），vite 原樣複製到建置產物根目錄。
// 頁面都在 web/ 底下，所以用往上一層的相對路徑，開發伺服器與 dist-web 都讀得到。
// 頭像輸出成 SVG（<image> 裁圓），沿用各畫面原本對 .avatar／svg 的尺寸與陣亡變灰規則。
import { PORTRAITS } from '../manage/portraits.ts';

const BASE = '../portraits';

export const avatarUrl = (portraitId: string): string => `${BASE}/avatars/${portraitId}.webp`;
export const fullUrl = (portraitId: string): string => `${BASE}/full/${portraitId}.webp`;

/** 沒有立繪代號的場合（試玩的 Bot、舊觀戰票）：依種子與座位挑，同一場的座位不會撞圖（步長 37 與 120 互質） */
export function portraitOfSeat(seed: number, seat: number): string {
  const n = PORTRAITS.length;
  return PORTRAITS[(((Math.imul(seed, 2654435761) >>> 0) % n) + seat * 37) % n].id;
}

let clipSeq = 0;

/** 圓形頭像：亮底圓（深色服裝不會融進暗色介面）；ring 有給就畫外框（攻防戰的隊色） */
export function portraitSvg(portraitId: string, size = 96, ring?: string): string {
  const clip = `pfc${++clipSeq}`;
  return `<svg class="avatar pf" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true"><defs><clipPath id="${clip}"><circle cx="50" cy="50" r="50"/></clipPath><radialGradient id="${clip}g" cx="50%" cy="38%" r="70%"><stop offset="0" stop-color="#8e98a8"/><stop offset="1" stop-color="#3a4458"/></radialGradient></defs><g clip-path="url(#${clip})"><rect width="100" height="100" fill="url(#${clip}g)"/><image href="${avatarUrl(portraitId)}" width="100" height="100" preserveAspectRatio="xMidYMid slice"/></g>${ring ? `<circle cx="50" cy="50" r="47" fill="none" stroke="${ring}" stroke-width="6"/>` : ''}</svg>`;
}

/** 全身立繪（透明底）；淡色描邊由 CSS 的 .pfull 處理 */
export function portraitFull(portraitId: string, cls = ''): string {
  return `<img class="pfull ${cls}" src="${fullUrl(portraitId)}" alt="" draggable="false" decoding="async">`;
}
