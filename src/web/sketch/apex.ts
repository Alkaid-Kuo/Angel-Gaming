// 設計稿 E：舞台、浮塵；把選單磚與地上的光點擺到透視金環上（半徑 R，角度看 data-ang，270° 是正後方）
import { dust, initStage } from './stage.ts';

initStage();
dust(document.getElementById('dust') as HTMLCanvasElement, ['rgba(255,217,138,.55)', 'rgba(220,235,255,.35)']);

const R = 900;
const world = document.querySelector('.world');
document.querySelectorAll<HTMLElement>('.otile').forEach((el) => {
  const deg = Number(el.dataset.ang);
  const a = (deg * Math.PI) / 180;
  const x = R * Math.cos(a);
  const z = R * Math.sin(a);
  // 兩側的磚稍微轉向圓心
  const ry = (deg - 270) * 0.25;
  el.style.transform = `translate3d(${x.toFixed(1)}px, 0, ${z.toFixed(1)}px) rotateY(${ry.toFixed(1)}deg) translate(-50%, -100%)`;
  world?.insertAdjacentHTML('afterbegin', `<span class="spot" style="transform:translate3d(${x.toFixed(1)}px, 0, ${z.toFixed(1)}px) rotateX(90deg) translate(-50%, -50%)"></span>`);
});
