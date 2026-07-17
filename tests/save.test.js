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

test('farmStock/ranchFedの型サニタイズ + 往復(FB3。farmStockはfishHutStock後継)', () => {
  const raw = { version: 2, farmStock: 'x', ranchFed: null };
  const s = memStorage({ [SAVE_KEY]: JSON.stringify(raw) });
  const { save, corrupted } = load(s);
  assert.equal(corrupted, false);
  assert.equal(save.farmStock, 0);
  assert.equal(save.ranchFed, 0);

  const s2 = memStorage();
  const a = defaultSave();
  a.farmStock = 7; a.ranchFed = 12;
  persist(s2, a);
  assert.deepEqual(load(s2).save, a);
});

// ===== FB3: 新資源wheat・farmStock・新ロール・旧フィールド撤去 =====
test('defaultSave: wheat在庫・farmStockを持ち、depotAuto/fishHutStockは持たない', () => {
  const d = defaultSave();
  assert.equal(d.resources.wheat, 0);
  assert.equal(d.depotStored.wheat, 0);
  assert.equal(d.farmStock, 0);
  assert.equal(d.version, 2);
  assert.ok(!('depotAuto' in d), 'depotAutoは撤去');
  assert.ok(!('fishHutStock' in d), 'fishHutStockは撤去');
});

test('depotStoredはwheatを含む4種にサニタイズされる', () => {
  const raw = { version: 2, depotStored: { log: 5, rawFish: 'x', cookedFish: 3, wheat: null, junk: 9 } };
  const s = memStorage({ [SAVE_KEY]: JSON.stringify(raw) });
  const { save } = load(s);
  assert.deepEqual(save.depotStored, { log: 5, rawFish: 0, cookedFish: 3, wheat: 0 });
});

test('新ロール(farmer/cook/merchant)は往復し、不正ロールは除去', () => {
  const raw = { version: 2, npcs: [{ role: 'farmer' }, { role: 'cook' }, { role: 'merchant' }, { role: 'wizard' }, { role: 'lumber' }] };
  const s = memStorage({ [SAVE_KEY]: JSON.stringify(raw) });
  assert.deepEqual(load(s).save.npcs, [{ role: 'farmer' }, { role: 'cook' }, { role: 'merchant' }, { role: 'lumber' }]);
});

test('v1セーブ(depotAuto/fishHutStock付き)を壊さず読める(前方互換・撤去フィールドは無視)', () => {
  const raw = { version: 1, money: 200, depotAuto: { process: 300, sell: 100 }, fishHutStock: 8,
                depotStored: { log: 4, rawFish: 2, cookedFish: 1 } };
  const s = memStorage({ [SAVE_KEY]: JSON.stringify(raw) });
  const { save, corrupted } = load(s);
  assert.equal(corrupted, false);
  assert.equal(save.money, 200);
  assert.equal(save.version, 2);
  assert.ok(!('depotAuto' in save));
  assert.ok(!('fishHutStock' in save));
  assert.equal(save.depotStored.wheat, 0);      // 旧3種セーブにwheatが補完される
  assert.equal(save.depotStored.log, 4);
  assert.equal(save.farmStock, 0);
});

test('padPaidのサニタイズ: 未知エリア/型破損を捨て、数値を矯正(T16)', () => {
  const raw = { version: 1, padPaid: { lake: { money: 60, log: 'x' }, mars: { money: 5 }, forest: null } };
  const s = memStorage({ [SAVE_KEY]: JSON.stringify(raw) });
  const { save, corrupted } = load(s);
  assert.equal(corrupted, false);
  assert.deepEqual(save.padPaid, { lake: { money: 60, log: 0 } });
});

test('padPaidの往復(T16)', () => {
  const s = memStorage();
  const a = defaultSave();
  a.padPaid = { forest: { money: 100, log: 7 } };
  persist(s, a);
  assert.deepEqual(load(s).save, a);
});
