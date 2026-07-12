// three非依存。プレイヤーの財布・背中の資源(内部カウント)・売買・アップグレード状態。
import { RESOURCES, PRICES, MARKET_MULT, UPGRADES, upgradeCost, upgradeValue } from './data.js';

export class Economy {
  constructor() {
    this.money = 0;
    this.resources = Object.fromEntries(Object.keys(RESOURCES).map(k => [k, 0]));
    this.upgrades = Object.fromEntries(Object.keys(UPGRADES).map(k => [k, 0]));
    this.hasMarket = false;
  }
  capacity() { return upgradeValue('capacity', this.upgrades.capacity); }
  speed() { return upgradeValue('speed', this.upgrades.speed); }
  npcCapacity() { return upgradeValue('npcCap', this.upgrades.npcCap); }
  totalCarried() { return Object.values(this.resources).reduce((a, b) => a + b, 0); }
  add(kind, n) {
    const room = Math.max(0, this.capacity() - this.totalCarried());
    const got = Math.min(room, n);
    this.resources[kind] += got;
    return got;
  }
  take(kind, n) {
    const got = Math.min(this.resources[kind], n);
    this.resources[kind] -= got;
    return got;
  }
  sellPrice(kind) { return this.hasMarket ? Math.ceil(PRICES[kind] * MARKET_MULT) : PRICES[kind]; }
  upgradeCostOf(key) { return upgradeCost(key, this.upgrades[key]); }
  buyUpgrade(key) {
    const c = this.upgradeCostOf(key);
    if (this.money < c) return false;
    this.money -= c;
    this.upgrades[key]++;
    return true;
  }
  wallet() { return Object.assign({ money: this.money }, this.resources); }
  canAfford(cost) {
    return Object.entries(cost).every(([k, v]) => (this.wallet()[k] ?? 0) >= v);
  }
  pay(cost) {
    for (const [k, v] of Object.entries(cost)) {
      if (k === 'money') this.money -= v; else this.resources[k] -= v;
    }
  }
}
