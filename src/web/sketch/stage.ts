// 設計稿共用舞台：以 1920×1080 設計、等比縮放到視窗；滑鼠視差（CSS 變數 --mx、--my，範圍 −1～1）；
// 網址帶 ?still 時是截圖模式：略過進場動畫、每個畫格回呼只跑一次。
export const still = location.search.includes('still');

type FrameHook = (t: number, mx: number, my: number) => void;
const hooks: FrameHook[] = [];

/** 每個畫格要跑的動畫（粒子、Mode 7 地板等）；截圖模式只跑一次 */
export function onFrame(fn: FrameHook): void {
  hooks.push(fn);
}

export function initStage(): HTMLElement {
  const stage = document.getElementById('stage') as HTMLElement;
  const fit = (): void => {
    stage.style.transform = `translate(-50%, -50%) scale(${Math.min(innerWidth / 1920, innerHeight / 1080)})`;
  };
  addEventListener('resize', fit);
  fit();
  if (still) stage.classList.add('still');
  let tx = 0;
  let ty = 0;
  let cx = 0;
  let cy = 0;
  window.addEventListener('mousemove', (e: MouseEvent) => {
    tx = (e.clientX / innerWidth) * 2 - 1;
    ty = (e.clientY / innerHeight) * 2 - 1;
  });
  const t0 = performance.now();
  const tick = (now: number): void => {
    cx += (tx - cx) * 0.06;
    cy += (ty - cy) * 0.06;
    stage.style.setProperty('--mx', cx.toFixed(4));
    stage.style.setProperty('--my', cy.toFixed(4));
    for (const h of hooks) h((now - t0) / 1000, cx, cy);
    if (!still) requestAnimationFrame(tick);
  };
  // 等各頁註冊好畫格回呼再開始
  setTimeout(() => requestAnimationFrame(tick), 0);
  return stage;
}

/** 浮塵粒子（畫在指定 canvas 上） */
export function dust(canvas: HTMLCanvasElement, colors: string[], count = 70): void {
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  const ps = Array.from({ length: count }, (_, i) => ({
    x: (i * 977) % canvas.width,
    y: (i * 571) % canvas.height,
    r: 0.6 + ((i * 37) % 10) / 6,
    v: 0.15 + ((i * 13) % 10) / 30,
    c: colors[i % colors.length],
  }));
  onFrame((_t, mx, my) => {
    g.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of ps) {
      p.y -= p.v;
      p.x += Math.sin(p.y / 90) * 0.25;
      if (p.y < -10) p.y = canvas.height + 10;
      g.fillStyle = p.c;
      g.beginPath();
      g.arc(p.x - mx * 20, p.y - my * 10, p.r, 0, Math.PI * 2);
      g.fill();
    }
  });
}
