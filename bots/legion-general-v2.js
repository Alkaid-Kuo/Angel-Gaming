// 軍團戰選手「將軍」v1：高地弓兵 + 槍盾防線 + 騎兵反擊
// 所有戰術都在「藍方座標系」寫（我方在西、敵人在東），紅方進出時鏡像轉換。

const T = 1000;
/** 佔點防線：槍兵的 x（格）、盾兵相對槍兵的前移量 */
const CAP_SX = 116;
const CAP_SH = 3;
/** 重騎兵是否長期駐守橋旗（false＝搶完中央旗就回防線當機動預備） */
const HC_DUTY = true;
/** 佔點是否派一團槍兵駐守南橋旗 */
const SPEAR_GARRISON = true;

/** 場上兵力（第一個前列兵種排在正中） */
const COMP_ANN = ['shield', 'spear', 'spear', 'archer', 'archer', 'archer', 'heavyCav', 'heavyCav', 'sword', 'light'];
const COMP_CAP = ['shield', 'spear', 'spear', 'spear', 'archer', 'archer', 'archer', 'heavyCav', 'heavyCav', 'light'];
/** 佔點後備（總點數 ≤ 1500 − 場上） */
const RESERVE = ['heavyCav', 'heavyCav', 'spear', 'spear', 'shield', 'archer', 'archer', 'archer', 'sword', 'light', 'light'];

function adiff(a, b) {
  const d = ((((a - b) % 360) + 540) % 360) - 180;
  return Math.abs(d);
}

export default class General {
  constructor() {
    this.data = null;
    this.h = null;
    this.p = 0;
    this.W = 0;
    this.H = 0;
    this.mode = 'annihilation';
    this.cost = {};
    this.seen = new Map();
    this.last = new Map();
    this.lastEnemyTick = -1000;
    this.advance = false;
    this.wp = 0;
    this.rej = 0;
    this.slot = new Map();
    this.strikeId = -1;
    this.strikeSince = 0;
    this.okSince = -1;
    this.garrisonId = -1;
    this.strikeFlag = null;
  }

  declare() {
    return {
      name: 'General',
      version: 'v10',
      style: '高地弓兵、槍盾防線、騎兵反擊',
      knobs: [
        { key: 'patience', name: '等待秒數', description: '殲滅戰沒有接觸時，最久等多少秒才開始推進', min: 20, max: 120, default: 60, integer: true },
        { key: 'lineX', name: '防線位置', description: '防線離河的距離修正（格）', min: -6, max: 6, default: 0, integer: true },
        { key: 'volley', name: '齊射距離', description: '齊射目標最遠距離（格）', min: 8, max: 15, default: 14, integer: true },
      ],
    };
  }

  init(data, helpers) {
    this.data = data;
    this.h = helpers;
    this.p = data.playerId;
    this.W = data.map.width * T;
    this.H = data.map.height * T;
    this.mode = data.mode;
    for (const u of data.units) this.cost[u.kind] = u.cost;
  }

  // ---- 座標轉換（自反） ----
  bx(x) { return this.p === 0 ? x : this.W - x; }
  by(y) { return this.p === 0 ? y : this.H - y; }
  ba(a) { return this.p === 0 ? a : (a + 180) % 360; }

  ter(x, y) { return this.h.terrainAt(this.bx(x), this.by(y)); }

  // ---- 布陣 ----
  deploy(data, helpers) {
    this.init(data, helpers);
    const cy = this.H / 2;
    const ann = data.mode === 'annihilation';
    const out = [];
    let spent = 0;
    const add = (type, x, y, extra) => {
      if (spent + this.cost[type] > data.budget) return;
      spent += this.cost[type];
      out.push(Object.assign({ type, x: this.bx(x * T), y: this.by(y * T + (cy - 50 * T)), facing: this.ba(0) }, extra || {}));
    };
    const comp = ann ? COMP_ANN : COMP_CAP;
    const rows = { front: [], arch: [], back: [] };
    for (const k of comp) {
      if (k === 'spear' || k === 'shield' || k === 'sword') rows.front.push(k);
      else if (k === 'archer') rows.arch.push(k);
      else rows.back.push(k);
    }
    // 從中線往兩側交錯排開
    const place = (kinds, x, sp, extra) => {
      kinds.forEach((k, i) => {
        const off = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * sp;
        add(k, x, 50 + off, k === 'archer' ? extra : undefined);
      });
    };
    place(rows.front, 17, 8);
    place(rows.arch, 11, 7, { formation: 'square' });
    place(rows.back, 5, 12);
    if (!ann) {
      for (const k of RESERVE) {
        if (spent + this.cost[k] > data.budget) continue;
        spent += this.cost[k];
        out.push({ type: k, reserve: true, x: 0, y: 0 });
      }
    }
    return out;
  }

  // ---- 資料整理 ----
  mineOf(r) {
    return Object.assign({}, r, { x: this.bx(r.x), y: this.by(r.y), facing: this.ba(r.facing) });
  }

  enemyOf(e) {
    return Object.assign({}, e, { x: this.bx(e.x), y: this.by(e.y), facing: this.ba(e.facing) });
  }

  dist(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  gap(m, e) { return this.dist(m, e) - e.radius; }

  ang(a, b) { return this.h.angleTo(a.x, a.y, b.x, b.y); }

  emit(cmds, u, sig, cmd, minGap) {
    const l = this.last.get(u.id);
    if (l && l.sig === sig && this.tick - l.tick < (minGap || 20)) return false;
    this.last.set(u.id, { sig, tick: this.tick });
    cmds.push(cmd);
    return true;
  }

  // 轉成輸出指令（座標、角度轉回絕對座標）
  mv(u, x, y, f, intent) {
    const c = { type: 'move', id: u.id, x: this.bx(x), y: this.by(y), intent };
    if (f !== undefined) c.facing = this.ba(f);
    return c;
  }

  // ---- 主迴圈 ----
  decide(obs) {
    const cmds = [];
    this.tick = obs.tick;
    const data = this.data;
    const mine = [];
    const reserve = [];
    for (const r of obs.regiments) (r.reserve ? reserve : mine).push(this.mineOf(r));
    const en = obs.enemies.map((e) => this.enemyOf(e));
    for (const e of en) this.seen.set(e.id, Object.assign({}, e, { tick: obs.tick }));
    for (const ev of obs.events) {
      if (ev.type === 'destroyed') this.seen.delete(ev.reg);
      if (ev.type === 'rejected') this.rej++;
    }
    this.me = obs.me;
    this.updateGarrison(mine);
    this.flags = (obs.flags || []).map((f) => Object.assign({}, f, { x: this.bx(f.x), y: this.by(f.y) }));
    this.strikeFlag = null;
    if (this.mode === 'capture') {
      const cav = mine.filter((m) => m.kind === 'heavyCav' || m.kind === 'lightCav');
      if (cav.length > 0) {
        const mid = this.H / 2;
        const center = this.flags.find((f) => Math.abs(f.y - mid) < 10 * T);
        const bridges = this.flags.filter((f) => Math.abs(f.y - mid) >= 10 * T).sort((a, b) => a.y - b.y);
        const south = bridges[1];
        const north = bridges[0];
        const mineOk = (f) => f.owner === this.me && !f.contested;
        let pick = null;
        if (center && obs.tick < 450 && !mineOk(center)) {
          pick = center;
        } else if (!HC_DUTY) {
          pick = null;
        } else {
          const cur = this.flags.find((f) => f.id === this.strikeId && f.id !== (center && center.id));
          pick = cur || south || north;
          if (pick && mineOk(pick)) {
            if (this.okSince < 0) this.okSince = obs.tick;
            const other = pick === south ? north : south;
            if (obs.tick - this.okSince >= 300 && other && !mineOk(other)) { pick = other; this.okSince = -1; }
          } else {
            this.okSince = -1;
          }
        }
        if (pick) {
          if (pick.id !== this.strikeId) this.okSince = -1;
          this.strikeFlag = pick;
          this.strikeId = pick.id;
        }
      }
    }
    if (en.length > 0) this.lastEnemyTick = obs.tick;
    const quiet = obs.tick - this.lastEnemyTick;

    if (obs.tick === 0) cmds.push({ type: 'plan', text: '高地弓兵槍盾防線騎兵反擊' });

    // 佔點：召喚後備
    let quota = data.commandsPerDecision;
    if (this.mode === 'capture') {
      let fc = obs.fieldCost;
      for (const r of reserve) {
        if (quota <= 0) break;
        if (r.enterIn >= 0) continue;
        const c = this.cost[r.kind];
        if (fc + c > obs.fieldCap) continue;
        cmds.push({ type: 'summon', id: r.id, intent: '入場' });
        fc += c;
        quota--;
      }
    }

    // 是否推進
    const patience = (data.knobs.patience ?? 60) * 10;
    if (!this.advance) {
      if (this.mode === 'annihilation') {
        if (obs.tick >= patience && quiet > 80) this.advance = true;
      } else if (obs.tick >= 1500 && quiet > 150) {
        this.advance = true;
      }
    }

    const pri = [];
    for (const u of mine) {
      const c = this.unit(u, mine, en, quiet);
      if (c) pri.push(c);
    }
    pri.sort((a, b) => a.pri - b.pri);
    for (const c of pri) {
      if (quota <= 0) break;
      cmds.push(c.cmd);
      quota--;
    }
    return cmds;
  }

  /** 佔點：指定一團槍兵駐守南橋旗 */
  updateGarrison(mine) {
    if (this.mode !== 'capture' || !SPEAR_GARRISON) return;
    const sp = mine.filter((m) => m.kind === 'spear');
    if (this.garrisonId >= 0 && sp.some((m) => m.id === this.garrisonId)) return;
    this.garrisonId = sp.length >= 3 ? Math.max.apply(null, sp.map((m) => m.id)) : -1;
  }

  // 防線 / 集結位置（藍方座標，格）
  slotOf(u, index) {
    if (this.mode === 'capture' && u.id === this.garrisonId && this.flags && this.flags.length) {
      const south = this.flags.filter((f) => Math.abs(f.y - this.H / 2) >= 10 * T).sort((a, b) => b.y - a.y)[0];
      if (south) return [south.x / T, south.y / T];
    }
    const ann = this.mode === 'annihilation';
    const dx = (this.data.knobs.lineX ?? 0);
    if (ann) {
      const s = {
        spear: [[67 + dx, 41], [67 + dx, 59]],
        shield: [[67 + dx, 50]],
        archer: [[60.5, 59], [65.5, 59], [63, 55.5]],
        heavyCav: [[64, 33], [64, 67]],
        sword: [[61, 50]],
        light: [[61, 45]],
      };
      return (s[u.kind] || [[62, 50]])[Math.min(index, (s[u.kind] || [[62, 50]]).length - 1)];
    }
    const X = CAP_SX + dx;
    const s = {
      spear: [[X, 71.5], [X, 78.5], [X, 75], [X - 2, 70], [X - 2, 80]],
      shield: [[X + CAP_SH, 75]],
      archer: [[X - 2, 72.5], [X - 2, 77.5], [X - 5, 75]],
      heavyCav: [[X - 9, 66], [X - 9, 84]],
      lightCav: [[X - 9, 66], [X - 9, 84]],
      sword: [[X - 6, 70]],
      light: [[X - 6, 80]],
    };
    return (s[u.kind] || [[108, 75]])[Math.min(index, (s[u.kind] || [[108, 75]]).length - 1)];
  }

  // 推進路線（藍方座標，格）
  route() {
    if (this.mode === 'annihilation') return [[70, 50], [92, 50], [112, 50], [138, 50]];
    return [[112, 75], [120, 75], [140, 75], [200, 75]];
  }

  unit(u, mine, en, quiet) {
    const kind = u.kind;
    const same = mine.filter((m) => m.kind === kind);
    const index = same.findIndex((m) => m.id === u.id);
    const slot = this.slotOf(u, index);
    const sx = slot[0] * T, sy = slot[1] * T;
    const here = { x: u.x, y: u.y };
    const toSlot = Math.hypot(sx - u.x, sy - u.y);
    const nearAll = en.map((e) => ({ e, g: this.gap(u, e) })).sort((a, b) => a.g - b.g);
    const nearMelee = nearAll.find((n) => n.e.kind !== 'archer');
    const cmds = [];
    const out = (cmd, p) => ({ cmd, pri: p === undefined ? 5 : p });
    const E = (sig, cmd, p, gapT) => (this.emit(cmds, u, sig, cmd, gapT) ? out(cmd, p) : null);

    if (u.status === 'entering' || u.status === 'reserve') return null;
    // 衝刺中不下令
    if (u.dashing) return null;

    if (kind === 'spear') {
      if (nearMelee && nearMelee.g < 12 * T && (toSlot < 4 * T || nearMelee.g < 5 * T || u.engaged || u.status === 'braced' || u.status === 'bracing')) {
        const a = this.ang(u, nearMelee.e);
        if (u.status === 'braced' || u.status === 'bracing') {
          if (adiff(a, u.facing) > 80 && nearMelee.g < 8 * T && !u.engaged) {
            return E('unbrace', { type: 'unbrace', id: u.id, intent: '轉向' }, 2);
          }
          return null;
        }
        if (u.status === 'unbracing') return null;
        return E('brace' + a, { type: 'brace', id: u.id, facing: this.ba(a), intent: '槍林' }, 1);
      }
      if (u.id === this.garrisonId && toSlot < 2 * T && u.status !== 'braced' && u.status !== 'bracing' && u.status !== 'unbracing') {
        return E('gbrace', { type: 'brace', id: u.id, facing: this.ba(0), intent: '守旗' }, 2, 40);
      }
      if (this.advance && u.id !== this.garrisonId && (u.status === 'braced' || u.status === 'bracing') && quiet > 50) {
        return E('unbrace', { type: 'unbrace', id: u.id, intent: '收槍' }, 6);
      }
      if (u.status === 'braced' || u.status === 'bracing' || u.status === 'unbracing') {
        if (!this.advance) return null;
      }
      return this.goDefault(u, sx, sy, toSlot, cmds, E);
    }

    if (kind === 'shield') {
      if (nearMelee && nearMelee.g < 11 * T && (toSlot < 4 * T || nearMelee.g < 5 * T || u.engaged || u.status === 'walled' || u.status === 'walling')) {
        const a = this.ang(u, nearMelee.e);
        if (u.status === 'walled' || u.status === 'walling') return null;
        if (adiff(a, u.facing) > 20) return E('face' + a, { type: 'face', id: u.id, facing: this.ba(a), intent: '轉盾' }, 1, 8);
        return E('wall', { type: 'shield', id: u.id, mode: 'wall', intent: '盾牆' }, 1);
      }
      if (this.advance && (u.status === 'walled' || u.status === 'walling') && quiet > 50) {
        return E('unwall', { type: 'shield', id: u.id, mode: 'unwall', intent: '收盾' }, 6);
      }
      if (u.status === 'walled' || u.status === 'walling') {
        if (!this.advance) return null;
      }
      return this.goDefault(u, sx, sy, toSlot, cmds, E);
    }

    if (kind === 'archer') {
      const vr = (this.data.knobs.volley ?? 14) * T;
      if (u.skillCooldown === 0 && u.status !== 'volleying' && u.status !== 'reforming') {
        let best = null;
        for (const n of nearAll) {
          const d = this.dist(u, n.e);
          const hd = Math.max(-3, Math.min(3, (u.height || 0) - (n.e.height || 0)));
          if (d > Math.min(vr, (15.5 + hd) * T)) continue;
          const sc = n.e.men + (n.e.engaged ? 10 : 0) + (n.e.kind === 'archer' ? 6 : 0);
          if (!best || sc > best.sc) best = { e: n.e, sc };
        }
        if (best && best.e.men >= 8) {
          return E('volley', { type: 'volley', id: u.id, x: this.bx(best.e.x), y: this.by(best.e.y), intent: '齊射' }, 3, 40);
        }
      }
      return this.goDefault(u, sx, sy, toSlot, cmds, E);
    }

    if (kind === 'heavyCav' || kind === 'lightCav') {
      if (this.mode === 'capture' && this.strikeFlag) {
        const f = this.strikeFlag;
        const d = Math.hypot(u.x - f.x, u.y - f.y);
        const garrison = en.filter((e) => Math.hypot(e.x - f.x, e.y - f.y) < 8 * T);
        if (d < 16 * T && garrison.length) {
          const c = this.cavMicro(u, garrison, mine);
          if (c) return E(c.sig, c.cmd, 2, 15);
          const wt = { archer: 0, light: 1, sword: 2, shield: 4, spear: 3, lightCav: 2, heavyCav: 2 };
          const t = garrison.slice().sort((p, q) => (wt[p.kind] || 2) * 8 * T + this.dist(u, p) - ((wt[q.kind] || 2) * 8 * T + this.dist(u, q)))[0];
          if (u.order === 'attack' && u.target === t.id) return null;
          return E('atk' + t.id, { type: 'attack', id: u.id, target: t.id, intent: '剿守軍' }, 3, 20);
        }
        if (d < 4 * T && f.owner === this.me) return null;
        if (d < 3 * T) return null;
        if (u.order === 'move' && d > 4 * T && u.status === 'moving') return null;
        return E('raid' + f.id, this.mv(u, f.x, f.y, undefined, '奪旗'), 3, 40);
      }
      const c = this.cavMicro(u, en, mine);
      if (c) return E(c.sig, c.cmd, 2, 15);
      return this.goDefault(u, sx, sy, toSlot, cmds, E);
    }

    if (kind === 'sword') {
      if (nearAll.length && nearAll[0].g < 14 * T) {
        const t = nearAll[0];
        if (u.skillCooldown === 0 && t.g > 3 * T && t.g < 9 * T && !(t.e.kind === 'spear' && (t.e.status === 'braced' || t.e.status === 'bracing'))) {
          return E('assault' + t.e.id, { type: 'assault', id: u.id, target: t.e.id, intent: '突擊' }, 2, 15);
        }
        if (u.order !== 'attack' || u.target !== t.e.id) return E('atk' + t.e.id, { type: 'attack', id: u.id, target: t.e.id, intent: '攻擊' }, 4, 15);
        return null;
      }
      return this.goDefault(u, sx, sy, toSlot, cmds, E);
    }

    if (kind === 'light') {
      const arch = nearAll.find((n) => n.e.kind === 'archer');
      const t = arch || nearAll[0];
      if (t && t.g < 16 * T) {
        if (u.skillCooldown === 0 && t.g > 3 * T && t.g < 10 * T) {
          return E('inf' + t.e.id, { type: 'infiltrate', id: u.id, target: t.e.id, intent: '切入' }, 2, 15);
        }
        if (u.order !== 'attack' || u.target !== t.e.id) return E('atk' + t.e.id, { type: 'attack', id: u.id, target: t.e.id, intent: '攻擊' }, 4, 15);
        return null;
      }
      return this.goDefault(u, sx, sy, toSlot, cmds, E);
    }
    return null;
  }

  goDefault(u, sx, sy, toSlot, cmds, E) {
    if (this.advance) {
      const r = this.route();
      // 以前線中心（用自己所在最近的路線點）推進
      const wp = r[Math.min(this.wp, r.length - 1)];
      const wx = wp[0] * T, wy = wp[1] * T;
      if (Math.hypot(u.x - wx, u.y - wy) < 6 * T && this.wp < r.length - 1) this.wp++;
      if (u.order === 'attackMove' || u.order === 'attack') return null;
      return E('am' + this.wp, { type: 'attackMove', id: u.id, x: this.bx(wx), y: this.by(wy), intent: '推進' }, 6, 30);
    }
    if (toSlot > 2.5 * T && u.order !== 'move') {
      return E('mv' + sx + ',' + sy, this.mv(u, sx, sy, 0, '就位'), 7, 30);
    }
    return null;
  }

  cavMicro(u, en, mine, anchor) {
    if (u.skillCooldown > 0 || u.dashing) return null;
    if (u.terrain === 2 || u.terrain === 4) return null;
    let best = null;
    for (const e of en) {
      const d = this.dist(u, e);
      if (d < 7 * T || d > (this.mode === 'capture' ? 14 : 28) * T) continue;
      if (e.kind === 'spear' && (e.status === 'braced' || e.status === 'bracing')) continue;
      // 不限制衝鋒目標離旗的距離
      if (this.blocked(u, e)) continue;
      const w = { archer: 3, light: 2.5, sword: 1.5, lightCav: 1.2, heavyCav: 1, shield: 0.7, spear: 1 }[e.kind] || 1;
      const sc = w * e.men - d / T * 0.2;
      if (!best || sc > best.sc) best = { e, sc };
    }
    if (!best) return null;
    return { sig: 'chg' + best.e.id, cmd: { type: 'charge', id: u.id, target: best.e.id, x: this.bx(best.e.x), y: this.by(best.e.y), intent: '衝鋒' } };
  }

  // 直線上是否有擋騎兵衝鋒的地形
  blocked(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const n = Math.max(1, Math.floor(Math.hypot(dx, dy) / T));
    for (let k = 1; k < n; k++) {
      const t = this.ter(a.x + (dx * k) / n, a.y + (dy * k) / n);
      if (t === 2 || t === 4 || t === 5 || t === 7 || t === 8) return true;
    }
    return false;
  }
}
