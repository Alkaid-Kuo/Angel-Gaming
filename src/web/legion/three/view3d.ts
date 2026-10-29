// 即時 3D 觀戰：吃和 2D 觀戰同一份 worker 狀態流（LegionFrame），畫成 3D 沙盤；對外介面和 2D 的 LegionRenderer 一樣（BattleView），
// 觀戰畫面換一個繪製器就能用。世界層（地形、城池、士兵、托盤與地面範圍）用 Three.js；資訊層（軍團旗標、特效文字、倒數）畫在疊在上面的 2D 畫布。
// 鏡頭沿用 2D 的 cam（中心、每格像素）：拉遠是 66° 的高空俯視、拉近慢慢壓低到 32°；拉近後可以水平轉一整圈（右鍵拖曳或 [ ]），拉遠慢慢轉回北朝上。
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { DASH, FORMATION_NAMES, RULES, T, TERRAIN_NAMES, TILE, TPS, UNITS, stopsCavalry, walkable, type UnitKind } from '../../../legion/config.ts';
import { MAPS, type LegionMap } from '../../../legion/map.ts';
import { drawUnitIcon } from '../icons.ts';
import type { RamInfo } from '../../../legion/api.ts';
import { DOWN_BIT, LAYER_SHIFT, REG_MASK, type LegionFrame, type LegionMeta, type RegFrame } from '../protocol.ts';
import { DASH_COLOR, DASH_NAME, TAG, TEAM, TEAM_LIGHT, type Camera, type DrawOptions } from '../render.ts';
import type { BattleView } from '../view.ts';
import { City } from './city.ts';
import { Ground } from './ground.ts';
import { Nature } from './nature.ts';
import { PAL } from './palette.ts';
import { Siege } from './siege.ts';
import { Arrows, GroundDecals, Soldiers, type Pose } from './units.ts';

interface Effect {
  kind: 'ring' | 'text';
  x: number;
  y: number;
  t0: number;
  life: number;
  color: string;
  text?: string;
  size?: number;
}

interface Corpse {
  x: number;
  y: number;
  owner: number;
  kind: UnitKind;
  layer: number;
}

const DEG = Math.PI / 180;
const PITCH_FAR = 66 * DEG;
const PITCH_NEAR = 32 * DEG;
/** 水平轉角包回 -π～π */
const wrapYaw = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const MAX_SCALE = 140;
/** 主光從西北上方照下來（v2 第七節） */
const SUN_DIR = new THREE.Vector3(-0.55, 0.62, -0.45).normalize();

/** 移軸模糊（一個方向）：畫面中央一條帶子清楚，越往上下越模糊（v2 第二節）；amount 0 ＝ 不模糊 */
const TILT_SHADER = {
  uniforms: { tDiffuse: { value: null }, dir: { value: new THREE.Vector2(1, 0) }, amount: { value: 0 } },
  vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: [
    'uniform sampler2D tDiffuse;',
    'uniform vec2 dir;',
    'uniform float amount;',
    'varying vec2 vUv;',
    'void main() {',
    '  float k = smoothstep(0.2, 0.5, abs(vUv.y - 0.5)) * amount;',
    '  if (k <= 0.0) { gl_FragColor = texture2D(tDiffuse, vUv); return; }',
    '  vec2 d = dir * k;',
    '  vec4 s = texture2D(tDiffuse, vUv) * 0.2270;',
    '  s += (texture2D(tDiffuse, vUv + d * 1.3846) + texture2D(tDiffuse, vUv - d * 1.3846)) * 0.3162;',
    '  s += (texture2D(tDiffuse, vUv + d * 3.2308) + texture2D(tDiffuse, vUv - d * 3.2308)) * 0.0703;',
    '  gl_FragColor = s;',
    '}',
  ].join('\n'),
};

/** 依地圖名稱找回地圖（meta 只有名稱；城門洞、建物外觀要從地圖資料拿） */
function mapByName(name: string): LegionMap {
  for (const id of Object.keys(MAPS)) {
    const m = MAPS[id]();
    if (m.name === name) return m;
  }
  throw new Error(`找不到地圖：${name}`);
}

export class Legion3DView implements BattleView {
  readonly canvas: HTMLCanvasElement;
  readonly cam: Camera = { x: 80, y: 50, scale: 8 };
  readonly kindOf: UnitKind[];
  readonly ownerOf: number[];
  private readonly ctx: CanvasRenderingContext2D;
  private readonly meta: LegionMeta;
  private readonly map: LegionMap;
  private readonly gl: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(34, 1, 0.5, 2000);
  private readonly sun: THREE.DirectionalLight;
  private readonly composer: EffectComposer;
  private readonly ao: GTAOPass;
  private readonly tiltH: ShaderPass;
  private readonly tiltV: ShaderPass;
  /** 戰爭迷霧（一方視角時，看不到的地面變暗）：貼在地形上的一張畫布 */
  private readonly fogCanvas = document.createElement('canvas');
  private readonly fogTex: THREE.CanvasTexture;
  private readonly fog: THREE.Mesh;
  private readonly ground: Ground;
  private readonly city: City;
  private readonly nature: Nature;
  private readonly siege: Siege;
  private readonly soldiers: Soldiers;
  private readonly fallen: Soldiers;
  private readonly arrows = new Arrows(800);
  private readonly decals = new GroundDecals(80000);
  private readonly deploy = new GroundDecals(120000);
  private readonly team: THREE.Color[];
  private prev: LegionFrame | null = null;
  private cur: LegionFrame | null = null;
  private prevX: Int32Array;
  private prevY: Int32Array;
  private hasPrev: Uint8Array;
  private regById = new Map<number, RegFrame>();
  private prevRegById = new Map<number, RegFrame>();
  private field: RegFrame[] = [];
  private effects: Effect[] = [];
  private corpses: Corpse[] = [];
  /** 每團士兵多數所在的層（托盤畫在牆頂還是地面） */
  private regLayer = new Map<number, number>();
  private regTop = new Map<number, number>();
  /** 瞄準預覽的文字（地面標示畫完後由資訊層畫） */
  private aimText: { x: number; z: number; text: string; color: string }[] = [];
  /** 使用者轉的水平角與俯角微調 */
  private yaw = 0;
  private tilt = 0;
  private targetY = 0;
  private readonly disposers: (() => void)[] = [];
  private readonly ray = new THREE.Raycaster();
  private readonly v = new THREE.Vector3();

  constructor(overlay: HTMLCanvasElement, meta: LegionMeta) {
    this.canvas = overlay;
    this.ctx = overlay.getContext('2d')!;
    this.meta = meta;
    this.map = mapByName(meta.mapName);
    this.kindOf = meta.regs.map((r) => r.kind);
    this.ownerOf = meta.regs.map((r) => r.owner);
    this.prevX = new Int32Array(meta.soldierCount);
    this.prevY = new Int32Array(meta.soldierCount);
    this.hasPrev = new Uint8Array(meta.soldierCount);
    this.team = meta.players.map((p) => new THREE.Color(p.color));
    // WebGL 畫布放在資訊層底下（滑鼠事件仍由資訊層的畫布接）
    this.gl = document.createElement('canvas');
    this.gl.className = 'lg-canvas lg-gl';
    this.gl.style.pointerEvents = 'none';
    overlay.parentElement!.insertBefore(this.gl, overlay);
    this.renderer = new THREE.WebGLRenderer({ canvas: this.gl, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(PAL.bg);
    // 光：西北上方的暖色主光、天空與地面的半球光（v2 第七節）
    this.scene.add(new THREE.HemisphereLight(0xe9eff6, 0x5a5040, 1.15));
    this.sun = new THREE.DirectionalLight(0xfff0dc, 2.7);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.00015;
    this.sun.shadow.normalBias = 0.012;
    this.sun.shadow.radius = 2;
    this.scene.add(this.sun, this.sun.target);
    // 世界：地形、城池、樹、攻城物件
    this.ground = new Ground(this.map);
    this.city = new City(this.map, this.ground, meta.players.map((p) => p.color));
    this.nature = new Nature(this.map, this.ground);
    this.siege = new Siege(this.city, this.ground, meta.mode === 'capture' || meta.mode === 'siege' ? meta.flags : [], this.map.ram !== undefined);
    this.scene.add(this.ground.group, this.city.group, this.nature.group, this.siege.group);
    this.buildDeploy();
    const cap: Partial<Record<UnitKind, number>> = {};
    for (const r of meta.regs) cap[r.kind] = (cap[r.kind] ?? 0) + r.men0;
    this.soldiers = new Soldiers(cap);
    this.fallen = new Soldiers(cap);
    this.scene.add(this.soldiers.group, this.fallen.group, this.arrows.mesh, this.decals.mesh, this.deploy.mesh);
    // 戰爭迷霧：和地形同一份幾何（UV 一樣），畫布每格 2 像素
    this.fogCanvas.width = meta.width * 2;
    this.fogCanvas.height = meta.height * 2;
    this.fogTex = new THREE.CanvasTexture(this.fogCanvas);
    this.fog = new THREE.Mesh(this.ground.terrain.geometry, new THREE.MeshBasicMaterial({ map: this.fogTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
    this.fog.renderOrder = 3;
    this.fog.visible = false;
    this.scene.add(this.fog);
    // 後製：場景 → 環境遮蔽 → 移軸（左右、上下）→ 色調映射
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.ao = new GTAOPass(this.scene, this.camera, 512, 512);
    this.ao.blendIntensity = 0.55;
    this.ao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.5, thickness: 1.2, scale: 1 });
    this.composer.addPass(this.ao);
    this.tiltH = new ShaderPass(TILT_SHADER);
    this.tiltV = new ShaderPass(TILT_SHADER);
    this.composer.addPass(this.tiltH);
    this.composer.addPass(this.tiltV);
    this.composer.addPass(new OutputPass());
    this.bindRotate();
    // 開發時從主控台檢查場景用（正式建置不帶）
    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__v3d = { view: this, scene: this.scene };
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.ground.dispose();
    this.city.dispose();
    this.nature.dispose();
    this.siege.dispose();
    this.soldiers.dispose();
    this.fallen.dispose();
    this.arrows.dispose();
    this.decals.dispose();
    this.deploy.dispose();
    this.fogTex.dispose();
    (this.fog.material as THREE.Material).dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.gl.remove();
  }

  /** 3D 畫面要不要顯示（切回 2D 時藏起來） */
  setVisible(on: boolean): void {
    this.gl.style.display = on ? '' : 'none';
  }

  get frame(): LegionFrame | null {
    return this.cur;
  }

  reg(id: number): RegFrame | undefined {
    return this.regById.get(id);
  }

  // ───────── 狀態流 ─────────

  push(f: LegionFrame, now: number): void {
    if (this.cur !== null) {
      this.prev = this.cur;
      this.hasPrev.fill(0);
      const s = this.cur.soldiers;
      for (let i = 0; i < s.length; i += 4) {
        this.prevX[s[i]] = s[i + 1];
        this.prevY[s[i]] = s[i + 2];
        this.hasPrev[s[i]] = 1;
      }
      // 陣亡：上一格在、這一格不在
      const alive = new Uint8Array(this.meta.soldierCount);
      for (let i = 0; i < f.soldiers.length; i += 4) alive[f.soldiers[i]] = 1;
      for (let i = 0; i < s.length; i += 4) {
        if (alive[s[i]] === 1) continue;
        const reg = s[i + 3] & REG_MASK;
        this.corpses.push({ x: s[i + 1], y: s[i + 2], owner: this.ownerOf[reg], kind: this.kindOf[reg], layer: (s[i + 3] >> LAYER_SHIFT) & 3 });
      }
      if (this.corpses.length > 2500) this.corpses.splice(0, this.corpses.length - 2500);
    }
    this.prevRegById = this.regById;
    this.cur = f;
    this.regById = new Map(f.regs.map((r) => [r.id, r]));
    this.field = f.regs.filter((r) => !r.reserve);
    for (const ev of f.events) this.effectFor(ev, now);
  }

  reset(): void {
    this.prev = null;
    this.cur = null;
    this.effects = [];
    this.corpses = [];
    this.regById = new Map();
    this.prevRegById = new Map();
  }

  private regPos(id: number): { x: number; y: number } | null {
    const r = this.regById.get(id) ?? this.prevRegById.get(id);
    return r === undefined ? null : { x: r.x, y: r.y };
  }

  private effectFor(ev: LegionFrame['events'][number], now: number): void {
    const text = (id: number, color: string, t: string, life: number, size = 1): void => {
      const p = this.regPos(id);
      if (p !== null) this.effects.push({ kind: 'text', x: p.x, y: p.y, t0: now, life, color, text: t, size });
    };
    switch (ev.type) {
      case 'impact': {
        if (ev.target < 0 && ev.kills === 0) return;
        const p = this.regPos(ev.target) ?? this.regPos(ev.reg);
        if (p === null) return;
        const hit = [ev.kills > 0 ? `-${ev.kills}` : '', ev.downed > 0 ? `倒 ${ev.downed}` : ''].filter((x) => x !== '').join(' ');
        const color = ev.braced ? '#e2e8f0' : DASH_COLOR[ev.kind];
        this.effects.push({ kind: 'ring', x: p.x, y: p.y, t0: now, life: 900, color, size: ev.kind === 'charge' ? 3.6 : 2.6 });
        this.effects.push({ kind: 'text', x: p.x, y: p.y, t0: now, life: 1800, color, text: ev.braced ? `擋下${DASH_NAME[ev.kind]}！` : `${DASH_NAME[ev.kind]}！${hit}` });
        return;
      }
      case 'skill':
        if (ev.skill === 'volley') text(ev.reg, '#fbbf24', '齊射！', 1400, 0.8);
        else if (ev.skill === 'wall') text(ev.reg, '#a5f3fc', '盾牆！', 1400, 0.8);
        else if (ev.skill === 'brace') text(ev.reg, '#a5f3fc', '槍林！', 1400, 0.8);
        return;
      case 'ambush': {
        const p = this.regPos(ev.reg);
        if (p !== null) this.effects.push({ kind: 'ring', x: p.x, y: p.y, t0: now, life: 1200, color: '#facc15', size: 5 });
        text(ev.reg, '#fde047', '伏兵！', 2200);
        return;
      }
      case 'levelUp':
        text(ev.reg, '#fbbf24', `★ 老兵 ${ev.level}`, 2000);
        return;
      case 'contact':
        if (ev.flank !== 'front') text(ev.b, '#f87171', ev.flank === 'rear' ? '背擊！' : '側擊！', 1600);
        return;
      case 'flag': {
        const fl = this.meta.flags[ev.flag];
        this.effects.push({ kind: 'ring', x: fl.x, y: fl.y, t0: now, life: 1200, color: ev.owner >= 0 ? TEAM[ev.owner] : '#e2e8f0', size: RULES.capture.radius / TILE });
        return;
      }
      default:
        return;
    }
  }

  // ───────── 鏡頭 ─────────

  get fitScale(): number {
    return Math.min(this.canvas.clientWidth / this.meta.width, this.canvas.clientHeight / (this.meta.height * 0.92)) * 0.88;
  }

  fit(): void {
    this.cam.scale = this.fitScale;
    this.cam.x = this.meta.width / 2;
    this.cam.y = this.meta.height / 2;
    this.yaw = 0;
    this.tilt = 0;
  }

  clamp(): void {
    this.cam.scale = Math.max(this.fitScale * 0.85, Math.min(MAX_SCALE, this.cam.scale));
    this.cam.x = Math.max(0, Math.min(this.meta.width, this.cam.x));
    this.cam.y = Math.max(0, Math.min(this.meta.height, this.cam.y));
  }

  /** 拉近的程度：0 ＝ 全圖、1 ＝ 最近 */
  private zoomT(): number {
    const lo = Math.log(this.fitScale);
    const hi = Math.log(MAX_SCALE * 0.6);
    return Math.max(0, Math.min(1, (Math.log(this.cam.scale) - lo) / (hi - lo)));
  }

  private updateCamera(): void {
    const cw = Math.max(1, this.canvas.clientWidth);
    const ch = Math.max(1, this.canvas.clientHeight);
    const t = this.zoomT();
    const ease = t * t * (3 - 2 * t);
    const pitch = Math.max(20 * DEG, Math.min(80 * DEG, PITCH_FAR + (PITCH_NEAR - PITCH_FAR) * ease + this.tilt));
    const yaw = wrapYaw(this.yaw) * Math.min(1, t * 2.2);
    const fov = 34 - 4 * ease;
    const gy = this.ground.heightAt(this.cam.x, this.cam.y);
    this.targetY += (gy - this.targetY) * 0.15;
    if (!Number.isFinite(this.targetY)) this.targetY = gy;
    const dist = ch / (2 * this.cam.scale * Math.tan((fov * DEG) / 2));
    const c = this.camera;
    c.fov = fov;
    c.aspect = cw / ch;
    c.near = Math.max(0.3, dist * 0.08);
    c.far = dist * 4 + 600;
    c.position.set(this.cam.x + Math.sin(yaw) * Math.cos(pitch) * dist, this.targetY + Math.sin(pitch) * dist, this.cam.y + Math.cos(yaw) * Math.cos(pitch) * dist);
    c.lookAt(this.cam.x, this.targetY, this.cam.y);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    this.fitShadow(cw, ch);
  }

  /**
   * 陰影只算看得到的那一塊：畫面四角與中心射到地面的點，換到光的座標系取外框（往光源那側多留一段，畫面外的高樓影子也照得進來），
   * 外框對齊陰影貼圖的像素格，鏡頭移動時陰影邊緣不會閃。
   */
  private fitShadow(cw: number, ch: number): void {
    const center = new THREE.Vector3(this.cam.x, this.targetY, this.cam.y);
    const sc = this.sun.shadow.camera;
    this.sun.position.copy(center).add(SUN_DIR.clone().multiplyScalar(150));
    this.sun.target.position.copy(center);
    this.sun.target.updateMatrixWorld();
    sc.position.copy(this.sun.position);
    sc.lookAt(center);
    sc.updateMatrixWorld();
    const inv = sc.matrixWorldInverse;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    const far = this.camera.position.distanceTo(center) * 2.5;
    const p = new THREE.Vector3();
    for (const [sx, sy] of [
      [0, 0],
      [cw, 0],
      [0, ch],
      [cw, ch],
      [cw / 2, ch / 2],
    ]) {
      this.ray.setFromCamera(new THREE.Vector2((sx / cw) * 2 - 1, -(sy / ch) * 2 + 1), this.camera);
      const o = this.ray.ray.origin;
      const d = this.ray.ray.direction;
      const t = d.y < -1e-3 ? Math.min(far, (this.targetY - 0.5 - o.y) / d.y) : far;
      for (const lift of [0, 4]) {
        p.copy(o).addScaledVector(d, t);
        p.y += lift;
        p.applyMatrix4(inv);
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y);
        y1 = Math.max(y1, p.y);
      }
    }
    const m = 3;
    const size = Math.max(x1 - x0, y1 - y0) + m * 2;
    const texel = size / this.sun.shadow.mapSize.x;
    const snap = (v: number): number => Math.round(v / texel) * texel;
    sc.left = snap(x0 - m);
    sc.right = sc.left + size;
    sc.bottom = snap(y0 - m);
    sc.top = sc.bottom + size;
    sc.near = 1;
    sc.far = 420;
    sc.updateProjectionMatrix();
  }

  /** 右鍵拖曳（純觀戰）或 [ ] 鍵：水平轉、上下壓 */
  private bindRotate(): void {
    let drag: { x: number; y: number; yaw: number; tilt: number } | null = null;
    const down = (e: MouseEvent): void => {
      if (e.button !== 2 || this.meta.playerSide >= 0) return;
      drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, tilt: this.tilt };
    };
    const move = (e: MouseEvent): void => {
      if (drag === null || (e.buttons & 2) === 0) {
        drag = null;
        return;
      }
      this.yaw = wrapYaw(drag.yaw - (e.clientX - drag.x) * 0.006);
      this.tilt = Math.max(-14 * DEG, Math.min(14 * DEG, drag.tilt + (e.clientY - drag.y) * 0.004));
    };
    const ctx = (e: Event): void => {
      if (this.meta.playerSide < 0) e.preventDefault();
    };
    const key = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === '[') this.yaw = wrapYaw(this.yaw - 15 * DEG);
      else if (e.key === ']') this.yaw = wrapYaw(this.yaw + 15 * DEG);
    };
    this.canvas.addEventListener('mousedown', down);
    window.addEventListener('mousemove', move);
    this.canvas.addEventListener('contextmenu', ctx);
    window.addEventListener('keydown', key);
    this.disposers.push(() => {
      this.canvas.removeEventListener('mousedown', down);
      window.removeEventListener('mousemove', move);
      this.canvas.removeEventListener('contextmenu', ctx);
      window.removeEventListener('keydown', key);
    });
  }

  /** 螢幕像素 → 世界單位（射線打在地面上） */
  toWorld(px: number, py: number): { x: number; y: number } {
    this.updateCamera();
    const ndc = new THREE.Vector2((px / Math.max(1, this.canvas.clientWidth)) * 2 - 1, -(py / Math.max(1, this.canvas.clientHeight)) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const o = this.ray.ray.origin;
    const d = this.ray.ray.direction;
    let y = this.targetY;
    let x = this.cam.x;
    let z = this.cam.y;
    for (let k = 0; k < 5 && Math.abs(d.y) > 1e-4; k++) {
      const t = (y - o.y) / d.y;
      x = o.x + d.x * t;
      z = o.z + d.z * t;
      y = this.ground.heightAt(x, z);
    }
    return { x: x * TILE, y: z * TILE };
  }

  private project(x: number, y: number, z: number): [number, number, boolean] {
    this.v.set(x, y, z).project(this.camera);
    return [(this.v.x * 0.5 + 0.5) * this.canvas.clientWidth, (-this.v.y * 0.5 + 0.5) * this.canvas.clientHeight, this.v.z < 1];
  }

  toScreen(x: number, y: number): [number, number] {
    const p = this.project(x / TILE, this.heightAt(x / TILE, y / TILE, 0) + 0.3, y / TILE);
    return [p[0], p[1]];
  }

  ping(x: number, y: number, color: string): void {
    this.effects.push({ kind: 'ring', x, y, t0: performance.now(), life: 600, color, size: 1.6 });
  }

  regAt(id: number, alpha: number): { x: number; y: number; facing: number } | null {
    const a = this.prevRegById.get(id);
    const b = this.regById.get(id);
    if (b === undefined || b.reserve) return null;
    if (a === undefined) return { x: b.x, y: b.y, facing: b.facing };
    let df = b.facing - a.facing;
    if (df > 180) df -= 360;
    if (df < -180) df += 360;
    return { x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha, facing: a.facing + df * alpha };
  }

  shown(id: number, viewer: number): boolean {
    if (viewer < 0 || this.cur === null) return true;
    if (this.ownerOf[id] === viewer) return true;
    return this.cur.visible[viewer][id] === 1;
  }

  pick(px: number, py: number, viewer: number, alpha: number): number {
    if (this.cur === null) return -1;
    this.updateCamera();
    let best = -1;
    let bestD = Infinity;
    for (const r of this.field) {
      if (!this.shown(r.id, viewer)) continue;
      const p = this.regAt(r.id, alpha);
      if (p === null) continue;
      const top = this.regTop.get(r.id) ?? this.heightAt(p.x / TILE, p.y / TILE, 0);
      const [sx, sy, ok] = this.project(p.x / TILE, top + 0.3, p.y / TILE);
      if (!ok) continue;
      const d = Math.hypot(sx - px, sy - py);
      const lim = Math.max(18, (r.rad / TILE + 0.6) * this.cam.scale);
      if (d < lim && d < bestD) {
        bestD = d;
        best = r.id;
      }
    }
    return best;
  }

  /** 該處的高度：牆頂層站在牆頂、爬梯中沿梯子、地面層在馬道上沿石階 */
  private heightAt(x: number, z: number, layer: number): number {
    if (layer === 1) {
      const tx = Math.floor(x);
      const ty = Math.floor(z);
      const st = this.city.stairHeight(x, z);
      if (st !== null) return st;
      return this.city.wallTop(tx, ty);
    }
    if (layer === 2 && this.cur !== null) {
      // 爬雲梯：找最近的雲梯，依離梯腳多遠內插
      let best: { d: number; t: number; y0: number; y1: number } | null = null;
      for (const l of this.cur.structures.ladders) {
        const fx = l.footX / TILE;
        const fz = l.footY / TILE;
        const tx = l.x / TILE;
        const tz = l.y / TILE;
        const len = Math.hypot(tx - fx, tz - fz) || 1;
        const along = ((x - fx) * (tx - fx) + (z - fz) * (tz - fz)) / len;
        const d = Math.abs((x - fx) * (tz - fz) - (z - fz) * (tx - fx)) / len;
        if (best === null || d < best.d) best = { d, t: Math.max(0, Math.min(1, along / Math.max(0.3, len - 0.5))), y0: this.city.surfaceAt(fx, fz), y1: this.city.wallTop(Math.floor(tx), Math.floor(tz)) };
      }
      if (best !== null) return best.y0 + (best.y1 - best.y0) * best.t;
    }
    return this.city.surfaceAt(x, z);
  }

  // ───────── 畫面 ─────────

  draw(alpha: number, now: number, opt: DrawOptions): void {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== cw || size.y !== ch) {
      this.renderer.setSize(cw, ch, false);
      this.composer.setSize(cw, ch);
    }
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr);
      this.canvas.height = Math.round(ch * dpr);
    }
    this.updateCamera();
    const f = this.cur;
    this.deploy.mesh.visible = f === null || f.tick < 30;
    this.decals.begin();
    if (f !== null) {
      this.drawSoldiers(f, alpha, now, opt);
      this.drawFallen();
      this.drawArrows(f, alpha);
      this.drawGroundMarks(f, alpha, now, opt);
      this.siege.update(f.structures, f.flags.map((q) => q.owner), this.team, now, f.tick, this.ramAt(alpha));
    }
    this.decals.end();
    this.ground.update(now);
    // 移軸：全圖不模糊，拉近越多帶子外越糊
    const blur = Math.max(0, (this.zoomT() - 0.35) / 0.65) * 2.4;
    const pr = this.renderer.getPixelRatio();
    (this.tiltH.uniforms.dir.value as THREE.Vector2).set(1 / (cw * pr), 0);
    (this.tiltV.uniforms.dir.value as THREE.Vector2).set(0, 1 / (ch * pr));
    this.tiltH.uniforms.amount.value = blur;
    this.tiltV.uniforms.amount.value = blur;
    this.tiltH.enabled = blur > 0;
    this.tiltV.enabled = blur > 0;
    this.drawFog(alpha, opt);
    this.composer.render();
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (f === null) return;
    this.drawStructureLabels(f);
    this.drawFlagLabels(f, now);
    this.drawBanners(alpha, opt);
    this.drawEffects(now);
    this.drawOrders(opt);
  }

  /** 兩幀之間插值的衝車位置與朝向（引擎每 tick 才動一次，不插值會一頓一頓的） */
  private ramAt(alpha: number): RamInfo | null {
    const b = this.cur?.structures.ram ?? null;
    const a = this.prev?.structures.ram ?? null;
    if (b === null || a === null) return b;
    let df = b.facing - a.facing;
    if (df > 180) df -= 360;
    if (df < -180) df += 360;
    return { ...b, x: a.x + (b.x - a.x) * alpha, y: a.y + (b.y - a.y) * alpha, facing: a.facing + df * alpha };
  }

  /**
   * 推衝車：引擎把衝車放在推車那團的正前方（規格書 18.5），整團排在車後。畫面上把那團編號最小的幾個人
   * 移到車尾與車側的推車位置（離原位兩格以內），看起來是人在推車；其餘的人照原位。回傳 士兵 id → 位置（格）
   */
  private pushers(f: LegionFrame, alpha: number): Map<number, { x: number; z: number; rot: number }> {
    const out = new Map<number, { x: number; z: number; rot: number }>();
    const q = this.ramAt(alpha);
    if (q === null || q.crew === null) return out;
    const ids: number[] = [];
    const s = f.soldiers;
    for (let i = 0; i < s.length; i += 4) if ((s[i + 3] & REG_MASK) === q.crew && (s[i + 3] & DOWN_BIT) === 0) ids.push(s[i]);
    ids.sort((a, b) => a - b);
    // 車身長 2.2、寬 1.3：車尾兩排、兩側各兩個
    const slots: [number, number][] = [
      [-1.35, -0.4],
      [-1.35, 0.4],
      [-1.35, 0],
      [-1.75, -0.25],
      [-1.75, 0.25],
      [-0.4, -0.85],
      [-0.4, 0.85],
      [0.4, -0.85],
      [0.4, 0.85],
    ];
    const a = (q.facing * Math.PI) / 180;
    const fx = Math.cos(a);
    const fz = Math.sin(a);
    const cx = q.x / TILE;
    const cz = q.y / TILE;
    ids.slice(0, slots.length).forEach((id, k) => {
      const [along, side] = slots[k];
      out.set(id, { x: cx + fx * along - fz * side, z: cz + fz * along + fx * side, rot: -a });
    });
    return out;
  }

  private drawSoldiers(f: LegionFrame, alpha: number, now: number, opt: DrawOptions): void {
    const s = f.soldiers;
    const sol = this.soldiers;
    sol.begin();
    const push = this.pushers(f, alpha);
    const facing = new Map<number, number>();
    const layerCount = new Map<number, [number, number, number]>();
    const top = new Map<number, number>();
    for (let i = 0; i < s.length; i += 4) {
      const id = s[i];
      const flags = s[i + 3];
      const reg = flags & REG_MASK;
      if (!this.shown(reg, opt.viewer)) continue;
      const r = this.regById.get(reg);
      if (r === undefined) continue;
      let x = s[i + 1];
      let y = s[i + 2];
      if (this.hasPrev[id] === 1) {
        x = this.prevX[id] + (x - this.prevX[id]) * alpha;
        y = this.prevY[id] + (y - this.prevY[id]) * alpha;
      }
      const layer = (flags >> LAYER_SHIFT) & 3;
      let fa = facing.get(reg);
      if (fa === undefined) {
        fa = this.regAt(reg, alpha)?.facing ?? r.facing;
        facing.set(reg, fa);
      }
      const lc = layerCount.get(reg) ?? [0, 0, 0];
      lc[layer] += 1;
      layerCount.set(reg, lc);
      const kind = this.kindOf[reg];
      const pose: Pose = kind === 'spear' && (r.status === 'braced' || r.status === 'bracing') ? 'brace' : kind === 'shield' && (r.status === 'walled' || r.status === 'walling') ? 'wall' : 'stand';
      const pu = push.get(id);
      const wx = pu?.x ?? x / TILE;
      const wz = pu?.z ?? y / TILE;
      let wy = this.heightAt(wx, wz, layer);
      const moving = r.status === 'moving' || r.status === 'attacking' || r.status === 'charging' || r.dashing !== null;
      if (moving) wy += Math.abs(Math.sin(now * 0.012 + id * 1.7)) * 0.03;
      top.set(reg, Math.max(top.get(reg) ?? -Infinity, wy + (kind === 'lightCav' || kind === 'heavyCav' ? 0.95 : 0.65)));
      sol.add(kind, pose, { x: wx, y: wy, z: wz, rot: pu?.rot ?? -fa * DEG, down: (flags & DOWN_BIT) !== 0, shade: 1, team: this.team[this.ownerOf[reg]] });
    }
    sol.end();
    // 樹林裡的軍團：附近的樹冠變淡（v2：隱蔽處樹冠透明度 .4；沒隱蔽的淡一點，看得到人就好）
    const fades: { x: number; z: number; r: number; amount: number }[] = [];
    for (const r of this.field) {
      if (!this.shown(r.id, opt.viewer)) continue;
      const tx = Math.floor(r.x / TILE);
      const ty = Math.floor(r.y / TILE);
      if (tx < 0 || ty < 0 || tx >= this.meta.width || ty >= this.meta.height) continue;
      if (this.meta.terrain[ty * this.meta.width + tx] !== T.Forest) continue;
      fades.push({ x: r.x / TILE, z: r.y / TILE, r: r.rad / TILE + 1.2, amount: r.concealed ? 0.6 : 0.45 });
    }
    this.nature.fadeAround(fades);
    this.regLayer.clear();
    for (const [reg, c] of layerCount) this.regLayer.set(reg, c[1] > c[0] && c[1] >= c[2] ? 1 : c[2] > c[0] ? 2 : 0);
    this.regTop = top;
  }

  /** 一方視角：己方軍團視野以外的地面變暗（照 2D 的做法：視野半徑 ＝ 兵種視野 ＋ 高度加成 ＋ 軍團半徑） */
  private drawFog(alpha: number, opt: DrawOptions): void {
    this.fog.visible = opt.viewer >= 0 && this.cur !== null;
    if (!this.fog.visible) return;
    const g = this.fogCanvas.getContext('2d')!;
    const k = 2;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
    g.fillStyle = 'rgba(6,9,16,0.6)';
    g.fillRect(0, 0, this.fogCanvas.width, this.fogCanvas.height);
    g.globalCompositeOperation = 'destination-out';
    for (const r of this.field) {
      if (this.ownerOf[r.id] !== opt.viewer) continue;
      const p = this.regAt(r.id, alpha);
      if (p === null) continue;
      const lv = this.meta.heights[Math.floor(p.y / TILE) * this.meta.width + Math.floor(p.x / TILE)] ?? 1;
      const sight = UNITS[this.kindOf[r.id]].sight + RULES.height.sightPerLevel * Math.max(0, lv - 1);
      const x = (p.x / TILE) * k;
      const y = (p.y / TILE) * k;
      const R = ((sight + r.rad) / TILE) * k;
      const grad = g.createRadialGradient(x, y, R * 0.82, x, y, R);
      grad.addColorStop(0, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(x, y, R, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    this.fogTex.needsUpdate = true;
  }

  private drawFallen(): void {
    const fl = this.fallen;
    fl.begin();
    const c = new THREE.Color();
    for (const k of this.corpses) {
      const x = k.x / TILE;
      const z = k.y / TILE;
      fl.add(k.kind, 'stand', { x, y: this.heightAt(x, z, k.layer === 1 ? 1 : 0), z, rot: (k.x % 628) / 100, down: true, shade: 0.5, team: c.copy(this.team[k.owner]).multiplyScalar(0.45) });
    }
    fl.end();
  }

  private drawArrows(f: LegionFrame, alpha: number): void {
    const a = f.arrows;
    this.arrows.begin();
    const t = f.tick - 1 + alpha;
    const p = new THREE.Vector3();
    const q = new THREE.Vector3();
    for (let i = 0; i < a.length; i += 6) {
      const [x0, y0, x1, y1, t0, t1] = [a[i] / TILE, a[i + 1] / TILE, a[i + 2] / TILE, a[i + 3] / TILE, a[i + 4], a[i + 5]];
      const u = Math.max(0, Math.min(1, (t - t0) / Math.max(1, t1 - t0)));
      const len = Math.hypot(x1 - x0, y1 - y0);
      const h0 = this.city.surfaceAt(x0, y0) + 0.5;
      const h1 = this.city.surfaceAt(x1, y1) + 0.4;
      const at = (k: number, out: THREE.Vector3): THREE.Vector3 => out.set(x0 + (x1 - x0) * k, h0 + (h1 - h0) * k + Math.sin(Math.PI * k) * len * 0.22, y0 + (y1 - y0) * k);
      at(u, p);
      at(Math.min(1, u + 0.02), q);
      this.arrows.add(p, q.sub(p));
    }
    this.arrows.end();
  }

  // ───────── 地面上的標示（托盤、範圍、旗圈、落點） ─────────

  private ringAt(cx: number, cz: number, r: number, width: number, color: THREE.Color, alpha: number, layer = 0, from = 0, to = Math.PI * 2, fill = 0): void {
    const n = Math.max(12, Math.min(72, Math.round(r * 10)));
    const steps = Math.max(2, Math.ceil((n * (to - from)) / (Math.PI * 2)));
    const d = this.decals;
    const P = (a: number, rr: number): THREE.Vector3 => {
      const x = cx + Math.cos(a) * rr;
      const z = cz + Math.sin(a) * rr;
      return new THREE.Vector3(x, this.heightAt(x, z, layer) + 0.04, z);
    };
    const center = new THREE.Vector3(cx, this.heightAt(cx, cz, layer) + 0.04, cz);
    for (let k = 0; k < steps; k++) {
      const a0 = from + ((to - from) * k) / steps;
      const a1 = from + ((to - from) * (k + 1)) / steps;
      const o0 = P(a0, r);
      const o1 = P(a1, r);
      const i0 = P(a0, r - width);
      const i1 = P(a1, r - width);
      d.tri(o0, o1, i1, color, alpha);
      d.tri(o0, i1, i0, color, alpha);
      if (fill > 0) d.tri(center, i0, i1, color, fill);
    }
  }

  /** 貼地的矩形（中心、朝向、前後半長 hd、左右半寬 hw） */
  private rectAt(cx: number, cz: number, facing: number, hd: number, hw: number, color: THREE.Color, fill: number, edge: number, layer: number, width = 0.1): void {
    const fx = Math.cos(facing);
    const fz = Math.sin(facing);
    const P = (f: number, l: number): THREE.Vector3 => {
      const x = cx + fx * f - fz * l;
      const z = cz + fz * f + fx * l;
      return new THREE.Vector3(x, this.heightAt(x, z, layer) + 0.04, z);
    };
    const nf = Math.max(1, Math.round(hd));
    const nl = Math.max(1, Math.round(hw));
    const d = this.decals;
    if (fill > 0) {
      for (let a = 0; a < nf * 2; a++) {
        for (let b = 0; b < nl * 2; b++) {
          const f0 = -hd + (a / (nf * 2)) * hd * 2;
          const f1 = -hd + ((a + 1) / (nf * 2)) * hd * 2;
          const l0 = -hw + (b / (nl * 2)) * hw * 2;
          const l1 = -hw + ((b + 1) / (nl * 2)) * hw * 2;
          d.tri(P(f0, l0), P(f1, l0), P(f1, l1), color, fill);
          d.tri(P(f0, l0), P(f1, l1), P(f0, l1), color, fill);
        }
      }
    }
    if (edge <= 0) return;
    const sides: [number, number, number, number][] = [
      [-hd, -hw, hd, -hw],
      [hd, -hw, hd, hw],
      [hd, hw, -hd, hw],
      [-hd, hw, -hd, -hw],
    ];
    for (const [fa, la, fb, lb] of sides) {
      const n = Math.max(2, Math.round(Math.hypot(fb - fa, lb - la) * 2));
      for (let k = 0; k < n; k++) {
        const t0 = k / n;
        const t1 = (k + 1) / n;
        const nfv = fb - fa;
        const nlv = lb - la;
        const len = Math.hypot(nfv, nlv) || 1;
        // 往內縮 width
        const inf = (-nlv / len) * width;
        const inl = (nfv / len) * width;
        const a0 = P(fa + nfv * t0, la + nlv * t0);
        const a1 = P(fa + nfv * t1, la + nlv * t1);
        const b0 = P(fa + nfv * t0 + inf, la + nlv * t0 + inl);
        const b1 = P(fa + nfv * t1 + inf, la + nlv * t1 + inl);
        d.tri(a0, a1, b1, color, edge);
        d.tri(a0, b1, b0, color, edge);
      }
    }
  }

  private lineAt(x0: number, z0: number, x1: number, z1: number, width: number, color: THREE.Color, alpha: number, layer = 0, dash = 0): void {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 1e-3) return;
    const ux = (x1 - x0) / len;
    const uz = (z1 - z0) / len;
    const n = Math.max(1, Math.ceil(len / 0.5));
    const d = this.decals;
    for (let k = 0; k < n; k++) {
      if (dash > 0 && k % 2 === 1) continue;
      const a = (k / n) * len;
      const b = ((k + 1) / n) * len;
      const P = (s: number, side: number): THREE.Vector3 => {
        const x = x0 + ux * s - uz * side;
        const z = z0 + uz * s + ux * side;
        return new THREE.Vector3(x, this.heightAt(x, z, layer) + 0.05, z);
      };
      d.tri(P(a, -width / 2), P(b, -width / 2), P(b, width / 2), color, alpha);
      d.tri(P(a, -width / 2), P(b, width / 2), P(a, width / 2), color, alpha);
    }
  }

  private drawGroundMarks(f: LegionFrame, alpha: number, now: number, opt: DrawOptions): void {
    const white = new THREE.Color(0xe2e8f0);
    const gold = new THREE.Color(0xfbbf24);
    const red = new THREE.Color(0xf87171);
    // 旗圈：佔領者的顏色，爭奪中閃黃；佔領進度是外圈的一段弧
    const R = RULES.capture.radius / TILE;
    if (this.meta.mode === 'capture' || this.meta.mode === 'siege') {
      this.meta.flags.forEach((fl, i) => {
        const st = f.flags[i];
        const x = fl.x / TILE;
        const z = fl.y / TILE;
        const blink = Math.floor(now / 350) % 2 === 0;
        const c = st.contested ? (blink ? new THREE.Color(0xfacc15) : white) : st.owner >= 0 ? this.team[st.owner] : white;
        this.ringAt(x, z, R, 0.14, c, 0.8, 0, 0, Math.PI * 2, st.owner >= 0 ? 0.1 : 0.04);
        if (st.capturer >= 0 && st.progress > 0) this.ringAt(x, z, R + 0.45, 0.28, this.team[st.capturer], 0.95, 0, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * st.progress) / st.need);
      });
    }
    // 砲擊落點
    for (const b of f.structures.bombards) this.ringAt(b.x / TILE, b.y / TILE, b.radius / TILE, 0.16, red, 0.85, 0, 0, Math.PI * 2, 0.12);
    // 托盤、選取、招牌技能
    for (const r of this.field) {
      if (!this.shown(r.id, opt.viewer)) continue;
      const p = this.regAt(r.id, alpha);
      if (p === null) continue;
      const owner = this.ownerOf[r.id];
      const layer = this.regLayer.get(r.id) ?? 0;
      const x = p.x / TILE;
      const z = p.y / TILE;
      const fa = p.facing * DEG;
      this.rectAt(x, z, fa, r.halfD / TILE + 0.3, r.halfW / TILE + 0.3, this.team[owner], r.concealed ? 0.08 : 0.2, r.concealed ? 0.4 : 0.85, layer, 0.09);
      const sel = opt.selection && opt.selection.size > 0 ? opt.selection.has(r.id) : opt.selected === r.id;
      if (sel || opt.hovered === r.id) this.rectAt(x, z, fa, r.halfD / TILE + 0.6, r.halfW / TILE + 0.6, white, 0, sel ? 0.95 : 0.5, layer, 0.07);
      if (sel && (opt.selection === undefined || opt.selection.size <= 1)) {
        const u = UNITS[this.kindOf[r.id]];
        if (u.range > 0) this.ringAt(x, z, u.range / TILE, 0.1, gold, 0.7, 0);
        const tgt = r.target >= 0 ? r.target : r.fireTarget;
        const tp = tgt >= 0 ? this.regAt(tgt, alpha) : null;
        if (tp !== null) this.lineAt(x, z, tp.x / TILE, tp.y / TILE, 0.12, this.team[owner], 0.8, 0, 1);
      }
      const kind = this.kindOf[r.id];
      if (r.volley !== null) {
        const vx = r.volley.x / TILE;
        const vz = r.volley.y / TILE;
        const VR = RULES.volley.radius / TILE;
        this.ringAt(vx, vz, VR, 0.1, new THREE.Color(TEAM_LIGHT[owner]), 0.8, 0, 0, Math.PI * 2, 0.13);
        const left = Math.max(0, Math.min(1, (r.volley.until - f.tick) / RULES.volley.duration));
        this.ringAt(vx, vz, VR + 0.35, 0.22, gold, 0.95, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
      }
      if (kind === 'spear' && (r.status === 'braced' || r.status === 'bracing' || r.status === 'unbracing')) {
        const ready = r.status === 'braced';
        const BR = (Math.hypot(r.halfW, r.halfD) + UNITS.spear.reach + 600) / TILE;
        const half = r.formation === 'circle' ? Math.PI : RULES.flank.frontHalf * DEG;
        const a0 = r.braceFacing * DEG;
        this.ringAt(x, z, BR, 0.1, white, ready ? 0.75 : 0.35, layer, a0 - half, a0 + half, ready ? 0.14 : 0.06);
      }
      if (kind === 'shield' && (r.stance === 'raise' || r.status === 'walled')) {
        const cd = RULES.shield.cover.depth / TILE;
        const back = -(r.halfD / TILE) - cd / 2;
        this.rectAt(x + Math.cos(fa) * back, z + Math.sin(fa) * back, fa, cd / 2, r.halfW / TILE, new THREE.Color(TEAM_LIGHT[owner]), 0.08, 0.4, layer, 0.06);
      }
      if (r.dash !== null && r.dashing !== null) {
        const a = r.dash.dir * DEG;
        const len = Math.max(r.dash.left, 1500) / TILE;
        const c = new THREE.Color(DASH_COLOR[r.dashing]);
        const ex = x + Math.cos(a) * len;
        const ez = z + Math.sin(a) * len;
        this.lineAt(x, z, ex, ez, 0.22, c, r.dash.aligning ? 0.5 : 0.85, 0, r.dash.aligning ? 1 : 0);
        this.lineAt(ex, ez, ex - Math.cos(a + 0.5) * 0.9, ez - Math.sin(a + 0.5) * 0.9, 0.22, c, 0.9);
        this.lineAt(ex, ez, ex - Math.cos(a - 0.5) * 0.9, ez - Math.sin(a - 0.5) * 0.9, 0.22, c, 0.9);
      }
    }
    if (opt.aim) this.aimMarks(opt.aim, alpha);
    if (opt.order) {
      const c = new THREE.Color(0xbfdbfe);
      const a = opt.order.from;
      const b = opt.order.to;
      const x0 = a.x / TILE;
      const z0 = a.y / TILE;
      const x1 = b.x / TILE;
      const z1 = b.y / TILE;
      const ang = Math.atan2(z1 - z0, x1 - x0);
      this.lineAt(x0, z0, x1, z1, 0.18, c, 0.9);
      this.lineAt(x1, z1, x1 - Math.cos(ang + 0.5) * 0.9, z1 - Math.sin(ang + 0.5) * 0.9, 0.18, c, 0.9);
      this.lineAt(x1, z1, x1 - Math.cos(ang - 0.5) * 0.9, z1 - Math.sin(ang - 0.5) * 0.9, 0.18, c, 0.9);
    }
    // 特效的地面圈
    for (const e of this.effects) {
      if (e.kind !== 'ring') continue;
      const p = (now - e.t0) / e.life;
      if (p < 0 || p > 1) continue;
      this.ringAt(e.x / TILE, e.y / TILE, (e.size ?? 3) * (0.3 + p * 0.9), 0.18, new THREE.Color(e.color), 1 - p, 0);
    }
  }

  private terrainAt(x: number, y: number): number {
    const tx = Math.floor(x / TILE);
    const ty = Math.floor(y / TILE);
    if (tx < 0 || ty < 0 || tx >= this.meta.width || ty >= this.meta.height) return T.River;
    return this.meta.terrain[ty * this.meta.width + tx];
  }

  /**
   * 技能瞄準（照 2D）：衝刺畫隊形寬度的路線帶與中線（騎兵的助跑段是虛線），會被地形擋下的位置打叉；
   * 齊射畫射程圈與落點圈（超出射程變紅）；槍林畫正面扇形。冷卻中畫成灰色。文字由資訊層畫（aimText）
   */
  private aimMarks(aim: { ids: readonly number[]; to: { x: number; y: number } }, alpha: number): void {
    this.aimText = [];
    for (const id of aim.ids) {
      const p = this.regAt(id, alpha);
      const r = this.regById.get(id);
      if (p === null || r === undefined) continue;
      const kind = this.kindOf[id];
      const cd = r.skillCd > 0;
      const color = new THREE.Color(cd ? 0x94a3b8 : 0xfde68a);
      const css = cd ? '#cbd5e1' : '#fde68a';
      const ang = Math.atan2(aim.to.y - p.y, aim.to.x - p.x);
      const x = p.x / TILE;
      const z = p.y / TILE;
      const layer = this.regLayer.get(id) ?? 0;
      const dash = kind === 'sword' ? DASH.assault : kind === 'light' ? DASH.infiltrate : kind === 'lightCav' ? DASH.lightCav : kind === 'heavyCav' ? DASH.heavyCav : null;
      if (dash !== null) {
        const cav = dash.kind === 'charge';
        const fx = Math.cos(ang);
        const fy = Math.sin(ang);
        const hw = Math.max(500, r.halfW);
        const lanes = Math.max(3, Math.round((hw * 2) / 500) + 1);
        const stops: { d: number; l: number; t: number }[] = [];
        for (let i = 0; i < lanes; i++) {
          const l = -hw + (2 * hw * i) / (lanes - 1);
          for (let d = 250; d <= dash.dist; d += 250) {
            const tt = this.terrainAt(p.x + fx * d - fy * l, p.y + fy * d + fx * l);
            if (cav ? stopsCavalry(tt) : !walkable(tt)) {
              stops.push({ d, l, t: tt });
              break;
            }
          }
        }
        const len = dash.dist / TILE;
        this.rectAt(x + fx * len * 0.5, z + fy * len * 0.5, ang, len / 2, hw / TILE, color, 0.1, 0, layer);
        const run = Math.min(dash.dist, dash.runup) / TILE;
        if (run > 0) this.lineAt(x, z, x + fx * run, z + fy * run, 0.14, color, 0.9, layer, 1);
        const ex = x + fx * len;
        const ez = z + fy * len;
        this.lineAt(x + fx * run, z + fy * run, ex, ez, 0.24, color, 0.95, layer);
        this.lineAt(ex, ez, ex - Math.cos(ang + 0.5) * 0.9, ez - Math.sin(ang + 0.5) * 0.9, 0.22, color, 0.95, layer);
        this.lineAt(ex, ez, ex - Math.cos(ang - 0.5) * 0.9, ez - Math.sin(ang - 0.5) * 0.9, 0.22, color, 0.95, layer);
        const red = new THREE.Color(0xf87171);
        for (const st of stops) {
          const sx = (p.x + fx * st.d - fy * st.l) / TILE;
          const sz = (p.y + fy * st.d + fx * st.l) / TILE;
          this.lineAt(sx - 0.3, sz - 0.3, sx + 0.3, sz + 0.3, 0.1, red, 0.95);
          this.lineAt(sx + 0.3, sz - 0.3, sx - 0.3, sz + 0.3, 0.1, red, 0.95);
        }
        this.aimText.push({ x: ex, z: ez, text: `${len.toFixed(0)} 格`, color: css });
        if (stops.length > 0) {
          const first = stops.reduce((a, b) => (a.d <= b.d ? a : b));
          this.aimText.push({ x: (p.x + fx * first.d - fy * first.l) / TILE, z: (p.y + fy * first.d + fx * first.l) / TILE, text: `約 ${Math.round((stops.length * 100) / lanes)}% 的人會被${TERRAIN_NAMES[first.t]}擋下`, color: '#fca5a5' });
        }
        if (cd) this.aimText.push({ x, z, text: `冷卻 ${Math.ceil(r.skillCd / TPS)} 秒`, color: '#cbd5e1' });
      } else if (kind === 'archer') {
        const lvAt = (q: number, w: number): number => this.meta.heights[Math.floor(w / TILE) * this.meta.width + Math.floor(q / TILE)] ?? 0;
        const lv = Math.max(-RULES.height.clamp, Math.min(RULES.height.clamp, lvAt(p.x, p.y) - lvAt(aim.to.x, aim.to.y)));
        const range = (UNITS.archer.range + RULES.height.rangePerLevel * lv) / TILE;
        const tx = aim.to.x / TILE;
        const tz = aim.to.y / TILE;
        const ok = Math.hypot(tx - x, tz - z) <= range;
        this.ringAt(x, z, range, 0.08, new THREE.Color(0xfde68a), 0.5, layer);
        const c = cd ? new THREE.Color(0x94a3b8) : ok ? new THREE.Color(0xfde68a) : new THREE.Color(0xf87171);
        this.ringAt(tx, tz, RULES.volley.radius / TILE, 0.14, c, 0.95, 0, 0, Math.PI * 2, 0.15);
        this.aimText.push({ x: tx, z: tz, text: cd ? `冷卻 ${Math.ceil(r.skillCd / TPS)} 秒` : ok ? '齊射' : '超出射程', color: cd ? '#cbd5e1' : ok ? '#fde68a' : '#f87171' });
      } else if (kind === 'spear') {
        const R = (r.halfD + UNITS.spear.reach) / TILE;
        const half = RULES.flank.frontHalf * DEG;
        this.ringAt(x, z, R, 0.12, color, 0.9, layer, ang - half, ang + half, 0.18);
        this.aimText.push({ x: x + Math.cos(ang) * R, z: z + Math.sin(ang) * R, text: r.status === 'braced' || r.status === 'bracing' ? '收槍林' : '槍林', color: css });
      } else if (kind === 'shield') {
        this.aimText.push({ x, z, text: r.status === 'walled' || r.status === 'walling' ? '收盾牆' : '盾牆', color: css });
      }
    }
  }

  /** 開戰前的布陣區（藍攻紅守）：一次做好，開戰後藏起來 */
  private buildDeploy(): void {
    const d = this.deploy;
    d.begin();
    const { width: w } = this.meta;
    this.meta.deploy.forEach((z, p) => {
      const mask = this.meta.deployMask[p];
      const c = this.team[p];
      for (let y = z.y0; y < z.y1; y++) {
        for (let x = z.x0; x < z.x1; x++) {
          if (mask !== null && mask[y * w + x] !== 1) continue;
          const t = this.meta.terrain[y * w + x];
          const top = t === 8 || t === 10 ? 1 : 0;
          const P = (xx: number, zz: number): THREE.Vector3 => new THREE.Vector3(xx, (top === 1 ? this.city.wallTop(x, y) : this.city.surfaceAt(xx, zz)) + 0.05, zz);
          d.tri(P(x, y), P(x + 1, y), P(x + 1, y + 1), c, 0.22);
          d.tri(P(x, y), P(x + 1, y + 1), P(x, y + 1), c, 0.22);
        }
      }
    });
    d.end();
  }

  // ───────── 資訊層（2D 畫布） ─────────

  private screenOf(x: number, z: number, y: number): [number, number] | null {
    const [sx, sy, ok] = this.project(x, y, z);
    return ok ? [sx, sy] : null;
  }

  /** 城門血量、雲梯進度、砲擊倒數 */
  private drawStructureLabels(f: LegionFrame): void {
    const ctx = this.ctx;
    const font = getComputedStyle(document.body).fontFamily;
    for (const g of f.structures.gates) {
      const top = this.city.wallTop(Math.floor(g.x / TILE), Math.floor(g.y / TILE));
      const p = this.screenOf(g.x / TILE, g.y / TILE, top + 1.2);
      if (p === null) continue;
      const bw = 46;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(p[0] - bw / 2, p[1], bw, 5);
      ctx.fillStyle = g.hp > g.hpMax / 2 ? '#a3e635' : g.hp > g.hpMax / 4 ? '#facc15' : '#f87171';
      ctx.fillRect(p[0] - bw / 2, p[1], (bw * g.hp) / g.hpMax, 5);
      if (g.state === 'broken' || g.state === 'open') {
        ctx.font = `700 11px ${font}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#f1f5f9';
        ctx.fillText(g.state === 'broken' ? '城門已破' : '城門開著', p[0], p[1] - 4);
      }
    }
    for (const l of f.structures.ladders) {
      if (l.built && l.topple < 0) continue;
      const p = this.screenOf(l.footX / TILE, l.footY / TILE, this.city.surfaceAt(l.footX / TILE, l.footY / TILE) + 0.5);
      if (p === null) continue;
      const k = l.built ? l.topple / RULES.ladder.toppleTicks : l.progress / l.buildTicks;
      ctx.beginPath();
      ctx.arc(p[0], p[1], 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
      ctx.strokeStyle = l.built ? TEAM[1 - l.owner] : TEAM[l.owner];
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    for (const b of f.structures.bombards) {
      const p = this.screenOf(b.x / TILE, b.y / TILE, this.city.surfaceAt(b.x / TILE, b.y / TILE) + 0.6);
      if (p === null) continue;
      ctx.font = `800 ${Math.round(Math.max(13, Math.min(22, this.cam.scale * 1.2)))}px ${font}`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(`${Math.ceil(b.landIn / TPS)}`, p[0], p[1]);
      ctx.fillStyle = '#fecaca';
      ctx.fillText(`${Math.ceil(b.landIn / TPS)}`, p[0], p[1]);
    }
  }

  private drawFlagLabels(f: LegionFrame, _now: number): void {
    if (this.meta.mode !== 'capture' && this.meta.mode !== 'siege') return;
    const ctx = this.ctx;
    const font = getComputedStyle(document.body).fontFamily;
    this.meta.flags.forEach((fl, i) => {
      const st = f.flags[i];
      const x = fl.x / TILE;
      const z = fl.y / TILE;
      const p = this.screenOf(x, z, this.city.surfaceAt(x, z) + 3.6);
      if (p === null) return;
      const label =
        this.meta.mode === 'siege'
          ? `${i === 0 ? 'A' : 'B'} ${fl.name}・佔 ${st.need / TPS} 秒${st.open ? '' : st.owner === this.meta.defender ? '・要先佔 A' : ''}${st.contested ? '・爭奪中' : ''}${st.capturer >= 0 && st.progress > 0 ? `・${Math.floor((st.progress * 100) / st.need)}%` : ''}`
          : `${fl.name}・每秒 ${fl.points} 分${st.contested ? '・爭奪中' : ''}`;
      ctx.font = `700 12px ${font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tw = ctx.measureText(label).width + 12;
      ctx.fillStyle = 'rgba(8,12,20,0.78)';
      ctx.strokeStyle = st.owner >= 0 ? TEAM[st.owner] : 'rgba(226,232,240,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(p[0] - tw / 2, p[1] - 10, tw, 20, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = st.contested ? '#fde047' : '#f1f5f9';
      ctx.fillText(label, p[0], p[1] + 0.5);
    });
  }

  /** 軍團旗標（照 2D 的樣式）：兵種圖示、人數、老兵星、人數條、狀態標籤、AI 意圖；重疊就往上疊 */
  private drawBanners(alpha: number, opt: DrawOptions): void {
    const ctx = this.ctx;
    const k = Math.max(0.8, Math.min(1.2, this.cam.scale / 12));
    const font = getComputedStyle(document.body).fontFamily;
    const w = 46 * k;
    const h = 15 * k;
    const ih = 12 * k;
    const zoomed = opt.showIntent && this.cam.scale >= this.fitScale * 1.6;
    const intentOf = (r: RegFrame): string =>
      r.intent !== '' && (opt.viewer < 0 || this.ownerOf[r.id] === opt.viewer) && (zoomed || opt.hovered === r.id || opt.selected === r.id) ? r.intent : '';
    const order = [...this.field].sort((a, b) => (b.id === opt.selected ? 1 : 0) - (a.id === opt.selected ? 1 : 0) || b.y - a.y);
    const placed: [number, number, number][] = [];
    const spot = new Map<number, [number, number, number]>();
    for (const r of order) {
      if (!this.shown(r.id, opt.viewer)) continue;
      const p = this.regAt(r.id, alpha);
      if (p === null) continue;
      const top = this.regTop.get(r.id) ?? this.heightAt(p.x / TILE, p.y / TILE, 0) + 0.7;
      const sp = this.screenOf(p.x / TILE, p.y / TILE, top + 0.5);
      if (sp === null) continue;
      const bh = h + (intentOf(r) !== '' ? ih : 0);
      const bx = sp[0];
      const by0 = sp[1] - h / 2 - 6 - (bh - h);
      let by = by0;
      for (let tries = 0; tries < 6; tries++) {
        if (!placed.some(([px, py, ph]) => Math.abs(px - bx) < w + 6 && by < py + ph + 3 && py < by + bh + 3)) break;
        by -= h + 4;
      }
      placed.push([bx, by, bh]);
      spot.set(r.id, [bx, by, by0]);
    }
    for (const r of this.field) {
      const sp = spot.get(r.id);
      if (sp === undefined) continue;
      const owner = this.ownerOf[r.id];
      const st = this.meta.regs[r.id];
      const [x, y, y0] = sp;
      if (y !== y0) {
        ctx.strokeStyle = 'rgba(226,232,240,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y + h / 2);
        ctx.lineTo(x, y0 + h / 2);
        ctx.stroke();
      }
      const hover = opt.hovered === r.id || opt.selected === r.id;
      ctx.fillStyle = hover ? '#0f172a' : 'rgba(8,12,20,0.82)';
      ctx.strokeStyle = TEAM[owner];
      ctx.lineWidth = hover ? 2 : 1.2;
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h / 2, w, h, 4 * k);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = TEAM[owner];
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h / 2, h, h, [4 * k, 0, 0, 4 * k]);
      ctx.fill();
      drawUnitIcon(ctx, st.kind, x - w / 2 + h / 2, y, h * 0.86, '#fff', 2);
      ctx.font = `700 ${Math.round(10 * k)}px ${font}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f8fafc';
      ctx.fillText(String(r.men), x - w / 2 + h + 3 * k, y + 0.5);
      if (r.level > 1) {
        ctx.fillStyle = '#fbbf24';
        ctx.fillText('★'.repeat(r.level - 1), x - w / 2 + h + 19 * k, y + 0.5);
      }
      const frac = r.men / st.men0;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x - w / 2, y + h / 2 + 1.5, w, 2.5 * k);
      ctx.fillStyle = frac > 0.5 ? '#4ade80' : frac > 0.25 ? '#facc15' : '#f87171';
      ctx.fillRect(x - w / 2, y + h / 2 + 1.5, w * frac, 2.5 * k);
      const t = TAG[r.status];
      const tag = t !== undefined ? (r.status === 'reforming' ? `${t[0]}・${FORMATION_NAMES[r.formation]}` : t[0]) : r.concealed && opt.viewer < 0 ? '埋伏中' : '';
      if (tag !== '') {
        ctx.font = `700 ${Math.round(9 * k)}px ${font}`;
        const tw = ctx.measureText(tag).width + 6 * k;
        ctx.fillStyle = t !== undefined ? t[1] : '#a16207';
        ctx.beginPath();
        ctx.roundRect(x + w / 2 + 2, y - h / 2, tw, h, 3 * k);
        ctx.fill();
        if (r.status === 'reforming' && r.switchLeft > 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.fillRect(x + w / 2 + 2, y + h / 2 - 2 * k, tw * (1 - r.switchLeft / RULES.formationSwitchTicks), 2 * k);
        }
        ctx.fillStyle = '#fff';
        ctx.fillText(tag, x + w / 2 + 2 + 3 * k, y + 0.5);
      }
      const intent = intentOf(r);
      if (intent !== '') {
        ctx.font = `600 ${Math.round(9 * k)}px ${font}`;
        ctx.textAlign = 'center';
        const tw = ctx.measureText(intent).width + 8 * k;
        const iy = y + h / 2 + 5 * k + ih / 2;
        ctx.fillStyle = 'rgba(8,12,20,0.72)';
        ctx.beginPath();
        ctx.roundRect(x - tw / 2, iy - ih / 2 + 1, tw, ih - 1, 3 * k);
        ctx.fill();
        ctx.fillStyle = owner === 0 ? '#bfdbfe' : '#fecaca';
        ctx.fillText(intent, x, iy + 0.5);
      }
      ctx.globalAlpha = 1;
    }
  }

  private drawEffects(now: number): void {
    const ctx = this.ctx;
    const font = getComputedStyle(document.body).fontFamily;
    this.effects = this.effects.filter((e) => now - e.t0 < e.life);
    for (const e of this.effects) {
      if (e.kind !== 'text') continue;
      const p = (now - e.t0) / e.life;
      const x = e.x / TILE;
      const z = e.y / TILE;
      const sp = this.screenOf(x, z, this.heightAt(x, z, 0) + 1.2);
      if (sp === null) continue;
      ctx.globalAlpha = p < 0.8 ? 1 : (1 - p) / 0.2;
      ctx.font = `800 ${Math.round((14 + Math.min(6, this.cam.scale * 0.3)) * (e.size ?? 1))}px ${font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const ty = sp[1] - 20 - p * 24;
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(e.text ?? '', sp[0], ty);
      ctx.fillStyle = e.color;
      ctx.fillText(e.text ?? '', sp[0], ty);
      ctx.globalAlpha = 1;
    }
  }

  /** 玩家操控：框選框、右鍵拖曳的移動方向 */
  private drawOrders(opt: DrawOptions): void {
    const ctx = this.ctx;
    if (opt.box) {
      const b = opt.box;
      ctx.fillStyle = 'rgba(147,197,253,0.12)';
      ctx.strokeStyle = 'rgba(191,219,254,0.9)';
      ctx.lineWidth = 1;
      ctx.fillRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
      ctx.strokeRect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0));
    }
    if (opt.aim) {
      ctx.font = `600 12px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      for (const a of this.aimText) {
        const sp = this.screenOf(a.x, a.z, this.city.surfaceAt(a.x, a.z) + 0.6);
        if (sp === null) continue;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillText(a.text, sp[0] + 1, sp[1] - 7);
        ctx.fillStyle = a.color;
        ctx.fillText(a.text, sp[0], sp[1] - 8);
      }
    }
  }
}
