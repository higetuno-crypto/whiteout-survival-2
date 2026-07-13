// three非依存のDOM UI。HUDチップ(💰+携行資源)・アップグレードボタン・トースト。
// 要素は一度だけ生成し、update()は内部throttle(0.25秒)でtextContent/disabledのみ書き換える
// (毎フレームのDOM再構築禁止)。コンテナ(#hud/#upgrades/#toast)はindex.htmlに定義済み。
import { RESOURCES, UPGRADES } from './data.js';

const REFRESH_INTERVAL = 0.25; // HUD更新間隔(秒)。dtベースなので手動stepの検証でも決定的に動く

export class UI {
  constructor(eco, handlers = {}) {
    this.eco = eco;
    this.handlers = handlers;
    this._accum = 0;
    this._toastTimer = 0;

    // ---- HUD: 💰チップ + 携行資源チップ(RESOURCES順、所持0のkindは非表示) ----
    const hud = document.getElementById('hud');
    this.moneyChip = document.createElement('div');
    this.moneyChip.className = 'chip';
    hud.appendChild(this.moneyChip);
    this.resChips = {};
    for (const k of Object.keys(RESOURCES)) {
      const c = document.createElement('div');
      c.className = 'chip';
      c.style.display = 'none';
      hud.appendChild(c);
      this.resChips[k] = c;
    }

    // ---- アップグレードボタン(UPGRADES各キー。解放条件は後続タスク、今は常時表示) ----
    const up = document.getElementById('upgrades');
    this.upgButtons = {};
    for (const key of Object.keys(UPGRADES)) {
      const b = document.createElement('button');
      b.className = 'upg';
      b.style.background = 'linear-gradient(135deg,#4a9ede,#2a6ebe)';
      // 購入後はthrottleを待たず即リフレッシュ(残金・Lv・disabledを即反映)
      b.addEventListener('click', () => { this.handlers.onUpgrade?.(key); this._refresh(); });
      up.appendChild(b);
      this.upgButtons[key] = b;
    }

    this.toastEl = document.getElementById('toast');
    this._refresh(); // 初期表示(💰 0)
  }

  // #toast に表示して1.6秒でフェードアウト(opacity遷移はindex.htmlのCSSにある)
  toast(text) {
    this.toastEl.textContent = text;
    this.toastEl.style.opacity = '1';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.toastEl.style.opacity = '0'; }, 1600);
  }

  // 毎フレーム呼ばれるが、内部で0.25秒ごとに間引く
  update(dt = 1 / 60) {
    this._accum += dt;
    if (this._accum < REFRESH_INTERVAL) return;
    this._accum = 0;
    this._refresh();
  }

  _refresh() {
    const eco = this.eco;
    this.moneyChip.textContent = `💰 ${eco.money}`;
    for (const [k, def] of Object.entries(RESOURCES)) {
      const n = eco.resources[k] ?? 0;
      const c = this.resChips[k];
      if (n <= 0) { c.style.display = 'none'; continue; }
      c.style.display = '';
      c.textContent = `${def.emoji} ${n}`;
    }
    for (const [key, def] of Object.entries(UPGRADES)) {
      const b = this.upgButtons[key];
      const cost = eco.upgradeCostOf(key);
      b.textContent = `${def.emoji} ${def.name} Lv${eco.upgrades[key]}  💰${cost}`;
      b.disabled = eco.money < cost;
    }
  }
}
