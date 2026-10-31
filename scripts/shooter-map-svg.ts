// 攻防戰全圖輸出成 SVG（審圖、報告用）：地面依材質上色，牆、矮掩體、斜切格、包點、出生點照引擎 buildMap 的格子畫，區域名畫在主區域中央。
// 用法：node scripts/shooter-map-svg.ts maps/shooter/redrock.json --out docs/shots/redrock.svg [--scale 8]
import { readFileSync, writeFileSync } from 'node:fs';
import { UNIT } from '../src/shooter/config.ts';
import { SLOPE_LOW, buildMap, slopeCorner, type MapLayout } from '../src/shooter/map.ts';

const arg = (name: string, def: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
};
const file = process.argv[2];
const out = arg('out', '');
if (file === undefined || file.startsWith('--') || out === '') throw new Error('用法：node scripts/shooter-map-svg.ts 地圖.json --out 輸出.svg');
const S = Number(arg('scale', '8'));

const layout = JSON.parse(readFileSync(file, 'utf8')) as MapLayout;
const map = buildMap(layout);
const W = map.width;
const COLOR = { wall: '#20232a', low: '#d69630', stone: '#cbc5b8', dirt: '#d6c29a', wood: '#c9a77c', market: '#d9b6a0', plaza: '#e0d8c8', site: '#e3c4b8', none: '#cdc5b6', T: '#e0913a', CT: '#4a9be0', site2: '#c8473c' } as const;
const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const parts: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W * S} ${map.height * S}" width="${W * S}" height="${map.height * S}" font-family="Noto Sans TC, Microsoft JhengHei, sans-serif" shape-rendering="crispEdges">`];
parts.push(`<rect width="100%" height="100%" fill="${COLOR.wall}"/>`);

// 地面：先照區域上色（併入的框吃主區域的材質），再把不是地面的格蓋回去
const materialOf = (a: MapLayout['areas'][number]): string => COLOR[layout.areas.find((o) => o.id === (a.callout ?? a.id))?.material ?? 'none'];
for (const a of layout.areas) parts.push(`<rect x="${a.x0 * S}" y="${a.y0 * S}" width="${(a.x1 - a.x0) * S}" height="${(a.y1 - a.y0) * S}" fill="${materialOf(a)}"/>`);
// 一列一列併成矩形，檔案才不會太大
for (let y = 0; y < map.height; y++) {
  for (let x = 0; x < W; ) {
    const v = map.solid[y * W + x];
    let end = x + 1;
    while (end < W && map.solid[y * W + end] === v) end++;
    if (v === 1 || v === 2) parts.push(`<rect x="${x * S}" y="${y * S}" width="${(end - x) * S}" height="${S}" fill="${v === 1 ? COLOR.wall : COLOR.low}"/>`);
    x = end;
  }
}
// 斜切格：只畫實心半邊，地面已經鋪好
for (let i = 0; i < map.solid.length; i++) {
  const corner = slopeCorner(map.solid[i]);
  if (corner < 0) continue;
  const x = i % W;
  const y = (i - x) / W;
  const pt = (c: number): string => `${(x + (c === 1 || c === 2 ? 1 : 0)) * S},${(y + (c === 2 || c === 3 ? 1 : 0)) * S}`;
  parts.push(`<polygon points="${pt(corner)} ${pt((corner + 1) % 4)} ${pt((corner + 3) % 4)}" fill="${map.solid[i] >= SLOPE_LOW ? COLOR.low : COLOR.wall}"/>`);
}
for (const s of map.sites) {
  parts.push(`<rect x="${s.x0 * S}" y="${s.y0 * S}" width="${(s.x1 - s.x0) * S}" height="${(s.y1 - s.y0) * S}" fill="none" stroke="${COLOR.site2}" stroke-width="3"/>`);
  parts.push(`<text x="${((s.x0 + s.x1) / 2) * S}" y="${((s.y0 + s.y1) / 2) * S}" font-size="${S * 7}" font-weight="700" fill="${COLOR.site2}" opacity="0.45" text-anchor="middle" dominant-baseline="central">${s.id}</text>`);
}
for (const t of ['T', 'CT'] as const) {
  const z = map.spawnZones[t];
  parts.push(`<rect x="${z.x0 * S}" y="${z.y0 * S}" width="${(z.x1 - z.x0) * S}" height="${(z.y1 - z.y0) * S}" fill="none" stroke="${COLOR[t]}" stroke-width="2" stroke-dasharray="8 4"/>`);
  for (const s of map.spawns[t]) parts.push(`<circle cx="${(s.x / UNIT) * S}" cy="${(s.y / UNIT) * S}" r="${S * 0.8}" fill="${COLOR[t]}"/>`);
}
const seen = new Set<string>();
for (const r of map.regions) {
  if (seen.has(r.id)) continue;
  seen.add(r.id);
  parts.push(`<text x="${((r.x0 + r.x1) / 2) * S}" y="${((r.y0 + r.y1) / 2) * S}" font-size="${S * 1.5}" font-weight="600" fill="#1d2027" stroke="#fff" stroke-width="3" paint-order="stroke" text-anchor="middle" dominant-baseline="central">${esc(r.name)}</text>`);
}
parts.push('</svg>');
writeFileSync(out, `${parts.join('\n')}\n`);
