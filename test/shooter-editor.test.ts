import { describe, expect, it } from 'vitest';
import { REDROCK_LAYOUT, buildMap } from '../src/shooter/map.ts';
import { DRAFT_LAYOUT } from '../src/web/sketch/shooter/map-draft.ts';
import { analyze, deadEnds, pathField, tracePath, visibleCells } from '../src/web/shooter-editor/checks.ts';
import { formatDoc, parseDoc, toDoc } from '../src/web/shooter-editor/doc.ts';

describe('地圖編輯器的文件', () => {
  it('存檔格式讀回來與原圖相同，引擎也蓋得出一樣的格子', () => {
    const doc = toDoc(REDROCK_LAYOUT);
    const back = parseDoc(JSON.parse(formatDoc(doc)));
    expect(back).toEqual(doc);
    expect(buildMap(back).solid).toEqual(buildMap(REDROCK_LAYOUT).solid);
  });

  it('格式不對的檔案會被擋下', () => {
    expect(() => parseDoc({ id: 'x', name: 'x', width: 120, height: 120, areas: 'no' })).toThrow('areas');
    expect(() => parseDoc(null)).toThrow();
  });
});

describe('地圖檢查', () => {
  it('現行地圖通過全部硬條件', () => {
    const doc = toDoc(REDROCK_LAYOUT);
    expect(analyze(doc, buildMap(doc)).filter((c) => c.level === 'fail')).toEqual([]);
  });

  it('只有一個門的房間算死路，連門洞一起', () => {
    const doc = toDoc(DRAFT_LAYOUT);
    const names = deadEnds(doc, buildMap(doc)).map((i) => doc.areas[i].name);
    expect(names).toContain('藥鋪');
    expect(names).toContain('藥鋪門');
    expect(names).not.toContain('北街');
  });

  it('多開一個門，死路就消失', () => {
    const doc = toDoc(DRAFT_LAYOUT);
    doc.areas.push({ id: 'yardNorth', name: '內院北門', x0: 80, y0: 32, x1: 84, y1: 34 });
    const names = deadEnds(doc, buildMap(doc)).map((i) => doc.areas[i].name);
    expect(names).not.toContain('鐘樓內院');
    expect(names).not.toContain('內院門');
  });

  it('路程沿走得到的格子回到起點', () => {
    const map = buildMap(toDoc(REDROCK_LAYOUT));
    const [s, e] = [map.spawns.T[0], map.spawns.CT[0]];
    const field = pathField(map, Math.floor(s.x / 1000), Math.floor(s.y / 1000));
    const path = tracePath(map, field, Math.floor(e.x / 1000), Math.floor(e.y / 1000));
    expect(path.length).toBeGreaterThan(50);
    expect(path.at(-1)).toEqual([Math.floor(s.x / 1000), Math.floor(s.y / 1000)]);
  });

  it('牆後面看不到', () => {
    const map = buildMap(toDoc(REDROCK_LAYOUT));
    const s = map.spawns.T[0];
    const seen = visibleCells(map, Math.floor(s.x / 1000), Math.floor(s.y / 1000), false);
    const c = map.spawns.CT[0];
    expect(seen[Math.floor(c.y / 1000) * map.width + Math.floor(c.x / 1000)]).toBe(0);
    expect(seen[Math.floor(s.y / 1000) * map.width + Math.floor(s.x / 1000)]).toBe(1);
  });
});
