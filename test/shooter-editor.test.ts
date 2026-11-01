import { describe, expect, it } from 'vitest';
import { OLD_TOWN_LAYOUT, buildMap, type MapLayout } from '../src/shooter/map.ts';
import { analyze, deadEnds, pathField, tracePath, visibleCells } from '../src/web/shooter-editor/checks.ts';
import { fileNameOf, formatDoc, parseDoc, saveTarget, toDoc } from '../src/web/shooter-editor/doc.ts';

/** 兩個出生區、一條走道，走道旁掛一間單門的藥鋪（藥鋪門 → 藥鋪是死路） */
const DEAD_END_LAYOUT: MapLayout = {
  id: 'dead-end',
  name: '死路測試',
  width: 60,
  height: 60,
  areas: [
    { id: 'tSpawn', name: 'T 區', x0: 20, y0: 45, x1: 40, y1: 55 },
    { id: 'hall', name: '走道', x0: 28, y0: 15, x1: 32, y1: 45 },
    { id: 'ctSpawn', name: 'CT 區', x0: 20, y0: 5, x1: 40, y1: 15 },
    { id: 'shopDoor', name: '藥鋪門', x0: 32, y0: 28, x1: 36, y1: 32 },
    { id: 'shop', name: '藥鋪', x0: 36, y0: 24, x1: 46, y1: 36 },
  ],
  blocks: [],
  sites: [
    { id: 'A', x0: 21, y0: 6, x1: 27, y1: 12 },
    { id: 'B', x0: 33, y0: 6, x1: 39, y1: 12 },
  ],
  spawnZones: { T: { x0: 20, y0: 45, x1: 40, y1: 55 }, CT: { x0: 20, y0: 5, x1: 40, y1: 15 } },
  spawns: {
    T: [22, 26, 30, 34, 38].map((x) => ({ x: x * 1000 + 500, y: 50500, facing: 270 })),
    CT: [22, 26, 30, 34, 38].map((x) => ({ x: x * 1000 + 500, y: 10500, facing: 90 })),
  },
};

describe('地圖編輯器的文件', () => {
  it('存檔格式讀回來與原圖相同，引擎也蓋得出一樣的格子', () => {
    const doc = toDoc(OLD_TOWN_LAYOUT);
    const back = parseDoc(JSON.parse(formatDoc(doc)));
    expect(back).toEqual(doc);
    expect(buildMap(back).solid).toEqual(buildMap(OLD_TOWN_LAYOUT).solid);
  });

  it('存檔保留 theme、decor', () => {
    const back = parseDoc(JSON.parse(formatDoc(toDoc(OLD_TOWN_LAYOUT))));
    expect(back.theme).toBe('redrock');
    expect(back.decor).toEqual(OLD_TOWN_LAYOUT.decor);
  });

  it('正式地圖預設存副本，明確要求才寫回正式檔；其他地圖照舊', () => {
    expect(saveTarget('redrock')).toEqual({ file: 'redrock-edit', copy: true });
    expect(saveTarget('redrock', true)).toEqual({ file: 'redrock', copy: false });
    expect(saveTarget('New Map')).toEqual({ file: 'new-map', copy: false });
    expect(fileNameOf('赤岩')).toBe('map');
    expect(saveTarget('redrock').file).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('格式不對的檔案會被擋下', () => {
    expect(() => parseDoc({ id: 'x', name: 'x', width: 120, height: 120, areas: 'no' })).toThrow('areas');
    expect(() => parseDoc(null)).toThrow();
  });
});

describe('地圖檢查', () => {
  it('現行地圖通過全部硬條件', () => {
    const doc = toDoc(OLD_TOWN_LAYOUT);
    expect(analyze(doc, buildMap(doc)).filter((c) => c.level === 'fail')).toEqual([]);
  });

  it('赤岩舊城通過全部硬條件，沒有死路', () => {
    const doc = parseDoc(OLD_TOWN_LAYOUT);
    const checks = analyze(doc, buildMap(doc));
    expect(checks.filter((c) => c.level === 'fail')).toEqual([]);
    expect(deadEnds(doc, buildMap(doc))).toEqual([]);
    expect(checks.find((c) => c.label === '正式區域')?.level).toBe('info');
  });

  it('併入的框要指到排在前面的主區域', () => {
    const doc = toDoc(OLD_TOWN_LAYOUT);
    const level = (): string => analyze(doc, buildMap(doc)).find((c) => c.label === '區域併入')!.level;
    expect(level()).toBe('ok');
    doc.areas[0].callout = doc.areas[1].id;
    expect(level()).toBe('fail');
    delete doc.areas[0].callout;
    doc.areas[1].callout = doc.areas[0].id;
    expect(level()).toBe('ok');
  });

  it('只有一個門的房間算死路，連門洞一起', () => {
    const doc = toDoc(DEAD_END_LAYOUT);
    const names = deadEnds(doc, buildMap(doc)).map((i) => doc.areas[i].name);
    expect(names).toContain('藥鋪');
    expect(names).toContain('藥鋪門');
    expect(names).not.toContain('走道');
  });

  it('多開一個門，死路就消失', () => {
    const doc = toDoc(DEAD_END_LAYOUT);
    doc.areas.push({ id: 'shopBack', name: '藥鋪後門', x0: 34, y0: 15, x1: 38, y1: 24 });
    const names = deadEnds(doc, buildMap(doc)).map((i) => doc.areas[i].name);
    expect(names).not.toContain('藥鋪');
    expect(names).not.toContain('藥鋪門');
  });

  it('斜切多邊形的邊不是 45° 會被擋下，鋸齒多邊形只提醒', () => {
    const doc = toDoc(OLD_TOWN_LAYOUT);
    const levels = (): Record<string, string> => Object.fromEntries(analyze(doc, buildMap(doc)).map((c) => [c.label, c.level]));
    expect(levels()['斜切邊']).toBe('ok');
    doc.polys = [{ mode: 'wall', pts: [[40, 98], [46, 98], [40, 104]] }];
    expect(levels()['鋸齒斜角']).toBe('warn');
    doc.polys = [{ mode: 'wall', slope: true, pts: [[40, 98], [46, 98], [40, 103]] }];
    expect(levels()['斜切邊']).toBe('fail');
    doc.polys = [{ mode: 'wall', slope: true, pts: [[40, 98], [46, 98], [40, 104]] }];
    expect(levels()['斜切邊']).toBe('ok');
    expect(levels()['鋸齒斜角']).toBe('ok');
  });

  it('路程沿走得到的格子回到起點', () => {
    const map = buildMap(toDoc(OLD_TOWN_LAYOUT));
    const [s, e] = [map.spawns.T[0], map.spawns.CT[0]];
    const field = pathField(map, Math.floor(s.x / 1000), Math.floor(s.y / 1000));
    const path = tracePath(map, field, Math.floor(e.x / 1000), Math.floor(e.y / 1000));
    expect(path.length).toBeGreaterThan(50);
    expect(path.at(-1)).toEqual([Math.floor(s.x / 1000), Math.floor(s.y / 1000)]);
  });

  it('牆後面看不到', () => {
    const map = buildMap(toDoc(OLD_TOWN_LAYOUT));
    const s = map.spawns.T[0];
    const seen = visibleCells(map, Math.floor(s.x / 1000), Math.floor(s.y / 1000), false);
    const c = map.spawns.CT[0];
    expect(seen[Math.floor(c.y / 1000) * map.width + Math.floor(c.x / 1000)]).toBe(0);
    expect(seen[Math.floor(s.y / 1000) * map.width + Math.floor(s.x / 1000)]).toBe(1);
  });
});
