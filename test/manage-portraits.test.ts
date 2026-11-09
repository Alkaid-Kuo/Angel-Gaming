// 選手立繪：開局依品階從同品階的池不重複發，同種子同結果；清單與網頁資源一致。
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runSeason } from '../src/manage/autoplayer.ts';
import { SHOOTER_CONTENT } from '../src/manage/content-shooter.ts';
import { STUB_CONTENT, type ContentPack } from '../src/manage/content.ts';
import { newGame } from '../src/manage/game.ts';
import { FakeGateway } from '../src/manage/gateway-fake.ts';
import { PORTRAITS } from '../src/manage/portraits.ts';
import { deserialize, serialize } from '../src/manage/save.ts';
import type { Rarity } from '../src/manage/types.ts';
import { knownView } from '../src/manage/view.ts';

const PACKS: readonly ContentPack[] = [STUB_CONTENT, SHOOTER_CONTENT];
const POOL: Readonly<Record<Rarity, number>> = { N: 48, R: 36, SR: 24, SSR: 12 };
const rarityOf = new Map(PORTRAITS.map((p) => [p.id, p.rarity]));

describe('立繪清單', () => {
  it('120 張、id 不重複、各品階張數照配額且男女各半', () => {
    expect(PORTRAITS).toHaveLength(120);
    expect(new Set(PORTRAITS.map((p) => p.id)).size).toBe(120);
    for (const [r, n] of Object.entries(POOL)) {
      const pool = PORTRAITS.filter((p) => p.rarity === r);
      expect(pool, r).toHaveLength(n);
      expect(pool.filter((p) => p.gender === 'f'), r).toHaveLength(n / 2);
      expect(pool.every((p) => p.id.startsWith(`${r}_`)), r).toBe(true);
    }
  });

  it('頭像中心與邊長在立繪範圍內（介面裁半身用）', () => {
    for (const p of PORTRAITS) {
      const [x, y, side] = p.face;
      expect(x, p.id).toBeGreaterThan(0.2);
      expect(x, p.id).toBeLessThan(0.8);
      expect(y, p.id).toBeGreaterThan(0.03);
      expect(y, p.id).toBeLessThan(0.3);
      expect(side, p.id).toBeGreaterThan(0.2);
      expect(side, p.id).toBeLessThan(0.45);
    }
  });

  it('每張都有網頁用的立繪與頭像', () => {
    for (const p of PORTRAITS) {
      expect(existsSync(`public/portraits/full/${p.id}.webp`), p.id).toBe(true);
      expect(existsSync(`public/portraits/avatars/${p.id}.webp`), p.id).toBe(true);
    }
  });
});

describe('開局分配', () => {
  it('200 個種子：同局不重複、立繪品階與選手品階一致、沒有品階抽到見底', () => {
    for (const pack of PACKS) {
      const peak: Record<Rarity, number> = { N: 0, R: 0, SR: 0, SSR: 0 };
      for (let seed = 1; seed <= 200; seed++) {
        const s = newGame(seed, pack);
        const ids = s.players.map((p) => p.portraitId);
        expect(new Set(ids).size, `${pack.id}/${seed}`).toBe(ids.length);
        const used: Record<Rarity, number> = { N: 0, R: 0, SR: 0, SSR: 0 };
        for (const p of s.players) {
          expect(rarityOf.get(p.portraitId), `${pack.id}/${seed}/${p.id}`).toBe(p.rarity);
          used[p.rarity]++;
        }
        for (const r of Object.keys(used) as Rarity[]) peak[r] = Math.max(peak[r], used[r]);
      }
      // 超發會在 newGame 直接報錯；快見底的品階抽籤時會被排除，所以最多剛好用完
      for (const r of Object.keys(peak) as Rarity[]) expect(peak[r], `${pack.id}/${r}`).toBeLessThanOrEqual(POOL[r]);
    }
  });

  it('品階抽到會超過立繪池的種子（射擊包 446、610、710，原抽法 SR 會到 25～27 人）：見底的品階不再抽，開局照常', () => {
    for (const seed of [446, 610, 710]) {
      const s = newGame(seed, SHOOTER_CONTENT);
      const sr = s.players.filter((p) => p.rarity === 'SR').length;
      expect(sr, String(seed)).toBe(POOL.SR);
      expect(new Set(s.players.map((p) => p.portraitId)).size).toBe(s.players.length);
      // 玩家起手指定的品階有留位，不會被前面的隨機抽籤搶光
      expect(s.players.filter((p) => p.teamId === s.humanTeamId).map((p) => p.rarity).sort()).toEqual([...SHOOTER_CONTENT.economy.humanStartRarities].sort());
    }
  });

  it('同一種子開局立繪相同；不同種子的發放順序不同', () => {
    for (const pack of PACKS) {
      const a = newGame(31, pack).players.map((p) => p.portraitId);
      expect(newGame(31, pack).players.map((p) => p.portraitId)).toEqual(a);
      expect(newGame(32, pack).players.map((p) => p.portraitId)).not.toEqual(a);
    }
  });

  it('序列化讀回與打完整季後立繪不變；已知層公開 portraitId', async () => {
    const s = newGame(9, SHOOTER_CONTENT);
    const before = s.players.map((p) => [p.id, p.portraitId]);
    expect(deserialize(serialize(s), SHOOTER_CONTENT).players.map((p) => [p.id, p.portraitId])).toEqual(before);
    const v = knownView(s, SHOOTER_CONTENT, s.humanTeamId);
    expect(v.players.map((p) => [p.id, p.portraitId])).toEqual(before);
    const stub = newGame(9, STUB_CONTENT);
    const fresh = stub.players.map((p) => [p.id, p.portraitId]);
    await runSeason(stub, STUB_CONTENT, new FakeGateway(STUB_CONTENT), null);
    expect(['ended', 'bankrupt']).toContain(stub.phase);
    // 季中補人（規格 4.14）只往後加新選手：開局那些人的立繪不變，全部人的立繪仍不重複
    expect(stub.players.slice(0, fresh.length).map((p) => [p.id, p.portraitId])).toEqual(fresh);
    expect(new Set(stub.players.map((p) => p.portraitId)).size).toBe(stub.players.length);
  });

  it('池不夠發時明確報錯，不重複也不卡住', () => {
    const e = SHOOTER_CONTENT.economy;
    const handles = Array.from({ length: 400 }, (_, i) => `Tester${i}`);
    const big: ContentPack = { ...SHOOTER_CONTENT, handles, economy: { ...e, freeAgentCount: 300 } };
    expect(() => newGame(1, big)).toThrow(/立繪已經發完/);
  });
});
