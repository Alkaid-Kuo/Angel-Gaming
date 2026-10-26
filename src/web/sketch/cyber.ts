// 設計稿 A：雨、遠方天際線（程式產生）
import { initStage, onFrame, still } from './stage.ts';

initStage();

// 天際線：消失點附近一排高低不一的樓，零星亮窗
const city = document.getElementById('city') as HTMLCanvasElement | null;
if (city) {
  const g = city.getContext('2d') as CanvasRenderingContext2D;
  let s = 11;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (const [col, base, hMin, hMax, win] of [
    ['#120a26', 300, 60, 200, 0.05],
    ['#0a0718', 320, 30, 150, 0.09],
  ] as const) {
    let x = 0;
    while (x < city.width) {
      const w = 30 + Math.floor(rnd() * 70);
      const h = hMin + Math.floor(rnd() * (hMax - hMin));
      g.fillStyle = col;
      g.fillRect(x, base - h, w, city.height);
      if (rnd() < 0.3) {
        g.fillRect(x + w / 2 - 1, base - h - 30, 2, 30);
      }
      for (let wy = base - h + 6; wy < base; wy += 8) {
        for (let wx = x + 4; wx < x + w - 4; wx += 7) {
          if (rnd() < win) {
            g.fillStyle = rnd() < 0.5 ? 'rgba(41,240,255,.55)' : 'rgba(255,46,136,.5)';
            g.fillRect(wx, wy, 3, 2);
          }
        }
      }
      x += w + 2;
    }
  }
}

// 雨：斜向細線，近的粗而快
const rain = document.getElementById('rain') as HTMLCanvasElement | null;
if (rain) {
  const g = rain.getContext('2d') as CanvasRenderingContext2D;
  const drops = Array.from({ length: still ? 160 : 240 }, (_, i) => ({ x: (i * 811) % 2100 - 100, y: (i * 467) % 1080, z: 0.3 + ((i * 29) % 10) / 14 }));
  onFrame((_t, mx) => {
    g.clearRect(0, 0, 1920, 1080);
    for (const d of drops) {
      d.y += 22 * d.z;
      d.x -= 5 * d.z;
      if (d.y > 1090) {
        d.y = -40;
        d.x = ((d.x + 1500) % 2100) - 100;
      }
      g.strokeStyle = `rgba(170,210,255,${0.12 + d.z * 0.12})`;
      g.lineWidth = d.z;
      g.beginPath();
      g.moveTo(d.x - mx * 30 * d.z, d.y);
      g.lineTo(d.x - mx * 30 * d.z - 6 * d.z, d.y + 26 * d.z);
      g.stroke();
    }
  });
}
