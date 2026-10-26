// 設計稿 B：480×270 低解析背景（抖色天空、星星、天際線、Mode 7 旋轉地板與光環），放大 4 倍；像素圖示
import { initStage, onFrame, still } from './stage.ts';

initStage();

const W = 480;
const H = 270;
const HORIZON = 104;
const cv = document.getElementById('bg') as HTMLCanvasElement;
const g = cv.getContext('2d') as CanvasRenderingContext2D;
const img = g.createImageData(W, H);
const px = img.data;

const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const C = {
  sky0: hex('#0b0620'),
  sky1: hex('#1d0b3a'),
  sky2: hex('#4a1252'),
  sky3: hex('#ff2a6d'),
  city: hex('#140a2c'),
  city2: hex('#0a0618'),
  tileA: hex('#120a2a'),
  tileB: hex('#170e36'),
  grid: hex('#00c8e0'),
  ring: hex('#fcee0a'),
  ring2: hex('#ff2a6d'),
  fog: hex('#3a1450'),
};
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const put = (i: number, c: [number, number, number]): void => {
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
  px[i + 3] = 255;
};
/** 兩色之間以 Bayer 抖色混合（t 為 0～1） */
const dith = (x: number, y: number, a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => (t * 16 > BAYER[(y & 3) * 4 + (x & 3)] ? b : a);

// 天空（不動的部分預先算好）
const sky = new Uint8ClampedArray(W * HORIZON * 4);
{
  let seed = 3;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 0; y < HORIZON; y++) {
    for (let x = 0; x < W; x++) {
      const t = y / HORIZON;
      const c = t < 0.55 ? dith(x, y, C.sky0, C.sky1, t / 0.55) : t < 0.85 ? dith(x, y, C.sky1, C.sky2, (t - 0.55) / 0.3) : dith(x, y, C.sky2, C.sky3, (t - 0.85) / 0.15);
      const i = (y * W + x) * 4;
      sky.set([c[0], c[1], c[2], 255], i);
    }
  }
  // 太陽（條紋圓）
  for (let y = 40; y < HORIZON; y++) {
    for (let x = 300; x < 400; x++) {
      const dx = x - 350;
      const dy = y - 82;
      if (dx * dx + dy * dy < 44 * 44 && (y < 80 || (y % 4) > 1)) {
        const i = (y * W + x) * 4;
        const c = dith(x, y, hex('#ff6c11'), hex('#fcee0a'), Math.max(0, (82 - y) / 42));
        sky.set([c[0], c[1], c[2], 255], i);
      }
    }
  }
  // 天際線
  for (const [col, base, hMin, hMax] of [
    [C.city, HORIZON, 8, 30],
    [C.city2, HORIZON, 4, 18],
  ] as const) {
    let x = 0;
    while (x < W) {
      const w = 5 + Math.floor(rnd() * 12);
      const h = hMin + Math.floor(rnd() * (hMax - hMin));
      for (let y = base - h; y < base; y++) {
        for (let xx = x; xx < Math.min(W, x + w); xx++) {
          const i = (y * W + xx) * 4;
          const lit = (y - (base - h)) % 3 === 1 && (xx - x) % 2 === 1 && rnd() < 0.16;
          const c = lit ? (rnd() < 0.5 ? hex('#00f0ff') : hex('#ff2a6d')) : col;
          sky.set([c[0], c[1], c[2], 255], i);
        }
      }
      x += w + 1;
    }
  }
}
const stars = Array.from({ length: 70 }, (_, i) => ({ x: (i * 97) % W, y: (i * 53) % 60, p: i % 7 }));

function frame(t: number, mx: number): void {
  px.set(sky);
  for (const s of stars) {
    if (((Math.floor(t * 3) + s.p) % 7) < 5) put((s.y * W + s.x) * 4, hex('#f5f5f5'));
  }
  // Mode 7：攝影機繞著原點（舞台中心）轉，視線永遠朝向原點
  const ang = t * 0.12 + mx * 0.25;
  const camDist = 300;
  const camX = Math.sin(ang) * -camDist;
  const camZ = Math.cos(ang) * -camDist;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const focal = 160;
  const camH = 60;
  for (let y = HORIZON + 1; y < H; y++) {
    const p = y - HORIZON;
    const z = (camH * focal) / p;
    const fogT = Math.min(1, z / 900);
    for (let x = 0; x < W; x++) {
      const wx = ((x - W / 2) * z) / focal;
      const u = wx * ca + z * sa + camX;
      const v = -wx * sa + z * ca + camZ;
      const r = Math.sqrt(u * u + v * v);
      let c = ((Math.floor(u / 32) + Math.floor(v / 32)) & 1) === 0 ? C.tileA : C.tileB;
      const gu = ((u % 32) + 32) % 32;
      const gv = ((v % 32) + 32) % 32;
      if (gu < 1.6 || gv < 1.6) c = C.grid;
      if (Math.abs(r - 150) < 4) c = C.ring;
      else if (Math.abs(r - 168) < 2 && Math.floor((Math.atan2(v, u) + t * 0.6) * 10) % 2 === 0) c = C.ring2;
      else if (r < 120 && Math.abs(r - 100) < 1.4) c = C.ring2;
      put((y * W + x) * 4, dith(x, y, c, C.fog, fogT * 0.9));
    }
  }
  g.putImageData(img, 0, 0);
}
onFrame((t, mx) => frame(still ? 1.2 : t, mx));

// 8×8 像素圖示：. 透明、其他字元對應色票
const ICONS: Record<string, string[]> = {
  sword: ['......YY', '.....YY.', '....YY..', '.W.YY...', '..WY....', '..BW....', '.B..W...', 'B.......'],
  scroll: ['.WWWWW..', 'W.....W.', '.WCCC.W.', '.W....W.', '.WCCC.W.', '.W....W.', '.WWWWW.W', '......W.'],
  target: ['..MMMM..', '.M....M.', 'M..WW..M', 'M.W..W.M', 'M.W..W.M', 'M..WW..M', '.M....M.', '..MMMM..'],
  cup: ['YYYYYYYY', 'Y.YYYY.Y', '.YYYYYY.', '..YYYY..', '...YY...', '...YY...', '..YYYY..', '.YYYYYY.'],
  dice: ['WWWWWWWW', 'W.....MW', 'W......W', 'W..MM..W', 'W..MM..W', 'W......W', 'WM.....W', 'WWWWWWWW'],
  coin: ['..YYYY..', '.YYWWYY.', 'YYWYYYYY', 'YYWYYYYY', 'YYYWWYYY', 'YYYYYWYY', '.YYWWYY.', '..YYYY..'],
};
const PAL: Record<string, string> = { Y: '#fcee0a', W: '#f5f5f5', B: '#8c1eff', C: '#00f0ff', M: '#ff2a6d' };
document.querySelectorAll<HTMLElement>('[data-px-icon]').forEach((el) => {
  const rows = ICONS[el.dataset.pxIcon as string];
  const k = Number(el.dataset.k ?? 6);
  const rects = rows.flatMap((row, y) => [...row].map((ch, x) => (ch === '.' ? '' : `<rect x="${x}" y="${y}" width="1" height="1" fill="${PAL[ch]}"/>`)));
  el.innerHTML = `<svg width="${8 * k}" height="${8 * k}" viewBox="0 0 8 8" shape-rendering="crispEdges">${rects.join('')}</svg>`;
});
