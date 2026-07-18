// three非依存のDOM UI。HUDチップ(💰+携行資源)・アップグレードボタン・トースト。
// 要素は一度だけ生成し、update()は内部throttle(0.25秒)でtextContent/disabledのみ書き換える
// (毎フレームのDOM再構築禁止)。コンテナ(#hud/#upgrades/#toast)はindex.htmlに定義済み。
import { RESOURCES, UPGRADES, NPC_ROLE_INFO } from './data.js';

const REFRESH_INTERVAL = 0.25; // HUD更新間隔(秒)。dtベースなので手動stepの検証でも決定的に動く

// 雇用ダイアログの役割ボタンの配色(表示名/絵文字は NPC_ROLE_INFO を共有)。
const ROLE_BG = {
  lumber:   'linear-gradient(135deg,#6bbf59,#3a8a2f)',
  fisher:   'linear-gradient(135deg,#4a9ede,#2a6ebe)',
  farmer:   'linear-gradient(135deg,#d9a838,#a87a1c)',
  cook:     'linear-gradient(135deg,#ef7043,#c0392b)',
  merchant: 'linear-gradient(135deg,#9b6bd0,#6f3fae)',
};

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

    // ---- ☰ メニュー(左上): 💾セーブ / 🗑️リセット。誤タップ防止のため折りたたみ+リセットは確認付き ----
    this._buildMenu();

    this.toastEl = document.getElementById('toast');

    // ---- 目標ヒント(画面下中央。目標ガイドの矢印とセットで「次にやること」を言葉でも示す) ----
    this.hintEl = document.createElement('div');
    this.hintEl.id = 'hint';
    this.hintEl.style.cssText = 'position:fixed;bottom:14px;left:50%;transform:translateX(-50%);' +
      'background:rgba(30,45,70,0.72);color:#fff;padding:8px 18px;border-radius:18px;' +
      'font-weight:bold;font-size:14px;pointer-events:none;transition:opacity 0.3s;opacity:0;' +
      'white-space:nowrap;z-index:10';
    document.body.appendChild(this.hintEl);
    this._hintText = '';

    this._refresh(); // 初期表示(💰 0)
  }

  // ☰ 左上メニュー: 折りたたみ式で 💾セーブ / 🗑️リセット を格納(誤タップ防止+視認性向上)。
  // ボタン/メニューは pointerdown を止めてジョイスティック(body の pointerdown)を動かさない。
  _buildMenu() {
    const stop = e => e.stopPropagation();
    // ハンバーガーボタン
    const btn = document.createElement('button');
    btn.textContent = '☰';
    btn.setAttribute('aria-label', 'メニュー');
    btn.style.cssText = 'position:fixed;top:12px;left:12px;z-index:31;width:46px;height:46px;border:none;' +
      'border-radius:12px;background:rgba(60,66,80,.82);color:#fff;font-size:24px;line-height:1;cursor:pointer;' +
      'display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    btn.addEventListener('pointerdown', stop);
    btn.addEventListener('click', e => { stop(e); this._toggleMenu(); });
    document.body.appendChild(btn);
    // ドロップダウン(初期は非表示)
    const panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;top:66px;left:12px;z-index:31;display:none;flex-direction:column;gap:8px';
    panel.addEventListener('pointerdown', stop);
    const mkItem = (label, bg, onClick) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = `padding:11px 18px;min-width:150px;text-align:left;font-size:15px;font-weight:700;border:none;` +
        `border-radius:12px;color:#fff;cursor:pointer;background:${bg};box-shadow:0 2px 8px rgba(0,0,0,.3)`;
      b.addEventListener('click', e => { stop(e); this._closeMenu(); onClick(); });
      return b;
    };
    panel.appendChild(mkItem('💾 セーブ', 'linear-gradient(135deg,#5aa0d8,#2f6fae)', () => this.handlers.onSave?.()));
    panel.appendChild(mkItem('🗑️ リセット', 'linear-gradient(135deg,#e07a5a,#c0392b)', () => {
      this.showConfirm('本当にリセットしてよろしいですか？', () => this.handlers.onReset?.(),
        { yesLabel: 'リセットする', danger: true });
    }));
    document.body.appendChild(panel);
    this._menuBtn = btn;
    this._menuPanel = panel;
    this._menuOpen = false;
    // メニュー外をタップしたら閉じる(キャプチャ段階で拾い、開いている時だけ)
    document.addEventListener('pointerdown', () => { if (this._menuOpen) this._closeMenu(); });
  }

  _toggleMenu() { this._menuOpen ? this._closeMenu() : this._openMenu(); }
  _openMenu() { this._menuOpen = true; this._menuPanel.style.display = 'flex'; this._menuBtn.textContent = '✕'; }
  _closeMenu() { this._menuOpen = false; this._menuPanel.style.display = 'none'; this._menuBtn.textContent = '☰'; }

  // 汎用の確認ダイアログ(はい/いいえ)。onConfirm は「はい」で呼ぶ。破壊的操作は danger=赤。
  showConfirm(message, onConfirm, { yesLabel = 'はい', noLabel = 'やめる', danger = false } = {}) {
    if (this._confirmEl) return; // 二重表示防止
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:50;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.4)';
    backdrop.addEventListener('pointerdown', e => e.stopPropagation());
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:18px;padding:22px 24px;display:flex;flex-direction:column;gap:14px;min-width:260px;max-width:86vw;box-shadow:0 8px 30px rgba(0,0,0,.4);text-align:center';
    const msg = document.createElement('div');
    msg.textContent = message;
    msg.style.cssText = 'font-weight:800;font-size:17px;color:#243244;line-height:1.5';
    box.appendChild(msg);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:10px;justify-content:center';
    const close = () => { if (this._confirmEl) { this._confirmEl.remove(); this._confirmEl = null; } };
    const no = document.createElement('button');
    no.textContent = noLabel;
    no.style.cssText = 'flex:1;padding:12px 16px;font-size:15px;font-weight:700;border:none;border-radius:12px;color:#333;background:#e2e2e2;cursor:pointer';
    no.addEventListener('click', close);
    const yes = document.createElement('button');
    yes.textContent = yesLabel;
    yes.style.cssText = `flex:1;padding:12px 16px;font-size:15px;font-weight:700;border:none;border-radius:12px;color:#fff;cursor:pointer;background:${danger ? 'linear-gradient(135deg,#e0533a,#b5291b)' : 'linear-gradient(135deg,#4a9ede,#2a6ebe)'}`;
    yes.addEventListener('click', () => { close(); onConfirm(); });
    row.appendChild(no);
    row.appendChild(yes);
    box.appendChild(row);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    this._confirmEl = backdrop;
  }

  // 目標ヒントの文言を更新(同文はスキップ。空文字で非表示)
  setHint(text) {
    if (text === this._hintText) return;
    this._hintText = text;
    if (text) this.hintEl.textContent = text;
    this.hintEl.style.opacity = text ? '1' : '0';
  }

  // ==== 雇用ダイアログ(仲間の小屋の雇用パッドで1秒静止したときに表示) ====
  // 画面中央の軽いDOM。ゲームはポーズしない(toastと同様)。役割選択で onPick(role) を呼ぶ。
  get hireOpen() { return !!this._hireEl; }

  // roles = 現在雇える役割IDの配列(main.js が設備の完成状況で決める。FB3で2→最大5種に動的化)。
  showHireDialog(cost, roles, onPick) {
    if (this._hireEl) return; // 二重表示防止
    const backdrop = document.createElement('div');
    backdrop.style.cssText = 'position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.35)';
    backdrop.addEventListener('pointerdown', e => e.stopPropagation()); // ダイアログ操作でジョイスティックを動かさない
    const box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:18px;padding:20px 24px;display:flex;flex-direction:column;gap:10px;min-width:240px;max-height:82vh;overflow-y:auto;box-shadow:0 8px 30px rgba(0,0,0,.4);text-align:center';
    const title = document.createElement('div');
    title.textContent = `仲間を雇う(💰${cost})`;
    title.style.cssText = 'font-weight:900;font-size:18px;color:#243244';
    box.appendChild(title);
    const mkBtn = (role) => {
      const info = NPC_ROLE_INFO[role];
      const b = document.createElement('button');
      b.textContent = `${info.emoji} ${info.name}`;
      b.style.cssText = `padding:12px 16px;font-size:16px;font-weight:700;border:none;border-radius:12px;color:#fff;cursor:pointer;background:${ROLE_BG[role] ?? '#888'}`;
      b.addEventListener('click', () => { this._closeHire(); onPick(role); });
      return b;
    };
    for (const role of roles) box.appendChild(mkBtn(role));
    const cancel = document.createElement('button');
    cancel.textContent = 'やめる';
    cancel.style.cssText = 'padding:8px 16px;font-size:14px;font-weight:700;border:none;border-radius:12px;color:#333;background:#ddd;cursor:pointer';
    cancel.addEventListener('click', () => this._closeHire());
    box.appendChild(cancel);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    this._hireEl = backdrop;
  }

  _closeHire() {
    if (this._hireEl) { this._hireEl.remove(); this._hireEl = null; }
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
    // 金が増えたらチップを跳ねさせる(数字が跳ねる感覚。G5)。class再付与でアニメを再発火
    if (eco.money > (this._lastMoney ?? eco.money)) {
      this.moneyChip.classList.remove('punch');
      void this.moneyChip.offsetWidth;
      this.moneyChip.classList.add('punch');
    }
    this._lastMoney = eco.money;
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
