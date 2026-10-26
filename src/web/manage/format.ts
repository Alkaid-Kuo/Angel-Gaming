// 經營頁的顯示小工具。金額內部單位是千元，畫面一律用「萬」。
import type { ContentPack, LedgerCategory, Stage } from '../../manage/index.ts';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/** 千元 → 萬（整數不帶小數） */
export function wan(k: number): string {
  const v = k / 10;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function money(k: number): string {
  return `${wan(k)} 萬`;
}

export function signedMoney(k: number): string {
  return `${k >= 0 ? '+' : '−'}${wan(Math.abs(k))} 萬`;
}

export function lineageName(content: ContentPack, id: string): string {
  return content.lineages.find((l) => l.id === id)?.name ?? id;
}

export const STAGE_NAME: Record<Stage, string> = { regular: '例行賽', semi: '準決賽', third: '季軍戰', final: '決賽' };

export const CATEGORY_NAME: Record<LedgerCategory, string> = {
  prize: '獎金',
  sponsor: '贊助',
  bet: '下注',
  salary: '薪資',
  facility: '設施',
  signing: '簽約金',
  scout: '情報',
  training: '升版培訓',
  bailout: '金主補貼',
};

export function weekLabel(week: number): string {
  if (week === 0) return '休賽期';
  if (week === 8) return '第 8 週（準決賽）';
  if (week === 9) return '第 9 週（決賽）';
  return `第 ${week} 週`;
}

export function pct(wins: number, games: number): string {
  return games === 0 ? '—' : `${Math.round((wins * 100) / games)}%`;
}
