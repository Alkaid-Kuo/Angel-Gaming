/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- 3D 預覽從 CDN 載入 Three.js（不進 package.json），沒有型別定義
// 唯讀的地圖 3D 預覽：把格子地圖的地形、高度、城牆、房舍、樹林立起來，用來檢視地圖設計（沒有軍團、不跑引擎）。
// 一格 ＝ 1 單位；高度一階 ＝ LH 單位（有誇大，方便看出台地與城牆）。
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/+esm';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js/+esm';
import { T, TILE, WALL_LEVELS } from '../../legion/config.ts';
import { MAPS } from '../../legion/map.ts';

const LH = 0.5;
const HOUSE_H = 1.0;
const ROOF_H = 0.6;

const GROUND = {
  [T.Plain]: '#7d9656',
  [T.Road]: '#b39b6c',
  [T.Forest]: '#56713f',
  [T.Hill]: '#93975c',
  [T.Shallow]: '#79a6b3',
  [T.River]: '#386a8a',
  [T.Bridge]: '#8a6845',
  [T.Building]: '#9b9386',
  [T.Wall]: '#a59d90',
  [T.Stair]: '#c2b9a8',
  [T.Gatehouse]: '#8f8577',
  [T.Paved]: '#aaa498',
  [T.Rubble]: '#8b7f71',
};
const NAMES = { 'river-valley': '河谷', 'grand-valley': '大河谷', 'stone-pass': '石關城', grassland: '大草原' };

// ───────── 場景與鏡頭 ─────────

const host = document.getElementById('view');
const labelsEl = document.getElementById('labels');
const status = document.getElementById('status');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#0b0d10');
scene.fog = new THREE.Fog('#0b0d10', 260, 520);
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.5, 1200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 8;
controls.maxDistance = 420;
controls.screenSpacePanning = false;

scene.add(new THREE.HemisphereLight('#e8eef5', '#4d4536', 1.1));
const sun = new THREE.DirectionalLight('#fff3dc', 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

let world = null;
let labels = [];
let current = null;

// ───────── 小工具 ─────────

const hash = (a, b, s) => {
  let h = (a * 374761393 + b * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** 收集三角形的頂點與顏色，最後組成一個 BufferGeometry */
class Builder {
  constructor() {
    this.pos = [];
    this.col = [];
  }
  tri(a, b, c, color) {
    this.pos.push(...a, ...b, ...c);
    for (let k = 0; k < 3; k++) this.col.push(color.r, color.g, color.b);
  }
  quad(a, b, c, d, color) {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }
  /** 長方體：x0..x1、z0..z1、y0..y1（底面不畫） */
  box(x0, z0, x1, z1, y0, y1, top, side) {
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], top);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], side);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], side);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], side);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], side);
  }
  /** 兩坡屋頂：屋脊沿長邊，出簷 e */
  roof(x0, z0, x1, z1, y0, rh, e, color, gable) {
    x0 -= e;
    z0 -= e;
    x1 += e;
    z1 += e;
    const yr = y0 + rh;
    if (x1 - x0 >= z1 - z0) {
      const zm = (z0 + z1) / 2;
      this.quad([x0, y0, z0], [x0, yr, zm], [x1, yr, zm], [x1, y0, z0], color);
      this.quad([x1, y0, z1], [x1, yr, zm], [x0, yr, zm], [x0, y0, z1], color);
      this.tri([x0, y0, z0], [x0, y0, z1], [x0, yr, zm], gable);
      this.tri([x1, y0, z1], [x1, y0, z0], [x1, yr, zm], gable);
    } else {
      const xm = (x0 + x1) / 2;
      this.quad([x0, y0, z1], [xm, yr, z1], [xm, yr, z0], [x0, y0, z0], color);
      this.quad([x1, y0, z0], [xm, yr, z0], [xm, yr, z1], [x1, y0, z1], color);
      this.tri([x0, y0, z0], [x1, y0, z0], [xm, yr, z0], gable);
      this.tri([x1, y0, z1], [x0, y0, z1], [xm, yr, z1], gable);
    }
  }
  mesh(material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeVertexNormals();
    return new THREE.Mesh(g, material);
  }
}

// ───────── 地圖 → 3D ─────────

function build(m) {
  const { width: w, height: h, terrain, heights } = m;
  const ox = -w / 2;
  const oz = -h / 2;
  const at = (x, y) => terrain[y * w + x];
  const isWall = (t) => t === T.Wall || t === T.Gatehouse;
  /** 每格地表的高度 */
  const topY = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return -1.2;
    const i = y * w + x;
    const t = terrain[i];
    const base = heights[i] * LH;
    if (t === T.River) return base - 0.35;
    if (t === T.Shallow) return base - 0.12;
    if (isWall(t)) return base + WALL_LEVELS * LH;
    if (t === T.Stair) return base + WALL_LEVELS * LH * 0.5;
    return base;
  };
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });

  // 地表：每格一塊頂面，比鄰格高的那幾邊補上側面（台地、城牆、河岸自然成形）
  const ground = new Builder();
  const c = new THREE.Color();
  const side = new THREE.Color();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = at(x, y);
      const y0 = topY(x, y);
      const v = 0.94 + hash(x, y, 7) * 0.12;
      c.set(GROUND[t] ?? '#888888').multiplyScalar(t === T.River || isWall(t) ? 1 : v);
      if (t !== T.Wall && t !== T.River && heights[y * w + x] >= 3 && !isWall(t)) c.offsetHSL(0, -0.03, 0.03 * (heights[y * w + x] - 2));
      const X0 = x + ox;
      const Z0 = y + oz;
      ground.quad([X0, y0, Z0], [X0, y0, Z0 + 1], [X0 + 1, y0, Z0 + 1], [X0 + 1, y0, Z0], c);
      side.copy(c).multiplyScalar(isWall(t) ? 0.78 : 0.7);
      const edges = [
        [1, 0, [X0 + 1, Z0], [X0 + 1, Z0 + 1]],
        [-1, 0, [X0, Z0 + 1], [X0, Z0]],
        [0, 1, [X0 + 1, Z0 + 1], [X0, Z0 + 1]],
        [0, -1, [X0, Z0], [X0 + 1, Z0]],
      ];
      for (const [dx, dy, a, b] of edges) {
        const yn = topY(x + dx, y + dy);
        if (yn >= y0) continue;
        ground.quad([a[0], yn, a[1]], [b[0], yn, b[1]], [b[0], y0, b[1]], [a[0], y0, a[1]], side);
      }
    }
  }
  const groundMesh = ground.mesh(mat);
  groundMesh.receiveShadow = true;
  groundMesh.castShadow = true;
  group.add(groundMesh);

  // 水面：河與護城河上一層半透明的水
  const water = new Builder();
  const wc = new THREE.Color('#4f8fb5');
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = at(x, y);
      if (t !== T.River && t !== T.Shallow) continue;
      const wy = heights[y * w + x] * LH - 0.05;
      water.quad([x + ox, wy, y + oz], [x + ox, wy, y + oz + 1], [x + ox + 1, wy, y + oz + 1], [x + ox + 1, wy, y + oz], wc);
    }
  }
  if (water.pos.length > 0) group.add(water.mesh(new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.55, side: THREE.DoubleSide })));

  // 房舍：把相連的房舍格切成不超過 4 × 7 的長方形，每塊一棟（牆身 ＋ 兩坡屋頂）
  const used = new Uint8Array(w * h);
  const houses = new Builder();
  const roofs = new Builder();
  const body = new THREE.Color('#d8cfbd');
  const bodySide = new THREE.Color('#bfb4a0');
  const roofC = new THREE.Color();
  const gable = new THREE.Color('#c9bfab');
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y) !== T.Building || used[y * w + x] === 1) continue;
      let x1 = x;
      while (x1 + 1 < w && x1 - x < 6 && at(x1 + 1, y) === T.Building && used[y * w + x1 + 1] === 0) x1 += 1;
      let y1 = y;
      const rowFree = (yy) => {
        for (let xx = x; xx <= x1; xx++) if (at(xx, yy) !== T.Building || used[yy * w + xx] === 1) return false;
        return true;
      };
      const maxD = x1 - x >= 3 ? 3 : 6;
      while (y1 + 1 < h && y1 - y < maxD && rowFree(y1 + 1)) y1 += 1;
      for (let yy = y; yy <= y1; yy++) for (let xx = x; xx <= x1; xx++) used[yy * w + xx] = 1;
      const gy = topY(x, y);
      const inset = 0.08;
      const X0 = x + ox + inset;
      const Z0 = y + oz + inset;
      const X1 = x1 + 1 + ox - inset;
      const Z1 = y1 + 1 + oz - inset;
      const tall = HOUSE_H * (0.85 + hash(x, y, 3) * 0.3);
      houses.box(X0, Z0, X1, Z1, gy, gy + tall, bodySide, body);
      const official = heights[y * w + x] >= 4;
      roofC.set(official ? '#7a3b2c' : '#4f5861').multiplyScalar(0.9 + hash(x, y, 5) * 0.2);
      roofs.roof(X0, Z0, X1, Z1, gy + tall, ROOF_H, 0.18, roofC, gable);
    }
  }
  if (houses.pos.length > 0) {
    const hm = houses.mesh(mat);
    const rm = roofs.mesh(mat);
    for (const q of [hm, rm]) {
      q.castShadow = true;
      q.receiveShadow = true;
      group.add(q);
    }
  }

  // 城牆垛口：牆頂外緣（鄰格比牆頂低）每隔一格一個
  const merlons = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isWall(at(x, y))) continue;
      const y0 = topY(x, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const tn = x + dx < 0 || y + dy < 0 || x + dx >= w || y + dy >= h ? -1 : at(x + dx, y + dy);
        if (isWall(tn) || tn === T.Stair) continue;
        if ((x + y) % 2 !== 0) continue;
        merlons.push([x + ox + 0.5 + dx * 0.38, y0 + 0.17, y + oz + 0.5 + dy * 0.38]);
      }
    }
  }
  if (merlons.length > 0) {
    const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), new THREE.MeshLambertMaterial({ color: '#b3ab9e' }), merlons.length);
    const mx = new THREE.Matrix4();
    merlons.forEach((p, k) => im.setMatrixAt(k, mx.makeTranslation(p[0], p[1], p[2])));
    im.castShadow = true;
    group.add(im);
  }

  // 城門樓：門樓格上方一座兩層的樓（牆身 ＋ 屋頂）
  const towers = new Builder();
  const towerRoof = new Builder();
  for (const g of m.gates) {
    const gy = topY(g.x0, g.y0);
    const X0 = g.x0 + ox - 0.3;
    const Z0 = g.y0 + oz - 0.3;
    const X1 = g.x1 + ox + 0.3;
    const Z1 = g.y1 + oz + 0.3;
    towers.box(X0 + 0.3, Z0 + 0.3, X1 - 0.3, Z1 - 0.3, gy, gy + 1.1, new THREE.Color('#9b4335'), new THREE.Color('#b14d3c'));
    towerRoof.roof(X0 + 0.3, Z0 + 0.3, X1 - 0.3, Z1 - 0.3, gy + 1.1, 0.8, 0.45, new THREE.Color('#3f464d'), new THREE.Color('#8a3a2e'));
  }
  if (towers.pos.length > 0) {
    for (const q of [towers.mesh(mat), towerRoof.mesh(mat)]) {
      q.castShadow = true;
      group.add(q);
    }
  }

  // 樹：樹林格每格一到兩棵
  const trees = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (at(x, y) !== T.Forest) continue;
      const n = hash(x, y, 11) < 0.55 ? 1 : 2;
      for (let k = 0; k < n; k++) trees.push([x + ox + 0.2 + hash(x, y, 20 + k) * 0.6, topY(x, y), y + oz + 0.2 + hash(x, y, 30 + k) * 0.6, 0.75 + hash(x, y, 40 + k) * 0.6]);
    }
  }
  if (trees.length > 0) {
    const crown = new THREE.ConeGeometry(0.5, 1.4, 7);
    crown.translate(0, 0.95, 0);
    const im = new THREE.InstancedMesh(crown, new THREE.MeshLambertMaterial({ color: '#ffffff' }), trees.length);
    const mx = new THREE.Matrix4();
    const tc = new THREE.Color();
    trees.forEach(([x, y, z, s], k) => {
      im.setMatrixAt(k, mx.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(s, s, s)));
      im.setColorAt(k, tc.set('#3f6230').offsetHSL(0, 0, (hash(k, 1, 9) - 0.5) * 0.08));
    });
    im.castShadow = true;
    im.receiveShadow = true;
    group.add(im);
  }

  // 布陣區（開關）：藍方攻、紅方守
  const deploy = new THREE.Group();
  m.deploy.forEach((z, p) => {
    const b = new Builder();
    const col = new THREE.Color(p === 0 ? '#3b82f6' : '#ef4444');
    const mask = m.deployMask?.[p] ?? null;
    for (let y = z.y0; y < z.y1; y++) {
      for (let x = z.x0; x < z.x1; x++) {
        if (mask !== null && mask[y * w + x] !== 1) continue;
        const yy = topY(x, y) + 0.04;
        b.quad([x + ox, yy, y + oz], [x + ox, yy, y + oz + 1], [x + ox + 1, yy, y + oz + 1], [x + ox + 1, yy, y + oz], col);
      }
    }
    deploy.add(b.mesh(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide })));
  });
  deploy.visible = document.getElementById('deploy').checked;
  group.add(deploy);

  // 旗：旗杆 ＋ 旗面
  const tagFor = (x, y) => {
    const tx = Math.min(w - 1, Math.max(0, Math.floor(x / TILE)));
    const ty = Math.min(h - 1, Math.max(0, Math.floor(y / TILE)));
    return new THREE.Vector3(x / TILE + ox, topY(tx, ty), y / TILE + oz);
  };
  const flagLabels = [];
  m.flags.forEach((f, k) => {
    const p = tagFor(f.x, f.y);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 4, 6), new THREE.MeshLambertMaterial({ color: '#3a2f25' }));
    pole.position.set(p.x, p.y + 2, p.z);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1), new THREE.MeshLambertMaterial({ color: '#d23b2f', side: THREE.DoubleSide }));
    cloth.position.set(p.x + 0.8, p.y + 3.4, p.z);
    pole.castShadow = true;
    cloth.castShadow = true;
    group.add(pole, cloth);
    flagLabels.push({ name: `${'ABC'[k]} ${f.name}`, at: p.clone().add(new THREE.Vector3(0, 4.3, 0)), flag: true });
  });
  const landmarkLabels = m.landmarks
    .filter((l) => !m.flags.some((f) => f.name === l.name))
    .map((l) => ({ name: l.name, at: tagFor(l.x, l.y).add(new THREE.Vector3(0, 1.6, 0)), flag: false }));
  return { group, deploy, labels: [...flagLabels, ...landmarkLabels] };
}

// ───────── 切換地圖、標籤、鏡頭 ─────────

function setLabels(list) {
  labelsEl.textContent = '';
  labels = list.map((l) => {
    const el = document.createElement('div');
    el.className = l.flag ? 'tag flag' : 'tag';
    el.textContent = l.name;
    labelsEl.appendChild(el);
    return { ...l, el };
  });
}

function setCamera(kind) {
  const m = current;
  const span = Math.max(m.width, m.height);
  const presets = { top: [0, span * 1.05, span * 0.02], tilt: [-span * 0.25, span * 0.62, span * 0.62], low: [-span * 0.55, span * 0.2, span * 0.38] };
  const [x, y, z] = presets[kind];
  camera.position.set(x, y, z);
  controls.target.set(0, 0, 0);
  controls.update();
}

function load(id) {
  const t0 = performance.now();
  if (world !== null) {
    scene.remove(world.group);
    world.group.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) for (const mm of [o.material].flat()) mm.dispose();
    });
  }
  current = MAPS[id]();
  world = build(current);
  scene.add(world.group);
  setLabels(world.labels);
  const span = Math.max(current.width, current.height);
  sun.position.set(-span * 0.45, span * 0.9, -span * 0.3);
  sun.target.position.set(0, 0, 0);
  const sc = sun.shadow.camera;
  sc.left = -span * 0.75;
  sc.right = span * 0.75;
  sc.top = span * 0.75;
  sc.bottom = -span * 0.75;
  sc.near = 1;
  sc.far = span * 3;
  sc.updateProjectionMatrix();
  setCamera('tilt');
  document.getElementById('desc').textContent = `${current.width} × ${current.height} 格。${current.description}`;
  status.textContent = `${current.name}：建模 ${Math.round(performance.now() - t0)} ms`;
  try {
    localStorage.setItem('legion-map3d', id);
  } catch {
    // 私密視窗等情況存不了，略過
  }
}

const sel = document.getElementById('map');
for (const id of Object.keys(MAPS)) {
  const o = document.createElement('option');
  o.value = id;
  o.textContent = `${NAMES[id] ?? id}（${id}）`;
  sel.appendChild(o);
}
let start = new URLSearchParams(location.search).get('map');
if (start === null) {
  try {
    start = localStorage.getItem('legion-map3d');
  } catch {
    start = null;
  }
}
sel.value = start !== null && MAPS[start] ? start : 'stone-pass';
sel.addEventListener('change', () => load(sel.value));
document.getElementById('deploy').addEventListener('change', (e) => {
  if (world !== null) world.deploy.visible = e.target.checked;
});
document.getElementById('names').addEventListener('change', (e) => {
  labelsEl.style.display = e.target.checked ? '' : 'none';
});
for (const b of document.querySelectorAll('[data-cam]')) b.addEventListener('click', () => setCamera(b.dataset.cam));
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

load(sel.value);

const v = new THREE.Vector3();
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
  const W = window.innerWidth;
  const H = window.innerHeight;
  for (const l of labels) {
    v.copy(l.at).project(camera);
    const dist = camera.position.distanceTo(l.at);
    const show = v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1 && (l.flag || dist < 260);
    l.el.style.display = show ? '' : 'none';
    if (show) {
      l.el.style.left = `${((v.x + 1) / 2) * W}px`;
      l.el.style.top = `${((1 - v.y) / 2) * H}px`;
    }
  }
});
