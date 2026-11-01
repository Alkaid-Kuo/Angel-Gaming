// 材質族登錄：地圖 JSON 的 theme 代號 → 畫法。查不到退回赤岩；引擎與 Bot 不知道 theme。
import { REDROCK_THEME } from './redrock.ts';
import type { MapTheme } from './theme.ts';

const THEMES: Readonly<Record<string, MapTheme>> = { redrock: REDROCK_THEME };

export const themeOf = (id: string): MapTheme => THEMES[id] ?? REDROCK_THEME;
