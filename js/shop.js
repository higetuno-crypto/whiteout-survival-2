// 売店(shop_camp)の自動売却サブシステム + マネータワー(未回収金の見た目)。
// T9でmain.jsのクロージャに入っていた売却ロジック一式(moneyTower/tower/sellFlights/sellPool
// + 関数3つ)をShopSystemクラスへ抽出。売却/回収ロジックはT9から不変(札束枚数の式のみceilに調整)。
//
// 責務分離:
//   ShopSystem  — 未回収金(真実)の管理・売却tick・回収判定・売却フライト。T14でNPCも deposit() で入金。
//   MoneyTower  — 売店脇に積まれた未回収金の「見た目」(札束スタック + 回収フライト)。
import * as THREE from 'three';
import { lambert } from './render.js';
import { createKindMesh } from './entities.js';
import { ProximityAction } from './proximity.js';
import { sfx } from './sfx.js';

// 売却対象の優先順。丸太は建材なので最後(高価な物から売り、丸太は他に売る物が無いときだけ)。
// 丸太を末尾に入れているのは序盤の資金源のため: 最初の収入(湖解錠の💰65)は丸太売りで稼ぐ設計。
// wheat(小麦)は加工不要で直接売れる作物(FB1)。cookedFishの次に置く。
const SELL_ORDER = ['rawFish', 'cookedFish', 'wheat', 'plank', 'goods', 'log'];

/* ================= マネータワー(売店脇の未回収金スタック) =================
 * 内部金額(真実)は ShopSystem.moneyTower が持つ。このクラスは「見た目」だけを管理する:
 * 10金=1枚の札束を最大20枚積み、超過は頭上の「💰N」スプライトで表現(StackCarrierのカウンタと同方式)。
 * 回収時は札束が1枚ずつ0.05秒間隔でプレイヤーへ吸い込まれる(順次フライト)。メッシュはプール再利用。
 */
const BILL_GEO = new THREE.BoxGeometry(0.7, 0.12, 0.42);
const BILL_SIDE = lambert(0x4caf50);
const BILL_TOP = lambert(0x7ddc82); // 上面明るめ
// BoxGeometryの面順: +x,-x,+y(上),-y,+z,-z
const BILL_MATS = [BILL_SIDE, BILL_SIDE, BILL_TOP, BILL_SIDE, BILL_SIDE, BILL_SIDE];
const BILL_STEP = 0.13;   // 札束1枚ぶんの段差
const BILL_CAP = 20;      // 表示上限(超過は💰Nスプライト)
const YEN_PER_BILL = 10;  // 10金=1枚

export class MoneyTower {
  constructor(scene, x, z) {
    this.scene = scene;
    this.x = x;
    this.z = z;
    this.group = new THREE.Group();
    this.group.position.set(x, 0, z);
    scene.add(this.group);
    this.bills = [];    // 積まれた札束メッシュ(下から順)
    this.pool = [];
    this.flights = [];  // 回収フライト {mesh, from, t, delay}
    this._lastAmount = -1;

    // 💰Nオーバーフロースプライト(金額が変わったフレームだけ再描画)
    this._canvas = document.createElement('canvas');
    this._canvas.width = 256;
    this._canvas.height = 64;
    this._ctx = this._canvas.getContext('2d');
    this._tex = new THREE.CanvasTexture(this._canvas);
    const sm = new THREE.SpriteMaterial({ map: this._tex, transparent: true, depthTest: false });
    this.sprite = new THREE.Sprite(sm);
    this.sprite.scale.set(2.4, 0.6, 1);
    this.sprite.position.set(0, BILL_CAP * BILL_STEP + 0.6, 0);
    this.sprite.renderOrder = 6;
    this.sprite.visible = false;
    this.group.add(this.sprite);
  }

  // 金額に合わせて札束数を再構築(変化したフレームだけ)。Math.ceil(n/10) 枚(10金=1枚、n=0で0枚)
  setAmount(n) {
    if (n === this._lastAmount) return;
    this._lastAmount = n;
    const count = n <= 0 ? 0 : Math.min(BILL_CAP, Math.ceil(n / YEN_PER_BILL));
    while (this.bills.length > count) {
      const m = this.bills.pop();
      this.group.remove(m);
      this.pool.push(m);
    }
    while (this.bills.length < count) {
      const m = this.pool.pop() ?? new THREE.Mesh(BILL_GEO, BILL_MATS);
      const i = this.bills.length;
      m.position.set(0, 0.06 + i * BILL_STEP, 0);
      m.rotation.y = (i % 2) * 0.35 + Math.sin(i * 12.9898) * 0.08; // 雑に積まれた札束感
      m.scale.setScalar(1);
      this.group.add(m);
      this.bills.push(m);
    }
    const overflow = n > 0 && Math.ceil(n / YEN_PER_BILL) > BILL_CAP;
    this.sprite.visible = overflow;
    if (overflow) this._drawText(`💰${n}`);
  }

  _drawText(text) {
    const ctx = this._ctx, c = this._canvas;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';
    ctx.strokeText(text, c.width / 2, c.height / 2);
    ctx.fillText(text, c.width / 2, c.height / 2);
    this._tex.needsUpdate = true;
  }

  // 回収: 現在の札束を上から順に0.05秒間隔のフライトへ移す(金額の加算は呼び出し側で即時に済ませる)
  collect() {
    let delay = 0;
    for (let i = this.bills.length - 1; i >= 0; i--) {
      const mesh = this.bills[i];
      mesh.updateWorldMatrix(true, false);
      const wp = new THREE.Vector3();
      mesh.getWorldPosition(wp);
      this.group.remove(mesh);
      mesh.position.copy(wp);
      this.scene.add(mesh);
      this.flights.push({ mesh, from: wp.clone(), t: 0, delay });
      delay += 0.05;
    }
    this.bills.length = 0;
  }

  // targetPos = プレイヤーの吸い込み先ワールド座標(毎フレームの現在値を渡す=追尾する)
  update(dt, targetPos) {
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      if (f.delay > 0) { f.delay -= dt; continue; }
      f.t += dt / 0.3;
      const p = Math.min(1, f.t);
      const e = p * p * (3 - 2 * p);
      f.mesh.position.lerpVectors(f.from, targetPos, e);
      f.mesh.scale.setScalar(1 - 0.6 * e); // 吸い込まれ縮小
      if (p >= 1) {
        this.scene.remove(f.mesh);
        f.mesh.scale.setScalar(1);
        this.pool.push(f.mesh);
        this.flights.splice(i, 1);
        sfx.coin();                  // 札束がプレイヤーに届いた瞬間(連続でピッチ上昇。G5)
      }
    }
  }
}

/* ================= 売店の自動売却サブシステム =================
 * 売店(shop_camp)完成後、半径2.5m内に立つと0.12秒ごとに1個売却。
 * 売却対象は rawFish→cookedFish→plank→goods の優先順(丸太は建材なので売らない)。
 * 売値は売却時点の sellPrice で確定し moneyTower(未回収金)に積む。
 * タワー半径1.8m内で全額回収(HUDは即時、見た目は札束が1枚ずつ吸い込まれる)。 */
export class ShopSystem {
  constructor(scene, eco) {
    this.scene = scene;
    this.eco = eco;
    this.moneyTower = 0;    // 未回収金(真実)。T10でセーブに接続
    this.tower = null;      // MoneyTower(見た目)。attachShop で生成
    this.site = null;       // 接続済み売店 BuildSite
    this.sell = new ProximityAction({ radius: 2.5, startDelay: 0, interval: 0.12, requireStill: false });
    this.sellFlights = [];  // {mesh, from, to, t, kind} 売却品の売店への小フライト
    this.sellPool = Object.fromEntries(SELL_ORDER.map(k => [k, []]));
    this._towerTarget = new THREE.Vector3();
  }

  get attached() { return this.site !== null; }

  // shop_camp完成時に売店siteと接続(タワー位置=site脇 site.x + 2(ワールド座標))。復元済みの金額を見た目へ即反映。
  attachShop(site) {
    if (this.site) return;
    this.site = site;
    this.tower = new MoneyTower(this.scene, site.x + 2, site.z);
    this.tower.setAmount(this.moneyTower);
  }

  // 売上を未回収金に加算(T14でNPCが売却したぶんを積む入口)
  deposit(amount) { this.moneyTower += amount; }

  _launchSellFlight(kind, from, to) {
    const mesh = this.sellPool[kind].pop() ?? createKindMesh(kind);
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.sellFlights.push({ mesh, from: from.clone(), to: to.clone(), t: 0, kind });
  }

  _updateSellFlights(dt) {
    // T8納品と同じ放物線(0.38秒・smoothstep)。到着で消滅(プールへ)
    for (let i = this.sellFlights.length - 1; i >= 0; i--) {
      const f = this.sellFlights[i];
      f.t += dt / 0.38;
      const p = Math.min(1, f.t);
      const e = p * p * (3 - 2 * p);
      f.mesh.position.lerpVectors(f.from, f.to, e);
      f.mesh.position.y += 1.6 * 4 * e * (1 - e);
      if (p >= 1) {
        this.scene.remove(f.mesh);
        this.sellPool[f.kind].push(f.mesh);
        this.sellFlights.splice(i, 1);
        sfx.pop(f.to.x, f.to.z);     // 売却品が売店に届いたポコッ(G5)
      }
    }
  }

  // 毎フレーム。売却tick + 回収判定 + タワー/フライト更新。接続前は何もしない。
  update(dt, playerPos, carrier) {
    const shop = this.site;
    if (!shop) return;
    const eco = this.eco;
    const p = playerPos;
    // 売却tick
    const dist = Math.hypot(p.x - shop.x, p.z - shop.z);
    const hasSellable = SELL_ORDER.some(k => (eco.resources[k] ?? 0) > 0);
    const ticks = this.sell.update(dist <= this.sell.radius && hasSellable, true, dt);
    for (let i = 0; i < ticks; i++) {
      const kind = SELL_ORDER.find(k => (eco.resources[k] ?? 0) > 0);
      if (!kind || eco.take(kind, 1) <= 0) break;
      this.moneyTower += eco.sellPrice(kind);   // 財布に直接入れず未回収金へ(売却時点の価格で確定)
      const from = carrier.popVisualOf(kind) ?? new THREE.Vector3(p.x, 1.7, p.z);
      this._launchSellFlight(kind, from, new THREE.Vector3(shop.x, 1.1, shop.z));
    }
    // 回収(HUDのmoneyは即時全額、見た目だけ順次飛ぶ)
    if (this.moneyTower > 0 && Math.hypot(p.x - this.tower.x, p.z - this.tower.z) <= 1.8) {
      eco.money += this.moneyTower;
      this.moneyTower = 0;
      this.tower.collect();
    }
    this.tower.setAmount(this.moneyTower);
    this.tower.update(dt, this._towerTarget.set(p.x, 1.2, p.z));
    this._updateSellFlights(dt);
  }

  serialize() { return this.moneyTower; }

  // 金額セット + タワー見た目再構築(アニメなし)。接続前(tower未生成)は金額のみ保持し、
  // attachShop 時の setAmount で見た目が復元される。
  restore(n) {
    this.moneyTower = n;
    if (this.tower) this.tower.setAmount(n);
  }
}
