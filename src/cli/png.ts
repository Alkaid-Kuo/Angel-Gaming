// 地圖 PNG 輸出（Node）：每格 8×8 像素；不依賴外部套件。
import { deflateSync } from 'node:zlib';
import type { GeneratedMap } from '../mapgen/index.ts';

const PX = 8;
const COLORS: Record<string, [number, number, number]> = {
  plain: [95, 122, 69],
  blocked: [42, 45, 52],
  forest: [47, 82, 40],
  node: [125, 211, 252],
  rich: [251, 191, 36],
  tower: [229, 231, 235],
};
const SLOT_COLORS: [number, number, number][] = [
  [59, 130, 246],
  [239, 68, 68],
  [34, 197, 94],
  [234, 179, 8],
  [168, 85, 247],
  [249, 115, 22],
  [6, 182, 212],
  [236, 72, 153],
];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function renderPng(map: GeneratedMap): Buffer {
  const w = map.width * PX;
  const h = map.height * PX;
  const rgb = new Uint8Array(w * h * 3);
  const fill = (tx: number, ty: number, c: [number, number, number], inset = 0): void => {
    for (let y = ty * PX + inset; y < (ty + 1) * PX - inset; y++) {
      for (let x = tx * PX + inset; x < (tx + 1) * PX - inset; x++) {
        const i = (y * w + x) * 3;
        rgb[i] = c[0];
        rgb[i + 1] = c[1];
        rgb[i + 2] = c[2];
      }
    }
  };
  for (let ty = 0; ty < map.height; ty++) {
    for (let tx = 0; tx < map.width; tx++) {
      const t = map.tiles[ty * map.width + tx];
      fill(tx, ty, t === 1 ? COLORS.blocked : t === 2 ? COLORS.forest : COLORS.plain);
    }
  }
  for (const n of map.nodes) fill(n.tileX, n.tileY, n.rich ? COLORS.rich : COLORS.node, 1);
  for (const s of map.slots) {
    for (let y = s.tileY; y < s.tileY + 3; y++) for (let x = s.tileX; x < s.tileX + 3; x++) fill(x, y, SLOT_COLORS[s.slot % SLOT_COLORS.length]);
  }
  for (const t of map.watchtowers) {
    const tx = Math.floor(t.x / 1000);
    const ty = Math.floor(t.y / 1000);
    fill(tx - 1, ty - 1, COLORS.tower, 2);
    fill(tx, ty - 1, COLORS.tower, 2);
    fill(tx - 1, ty, COLORS.tower, 2);
    fill(tx, ty, COLORS.tower, 2);
  }
  // 每列前加 filter byte 0
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}
