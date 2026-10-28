// 3D 沙盤的攻城物件與旗：城門門扇（關、開、開關中、被撞破）、雲梯（架設中慢慢立起、被推倒往後倒）、衝車（撞門時撞木前後擺）、
// 砲擊的石彈（從攻方那一側飛過來）、佔點旗（旗桿、旗面換成佔領者的顏色）。
import * as THREE from 'three';
import type { GateInfo, LadderInfo, RamInfo, Structures } from '../../../legion/api.ts';
import { BOMBARD, RULES, TILE } from '../../../legion/config.ts';
import { Builder } from './builder.ts';
import type { City } from './city.ts';
import type { Ground } from './ground.ts';
import { PAL, col } from './palette.ts';

const WOOD = 0x6e4a2c;

function leafGeometry(width: number, height: number): THREE.BufferGeometry {
  const b = new Builder();
  b.box(0, 0, -0.07, width, height, 0.07, col(WOOD), undefined, [false, false, false, false, false, false]);
  // 鐵箍與門釘
  for (let y = 0.25; y < height - 0.1; y += 0.45) b.box(0.02, y, -0.09, width - 0.02, y + 0.06, 0.09, col(0x3a3530));
  return b.geometry();
}

function ladderGeometry(): THREE.BufferGeometry {
  const b = new Builder();
  const wood = col(0xb08a5a);
  b.box(0, -0.03, -0.24, 1, 0.03, -0.18, wood);
  b.box(0, -0.03, 0.18, 1, 0.03, 0.24, wood);
  for (let k = 0.08; k < 1; k += 0.1) b.box(k, -0.02, -0.2, k + 0.025, 0.02, 0.2, wood);
  return b.geometry();
}

/** 衝車：四輪木架、人字棚頂（蒙皮）、吊著的撞木；正面朝 +x */
function ramGroup(): { group: THREE.Group; log: THREE.Mesh } {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  const b = new Builder();
  const wood = col(PAL.wood);
  const dark = col(PAL.woodDark);
  b.box(-1.0, 0.18, -0.55, 1.0, 0.3, -0.45, dark);
  b.box(-1.0, 0.18, 0.45, 1.0, 0.3, 0.55, dark);
  for (const x of [-0.95, -0.05, 0.85]) for (const z of [-0.5, 0.42]) b.box(x, 0.3, z, x + 0.1, 1.1, z + 0.08, wood);
  for (const x of [-0.7, 0.7]) for (const z of [-0.6, 0.52]) b.prism(x, z + 0.04, 0, 0.36, 0.22, 0.22, 10, dark, 0, true);
  const hide = col(0x8a7a5c);
  b.quad([-1.1, 1.05, -0.65], [1.1, 1.05, -0.65], [1.1, 1.55, 0], [-1.1, 1.55, 0], hide, [0, 0.6, -1]);
  b.quad([-1.1, 1.05, 0.65], [1.1, 1.05, 0.65], [1.1, 1.55, 0], [-1.1, 1.55, 0], hide.clone().multiplyScalar(0.92), [0, 0.6, 1]);
  b.tri([-1.1, 1.05, -0.65], [-1.1, 1.05, 0.65], [-1.1, 1.55, 0], dark, [-1, 0, 0]);
  b.tri([1.1, 1.05, -0.65], [1.1, 1.05, 0.65], [1.1, 1.55, 0], dark, [1, 0, 0]);
  const group = new THREE.Group();
  const body = b.build(mat)!;
  group.add(body);
  const lb = new Builder();
  lb.prism(0, 0, -1.2, 1.0, 0.13, 0.13, 8, col(0x5e4630));
  lb.prism(0, 0, 1.0, 1.25, 0.17, 0.12, 8, col(0x4a4a4a));
  const g = lb.geometry();
  g.rotateZ(-Math.PI / 2);
  const log = new THREE.Mesh(g, mat);
  log.position.set(0, 0.72, 0);
  log.castShadow = true;
  group.add(log);
  return { group, log };
}

interface Door {
  readonly gate: Rect;
  readonly leaves: THREE.Group[];
  readonly portal: City['gatePortals'][number];
}

type Rect = { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };

export class Siege {
  readonly group = new THREE.Group();
  private readonly doors: Door[] = [];
  private readonly ladderGeo = ladderGeometry();
  private readonly ladderMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
  private readonly ladders: THREE.Mesh[] = [];
  private readonly ram: { group: THREE.Group; log: THREE.Mesh } | null;
  private readonly stones: THREE.Mesh[] = [];
  private readonly stoneGeo = new THREE.IcosahedronGeometry(0.35, 0);
  private readonly stoneMat = new THREE.MeshStandardMaterial({ color: 0x5f5a52, roughness: 0.9, flatShading: true });
  private readonly flags: { pole: THREE.Mesh; cloth: THREE.Mesh }[] = [];
  private readonly doorMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });

  private readonly city: City;
  private readonly ground: Ground;

  constructor(
    city: City,
    ground: Ground,
    flags: readonly { readonly x: number; readonly y: number }[],
    hasRam: boolean,
  ) {
    this.city = city;
    this.ground = ground;
    for (const p of city.gatePortals) {
      const span = p.alongX ? p.r.y1 - p.r.y0 : p.r.x1 - p.r.x0;
      const height = p.top - p.y - 0.05;
      const geo = leafGeometry(span / 2, height);
      const leaves = [0, 1].map(() => {
        const g = new THREE.Group();
        const m = new THREE.Mesh(geo, this.doorMat);
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
        this.group.add(g);
        return g;
      });
      this.doors.push({ gate: p.r, leaves, portal: p });
    }
    this.ram = hasRam ? ramGroup() : null;
    if (this.ram !== null) {
      this.ram.group.traverse((o) => {
        o.castShadow = true;
      });
      this.group.add(this.ram.group);
    }
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xd8d2c4, roughness: 0.6 });
    for (const f of flags) {
      const x = f.x / TILE;
      const z = f.y / TILE;
      const y = ground.heightAt(x, z);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 3.2, 8), poleMat);
      pole.position.set(x, y + 1.6, z);
      pole.castShadow = true;
      const cg = new THREE.PlaneGeometry(1.3, 0.8, 6, 2);
      cg.translate(0.65, 0, 0);
      const cloth = new THREE.Mesh(cg, new THREE.MeshStandardMaterial({ color: 0xe2e8f0, roughness: 0.7, side: THREE.DoubleSide }));
      cloth.position.set(x + 0.05, y + 2.75, z);
      cloth.castShadow = true;
      this.group.add(pole, cloth);
      this.flags.push({ pole, cloth });
    }
  }

  update(s: Structures, flagOwner: readonly number[], team: readonly THREE.Color[], now: number, tick: number): void {
    for (const d of this.doors) {
      const g = s.gates.find((q) => q.x0 === d.gate.x0 && q.y0 === d.gate.y0);
      this.placeDoor(d, g);
    }
    this.placeLadders(s.ladders);
    if (this.ram !== null) this.placeRam(s.ram, now);
    // 石彈：落地前從攻方那一側飛過來
    while (this.stones.length < s.bombards.length) {
      const m = new THREE.Mesh(this.stoneGeo, this.stoneMat);
      m.castShadow = true;
      this.stones.push(m);
      this.group.add(m);
    }
    this.stones.forEach((m, i) => {
      const bb = s.bombards[i];
      m.visible = bb !== undefined;
      if (bb === undefined) return;
      const f = 1 - Math.max(0, Math.min(1, bb.landIn / BOMBARD.delay));
      const lx = bb.x / TILE;
      const lz = bb.y / TILE;
      const ly = this.ground.heightAt(lx, lz);
      const sx = lx - 45;
      m.position.set(sx + (lx - sx) * f, ly + 0.3 + Math.sin(f * Math.PI) * 22 * (1 - f * 0.35), lz);
      m.rotation.set(tick * 0.3, tick * 0.2, 0);
    });
    this.flags.forEach((fl, i) => {
      const o = flagOwner[i] ?? -1;
      (fl.cloth.material as THREE.MeshStandardMaterial).color.copy(o >= 0 ? team[o] : col(0xe2e8f0));
      // 旗面飄動：沿旗面頂點一點波浪
      const pos = fl.cloth.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let k = 0; k < pos.count; k++) {
        const x = pos.getX(k);
        pos.setZ(k, Math.sin(x * 4 - now * 0.004 + i) * 0.08 * x);
      }
      pos.needsUpdate = true;
    });
  }

  private placeDoor(d: Door, g: GateInfo | undefined): void {
    const p = d.portal;
    const inward = p.outerAt === (p.alongX ? p.r.x0 : p.r.y0) ? 1 : -1;
    const plane = p.outerAt + inward * 0.25;
    const u0 = p.alongX ? p.r.y0 : p.r.x0;
    const u1 = p.alongX ? p.r.y1 : p.r.x1;
    const state = g?.state ?? 'closed';
    const open = state === 'open' ? 1 : state === 'closed' ? 0 : state === 'broken' ? 0 : 0.5;
    d.leaves.forEach((leaf, k) => {
      const hingeU = k === 0 ? u0 : u1;
      const dir = k === 0 ? 1 : -1;
      // 門扇的幾何沿區域 +x 長出去：先轉到沿 u 方向
      const baseRot = p.alongX ? (dir > 0 ? -Math.PI / 2 : Math.PI / 2) : dir > 0 ? 0 : Math.PI;
      const swing = (Math.PI / 2) * open * (p.alongX ? inward * dir : -inward * dir);
      leaf.position.set(p.alongX ? plane : hingeU, p.y, p.alongX ? hingeU : plane);
      leaf.rotation.set(0, baseRot + swing, 0);
      leaf.visible = true;
      if (state === 'broken') {
        // 被撞破：門扇倒在門洞裡
        leaf.position.set(p.alongX ? plane + inward * 1.2 : hingeU + dir * 0.2, p.y + 0.08, p.alongX ? hingeU + dir * 0.2 : plane + inward * 1.2);
        leaf.rotation.set(p.alongX ? 0 : (inward * Math.PI) / 2.2, baseRot, p.alongX ? (-inward * Math.PI) / 2.2 : 0);
      }
    });
  }

  private placeLadders(list: readonly LadderInfo[]): void {
    while (this.ladders.length < list.length) {
      const m = new THREE.Mesh(this.ladderGeo, this.ladderMat);
      m.castShadow = true;
      this.ladders.push(m);
      this.group.add(m);
    }
    this.ladders.forEach((m, i) => {
      const l = list[i];
      m.visible = l !== undefined;
      if (l === undefined) return;
      const fx = l.footX / TILE;
      const fz = l.footY / TILE;
      const tx = l.x / TILE;
      const tz = l.y / TILE;
      const fy = this.ground.heightAt(fx, fz);
      const ty = this.city.wallTop(Math.floor(tx), Math.floor(tz)) + 0.35;
      // 梯腳在地面格中心、梯頂靠在牆的外緣（牆格中心往外半格）
      const hor = Math.hypot(tx - fx, tz - fz);
      const run = Math.max(0.3, hor - 0.5);
      const full = Math.atan2(ty - fy, run);
      const len = Math.hypot(run, ty - fy) + 0.25;
      let pitch = full;
      if (!l.built) pitch = full * Math.max(0.05, l.progress / l.buildTicks);
      else if (l.topple >= 0) pitch = full + (Math.PI - full) * 0.55 * (l.topple / RULES.ladder.toppleTicks);
      const yaw = Math.atan2(-(tz - fz), tx - fx);
      m.position.set(fx, fy, fz);
      m.rotation.set(0, yaw, pitch, 'YXZ');
      m.scale.set(len, 1, 1);
    });
  }

  private placeRam(q: RamInfo | null, now: number): void {
    const r = this.ram!;
    r.group.visible = q !== null;
    if (q === null) return;
    const x = q.x / TILE;
    const z = q.y / TILE;
    r.group.position.set(x, this.ground.heightAt(x, z), z);
    r.group.rotation.set(0, (-q.facing * Math.PI) / 180, 0);
    // 撞門：撞木前後擺
    r.log.position.x = q.gate !== null ? Math.sin(now * 0.006) * 0.35 : 0;
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material as THREE.Material;
        m.dispose();
      }
    });
    this.ladderGeo.dispose();
    this.stoneGeo.dispose();
  }
}
