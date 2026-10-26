// 風格草圖共用：把頁面上的佔位元素換成隊徽與選手頭像。
//   data-crest="隊名" data-size        → 向量隊徽
//   data-avatar="種子" data-jersey data-size → 向量頭像
//   canvas[data-pix-avatar] / canvas[data-pix-crest] data-px data-scale → 像素化（縮到小格再整數倍放大，顏色量化到色票）
import { avatarSvg, crestSvg, npcCrest, type CrestSpec } from '../club/art.ts';

const ME: CrestSpec = { shape: 0, primary: '#3b82f6', secondary: '#d4a017', emblem: 'wings' };
const crestFor = (name: string): CrestSpec => (name === '天使戰隊' ? ME : npcCrest(name));

const NEON_PALETTE = [
  '#0d0221', '#1a1040', '#2e2160', '#541388', '#8c1eff', '#ff2a6d', '#ff6c11', '#fcee0a', '#00f0ff', '#05d9e8', '#1de9b6',
  '#f5f5f5', '#c0c0d8', '#7a7aa0', '#3b82f6', '#1e3a8a', '#d4a017', '#f6d2b8', '#e2b48f', '#b9825a', '#8a5a3b', '#3b2a20', '#111111',
];

function hexRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}
const PAL = NEON_PALETTE.map(hexRgb);

async function pixelate(svg: string, w: number, h: number): Promise<ImageData | null> {
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
  for (let i = 0; i < d.data.length; i += 4) {
    if (d.data[i + 3] < 110) {
      d.data[i + 3] = 0;
      continue;
    }
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < PAL.length; k++) {
      const dr = d.data[i] - PAL[k][0];
      const dg = d.data[i + 1] - PAL[k][1];
      const db = d.data[i + 2] - PAL[k][2];
      const dist = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
      if (dist < bd) {
        bd = dist;
        best = k;
      }
    }
    d.data[i] = PAL[best][0];
    d.data[i + 1] = PAL[best][1];
    d.data[i + 2] = PAL[best][2];
    d.data[i + 3] = 255;
  }
  return d;
}

async function paint(canvas: HTMLCanvasElement, svg: string, w: number, h: number): Promise<void> {
  const data = await pixelate(svg, w, h);
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
    el.innerHTML = crestSvg(crestFor(el.dataset.crest as string), Number(el.dataset.size ?? 48));
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

void fill();
