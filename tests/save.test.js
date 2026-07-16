import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAVE_KEY, BACKUP_KEY, defaultSave, load, persist } from '../js/save.js';

// localStorage互換の最小シム
function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)),
           removeItem: k => m.delete(k), _m: m };
}

test('セーブなし → デフォルトで開始、corrupted=false', () => {
  const { save, corrupted } = load(memStorage());
  assert.equal(corrupted, false);
  assert.deepEqual(save, defaultSave());
});

test('persist → load の往復で一致', () => {
  const s = memStorage();
  const a = defaultSave();
  a.money = 123; a.unlockedAreas.push('lake'); a.buildProgress.fence_camp = 12;
  persist(s, a);
  assert.deepEqual(load(s).save, a);
});

test('旧セーブに新フィールドを補完(コード更新でセーブが消えない)', () => {
  const s = memStorage({ [SAVE_KEY]: JSON.stringify({ version: 1, money: 50 }) });
  const { save, corrupted } = load(s);
  assert.equal(corrupted, false);
  assert.equal(save.money, 50);
  assert.deepEqual(save.unlockedAreas, ['camp']);   // 欠損は補完
  assert.equal(save.resources.log, 0);
  assert.equal(save.upgrades.capacity, 0);
});

test('未知エリアIDは読込時に無視される(前方互換)', () => {
  const raw = { version: 1, unlockedAreas: ['camp', 'lake', 'deletedArea'] };
  const s = memStorage({ [SAVE_KEY]: JSON.stringify(raw) });
  assert.deepEqual(load(s).save.unlockedAreas, ['camp', 'lake']);
});

test('壊れたJSONは消さずBACKUP_KEYへ退避して新規開始', () => {
  const s = memStorage({ [SAVE_KEY]: '{broken!!' });
  const { save, corrupted } = load(s);
  assert.equal(corrupted, true);
  assert.deepEqual(save, defaultSave());
  assert.equal(s.getItem(BACKUP_KEY), '{broken!!');
});

test('型破損フィールドはデフォルトに矯正され起動可能(corrupted=falseのまま)', () => {
  const raw = { version: 1, money: 'abc', moneyTower: null, resources: { log: 'x' }, buildProgress: [1, 2] };
  const s = memStorage({ [SAVE_KEY]: JSON.stringify(raw) });
  const { save, corrupted } = load(s);
  assert.equal(corrupted, false);
  assert.equal(save.money, 0);
  assert.equal(save.moneyTower, 0);
  assert.equal(save.resources.log, 0);
  assert.deepEqual(save.buildProgress, {});
});

test('npcsの不正roleはフィルタされる', () => {
  const raw = { version: 1, npcs: [{ role: 'lumber' }, { role: 'hacker' }, null, { role: 'fisher' }] };
  const s = memStorage({ [SAVE_KEY]: JSON.stringify(raw) });
  assert.deepEqual(load(s).save.npcs, [{ role: 'lumber' }, { role: 'fisher' }]);
});

test('npcs/moneyTowerを含む往復', () => {
  const s = memStorage();
  const a = defaultSave();
  a.npcs.push({ role: 'fisher' }); a.moneyTower = 55;
  persist(s, a);
  assert.deepEqual(load(s).save, a);
});

test('fishHutStock/ranchFedの型サニタイズ + 往復(T15)', () => {
  const raw = { version: 1, fishHutStock: 'x', ranchFed: null };
  const s = memStorage({ [SAVE_KEY]: JSON.stringify(raw) });
  const { save, corrupted } = load(s);
  assert.equal(corrupted, false);
  assert.equal(save.fishHutStock, 0);
  assert.equal(save.ranchFed, 0);

  const s2 = memStorage();
  const a = defaultSave();
  a.fishHutStock = 7; a.ranchFed = 12;
  persist(s2, a);
  assert.deepEqual(load(s2).save, a);
});
