// 建設予定地(白点線枠)への丸太納品と完成メッシュの出現。動画再現の核。
// 各施設: 白点線枠 → 背中の丸太を1本ずつ放物線納品 → 進捗 → 完成メッシュ出現。
// 移植元: reference/proto-a.html 396-410行(launchLog)・535-554行(フライト)・583-587行(easeOutBack)
//        158-175行(柵+mergeGeos) / 244-248行(スロット積み)
import * as THREE from 'three';
import { lambert, mergeGeos, roundedRectShape } from './render.js';
import { FACILITIES, AREAS, RESOURCES } from './data.js';
import { createKindMesh } from './entities.js';

// 納品フライト/建設中スタック用の丸太(X軸に寝かせた円柱)。モジュールで1回だけ生成して共有。
const FLIGHT_LOG_GEO = new THREE.CylinderGeometry(0.16, 0.16, 1.8, 9).rotateZ(Math.PI / 2);
const FLIGHT_LOG_SIDE = lambert(0xb0703c);
const FLIGHT_LOG_CAP = lambert(0xf3dfae);
const FLIGHT_LOG_MATS = [FLIGHT_LOG_SIDE, FLIGHT_LOG_CAP, FLIGHT_LOG_CAP];
const LOG_STEP = 0.31;       // 井桁スタックの段差(1段あたりの高さ)
// 単列タワー(bigmarket40本=12m)だと高すぎるため、proto-aのdepotSlotLocal風に
// 1段LOGS_PER_ROW本×行に広げるピラミッド積みへ変更(40本でも高さ約3m)。
const LOGS_PER_ROW = 4;      // 1段に並べる丸太の本数
const ROW_SPACING = 0.5;     // 同一段内の丸太間隔(木口が重ならない程度)
const CRIB_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)); // 奇数段の直交

// easeOutBack(0→1)。proto-a 583-587行と同じ係数(BuildSite内で完成演出/goods出現の2箇所から使う)
function easeOutBack(p) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}

// 調理フライト(T13): 生魚→焚き火→焼き魚。色/形はentities.jsのcreateKindMeshから複製して取得
// (entities.js非改変。RAW_FISH_MAT/COOKED_FISH_MATは非exportのため、生成物から色だけ拝借する)。
const _cookRawProto = createKindMesh('rawFish');
const _cookCookedProto = createKindMesh('cookedFish');
const COOK_FISH_GEO = _cookRawProto.geometry;              // rawFish/cookedFishは同一ジオメトリ
const COOK_FISH_SCALE = _cookRawProto.scale.clone();       // 扁平球のスケール(rawFish/cookedFish共通)
const COOK_RAW_COLOR = _cookRawProto.material.color.clone();
const COOK_COOKED_COLOR = _cookCookedProto.material.color.clone();
const COOK_OUT_DUR = 0.35;    // 背中→焚き火の放物線フライト
const COOK_SIZZLE_DUR = 0.3;  // 焚き火上でジュージュー(色変化+煙)
const COOK_BACK_DUR = 0.35;   // 焚き火→背中の放物線フライト(戻り)
const SMOKE_GEO = new THREE.SphereGeometry(0.07, 6, 5);
const SMOKE_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true });

// 白点線枠: 0.5m間隔で 0.28×0.06×0.1 の白Box を w×d 矩形の外周に並べた Group を返す(シェーダ不要)
export function dashedRect(w, d) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
  const geo = new THREE.BoxGeometry(0.28, 0.06, 0.1);
  const hw = w / 2, hd = d / 2, y = 0.06, step = 0.5;
  const nx = Math.max(1, Math.round(w / step));
  for (let i = 0; i <= nx; i++) {
    const x = -hw + w * (i / nx);
    for (const z of [-hd, hd]) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      g.add(m);
    }
  }
  const nz = Math.max(1, Math.round(d / step));
  for (let i = 0; i <= nz; i++) {
    const z = -hd + d * (i / nz);
    for (const x of [-hw, hw]) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.y = Math.PI / 2; // 長辺をz方向へ
      g.add(m);
    }
  }
  return g;
}

export class BuildSite {
  constructor(scene, facility, area) {
    this.scene = scene;
    this.f = facility;
    this.area = area;
    this.x = area.cx + facility.lx;
    this.z = area.cz + facility.lz;
    this.progress = 0;        // 納品済み丸太数(T10で永続化)
    this.completed = false;
    this.flights = [];        // {mesh, from, to, fromQ, toQ, t}
    this.buildLogs = [];      // 着地した「建設中の井桁スタック」(sceneの子)
    this.completedMesh = null;
    this.completeAnim = null; // {t} easeOutBack
    this.extra = {};          // campfire: {fire, light} / ranchPen: {penguins}
    this._fireTime = 0;
    this.cookFlights = [];    // 調理フライト(T13): {mesh, phase, t, from, fire, back, puffs}
    this.cooking = false;     // 調理中フラグ(main.jsがProximityAction.activeを毎フレーム反映。炎ブースト用)

    // T15: sawmill(製材所)の加工フライト。生資源→加工台→(木くずパフ)→加工品、をT13cookFlightsから一般化。
    this.craftFlights = [];   // {mesh, phase, t, from, station, back, puffs, outKind}
    // T15: 単純な放物線1本フライト(fishHutストック回収・ranchPen給餌の共通実装)
    this.itemFlights = [];    // {mesh, from, to, t, dur, height}

    // T15: fishHut(釣り小屋)の内部ストック(0..10、セーブ対象=main.jsのfishHutStock)。
    this.stock = 0;
    this._stockTimer = 0;        // 4秒毎の自動生産アキュムレータ
    this._stockMeshes = [];      // 表示中の魚メッシュ(最大5)
    this._stockPool = [];
    this._stockSprite = null;    // 「🐟N」オーバーフロースプライト(6以上で生成)
    this._stockCanvas = null; this._stockCtx = null; this._stockTex = null;
    this._stockLastShown = -1;
    this.stockAnchor = new THREE.Vector3(this.x + 2, 0.3, this.z); // 小屋脇のストック置き場

    // T15: ranchPen(牧場)の給餌カウント(セーブ対象=main.jsのranchFed)とペン脇の未回収goods。
    this.fed = 0;
    this.pendingGoods = 0;       // 未回収goods個数(最大5。セーブ対象外=リロードで消える表示のみの状態)
    this._goodsMeshes = [];
    this.goodsAnims = [];        // {mesh, t} easeOutBackで出現
    this.goodsAnchor = new THREE.Vector3(this.x + 2.2, 0.3, this.z); // ペン脇のgoods置き場

    // 納品タイマーはサイト側ではなく「配達者(deliverer)」側が持つ(BuildManager.serveDeliverer)。
    // プレイヤーとNPCが各自のペースで最寄り未完成サイトに納品できるようにするための分離(T14)。

    this.outline = dashedRect(4, 4);
    this.outline.position.set(this.x, 0, this.z);
    scene.add(this.outline);

    // 頭上の進捗スプライト「🪵 3/10」(StackCarrierのカウンタと同方式)
    this._canvas = document.createElement('canvas');
    this._canvas.width = 256;
    this._canvas.height = 64;
    this._ctx = this._canvas.getContext('2d');
    this._tex = new THREE.CanvasTexture(this._canvas);
    const sm = new THREE.SpriteMaterial({ map: this._tex, transparent: true, depthTest: false });
    this.progSprite = new THREE.Sprite(sm);
    this.progSprite.scale.set(2.4, 0.6, 1);
    this.progSprite.position.set(this.x, 2.4, this.z);
    this.progSprite.renderOrder = 6;
    scene.add(this.progSprite);
    this._drawProgress();
  }

  // 井桁スタック i 本目のワールド座標。LOGS_PER_ROW本ごとに1段登り、段内は予定地中心を軸に
  // 横へ広げる(proto-aのdepotSlotLocal風ピラミッド積み。単列タワーだと高さが出過ぎるため変更)。
  _slot(i) {
    const row = Math.floor(i / LOGS_PER_ROW);
    const posInRow = i % LOGS_PER_ROW;
    const offset = (posInRow - (LOGS_PER_ROW - 1) / 2) * ROW_SPACING;
    const y = 0.2 + row * LOG_STEP;
    return (row % 2 === 0)
      ? new THREE.Vector3(this.x, y, this.z + offset)
      : new THREE.Vector3(this.x + offset, y, this.z);
  }

  // i本目の向き(段の偶奇で90度交互=交互直交)
  _slotQuat(i) {
    const row = Math.floor(i / LOGS_PER_ROW);
    return row % 2 === 1 ? CRIB_Q.clone() : new THREE.Quaternion();
  }

  _drawProgress() {
    const ctx = this._ctx, c = this._canvas;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';
    const txt = `${RESOURCES.log.emoji} ${this.progress}/${this.f.costLogs}`;
    ctx.strokeText(txt, c.width / 2, c.height / 2);
    ctx.fillText(txt, c.width / 2, c.height / 2);
    this._tex.needsUpdate = true;
  }

  // プレイヤー(or NPC)が丸太を持って半径内にいるとき 0.1秒ごとに1本呼ばれる。
  // fromWorld: 発射元ワールド座標(StackCarrier.popVisual() の戻り値)
  deliverOne(fromWorld) {
    const mesh = new THREE.Mesh(FLIGHT_LOG_GEO, FLIGHT_LOG_MATS);
    mesh.position.copy(fromWorld);
    this.scene.add(mesh);
    const i = this.progress;
    this.flights.push({
      mesh,
      from: fromWorld.clone(),
      to: this._slot(i),
      fromQ: mesh.quaternion.clone(),
      toQ: this._slotQuat(i),
      t: 0,
    });
    this.progress++;
    this._drawProgress();
  }

  // 調理(T13): 生魚1匹ぶんの演出を開始する(内部カウントの変換はmain.js側でtick時に即時確定済み。
  // ここは見た目のみ)。fromWorld=発射元(背中, StackCarrier.popVisualOfの戻り値)。
  // backTarget=戻り先(呼び出し時点のプレイヤー背中付近。フライト中の追尾はしない=他フライトと同じ簡略化)。
  cookFish(fromWorld, backTarget) {
    const mat = lambert(COOK_RAW_COLOR.getHex());
    const mesh = new THREE.Mesh(COOK_FISH_GEO, mat);
    mesh.scale.copy(COOK_FISH_SCALE);
    mesh.position.copy(fromWorld);
    this.scene.add(mesh);
    this.cookFlights.push({
      mesh,
      phase: 'out',   // 'out' → 'sizzle' → 'back'
      t: 0,
      from: fromWorld.clone(),
      fire: new THREE.Vector3(this.x, 0.95, this.z),
      back: backTarget.clone(),
      puffs: null,
    });
  }

  // 白い煙/木くずパフ2個を生成(白・半透明。加工の間だけゆっくり上昇+フェード)。
  // T13の調理(ジュージュー)とT15の製材(木くず)で共用する(見た目は同じ白いパフでよい)。
  _spawnSmokePuffs(pos) {
    const mat = SMOKE_MAT.clone();
    const meshes = [];
    for (let k = 0; k < 2; k++) {
      const sm = new THREE.Mesh(SMOKE_GEO, mat);
      sm.position.set(pos.x + (k === 0 ? -0.12 : 0.12), pos.y + 0.15, pos.z);
      this.scene.add(sm);
      meshes.push(sm);
    }
    return { meshes, mat };
  }

  // T15製材(sawmill): 生資源1個ぶんの加工演出を開始する(T13cookFishの一般化。内部カウントの
  // 変換はmain.js側でtick時に即時確定済み。ここは見た目のみ)。fromWorld=発射元(背中)。
  // backTarget=戻り先(呼び出し時点のプレイヤー背中付近)。inKind/outKindは資源kind文字列。
  craftItem(fromWorld, backTarget, inKind, outKind) {
    const mesh = createKindMesh(inKind);
    mesh.position.copy(fromWorld);
    this.scene.add(mesh);
    this.craftFlights.push({
      mesh,
      phase: 'out',   // 'out' → 'process' → 'back'
      t: 0,
      from: fromWorld.clone(),
      station: new THREE.Vector3(this.x, 0.95, this.z),
      back: backTarget.clone(),
      puffs: null,
      outKind,
    });
  }

  // T15: 発射元(fromWorld)からtargetへの単純な放物線1本フライト(fishHutストック回収・
  // ranchPen給餌の共通実装)。kind=表示メッシュの資源種。
  spawnItemFlight(kind, fromWorld, target, dur = 0.35, height = 1.6) {
    const mesh = createKindMesh(kind);
    mesh.position.copy(fromWorld);
    this.scene.add(mesh);
    this.itemFlights.push({ mesh, from: fromWorld.clone(), to: target.clone(), t: 0, dur, height });
  }

  /* ============== T15 fishHut: 内部ストック(0..10)の表示(moneyTowerと同方式) ============== */
  _ensureStockSprite() {
    if (this._stockSprite) return;
    this._stockCanvas = document.createElement('canvas');
    this._stockCanvas.width = 256;
    this._stockCanvas.height = 64;
    this._stockCtx = this._stockCanvas.getContext('2d');
    this._stockTex = new THREE.CanvasTexture(this._stockCanvas);
    const sm = new THREE.SpriteMaterial({ map: this._stockTex, transparent: true, depthTest: false });
    this._stockSprite = new THREE.Sprite(sm);
    this._stockSprite.scale.set(1.6, 0.5, 1);
    this._stockSprite.position.set(this.stockAnchor.x, 1.15, this.stockAnchor.z);
    this._stockSprite.renderOrder = 6;
    this._stockSprite.visible = false;
    this.scene.add(this._stockSprite);
  }

  // n=this.stock の現在値を表示へ反映(変化時のみ再構築。表示上限5+「🐟N」オーバーフロー表示)
  setStockVisual(n) {
    if (n === this._stockLastShown) return;
    this._stockLastShown = n;
    const cap = 5;
    const shown = Math.min(cap, n);
    while (this._stockMeshes.length > shown) {
      const m = this._stockMeshes.pop();
      this.scene.remove(m);
      this._stockPool.push(m);
    }
    while (this._stockMeshes.length < shown) {
      const i = this._stockMeshes.length;
      const m = this._stockPool.pop() ?? createKindMesh('rawFish');
      m.position.set(this.stockAnchor.x + (i - 2) * 0.28, this.stockAnchor.y, this.stockAnchor.z + (i % 2) * 0.2);
      m.rotation.y = i * 0.9;
      this.scene.add(m);
      this._stockMeshes.push(m);
    }
    const overflow = n > cap;
    if (overflow) this._ensureStockSprite();
    if (this._stockSprite) {
      this._stockSprite.visible = overflow;
      if (overflow) this._drawStockText(`${RESOURCES.rawFish.emoji}${n}`);
    }
  }

  _drawStockText(text) {
    const ctx = this._stockCtx, c = this._stockCanvas;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';
    ctx.strokeText(text, c.width / 2, c.height / 2);
    ctx.fillText(text, c.width / 2, c.height / 2);
    this._stockTex.needsUpdate = true;
  }

  // セーブ復元。this.stockは常に保持し、完成済みなら表示も即反映する(main.jsが起動時に1回呼ぶ)。
  restoreStock(n) {
    this.stock = Math.max(0, Math.min(10, Math.trunc(n) || 0));
    if (this.completed) this.setStockVisual(this.stock);
  }

  /* ============== T15 ranchPen: 給餌→3匹ごとにgoods1個(最大5未回収) ============== */
  // fromWorld=発射元(背中)。kind='rawFish'|'cookedFish'。給餌数を進め、3の倍数でgoods1個を出現させる。
  feedOne(fromWorld, kind) {
    this.spawnItemFlight(kind, fromWorld, new THREE.Vector3(this.x, 0.5, this.z));
    this.fed++;
    if (this.fed % 3 === 0 && this.pendingGoods < 5) this._spawnGoods();
  }

  _spawnGoods() {
    const mesh = createKindMesh('goods');
    const i = this.pendingGoods;
    mesh.position.set(this.goodsAnchor.x + (i - 2) * 0.4, this.goodsAnchor.y, this.goodsAnchor.z);
    mesh.scale.setScalar(0.001);
    this.scene.add(mesh);
    this._goodsMeshes.push(mesh);
    this.goodsAnims.push({ mesh, t: 0 });
    this.pendingGoods++;
  }

  // 未回収goodsを1個外す(先頭=最初に出現した1個)。main.jsが近接判定後にeco.add成功時だけ呼ぶ。
  popGoods() {
    const mesh = this._goodsMeshes.shift();
    if (!mesh) return false;
    this.scene.remove(mesh);
    const idx = this.goodsAnims.findIndex(a => a.mesh === mesh);
    if (idx !== -1) this.goodsAnims.splice(idx, 1);
    this.pendingGoods--;
    for (let j = 0; j < this._goodsMeshes.length; j++) {
      this._goodsMeshes[j].position.x = this.goodsAnchor.x + (j - 2) * 0.4;
    }
    return true;
  }

  // セーブ復元(給餌数のみ。未回収goodsの見た目は再現しない=リロードで消える簡略仕様)
  restoreFed(n) {
    this.fed = Math.max(0, Math.trunc(n) || 0);
  }

  update(dt) {
    // 放物線フライト(proto-a 535-554行: 0.38秒・smoothstep・放物線高さ2.1*4*e*(1-e)・slerp)
    for (let i = this.flights.length - 1; i >= 0; i--) {
      const f = this.flights[i];
      f.t += dt / 0.38;
      const p = Math.min(1, f.t);
      const e = p * p * (3 - 2 * p);
      f.mesh.position.lerpVectors(f.from, f.to, e);
      f.mesh.position.y += 2.1 * 4 * e * (1 - e);
      f.mesh.quaternion.slerpQuaternions(f.fromQ, f.toQ, e);
      if (p >= 1) {
        f.mesh.position.copy(f.to);
        f.mesh.quaternion.copy(f.toQ);
        this.buildLogs.push(f.mesh); // 着地した丸太は建設中スタックとして残す
        this.flights.splice(i, 1);
      }
    }

    // 完成: 全数納品済み & フライトが空
    if (!this.completed && this.progress >= this.f.costLogs && this.flights.length === 0) {
      this._complete();
    }

    // 完成メッシュ出現(proto-a 583-587行 easeOutBack)
    if (this.completeAnim) {
      this.completeAnim.t += dt;
      const p = Math.min(1, this.completeAnim.t / 0.4);
      this.completedMesh.scale.setScalar(Math.max(0.001, easeOutBack(p)));
      if (p >= 1) { this.completedMesh.scale.setScalar(1); this.completeAnim = null; }
    }

    // 調理フライト(T13): 生魚→焚き火(0.35s放物線)→ジュージュー(0.3s。色変化+煙2個)→焼き魚→背中(0.35s放物線)。
    // 内部カウントはtick時点(main.js)で確定済みなので、ここで完了を待たずとも数の真実は既に合っている。
    for (let i = this.cookFlights.length - 1; i >= 0; i--) {
      const f = this.cookFlights[i];
      f.t += dt;
      if (f.phase === 'out') {
        const p = Math.min(1, f.t / COOK_OUT_DUR);
        const e = p * p * (3 - 2 * p);
        f.mesh.position.lerpVectors(f.from, f.fire, e);
        f.mesh.position.y += 1.4 * 4 * e * (1 - e);
        if (p >= 1) {
          f.mesh.position.copy(f.fire);
          f.phase = 'sizzle';
          f.t = 0;
          f.puffs = this._spawnSmokePuffs(f.fire);
        }
      } else if (f.phase === 'sizzle') {
        const p = Math.min(1, f.t / COOK_SIZZLE_DUR);
        f.mesh.material.color.lerpColors(COOK_RAW_COLOR, COOK_COOKED_COLOR, p);
        if (f.puffs) {
          for (const sm of f.puffs.meshes) sm.position.y += 0.6 * dt;
          f.puffs.mat.opacity = 1 - p;
        }
        if (p >= 1) {
          f.mesh.material.color.copy(COOK_COOKED_COLOR);
          if (f.puffs) {
            for (const sm of f.puffs.meshes) this.scene.remove(sm);
            f.puffs.mat.dispose();
            f.puffs = null;
          }
          f.phase = 'back';
          f.t = 0;
        }
      } else { // 'back'
        const p = Math.min(1, f.t / COOK_BACK_DUR);
        const e = p * p * (3 - 2 * p);
        f.mesh.position.lerpVectors(f.fire, f.back, e);
        f.mesh.position.y += 1.4 * 4 * e * (1 - e);
        if (p >= 1) {
          this.scene.remove(f.mesh);
          f.mesh.material.dispose();
          this.cookFlights.splice(i, 1);
        }
      }
    }

    // campfire の炎ゆらぎ + 光の明滅(調理中はmain.jsがthis.cookingを立て、炎を1.3倍に強める)
    if (this.extra.fire) {
      this._fireTime += dt;
      let sy = 1 + 0.15 * Math.sin(this._fireTime * 12) + 0.08 * Math.sin(this._fireTime * 27);
      if (this.cooking) sy *= 1.3;
      this.extra.fire.scale.set(1, sy, 1);
      if (this.extra.light) this.extra.light.intensity = 0.8 + 0.25 * Math.sin(this._fireTime * 15);
    }

    // T15製材(sawmill): 生資源→加工台(0.35s放物線)→木くずパフ(0.3s)→加工品→背中(0.35s放物線)。
    // T13cookFlightsとの違い: 色lerpではなくジオメトリごと差し替える(丸太と板材は別形状のため)。
    for (let i = this.craftFlights.length - 1; i >= 0; i--) {
      const f = this.craftFlights[i];
      f.t += dt;
      if (f.phase === 'out') {
        const p = Math.min(1, f.t / COOK_OUT_DUR);
        const e = p * p * (3 - 2 * p);
        f.mesh.position.lerpVectors(f.from, f.station, e);
        f.mesh.position.y += 1.4 * 4 * e * (1 - e);
        if (p >= 1) {
          f.mesh.position.copy(f.station);
          f.phase = 'process';
          f.t = 0;
          f.puffs = this._spawnSmokePuffs(f.station);
        }
      } else if (f.phase === 'process') {
        const p = Math.min(1, f.t / COOK_SIZZLE_DUR);
        if (f.puffs) {
          for (const sm of f.puffs.meshes) sm.position.y += 0.6 * dt;
          f.puffs.mat.opacity = 1 - p;
        }
        if (p >= 1) {
          if (f.puffs) {
            for (const sm of f.puffs.meshes) this.scene.remove(sm);
            f.puffs.mat.dispose();
            f.puffs = null;
          }
          // 見た目を加工品メッシュへ差し替え(共有の資源メッシュ=disposeしない。scene.removeのみでプールへは戻さない簡略実装)
          this.scene.remove(f.mesh);
          f.mesh = createKindMesh(f.outKind);
          f.mesh.position.copy(f.station);
          this.scene.add(f.mesh);
          f.phase = 'back';
          f.t = 0;
        }
      } else { // 'back'
        const p = Math.min(1, f.t / COOK_BACK_DUR);
        const e = p * p * (3 - 2 * p);
        f.mesh.position.lerpVectors(f.station, f.back, e);
        f.mesh.position.y += 1.4 * 4 * e * (1 - e);
        if (p >= 1) {
          this.scene.remove(f.mesh);
          this.craftFlights.splice(i, 1);
        }
      }
    }

    // T15: 単純な放物線1本フライト(fishHutストック回収・ranchPen給餌)
    for (let i = this.itemFlights.length - 1; i >= 0; i--) {
      const f = this.itemFlights[i];
      f.t += dt / f.dur;
      const p = Math.min(1, f.t);
      const e = p * p * (3 - 2 * p);
      f.mesh.position.lerpVectors(f.from, f.to, e);
      f.mesh.position.y += f.height * 4 * e * (1 - e);
      if (p >= 1) {
        this.scene.remove(f.mesh);
        this.itemFlights.splice(i, 1);
      }
    }

    // T15 fishHut: 完成後、4秒毎に内部ストック+1(上限10。プレイヤー近接に関係なく自動生産)
    if (this.f.kind === 'fishHut' && this.completed) {
      this._stockTimer += dt;
      while (this._stockTimer >= 4) {
        this._stockTimer -= 4;
        if (this.stock < 10) this.stock++;
      }
      this.setStockVisual(this.stock);
    }

    // T15 ranchPen: 未回収goodsの出現アニメ(completeAnimと同じeaseOutBackヘルパーを共用)
    for (let i = this.goodsAnims.length - 1; i >= 0; i--) {
      const a = this.goodsAnims[i];
      a.t += dt;
      const p = Math.min(1, a.t / 0.35);
      a.mesh.scale.setScalar(Math.max(0.001, easeOutBack(p)));
      if (p >= 1) { a.mesh.scale.setScalar(1); this.goodsAnims.splice(i, 1); }
    }

    // T15 ranchPen: ペンギン2羽がゆっくりうろつく(泳ぐ魚=world.jsのlakeFishと同じ円運動)
    if (this.extra.penguins) {
      for (const pg of this.extra.penguins) {
        pg.theta += pg.speed * dt;
        pg.mesh.position.set(Math.cos(pg.theta) * pg.radius, 0, Math.sin(pg.theta) * pg.radius);
        const vx = -Math.sin(pg.theta), vz = Math.cos(pg.theta);
        pg.mesh.rotation.y = Math.atan2(vx, vz);
      }
    }
  }

  _complete() {
    this.completed = true;
    // 飛行中/建設中の丸太と点線枠・進捗表示を消す
    for (const f of this.flights) this.scene.remove(f.mesh);
    this.flights.length = 0;
    for (const m of this.buildLogs) this.scene.remove(m);
    this.buildLogs.length = 0;
    if (this.outline.parent) this.outline.parent.remove(this.outline);
    // outlineのgeo/matはdashedRect()呼び出しごとに専有生成される(site固有。全子メッシュが同一インスタンスを共有)。
    // 他サイトや共有のFLIGHT_LOG_*には触れない。
    const outlineChild = this.outline.children[0];
    if (outlineChild) { outlineChild.geometry.dispose(); outlineChild.material.dispose(); }
    if (this.progSprite.parent) this.progSprite.parent.remove(this.progSprite);
    this._tex.dispose();
    this.progSprite.material.dispose();
    // 完成メッシュを easeOutBack で出現
    const mesh = this._buildMesh();
    mesh.position.set(this.x, 0, this.z);
    mesh.scale.setScalar(0.001);
    this.completedMesh = mesh;
    this.scene.add(mesh);
    this.completeAnim = { t: 0 };
  }

  // アニメなしで即完成状態にする(チート/セーブ復元用)
  forceComplete() {
    if (this.completed) return;
    this.progress = this.f.costLogs;
    this._complete();
    this.completedMesh.scale.setScalar(1);
    this.completeAnim = null;
    this._fireTime = 0;
  }

  // 進捗 n を復元(セーブ読込時)。n>=costLogs なら即完成、それ未満なら井桁スタックを静的に再現。
  restore(n) {
    if (n >= this.f.costLogs) { this.forceComplete(); return; }
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(FLIGHT_LOG_GEO, FLIGHT_LOG_MATS);
      mesh.position.copy(this._slot(i));
      mesh.quaternion.copy(this._slotQuat(i));
      this.scene.add(mesh);
      this.buildLogs.push(mesh);
    }
    this.progress = n;
    this._drawProgress();
  }

  _buildMesh() {
    switch (this.f.kind) {
      case 'fence':    return this._fenceMesh();
      case 'shop':     return this._shopMesh();
      case 'campfire': return this._campfireMesh();
      case 'bridge':   return this._bridgeMesh();
      case 'sawmill':  return this._sawmillMesh();
      case 'fishHut':  return this._fishHutMesh();
      case 'ranchPen': return this._ranchPenMesh();
      case 'market':   return this._marketMesh();
      default:         return this._signMesh();
    }
  }

  // 丸太の桟橋。camp と lake の間の雪原ギャップ(ワールド z -16〜-10 付近)を渡す。
  // 横倒し丸太(円柱をZ回転して軸をXへ=デッキ幅2.2)をz方向に0.3間隔で並べ、両脇に低い縁木。
  // 側面と木口で色を分けるため、fence と同様に「側面(開端円柱)」と「木口(円)」の2メッシュに結合。
  _bridgeMesh() {
    const g = new THREE.Group();
    const sides = [], caps = [];
    const halfW = 1.1, r = 0.14;                 // デッキ半幅(丸太長2.2)・半径
    const zFrom = -3, zTo = 3, step = 0.3;       // ローカルz範囲(サイト z=-14 基準 → ワールド -17..-11)
    for (let z = zFrom; z <= zTo + 1e-6; z += step) {
      sides.push(new THREE.CylinderGeometry(r, r, halfW * 2, 8, 1, true).rotateZ(Math.PI / 2).translate(0, r, z));
      caps.push(new THREE.CircleGeometry(r, 8).rotateY(Math.PI / 2).translate(halfW, r, z));   // +X端
      caps.push(new THREE.CircleGeometry(r, 8).rotateY(-Math.PI / 2).translate(-halfW, r, z)); // -X端
    }
    // 両脇の低い縁木(Z方向に走る細い丸太。閉じた円柱=側面材で結合)
    const railR = 0.1, railLen = (zTo - zFrom) + 0.6;
    for (const sx of [-1, 1]) {
      sides.push(new THREE.CylinderGeometry(railR, railR, railLen, 7).rotateX(Math.PI / 2).translate(sx * halfW, r + 0.16, 0));
    }
    g.add(new THREE.Mesh(mergeGeos(sides), lambert(0xb0703c)));   // 側面
    g.add(new THREE.Mesh(mergeGeos(caps), lambert(0xf3dfae)));    // 木口
    return g;
  }

  // エリア外周の丸太柵(proto-a 158-175行を area の角丸矩形で。mergeGeosで2メッシュに結合)
  // 4辺の中点はゲート開口部として支柱を置かない(オーナーFB: 柵に意味を持たせる+ドア)。
  _fenceMesh() {
    const g = new THREE.Group();
    const { hw, hd } = this.area;
    const gates = [[-hw, 0], [hw, 0], [0, -hd], [0, hd]]; // エリアローカルのゲート中心
    const GATE_HALF = 1.7;
    const shape = roundedRectShape(hw, hd, 2.5);
    const N = 82;
    const pts = shape.getSpacedPoints(N); // 末尾は先頭と同一なので N 本ぶんだけ使う
    const sides = [], caps = [];
    for (let i = 0; i < N; i++) {
      const x = pts[i].x, z = -pts[i].y;
      if (gates.some(([gx, gz]) => Math.hypot(x - gx, z - gz) < GATE_HALF)) continue; // 開口部
      const h = 1.72 + Math.sin(i * 12.9898) * Math.sin(i * 78.233) * 0.18 + 0.14;
      const r = 0.40 + Math.abs(Math.sin(i * 4.7)) * 0.045;
      sides.push(new THREE.CylinderGeometry(r, r, h, 9, 1, true).translate(x, h / 2 - 0.12, z));
      caps.push(new THREE.CircleGeometry(r, 9).rotateX(-Math.PI / 2).translate(x, h - 0.12, z));
    }
    g.add(new THREE.Mesh(mergeGeos(sides), lambert(0xc49a6c)));
    g.add(new THREE.Mesh(mergeGeos(caps), lambert(0xf5e6c0)));
    return g;
  }

  // 屋台(Box土台 + 4本柱 + コーン屋根、茶+赤)
  _shopMesh() {
    const g = new THREE.Group();
    const wood = lambert(0x9c6b3f);
    const red = lambert(0xc0392b);
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1, 1.2), wood);
    base.position.y = 0.5;
    g.add(base);
    const postGeo = new THREE.CylinderGeometry(0.08, 0.08, 1.4, 6);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const p = new THREE.Mesh(postGeo, wood);
      p.position.set(sx * 0.8, 1.7, sz * 0.5);
      g.add(p);
    }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.5, 0.8, 4), red);
    roof.position.y = 2.8;
    roof.rotation.y = Math.PI / 4;
    g.add(roof);
    return g;
  }

  // 焚き火(石リング + 交差する薪 + 炎コーン + PointLight)
  _campfireMesh() {
    const g = new THREE.Group();
    const stoneGeo = new THREE.SphereGeometry(0.22, 8, 6);
    const stoneMat = lambert(0x8a8f96);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const s = new THREE.Mesh(stoneGeo, stoneMat);
      s.position.set(Math.cos(a) * 0.7, 0.18, Math.sin(a) * 0.7);
      g.add(s);
    }
    const logMat = lambert(0x7a4a26);
    const logGeo = new THREE.CylinderGeometry(0.1, 0.1, 1.2, 7);
    const w1 = new THREE.Mesh(logGeo, logMat);
    w1.rotation.z = Math.PI / 2; w1.rotation.y = 0.3; w1.position.y = 0.18;
    const w2 = new THREE.Mesh(logGeo, logMat);
    w2.rotation.z = Math.PI / 2; w2.rotation.y = -0.9; w2.position.y = 0.28;
    g.add(w1, w2);
    const fire = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 8), new THREE.MeshBasicMaterial({ color: 0xff8c33 }));
    fire.position.y = 0.7;
    g.add(fire);
    this.extra.fire = fire;
    const light = new THREE.PointLight(0xff8844, 0.8, 6);
    light.position.y = 0.9;
    g.add(light);
    this.extra.light = light;
    return g;
  }

  // T15製材所: 屋根なし作業台(Box+4脚) + 丸鋸盤(モーター箱+円盤刃)、茶系
  _sawmillMesh() {
    const g = new THREE.Group();
    const wood = lambert(0x9c6b3f);
    const dark = lambert(0x6e4c30);
    const blade = lambert(0xb8bec6);
    const table = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.16, 1.6), wood);
    table.position.y = 0.75;
    g.add(table);
    const legGeo = new THREE.BoxGeometry(0.14, 0.75, 0.14);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, dark);
      leg.position.set(sx * 1.15, 0.375, sz * 0.65);
      g.add(leg);
    }
    const motor = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.7), dark);
    motor.position.set(-0.6, 1.08, 0);
    g.add(motor);
    const sawBlade = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.06, 16), blade);
    sawBlade.rotation.z = Math.PI / 2; // 刃を縦(YZ平面)に立てる
    sawBlade.position.set(0.05, 1.05, 0);
    g.add(sawBlade);
    return g;
  }

  // T15釣り小屋: 小屋(箱+四角錐屋根+ドア) + 脇の魚網ポール2本+網パネル
  _fishHutMesh() {
    const g = new THREE.Group();
    const wall = lambert(0xd8b56a);
    const roofMat = lambert(0x6e4c30);
    const doorMat = lambert(0x4a3220);
    const poleMat = lambert(0x8a5a33);
    const netMat = lambert(0xcac4b0, { transparent: true, opacity: 0.85 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 1.8), wall);
    body.position.y = 0.7;
    g.add(body);

    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.7, 0.9, 4), roofMat);
    roof.position.y = 1.85;
    roof.rotation.y = Math.PI / 4;
    g.add(roof);

    const door = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.08), doorMat);
    door.position.set(0, 0.45, 0.94);
    g.add(door);

    const poleGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6);
    const p1 = new THREE.Mesh(poleGeo, poleMat); p1.position.set(1.7, 0.8, 0.9);
    const p2 = new THREE.Mesh(poleGeo, poleMat); p2.position.set(1.7, 0.8, -0.9);
    g.add(p1, p2);
    const net = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.1), netMat);
    net.position.set(1.7, 0.9, 0);
    net.rotation.y = Math.PI / 2;
    g.add(net);

    return g;
  }

  // 2頭身のミニペンギン(黒/白+オレンジのくちばし)。ranchPenのペンの中をうろつく。
  _makePenguin() {
    const g = new THREE.Group();
    const black = lambert(0x1c1c22);
    const white = lambert(0xf4f4f2);
    const orange = lambert(0xe8912a);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), black);
    body.scale.set(0.85, 1.15, 0.85);
    body.position.y = 0.24;
    g.add(body);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), white);
    belly.scale.set(0.8, 1.0, 0.6);
    belly.position.set(0, 0.2, 0.13);
    g.add(belly);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), black);
    head.position.y = 0.46;
    g.add(head);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 6), orange);
    beak.rotation.x = Math.PI / 2;
    beak.position.set(0, 0.45, 0.15);
    g.add(beak);
    return g;
  }

  // T15牧場: 低い丸太柵の小型囲い + ペンギン2羽(円運動でうろつく。this.extra.penguinsに保持しupdateで動かす)
  _ranchPenMesh() {
    const g = new THREE.Group();
    const shape = roundedRectShape(1.8, 1.8, 0.5);
    // N=20だと支柱が疎らで遠目に建設中の白い点線枠(dashedRect)と見紛う。密度を上げて連続した柵に見せる。
    const N = 34;
    const pts = shape.getSpacedPoints(N);
    const sides = [], caps = [];
    for (let i = 0; i < N; i++) {
      const x = pts[i].x, z = -pts[i].y;
      const h = 0.55, r = 0.1;
      sides.push(new THREE.CylinderGeometry(r, r, h, 7, 1, true).translate(x, h / 2, z));
      caps.push(new THREE.CircleGeometry(r, 7).rotateX(-Math.PI / 2).translate(x, h, z));
    }
    g.add(new THREE.Mesh(mergeGeos(sides), lambert(0xc49a6c)));
    g.add(new THREE.Mesh(mergeGeos(caps), lambert(0xf5e6c0)));

    const penguins = [];
    for (let i = 0; i < 2; i++) {
      const mesh = this._makePenguin();
      g.add(mesh);
      penguins.push({ mesh, theta: (i / 2) * Math.PI * 2, radius: 0.7 + i * 0.3, speed: 0.5 + i * 0.15 });
    }
    this.extra.penguins = penguins;
    return g;
  }

  // T15大市場: 屋台(shopメッシュ)を1.5倍スケール + 旗竿+旗
  _marketMesh() {
    const g = this._shopMesh();
    g.scale.setScalar(1.5);
    const poleMat = lambert(0x6e4c30);
    const flagMat = lambert(0xc0392b, { side: THREE.DoubleSide });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 6), poleMat);
    pole.position.set(0, 3.7, 0);
    g.add(pole);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.4), flagMat);
    flag.position.set(0.32, 4.15, 0);
    g.add(flag);
    return g;
  }

  // 暫定の木看板(後続タスクで各kindの本命メッシュに置き換え)
  _signMesh() {
    const g = new THREE.Group();
    const wood = lambert(0x9c6b3f);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.8, 6), wood);
    post.position.y = 0.9;
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 0.12), lambert(0xcaa472));
    board.position.y = 1.7;
    g.add(post, board);
    return g;
  }
}

export class BuildManager {
  constructor(scene, world, eco) {
    this.scene = scene;
    this.world = world;
    this.eco = eco;
    this.sites = new Map(); // facilityId -> BuildSite
  }

  spawnSitesForArea(areaId, buildProgress = {}) {
    const area = AREAS.find(a => a.id === areaId);
    if (!area) return;
    for (const f of FACILITIES) {
      if (f.areaId !== areaId || this.sites.has(f.id)) continue;
      const site = new BuildSite(this.scene, f, area);
      const n = buildProgress[f.id];
      if (typeof n === 'number' && n > 0) site.restore(n);
      this.sites.set(f.id, site);
    }
  }

  // pos に最も近い「未完成(納品途中)」サイトを返す。radius 内に無ければ null。
  // radius 省略時は距離無制限(NPCが遠くの納品先へ向かうナビ目標の取得に使う)。
  nearestIncompleteSite(pos, radius = Infinity) {
    let best = null, bd = radius;
    for (const site of this.sites.values()) {
      if (site.completed || site.progress >= site.f.costLogs) continue; // 完成/納品済みは対象外
      const d = Math.hypot(pos.x - site.x, pos.z - site.z);
      if (d <= bd) { bd = d; best = site; }
    }
    return best;
  }

  // 配達者1体ぶんの納品tick。deliverer = { pos, deliver(ProximityAction), takeLog():0|1, popLogVisual():Vector3|null }。
  // 最寄りの未完成サイト(deliver.radius内)に対し、配達者自身のタイマーで0本以上納品する。
  // プレイヤー(main.jsアダプタ)とNPC(npc.js)が同じ実装を共有する。
  serveDeliverer(dt, d) {
    const site = this.nearestIncompleteSite(d.pos, d.deliver.radius);
    const ticks = d.deliver.update(!!site, true, dt);
    if (!site) return;
    for (let i = 0; i < ticks; i++) {
      if (site.progress >= site.f.costLogs) break;
      if (d.takeLog() <= 0) break;                      // 在庫切れ(内部数の真実は配達者側)
      const pos = d.popLogVisual();                     // 丸太指定で見た目を外す(混載時に魚を消さない)→座標取得
      site.deliverOne(pos ?? new THREE.Vector3(d.pos.x, 1.7, d.pos.z));
    }
  }

  // deliverers = 配達者の配列(プレイヤー + 任意のNPC)。各自の納品tick後、全サイトを更新する。
  update(dt, deliverers) {
    for (const d of deliverers) this.serveDeliverer(dt, d);
    for (const site of this.sites.values()) site.update(dt);
  }

  serialize() {
    const out = {};
    for (const [id, site] of this.sites) out[id] = site.progress;
    return out;
  }
}
