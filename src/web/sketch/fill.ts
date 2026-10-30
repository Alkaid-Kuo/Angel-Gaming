// 風格草圖共用：把頁面上的佔位元素換成隊徽與選手頭像。
//   data-crest="隊名" data-size        → 向量隊徽
//   data-avatar="種子" data-jersey data-size → 向量頭像
//   canvas[data-pix-avatar] / canvas[data-pix-crest] data-px data-scale → 像素化（縮到小格再整數倍放大，顏色量化到色票）
import { avatarSvg, crestSvg, icon, npcCrest, type CrestSpec, type IconName } from '../club/art.ts';

const ME: CrestSpec = { shape: 0, primary: '#3b82f6', secondary: '#d4a017', emblem: 'wings' };
const crestFor = (name: string): CrestSpec => (name === '天使戰隊' ? ME : npcCrest(name));

function hexRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
// 像素版（設計稿 B）只用雙色調：依亮度對到色階，我方 data-ramp="c"（靛→青）、對手 "p"（靛→粉）
const RAMPS: Record<string, [number, number, number][]> = {
  c: ['#060515', '#141838', '#1e2552', '#0c3550', '#1580a0', '#22b8d0', '#3ff0ff', '#b8fbff', '#f4f0ff'].map(hexRgb),
  p: ['#060515', '#141838', '#3d0f3f', '#7a1a5c', '#c4286c', '#ff3d7f', '#ff9ec4', '#f4f0ff'].map(hexRgb),
};

async function pixelate(svg: string, w: number, h: number, ramp: [number, number, number][]): Promise<ImageData | null> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '))}`;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h);
  // 先找出整張的亮度範圍，再拉滿整條色階（不然頭像會整片偏暗）
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < d.data.length; i += 4) {
    if (d.data[i + 3] < 110) continue;
    const l = d.data[i] * 0.3 + d.data[i + 1] * 0.59 + d.data[i + 2] * 0.11;
    lo = Math.min(lo, l);
    hi = Math.max(hi, l);
  }
  for (let i = 0; i < d.data.length; i += 4) {
    if (d.data[i + 3] < 110) {
      d.data[i + 3] = 0;
      continue;
    }
    const lum = (d.data[i] * 0.3 + d.data[i + 1] * 0.59 + d.data[i + 2] * 0.11 - lo) / Math.max(1, hi - lo + 1);
    const [r, g, b] = ramp[Math.min(ramp.length - 1, Math.floor(lum * ramp.length))];
    d.data[i] = r;
    d.data[i + 1] = g;
    d.data[i + 2] = b;
    d.data[i + 3] = 255;
  }
  return d;
}

async function paint(canvas: HTMLCanvasElement, svg: string, w: number, h: number): Promise<void> {
  const data = await pixelate(svg, w, h, RAMPS[canvas.dataset.ramp ?? 'c'] ?? RAMPS.c);
  if (!data) return;
  const scale = Number(canvas.dataset.scale ?? 4);
  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w * scale}px`;
  canvas.style.height = `${h * scale}px`;
  (canvas.getContext('2d') as CanvasRenderingContext2D).putImageData(data, 0, 0);
}

export async function fill(root: ParentNode = document): Promise<void> {
  root.querySelectorAll<HTMLElement>('[data-crest]').forEach((el) => {
    const spec = { ...crestFor(el.dataset.crest as string) };
    if (el.dataset.primary) spec.primary = el.dataset.primary;
    if (el.dataset.secondary) spec.secondary = el.dataset.secondary;
    el.innerHTML = crestSvg(spec, Number(el.dataset.size ?? 48));
  });
  root.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon as IconName, Number(el.dataset.size ?? 24), Number(el.dataset.stroke ?? 1.8));
  });
  root.querySelectorAll<HTMLElement>('[data-avatar]').forEach((el) => {
    el.innerHTML = avatarSvg(el.dataset.avatar as string, el.dataset.jersey ?? '#3b82f6', Number(el.dataset.size ?? 96));
  });
  const jobs: Promise<void>[] = [];
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-pix-avatar]').forEach((c) => {
    const px = Number(c.dataset.px ?? 32);
    jobs.push(paint(c, avatarSvg(c.dataset.pixAvatar as string, c.dataset.jersey ?? '#3b82f6', 100), px, px));
  });
  root.querySelectorAll<HTMLCanvasElement>('canvas[data-pix-crest]').forEach((c) => {
    const px = Number(c.dataset.px ?? 24);
    jobs.push(paint(c, crestSvg(crestFor(c.dataset.pixCrest as string), 100), px, Math.round(px * 1.1)));
  });
  await Promise.all(jobs);
  document.body.classList.add('ready');
}

// 完整 UI 的頁面（#stage 標了 data-screen）由 ui.ts 先補好外框與顏色再呼叫 fill()；
// 打包後 ui.ts 會先載入這支，所以這裡不能自己先畫
if (!document.querySelector('#stage[data-screen]')) void fill();
