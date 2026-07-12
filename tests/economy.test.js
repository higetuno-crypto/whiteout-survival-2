import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Economy } from '../js/economy.js';

test('初期状態: 金0・資源0・容量はcapacity Lv0の値(10)', () => {
  const e = new Economy();
  assert.equal(e.money, 0);
  assert.equal(e.resources.log, 0);
  assert.equal(e.capacity(), 10);
});

test('add/takeは容量と在庫でクランプされる', () => {
  const e = new Economy();
  assert.equal(e.add('log', 99), 10);      // 容量10なので10だけ入る
  assert.equal(e.totalCarried(), 10);
  assert.equal(e.take('log', 3), 3);
  assert.equal(e.take('log', 99), 7);      // 残り7だけ取れる
});

test('sellPriceは大市場で1.5倍(端数切り上げ)', () => {
  const e = new Economy();
  assert.equal(e.sellPrice('rawFish'), 5);
  e.hasMarket = true;
  assert.equal(e.sellPrice('rawFish'), 8); // ceil(5*1.5)
});

test('アップグレード購入でレベルと容量が上がり、金が減る', () => {
  const e = new Economy();
  e.money = 100;
  assert.equal(e.upgradeCostOf('capacity'), 20);
  assert.equal(e.buyUpgrade('capacity'), true);
  assert.equal(e.money, 80);
  assert.equal(e.capacity(), 15);
  assert.equal(e.upgradeCostOf('capacity'), 34); // round(20*1.7)
  e.money = 0;
  assert.equal(e.buyUpgrade('capacity'), false); // 金欠で失敗
});

test('canAfford/pay: 複合コスト(金+丸太)', () => {
  const e = new Economy();
  e.money = 300; e.resources.log = 25;
  assert.equal(e.canAfford({ money: 250, log: 20 }), true);
  e.pay({ money: 250, log: 20 });
  assert.equal(e.money, 50);
  assert.equal(e.resources.log, 5);
  assert.equal(e.canAfford({ money: 100 }), false);
});

test('walletビューはmoneyと資源を合成する(canUnlockArea連携用)', () => {
  const e = new Economy();
  e.money = 7; e.resources.log = 2;
  assert.deepEqual(e.wallet().money, 7);
  assert.deepEqual(e.wallet().log, 2);
});
