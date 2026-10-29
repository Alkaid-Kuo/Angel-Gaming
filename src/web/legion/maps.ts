// 觀戰端依地圖名稱找回地圖資料（meta 只有名稱；城門洞、建物外觀、雲梯能架在哪都要從地圖資料拿）
import { MAPS, type LegionMap } from '../../legion/map.ts';

export function mapByName(name: string): LegionMap {
  for (const id of Object.keys(MAPS)) {
    const m = MAPS[id]();
    if (m.name === name) return m;
  }
  throw new Error(`找不到地圖：${name}`);
}
