// 元帥：共用兵種輔助函式源自開發包，戰略與調度獨立實作。
// 軍團戰陪練對手（push）
const TILE = 1000;
const TR = { plain: 0, road: 1, forest: 2, hill: 3, shallow: 4, river: 5, bridge: 6, building: 7, wall: 8 };

class LegionBase {
  constructor() {
    this.data = (null);
    this.h = (null);
    this.obs = (null);
    this.p = 0;
    this.W = 0;
    this.H = 0;
    this.k = {};
    this.units = {};
    this.seen = new Map();
    this.lastSeenAt = new Map();
    this.sent = new Map();
    this.role = new Map();
    this.plan = [];
    this.geo = { forests: [], hills: [], bridges: [], fords: [] };
    this.mem = new Map();
    this.busy = false;
    this.lastFight = -1;
    this.myHp = -1;
    this.sx = 1;
    this.sy = 1;
    this.reserves = [];
    this.autoReinforce = true;
  }

  setup(data, helpers) {
    this.data = data;
    this.h = helpers;
    this.p = data.playerId;
    this.W = data.map.width * TILE;
    this.H = data.map.height * TILE;
    this.sx = data.map.width / 160;
    this.sy = data.map.height / 100;
    this.k = data.knobs;
    for (const u of data.units) this.units[u.kind] = u;
    this.geo = {
      forests: this.blobs((t) => t === TR.forest),
      hills: this.blobs((t, h) => h >= 3 && t !== TR.forest),
      bridges: this.blobs((t) => t === TR.bridge),
      fords: this.blobs((t) => t === TR.shallow),
    };
  }

  blobs(test) {
    const m = this.data.map;
    const seen = new Uint8Array(m.width * m.height);
    const out = [];
    for (let i = 0; i < m.width * m.height; i++) {
      if (seen[i] || !test(m.terrain[i], m.heights[i])) continue;
      let sx = 0;
      let sy = 0;
      let n = 0;
      const stack = [i];
      seen[i] = 1;
      while (stack.length) {
        const j = (stack.pop());
        const x = j % m.width;
        const y = (j - x) / m.width;
        sx += x;
        sy += y;
        n += 1;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= m.width || ny >= m.height) continue;
          const q = ny * m.width + nx;
          if (seen[q] || !test(m.terrain[q], m.heights[q])) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
      if (n >= 6) out.push({ x: Math.round(((sx / n) + 0.5) * TILE), y: Math.round(((sy / n) + 0.5) * TILE), size: n });
    }
    return out;
  }

  at(tx, ty) {
    const x = Math.round(tx * this.sx * TILE);
    const y = Math.round(ty * this.sy * TILE);
    return this.p === 0 ? { x, y } : { x: this.W - x, y: this.H - y };
  }

  deployAt(e) {
    return this.at(e.tx / this.sx, e.ty);
  }

  loc(o) {
    const x = this.p === 0 ? o.x : this.W - o.x;
    const y = this.p === 0 ? o.y : this.H - o.y;
    return { x: x / TILE / this.sx, y: y / TILE / this.sy };
  }

  rnd(v) {
    const f = Math.floor(v);
    const d = v - f;
    if (d !== 0.5) return d > 0.5 ? f + 1 : f;
    return f % 2 === 0 ? f : f + 1;
  }

  face(deg) {
    return ((this.p === 0 ? deg : deg + 180) % 360 + 360) % 360;
  }

  get forward() {
    return this.face(0);
  }

  dist(a, b) {
    return this.h.dist(a.x, a.y, b.x, b.y);
  }

  gap(a, b) {
    return (this.dist(a, b) - (a.radius || 0) - (b.radius || 0)) / TILE;
  }

  angle(a, b) {
    return this.h.angleTo(a.x, a.y, b.x, b.y);
  }

  adiff(a, b) {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  offset(o, deg, tiles) {
    const [x, y] = this.h.offset(o.x, o.y, deg, tiles * TILE);
    return { x, y };
  }

  isCav(kind) {
    return kind === 'lightCav' || kind === 'heavyCav';
  }

  clearLine(a, b, cavalry) {
    const n = Math.max(1, Math.ceil(this.dist(a, b) / 600));
    for (let i = 1; i <= n; i++) {
      const t = this.h.terrainAt(a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n);
      if (t === TR.river || t === TR.building || t === TR.wall) return false;
      if (cavalry && (t === TR.forest || t === TR.shallow)) return false;
    }
    return true;
  }

  deployFrom(entries) {
    this.plan = entries;
    const placed = [];
    const out = entries.map((e) => {
      const rad = this.radiusOf(e.type, e.formation, e.width);
      let pos = this.deployAt(e);
      for (let k = 1; k < 60 && placed.some((q) => this.dist(q, pos) < (q.rad + rad) * 0.62); k++) {
        const ty = e.ty + (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * 2;
        if (ty >= 4 && ty <= 96) pos = this.deployAt({ ...e, ty });
      }
      placed.push({ x: pos.x, y: pos.y, rad });
      return { type: e.type, x: pos.x, y: pos.y, facing: this.face(e.facing || 0), ...(e.width ? { width: e.width } : {}), ...(e.formation ? { formation: e.formation } : {}), ...(e.stance ? { stance: e.stance } : {}) };
    });
    if (this.data.mode === 'capture' && this.data.capture) {
      let left = this.data.capture.budget - entries.reduce((t, e) => t + this.units[e.type].cost, 0);
      for (let i = 0; entries.length > 0 && i < 200; i++) {
        const e = entries[i % entries.length];
        if (this.units[e.type].cost > left) {
          if (entries.every((q) => this.units[q.type].cost > left)) break;
          continue;
        }
        left -= this.units[e.type].cost;
        out.push({ type: e.type, x: 0, y: 0, reserve: true, ...(e.formation ? { formation: e.formation } : {}) });
      }
    }
    return out;
  }

  buy(wish, extra = []) {
    let budget = this.data.mode === 'capture' && this.data.capture ? this.data.capture.fieldCap : this.data.budget;
    const out = [];
    for (const [type, role] of wish) {
      if (this.units[type].cost > budget) continue;
      budget -= this.units[type].cost;
      out.push({ type, role });
    }
    for (let i = 0; extra.length > 0 && i < 40; i++) {
      if (extra.every(([t]) => this.units[t].cost > budget)) break;
      const [type, role] = extra[i % extra.length];
      if (this.units[type].cost > budget) continue;
      budget -= this.units[type].cost;
      out.push({ type, role });
    }
    return out;
  }

  radiusOf(type, formation, width) {
    const u = this.units[type];
    const f = formation || u.formations[0];
    const n = u.men;
    let files = 1;
    let ranks;
    if (f === 'line') {
      files = Math.max(1, Math.min(width || u.lineWidth, n));
      if (n >= 2 && Math.ceil(n / files) < 2) files = Math.ceil(n / 2);
      ranks = Math.ceil(n / files);
    } else if (f === 'square') {
      ranks = Math.max(2, Math.ceil(n / u.squareWidth));
      files = Math.ceil(n / ranks);
    } else if (f === 'wedge') {
      ranks = 0;
      for (let left = n, r = 0; left > 0; r++) {
        const c = Math.min(left, 2 * r + 1);
        files = Math.max(files, c);
        left -= c;
        ranks += 1;
      }
    } else return (n * u.spacingX) / 6283 + u.spacingX;
    const hw = (files * u.spacingX) / 2;
    const hd = (ranks * u.spacingY) / 2;
    return Math.sqrt(hw * hw + hd * hd);
  }

  update(obs) {
    this.reserves = obs.regiments.filter((r) => r.reserve);
    this.obs = { ...obs, regiments: obs.regiments.filter((r) => !r.reserve) };
    obs = this.obs;
    if (this.role.size === 0 && obs.regiments.length > 0) {
      const used = new Set();
      for (const r of obs.regiments) {
        let best = -1;
        let bestD = Infinity;
        this.plan.forEach((e, i) => {
          if (used.has(i) || e.type !== r.kind) return;
          const d = this.dist(this.deployAt(e), r);
          if (d < bestD) {
            bestD = d;
            best = i;
          }
        });
        if (best >= 0) {
          used.add(best);
          this.role.set(r.id, this.plan[best].role);
        }
      }
    }
    for (const r of obs.regiments) {
      if (this.role.has(r.id)) continue;
      const e = this.plan.find((q) => q.type === r.kind);
      if (e) this.role.set(r.id, e.role);
    }
    const hp = obs.regiments.reduce((t, r) => t + r.hp, 0);
    let hurt = this.myHp >= 0 && hp < this.myHp;
    this.myHp = hp;
    for (const e of obs.enemies) {
      const old = this.seen.get(e.id);
      if (old && e.men < old.men) hurt = true;
    }
    this.busy = hurt || obs.regiments.some((r) => r.engaged);
    if (this.busy) this.lastFight = obs.tick;
    for (const e of obs.enemies) {
      const old = this.seen.get(e.id);
      const dt = old ? Math.max(1, obs.tick - old.tick) : 1;
      const vx = old && obs.tick - old.tick <= 20 ? (e.x - old.x) / dt : 0;
      const vy = old && obs.tick - old.tick <= 20 ? (e.y - old.y) / dt : 0;
      this.seen.set(e.id, { ...e, tick: obs.tick, vx, vy });
      if (e.routed) this.lastSeenAt.delete(e.id);
      else this.lastSeenAt.set(e.id, { x: e.x, y: e.y, kind: e.kind });
    }
    for (const [id, e] of this.seen) if (obs.tick - e.tick > 400 || e.routed) this.seen.delete(id);
    for (const ev of obs.events) if (ev.type === 'destroyed') this.lastSeenAt.delete(ev.reg);
  }

  mine(role) {
    return this.obs.regiments.filter((r) => !r.routed && this.role.get(r.id) === role);
  }

  get foes() {
    return this.obs.enemies.filter((e) => !e.routed);
  }

  remembered(maxAge) {
    const out = [];
    for (const e of this.seen.values()) {
      const age = this.obs.tick - e.tick;
      if (age > maxAge) continue;
      const k = Math.min(age, 30);
      out.push({ ...e, x: this.rnd(e.x + e.vx * k), y: this.rnd(e.y + e.vy * k) });
    }
    return out;
  }

  predict(e, ticks) {
    const m = this.seen.get(e.id);
    if (!m) return { x: e.x, y: e.y };
    return { x: this.rnd(e.x + m.vx * ticks), y: this.rnd(e.y + m.vy * ticks) };
  }

  nearestFoe(r, filter, maxTiles) {
    let best = null;
    let bestD = maxTiles === undefined ? Infinity : maxTiles;
    for (const e of this.foes) {
      if (filter && !filter(e)) continue;
      const d = this.gap(r, e);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  inFront(e, p, deg = 60) {
    return this.adiff(this.angle(e, p), e.facing) <= deg;
  }

  approaching(e, me) {
    const moving = e.status === 'moving' || e.status === 'attacking' || e.status === 'assaulting' || e.status === 'infiltrating' || e.status === 'charging';
    return moving && this.adiff(e.facing, this.angle(e, me)) < 50;
  }

  spearWall(e, me) {
    return e.kind === 'spear' && (e.status === 'braced' || e.status === 'bracing') && e.formation !== 'circle' && this.inFront(e, me, 70);
  }

  shieldWall(e, me) {
    return e.kind === 'shield' && e.status === 'walled' && this.inFront(e, me, 70);
  }

  send(out, prio, c, intent, hold = 0) {
    const cmd = ({ ...c, intent });
    const key = JSON.stringify(c);
    const last = this.sent.get(c.id);
    if (last) {
      if (last.key === key && this.obs.tick - last.tick < 30) return;
      if (this.obs.tick < last.until && prio < 8 && last.key !== key) return;
    }
    out.push({ prio, c: cmd, key, hold });
  }

  committed(r) {
    const last = this.sent.get(r.id);
    return !!last && this.obs.tick < last.until;
  }

  reinforce(out) {
    if (this.data.mode !== 'capture') return;
    const room = this.obs.fieldCap - this.obs.fieldCost;
    const r = this.reserves.find((q) => q.enterIn < 0 && this.units[q.kind].cost <= room);
    if (r) this.send(out, 3, { type: 'summon', id: r.id }, '後備入場', 0);
  }

  flush(out) {
    if (this.autoReinforce) this.reinforce(out);
    const best = new Map();
    for (const o of out) {
      const cur = best.get(o.c.id);
      if (!cur || o.prio > cur.prio) best.set(o.c.id, o);
    }
    const picked = [...best.values()].sort((a, b) => b.prio - a.prio).slice(0, this.data.commandsPerDecision);
    for (const o of picked) this.sent.set(o.c.id, { key: o.key, tick: this.obs.tick, until: this.obs.tick + o.hold });
    return picked.map((o) => o.c);
  }

  state(id) {
    let s = this.mem.get(id);
    if (!s) {
      s = {};
      this.mem.set(id, s);
    }
    return s;
  }

  lineSlots(regs, anchor, facing, gapTiles) {
    const widths = regs.map((r) => (r.radius * 2) / TILE + gapTiles);
    const total = widths.reduce((s, w) => s + w, 0);
    let off = -total / 2;
    const out = new Map();
    regs.forEach((r, i) => {
      const mid = off + widths[i] / 2;
      out.set(r.id, this.offset(anchor, facing + 90, mid));
      off += widths[i];
    });
    return out;
  }

  spearReact(out, r, mayHold) {
    const s = this.state(r.id);
    const cav = this.nearestFoe(r, (e) => this.isCav(e.kind) && this.inFront(r, e, 75) && (e.dashing === 'charge' || this.approaching(e, r)), 14);
    const inf = mayHold ? this.nearestFoe(r, (e) => !this.isCav(e.kind) && e.kind !== 'archer' && this.inFront(r, e, 60) && (this.approaching(e, r) || this.gap(r, e) < 1.5), 6) : null;
    const threat = cav || inf;
    const braced = r.status === 'braced' || r.status === 'bracing';
    if (threat) s.lastThreat = this.obs.tick;
    if (threat && !braced && !r.engaged) {
      const f = this.angle(r, threat);
      this.send(out, 9, { type: 'brace', id: r.id, facing: f }, cav ? '架槍林擋騎兵' : '架槍林守正面', 40);
      return true;
    }
    if (braced) {
      if (!threat && this.obs.tick - (s.lastThreat || 0) > 40) {
        this.send(out, 5, { type: 'unbrace', id: r.id }, '收槍林');
        return true;
      }
      return true;
    }
    return false;
  }

  swordAssault(out, r, t) {
    if (r.skillCooldown > 0 || r.dashing || r.engaged) return false;
    const d = this.gap(r, t);
    if (d < 1.5 || d > 6.5) return false;
    if (this.spearWall(t, r) || this.shieldWall(t, r) || t.dashing) return false;
    if (!this.inFront(r, t, 35)) return false;
    const p = this.predict(t, 15);
    this.send(out, 8, { type: 'assault', id: r.id, x: p.x, y: p.y }, `突擊${this.units[t.kind].name}`, 30);
    return true;
  }

  meleeTarget(r, maxTiles, load) {
    let best = null;
    let bestS = Infinity;
    for (const e of this.foes) {
      const d = this.gap(r, e);
      if (d > maxTiles) continue;
      if (!this.isCav(r.kind) && this.isCav(e.kind) && !e.engaged && e.status !== 'idle' && d > 2) continue;
      let s = d;
      if (e.engaged) s -= 5;
      if (e.kind === 'archer') s -= 4;
      if (r.kind === 'spear' && this.isCav(e.kind)) s -= 6;
      if (this.isCav(r.kind) || r.kind === 'sword' || r.kind === 'light') {
        if (this.spearWall(e, r)) s += 30;
      }
      if (this.shieldWall(e, r) && r.kind !== 'heavyCav') s += 8;
      if (r.kind === 'light' && e.kind !== 'archer' && !e.engaged) s += 10;
      s += 4 * ((load && load.get(e.id)) || 0);
      if (s < bestS) {
        bestS = s;
        best = e;
      }
    }
    return best;
  }

  flankPoint(r, t, tiles) {
    const a = this.offset(t, t.facing + 110, tiles);
    const b = this.offset(t, t.facing - 110, tiles);
    const okA = this.h.terrainAt(a.x, a.y) !== TR.river;
    const okB = this.h.terrainAt(b.x, b.y) !== TR.river;
    if (okA && (!okB || this.dist(r, a) <= this.dist(r, b))) return a;
    return b;
  }

  cavalryCycle(out, r, rally, reach) {
    if (r.dashing) return true;
    const s = this.state(r.id);
    const heavy = r.kind === 'heavyCav';
    const name = heavy ? '重騎' : '輕騎';
    if (r.engaged) {
      const near = this.nearestFoe(r, null, 2);
      const weak = near && near.men / near.men0 < 0.35 && near.kind !== 'spear';
      if (!weak && r.men > 1) {
        const back = this.offset(r, this.face(180), 10);
        this.send(out, 7, { type: 'move', id: r.id, x: back.x, y: back.y }, `${name}脫離重整`, 30);
        return true;
      }
      return false;
    }
    let best = null;
    let bestS = -Infinity;
    for (const e of this.foes) {
      const d = this.gap(r, e);
      if (d > reach) continue;
      if (e.kind === 'spear' && (e.status === 'braced' || e.status === 'bracing') && e.formation !== 'circle') continue;
      if (e.kind === 'spear' && !e.engaged) continue;
      if (this.isCav(e.kind)) continue;
      if (e.dashing === 'charge') continue;
      let sc = 30 - d;
      if (e.kind === 'archer') sc += 25;
      if (e.kind === 'light') sc += 10;
      if (e.engaged) sc += 18;
      if (!this.inFront(e, r, 60)) sc += 12;
      if (!heavy && e.kind === 'shield') sc -= 25;
      if (sc > bestS) {
        bestS = sc;
        best = e;
      }
    }
    if (best && r.skillCooldown === 0) {
      const d = this.gap(r, best);
      const exposed = !this.inFront(best, r, 60) || best.engaged;
      if (exposed && d >= 4 && d <= 22) {
        const p = this.predict(best, Math.round((d * TILE) / (heavy ? 600 : 680)));
        if (this.clearLine(r, p, true)) {
          s.chargedAt = this.obs.tick;
          this.send(out, 9, { type: 'charge', id: r.id, x: p.x, y: p.y }, `${name}衝鋒${this.units[best.kind].name}`, 20);
          return true;
        }
      }
      if (d <= 30) {
        const fp = this.flankPoint(r, best, 12);
        this.send(out, 6, { type: 'move', id: r.id, x: fp.x, y: fp.y }, `${name}繞到${this.units[best.kind].name}側面`, 20);
        return true;
      }
    }
    if (this.dist(r, rally) > 3000) {
      this.send(out, 2, { type: 'move', id: r.id, x: rally.x, y: rally.y, facing: this.forward }, r.skillCooldown > 0 ? `${name}重整，等待再衝` : `${name}在側翼待命`, 20);
      return true;
    }
    return false;
  }

  archerReact(out, r, post) {
    const s = this.state(r.id);
    const range = this.units.archer.range / TILE;
    const melee = this.nearestFoe(r, (e) => e.kind !== 'archer' && !e.engaged && (e.kind === 'shield' ? this.gap(r, e) < 2 : this.approaching(e, r) || this.gap(r, e) < 3), 6);
    const screened = melee && this.obs.regiments.some((o) => o.id !== r.id && o.kind !== 'archer' && !o.routed && this.dist(o, melee) < this.dist(r, melee) - 1500);
    if (melee && !screened && !r.engaged && this.obs.tick - (s.kitedAt || -100) > 40) {
      const away = this.angle(melee, r);
      const back = this.offset(r, away, 9);
      s.kitedAt = this.obs.tick;
      this.send(out, 8, { type: 'move', id: r.id, x: back.x, y: back.y }, '後撤避開近戰', 30);
      return true;
    }
    if (r.status === 'volleying') return true;
    if (r.skillCooldown === 0 && r.status !== 'moving') {
      let best = null;
      let bestS = 0;
      for (const e of this.foes) {
        const d = this.dist(r, e) / TILE;
        if (d > range + (r.height - e.height) - 1) continue;
        let sc = e.men;
        if (e.engaged) sc += 20;
        if (e.terrain === TR.shallow) sc += 25;
        if (e.kind === 'shield') sc -= 30;
        for (const o of this.foes) if (o !== e && this.dist(o, e) < 5000) sc += 15;
        if (sc > bestS) {
          bestS = sc;
          best = e;
        }
      }
      if (best && bestS >= 45) {
        const p = this.predict(best, 12);
        this.send(out, 7, { type: 'volley', id: r.id, x: p.x, y: p.y }, `齊射${this.units[best.kind].name}`, 30);
        return true;
      }
    }
    let pick = null;
    let pickS = -Infinity;
    let inRangeCount = 0;
    for (const e of this.foes) {
      const d = (this.dist(r, e) - e.radius / 2) / TILE;
      if (d > range + (r.height - e.height) - 1.5) continue;
      inRangeCount += 1;
      let sc = -d + (1 - e.men / e.men0) * 10;
      if (e.kind === 'shield') sc -= e.stance === 'carry' && e.status !== 'walled' && e.status !== 'walling' ? 10 : 40;
      if (e.kind === 'archer') sc += 12;
      if (e.engaged) sc += 8;
      if (e.routed) sc -= 30;
      if (sc > pickS) {
        pickS = sc;
        pick = e;
      }
    }
    if (pick && r.order === 'attack' && r.target === pick.id) return true;
    if (pick && inRangeCount > 1) {
      this.send(out, 8, { type: 'attack', id: r.id, target: pick.id }, `集火${this.units[pick.kind].name}`, 40);
      return true;
    }
    const inRange = this.foes.some((e) => this.dist(r, e) / TILE - e.radius / TILE / 2 <= range + (r.height - e.height) - 1);
    const contested = this.foes.some((e) => e.kind !== 'archer' && e.kind !== 'light' && this.dist(e, post) < 7000);
    const settle = inRange && (contested || this.obs.tick - (s.kitedAt || -1000) < 200);
    const higher = this.h.heightAt(post.x, post.y) > r.height && !this.foes.some((e) => e.kind !== 'archer' && this.gap(r, e) < 8);
    const far = this.dist(r, post) > (inRange && !higher ? 12000 : 2500);
    if (far && !settle && !this.committed(r) && this.obs.tick - (s.kitedAt || -100) > 60) {
      this.send(out, 3, { type: 'move', id: r.id, x: post.x, y: post.y, facing: this.forward }, '進入射擊陣地', 30);
      return true;
    }
    if (r.status !== 'moving' && r.order !== 'hold') {
      this.send(out, 1, { type: 'hold', id: r.id }, '站定射擊', 20);
      return true;
    }
    return false;
  }

  shieldReact(out, r, ward, forward = 3500) {
    const s = this.state(r.id);
    const archers = this.nearestFoe(r, (e) => e.kind === 'archer', 18);
    const inf = this.nearestFoe(r, (e) => !this.isCav(e.kind) && e.kind !== 'archer' && e.kind !== 'shield' && this.inFront(r, e, 70) && (this.approaching(e, r) || this.gap(r, e) < 1.5), 5);
    if (inf) s.lastInf = this.obs.tick;
    if (r.status === 'walled' || r.status === 'walling') {
      if (!inf && this.obs.tick - (s.lastInf || 0) > 30) {
        this.send(out, 5, { type: 'shield', id: r.id, mode: 'unwall' }, '收盾牆');
        return true;
      }
      return true;
    }
    if (inf && !r.engaged && !ward?.dashing) {
      this.send(out, 8, { type: 'shield', id: r.id, mode: 'wall' }, '架盾牆擋步兵', 40);
      return true;
    }
    const want = archers ? 'raise' : 'carry';
    if (r.stance !== want) {
      this.send(out, 6, { type: 'shield', id: r.id, mode: want }, want === 'raise' ? '舉盾擋箭' : '持盾行軍', 20);
      return true;
    }
    if (ward && r.order !== 'follow') {
      this.send(out, 3, { type: 'follow', id: r.id, target: ward.id, forward }, `護送${this.units[ward.kind].name}`, 30);
      return true;
    }
    return false;
  }

  scoutReact(out, r, watch, watchName) {
    const threat = this.nearestFoe(r, (e) => e.kind !== 'archer' && e.kind !== 'light', 6);
    if (threat && !r.engaged) {
      const back = this.offset(r, this.angle(threat, r), 10);
      this.send(out, 8, { type: 'move', id: r.id, x: back.x, y: back.y }, '斥候後撤', 30);
      return true;
    }
    const prey = this.nearestFoe(r, (e) => e.kind === 'archer' && (e.engaged || r.men * 2 >= e.men) && !this.foes.some((o) => o !== e && o.kind !== 'archer' && this.dist(o, e) < 6000), 12);
    if (prey) {
      if (r.skillCooldown === 0 && !r.dashing && this.gap(r, prey) > 2) {
        const p = this.predict(prey, 15);
        this.send(out, 9, { type: 'infiltrate', id: r.id, x: p.x, y: p.y }, '切入敵方弓兵', 25);
        return true;
      }
      this.send(out, 6, { type: 'attack', id: r.id, target: prey.id }, '襲擊敵方弓兵', 20);
      return true;
    }
    const bow = (this.units.archer.range / TILE + 3) * TILE;
    const archers = [...this.lastSeenAt.values()].filter((e) => e.kind === 'archer');
    const inRange = ( p) => archers.find((e) => this.dist(e, p) < bow);
    const near = inRange(r);
    if (near && !r.engaged) {
      const safe = this.offset(near, this.angle(near, r), bow / TILE + 2);
      this.send(out, 7, { type: 'move', id: r.id, x: safe.x, y: safe.y }, '避開弓兵射程', 30);
      return true;
    }
    const risky = inRange(watch);
    const post = risky ? this.offset(risky, this.angle(risky, r), bow / TILE + 2) : watch;
    if (this.dist(r, post) > 2000) {
      this.send(out, 1, { type: 'move', id: r.id, x: post.x, y: post.y }, `偵察${watchName}`, 30);
      return true;
    }
    return false;
  }

  huntPoint() {
    if (this.lastFight < 0) return null;
    const behind = this.obs.timeLeft < 900 && this.strengthRatio() < 1;
    if (this.obs.tick - this.lastFight < 300 && !behind) return null;
    const own = this.obs.regiments.filter((r) => !r.routed);
    if (own.length === 0) return null;
    const c = { x: own.reduce((t, r) => t + r.x, 0) / own.length, y: own.reduce((t, r) => t + r.y, 0) / own.length };
    let best = null;
    let bestD = Infinity;
    for (const e of this.remembered(400)) {
      const d = this.dist(c, e);
      if (d < bestD) {
        bestD = d;
        best = { x: e.x, y: e.y };
      }
    }
    if (best) return best;
    for (let guard = 0; guard < 50 && this.lastSeenAt.size > 0; guard++) {
      let id = -1;
      let near = Infinity;
      for (const [k, p] of this.lastSeenAt) {
        const d = this.dist(c, p);
        if (d < near) {
          near = d;
          id = k;
        }
      }
      if (near > 6 * TILE) return this.lastSeenAt.get(id) || null;
      this.lastSeenAt.delete(id);
    }
    const sweep = [this.at(128, 50), this.at(110, 24), this.at(110, 76), this.at(86, 50)];
    return sweep[Math.floor(this.obs.tick / 300) % sweep.length];
  }

  get flags() {
    return this.obs.flags;
  }

  get mainFlag() {
    return this.flags.reduce(( b, f) => (b === null || f.points > b.points ? f : b), null);
  }

  sideFlagFor(from, except = -1) {
    const main = this.mainFlag;
    let best = null;
    let bestD = Infinity;
    for (const f of this.flags) {
      if (f === main || f.id === except) continue;
      const d = this.dist(from, f) * (f.owner === this.p && !f.contested ? 3 : 1);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    return best;
  }

  takeFlag(out, r, f, prio) {
    if (this.dist(r, f) <= this.data.capture.radius * 0.5) return false;
    const why = f.owner === this.p ? (f.contested ? `守住${f.name}` : `回防${f.name}`) : `佔領${f.name}`;
    this.send(out, prio, { type: 'move', id: r.id, x: f.x, y: f.y }, why, 30);
    return true;
  }

  strengthRatio() {
    const mine = this.obs.regiments.filter((r) => !r.routed).reduce((s, r) => s + r.men * this.units[r.kind].cost / this.units[r.kind].men, 0);
    const theirs = this.remembered(300).reduce((s, e) => s + e.men * this.units[e.kind].cost / this.units[e.kind].men, 0);
    return theirs === 0 ? 9 : mine / theirs;
  }
}

const POLICIES = {"army":[["spear",2],["shield",1],["archer",8],["light",1]],"brace":true,"defend":true,"fireline":true,"x":66,"y":59,"guard":true,"cavFocus":true,"spearFront":0,"shieldFront":-1,"archWidth":6,"capture":{"army":[["light",26]],"infiltrate":true}};
export default class Marshal extends LegionBase {
  constructor() { super(); this.jobs = new Map(); this.dest = new Map(); this.policy=POLICIES; }
  declare() {
    const POLICY=POLICIES;
    return { name: '元帥', version: 'v1', style: '兵力集中、快速佔旗、協同集火與持續增援', knobs: [
      {key:'aggression',name:'接戰距離',description:'主動接敵距離（格）',min:8,max:30,default:POLICY.reach || 20,integer:true},
      {key:'advance',name:'集結位置',description:'殲滅戰初期集結位置',min:45,max:85,default:POLICY.x || 68,integer:true},
      ...(POLICY.defend ? [{key:'fireDepth',name:'火線間距',description:'殲滅戰兩排弓兵的前後間距（格）',min:3,max:8,default:4,integer:true}] : [{key:'patience',name:'推進時間',description:'殲滅戰全面推進時間（秒）',min:0,max:150,default:POLICY.wait || 45,integer:true}])
    ]};
  }
  deploy(data,h) {
    this.policy=data.mode==='capture'&&POLICIES.capture?POLICIES.capture:POLICIES;
    const POLICY=this.policy;
    this.setup(data,h);
    const army = [];
    for (const [type,n] of POLICY.army) for(let i=0;i<n;i++) army.push({type,role:type});
    let spent=0;
    const list=army.filter(e=>{const c=this.units[e.type].cost;if(spent+c>500)return false;spent+=c;return true;});
    const count={};
    const plan=list.map((e,i)=>{
      const j=count[e.type] || 0; count[e.type]=j+1;
      const n=list.filter(a=>a.type===e.type).length;
      const row=Math.floor(j/8), col=j%8;
      return {...e,tx:17-row*6-(e.type==='archer'?7:0),ty: n<=8 ? 50+(j-(n-1)/2)*(POLICY.deployGap||9) : 12+col*10,
        facing:0,...(e.type==='spear'?{formation:'line',width:POLICY.width||15}:{}),...(e.type==='archer'?{width:POLICY.archWidth||12}:{}),...(e.type==='shield'?{stance:'raise'}:{})};
    });
    const deployed=this.deployFrom(plan), placed=[];
    const z=data.map.deploy[data.playerId];
    for(const r of deployed) {
      if(r.reserve)continue;
      const rad=this.radiusOf(r.type,r.formation,r.width);
      const valid=(x,y)=>x>=z.x0*TILE&&x<z.x1*TILE&&y>=z.y0*TILE&&y<z.y1*TILE&&!([5,7,8].includes(h.terrainAt(x,y)))&&!placed.some(a=>this.dist(a,{x,y})<(a.rad+rad)*0.57);
      if(!valid(r.x,r.y)) {
        let best=null, distance=Infinity;
        for(let x=z.x0+1;x<z.x1;x+=2)for(let y=z.y0+3;y<z.y1-2;y+=2) {
          if(!valid(x*TILE,y*TILE))continue;
          const d=(x*TILE-r.x)*(x*TILE-r.x)+(y*TILE-r.y)*(y*TILE-r.y);
          if(d<distance){distance=d;best={x:x*TILE,y:y*TILE};}
        }
        if(best){r.x=best.x;r.y=best.y;}
      }
      placed.push({x:r.x,y:r.y,rad});
    }
    return deployed;
  }
  issue(out,r,c,why,prio=5) { this.send(out,prio,{...c,id:r.id},why,15); }
  decide(obs) {
    const POLICY=this.policy;
    this.update(obs);
    const out=[];
    const own=this.obs.regiments;
    const capture=this.data.mode==='capture';
    const foes=this.foes;
    const load=new Map();
    const flags=this.flags;
    for (const r of own) {
      if(r.dashing || r.status==='reforming')continue;
      let goal;
      if(capture) {
        if(!this.jobs.has(r.id)) {
          const cnt=flags.map(f=>own.filter(a=>this.jobs.get(a.id)===f.id).reduce((s,a)=>s+this.units[a.kind].cost,0)/(f.points===2?(POLICY.centerWeight||2):1));
          const best=flags.reduce((a,f,i)=>cnt[i]<cnt[a]?i:a,0);
          this.jobs.set(r.id,flags[best].id);
        }
        goal=flags.find(f=>f.id===this.jobs.get(r.id));
      } else {
        const progress=!POLICY.defend && obs.tick>this.k.patience*10 ? Math.min(65,(obs.tick-this.k.patience*10)/12):0;
        goal=this.at(Math.min(145,this.k.advance+progress),POLICY.y||50);
        if(foes.length && !POLICY.defend) {
          const center={x:own.reduce((s,a)=>s+a.x,0)/own.length,y:own.reduce((s,a)=>s+a.y,0)/own.length};
          const target=foes.reduce((a,e)=>this.dist(e,center)<this.dist(a,center)?e:a,foes[0]);
          if(this.dist(center,target)<35000)goal=target;
        }
      }
      if(!goal)continue;
      if(r.kind==='archer') {
        const index=own.filter(a=>a.kind==='archer').findIndex(a=>a.id===r.id);
        const post=capture?this.offset(goal,this.face(180),POLICY.archBack||2):this.offset(this.offset(goal,this.face(180),4+Math.floor(index/4)*(this.k.fireDepth||4)),this.face(90),(index%4-1.5)*4);
        if(POLICY.fireline && !capture) {this.fireline(out,r,post);continue;}
        this.archerReact(out,r,post); continue;
      }
      if(!capture && POLICY.defend) {
        const peers=own.filter(a=>a.kind===r.kind), index=peers.findIndex(a=>a.id===r.id);
        goal=this.offset(this.offset(goal,this.forward,r.kind==='shield'?(POLICY.shieldFront === undefined?2:POLICY.shieldFront):(POLICY.spearFront===undefined?4:POLICY.spearFront)),this.face(90),(index-(peers.length-1)/2)*(r.kind==='spear'?(POLICY.spearGap||10):8));
      }
      if(!capture&&POLICY.guard&&r.kind==='spear') {
        const t=this.nearestFoe(r,e=>this.isCav(e.kind),20);
        if(t && (t.dashing || this.approaching(t,r) || this.gap(r,t)<10)) {
          const facing=this.angle(r,t);
          if(r.status==='braced'||r.status==='bracing') {
            if(this.adiff(r.facing,facing)>65)this.issue(out,r,{type:'unbrace'},'轉向攔截騎兵',9);
          } else if(r.status!=='unbracing')this.issue(out,r,{type:'brace',facing},'掩護弓兵防騎兵',9);
          continue;
        }
      }
      if(r.status==='unbracing')continue;
      let target=null, score=Infinity;
      for(const e of foes) {
        const d=this.gap(r,e);
        if(d>(!capture&&POLICY.defend?8:this.k.aggression))continue;
        if(!capture&&POLICY.defend&&this.dist(e,goal)>14000)continue;
        if(capture && this.dist(e,goal)>24000 && this.dist(r,goal)>8000)continue;
        let s=d+(load.get(e.id)||0)*(POLICY.load||1);
        if(e.kind==='archer')s-=4;
        if(e.engaged)s-=3;
        if(s<score){score=s;target=e;}
      }
      if(target) {
        load.set(target.id,(load.get(target.id)||0)+1);
        if(r.kind==='spear' && POLICY.brace && this.spearReact(out,r,true))continue;
        if(r.kind==='shield' && POLICY.defend && !capture) {
          if(this.dist(r,goal)>3000) this.issue(out,r,{type:'move',x:goal.x,y:goal.y,facing:this.forward},'盾兵掩護火線');
          else if(r.status!=='walled'&&r.status!=='walling')this.issue(out,r,{type:'shield',mode:'wall'},'架設盾牆',7);
          continue;
        }
        if(r.kind==='sword' && this.swordAssault(out,r,target))continue;
        if(r.kind==='light' && POLICY.infiltrate && r.skillCooldown===0 && !r.engaged && this.gap(r,target)>1 && this.gap(r,target)<8 && !this.spearWall(target,r) && this.inFront(r,target,35)) {
          this.issue(out,r,{type:'infiltrate',target:target.id},'切入敵陣',8);continue;
        }
        this.issue(out,r,{type:'attack',target:target.id},'協同集火');continue;
      }
      if(r.status==='braced'||r.status==='bracing'){this.issue(out,r,{type:'unbrace'},'收陣推進');continue;}
      if(this.dist(r,goal)>2000) this.issue(out,r,{type:'attackMove',x:goal.x,y:goal.y},capture?'搶佔責任旗點':'集中兵力推進',3);
    }
    return this.flush(out);
  }
  fireline(out,r,post) {
    const POLICY=this.policy;
    if(r.status==='volleying')return;
    const nearby=this.foes.filter(e=>this.gap(r,e)<(this.isCav(e.kind)?8:4)&&e.kind!=='archer');
    if(nearby.length&&!r.engaged) {
      const e=nearby.reduce((a,b)=>this.dist(a,r)<this.dist(b,r)?a:b);
      const screen=this.obs.regiments.some(a=>a.kind!=='archer'&&this.dist(a,e)+2000<this.dist(r,e));
      if(!screen) {const p=this.offset(r,this.angle(e,r),6);this.issue(out,r,{type:'move',x:p.x,y:p.y},'火線後撤',9);return;}
    }
    const targets=this.foes.filter(e=>this.dist(r,e)<this.units.archer.range+Math.max(-3,Math.min(3,r.height-e.height))*1000-1500);
    if(targets.length) {
      const best=targets.reduce((a,b)=> {
        const sc=e=>(e.kind==='archer'?35:0)+(e.engaged?12:0)-this.dist(e,r)/1000+(e.kind==='shield'?-40:0)+(POLICY.cavFocus&&this.isCav(e.kind)?60:0);
        return sc(a)>sc(b)?a:b;
      });
      if(r.skillCooldown===0&&best.engaged&&best.kind!=='shield') {
        const p=this.predict(best,10);
        const range=this.units.archer.range+Math.max(-3,Math.min(3,r.height-this.h.heightAt(p.x,p.y)))*1000;
        if(this.dist(r,p)<range-300){this.issue(out,r,{type:'volley',x:p.x,y:p.y},'集中齊射',8);return;}
      }
      if(r.target!==best.id||r.order!=='attack')this.issue(out,r,{type:'attack',target:best.id},'火線集火',7);
      return;
    }
    if(this.dist(r,post)>2000)this.issue(out,r,{type:'move',x:post.x,y:post.y,facing:this.forward},'集結火力陣地',3);
    else if(r.order!=='hold')this.issue(out,r,{type:'hold'},'維持火線',2);
  }
}
