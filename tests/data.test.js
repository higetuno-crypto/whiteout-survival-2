import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AREAS, FACILITIES, canUnlockArea, sanitizeUnlocked, areAreasAdjacent, RESOURCES, PRICES } from '../js/data.js';

test('エリアは7つ、先頭はcampでコストなし', () => {
  assert.equal(AREAS.length, 7);
  assert.equal(AREAS[0].id, 'camp');
  assert.deepEqual(AREAS[0].cost, {});
});

test('canUnlockArea: 支払い可能なら ok', () => {
  const r = canUnlockArea('lake', ['camp'], { money: 150, log: 0 });
  assert.equal(r.ok, true);
});

test('canUnlockArea: 資金不足なら不足分を返す', () => {
  const r = canUnlockArea('lake', ['camp'], { money: 30, log: 0 });
  // lakeのコストは💰65(オーナーFBで100→65に調整)
  assert.equal(r.ok, false);
  assert.equal(r.missing.money, 35);
});

test('canUnlockArea: 解錠済み・未知IDは ok=false', () => {
  assert.equal(canUnlockArea('camp', ['camp'], { money: 9999, log: 9999 }).ok, false);
  assert.equal(canUnlockArea('mars', ['camp'], { money: 9999, log: 9999 }).ok, false);
});

test('canUnlockArea: 複合コスト(金+丸太)の不足分', () => {
  const r = canUnlockArea('forest', ['camp'], { money: 250, log: 5 });
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, { log: 15 });
});

test('sanitizeUnlocked: 未知エリアを捨て、campを必ず含む(前方互換)', () => {
  assert.deepEqual(sanitizeUnlocked(['lake', 'oldArea9', 'camp']), ['camp', 'lake']);
  assert.deepEqual(sanitizeUnlocked([]), ['camp']);
});

test('sanitizeUnlocked: 非配列入力でもcampのみを返す', () => {
  assert.deepEqual(sanitizeUnlocked(undefined), ['camp']);
  assert.deepEqual(sanitizeUnlocked(null), ['camp']);
});

test('全施設は実在エリアに属し、丸太コストを持つ', () => {
  const ids = new Set(AREAS.map(a => a.id));
  for (const f of FACILITIES) {
    assert.ok(ids.has(f.areaId), f.id);
    assert.ok(f.costLogs > 0 || f.kind === 'unlockPad', f.id);
  }
});

test('隣接判定: campは lake/forest/hut/market と隣接、fishery とは非隣接', () => {
  const byId = Object.fromEntries(AREAS.map(a => [a.id, a]));
  assert.equal(areAreasAdjacent(byId.camp, byId.lake), true);
  assert.equal(areAreasAdjacent(byId.camp, byId.forest), true);
  assert.equal(areAreasAdjacent(byId.camp, byId.hut), true);
  assert.equal(areAreasAdjacent(byId.camp, byId.market), true);
  assert.equal(areAreasAdjacent(byId.camp, byId.fishery), false);
  assert.equal(areAreasAdjacent(byId.lake, byId.fishery), true);
});

test('価格表: 加工するほど高い', () => {
  assert.ok(PRICES.cookedFish > PRICES.rawFish);
  assert.ok(PRICES.plank > PRICES.log);
  assert.ok(PRICES.goods > PRICES.plank);
  assert.ok(RESOURCES.log.emoji.length > 0);
});

test('全エリアはcampから隣接経路で到達可能(解錠可能性の保証)', () => {
  const reached = new Set(['camp']);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of AREAS) {
      if (reached.has(a.id)) continue;
      if (AREAS.some(b => reached.has(b.id) && areAreasAdjacent(a, b))) { reached.add(a.id); grew = true; }
    }
  }
  assert.equal(reached.size, AREAS.length);
});
