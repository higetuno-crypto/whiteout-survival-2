// 建設予定地(白点線枠)への丸太納品と完成メッシュの出現。動画再現の核。
// 各施設: 白点線枠 → 背中の丸太を1本ずつ放物線納品 → 進捗 → 完成メッシュ出現。
// 移植元: reference/proto-a.html 396-410行(launchLog)・535-554行(フライト)・583-587行(easeOutBack)
//        158-175行(柵+mergeGeos) / 244-248行(スロット積み)
import * as THREE from 'three';
import { lambert, mergeGeos, roundedRectShape } from './render.js';
import { FACILITIES, AREAS, RESOURCES } from './data.js';
import { ProximityAction } from './proximity.js';

// 納品フライト/建設中スタック用の丸太(X軸に寝かせた円柱)。モジュールで1回だけ生成して共有。
const FLIGHT_LOG_GEO = new THREE.CylinderGeometry(0.16, 0.16, 1.8, 9).rotateZ(Math.PI / 2);
const FLIGHT_LOG_SIDE = lambert(0xb0703c);
const FLIGHT_LOG_CAP = lambert(0xf3dfae);
const FLIGHT_LOG_MATS = [FLIGHT_LOG_SIDE, FLIGHT_LOG_CAP, FLIGHT_LOG_CAP];
const LOG_STEP = 0.31;       // 井桁スタックの段差
const CRIB_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)); // 奇数段の直交

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
    this.extra = {};          // campfire: {fire, light}
    this._fireTime = 0;

    // 納品ステートマシン(近接で0.1秒ごとに1本)。伐採と同じ ProximityAction を再利用。
    this.deliver = new ProximityAction({ radius: 2.5, startDelay: 0, interval: 0.1, requireStill: false });

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

  // 井桁スタック i 段目のワールド座標(予定地中心の少し上へ積む)
  _slot(i) { return new THREE.Vector3(this.x, 0.2 + i * LOG_STEP, this.z); }

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
    const toQ = (i % 2 === 1) ? CRIB_Q.clone() : new THREE.Quaternion();
    this.flights.push({
      mesh,
      from: fromWorld.clone(),
      to: this._slot(i),
      fromQ: mesh.quaternion.clone(),
      toQ,
      t: 0,
    });
    this.progress++;
    this._drawProgress();
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
      const c1 = 1.70158, c3 = c1 + 1;
      const s = 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
      this.completedMesh.scale.setScalar(Math.max(0.001, s));
      if (p >= 1) { this.completedMesh.scale.setScalar(1); this.completeAnim = null; }
    }

    // campfire の炎ゆらぎ + 光の明滅
    if (this.extra.fire) {
      this._fireTime += dt;
      const sy = 1 + 0.15 * Math.sin(this._fireTime * 12) + 0.08 * Math.sin(this._fireTime * 27);
      this.extra.fire.scale.set(1, sy, 1);
      if (this.extra.light) this.extra.light.intensity = 0.8 + 0.25 * Math.sin(this._fireTime * 15);
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
    if (this.progSprite.parent) this.progSprite.parent.remove(this.progSprite);
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
      if (i % 2 === 1) mesh.quaternion.copy(CRIB_Q);
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
      default:         return this._signMesh();
    }
  }

  // エリア外周の丸太柵(proto-a 158-175行を area の角丸矩形で。mergeGeosで2メッシュに結合)
  _fenceMesh() {
    const g = new THREE.Group();
    const shape = roundedRectShape(this.area.hw, this.area.hd, 2.5);
    const N = 82;
    const pts = shape.getSpacedPoints(N); // 末尾は先頭と同一なので N 本ぶんだけ使う
    const sides = [], caps = [];
    for (let i = 0; i < N; i++) {
      const x = pts[i].x, z = -pts[i].y;
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

  update(dt, playerPos, eco, carrier) {
    for (const site of this.sites.values()) {
      if (!site.completed) {
        const dist = Math.hypot(playerPos.x - site.x, playerPos.z - site.z);
        const hasLog = (eco.resources.log ?? 0) > 0;
        const inRange = dist <= site.deliver.radius && hasLog && site.progress < site.f.costLogs;
        const ticks = site.deliver.update(inRange, true, dt);
        for (let i = 0; i < ticks; i++) {
          if (site.progress >= site.f.costLogs || (eco.resources.log ?? 0) <= 0) break;
          if (eco.take('log', 1) <= 0) break;                 // 内部数の真実は eco 側
          const pos = carrier.popVisualOf('log');              // 丸太指定で見た目を外す(混載時に魚を消さない)→座標取得
          site.deliverOne(pos ?? new THREE.Vector3(playerPos.x, 1.7, playerPos.z));
        }
      }
      site.update(dt);
    }
  }

  serialize() {
    const out = {};
    for (const [id, site] of this.sites) out[id] = site.progress;
    return out;
  }
}

/* ================= マネータワー(売店脇の未回収金スタック) =================
 * 内部金額(真実)は main.js の moneyTower 変数が持つ。このクラスは「見た目」だけを管理する:
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

  // 金額に合わせて札束数を再構築(変化したフレームだけ)。Math.floor(n/10)+1 枚、n=0なら0枚
  setAmount(n) {
    if (n === this._lastAmount) return;
    this._lastAmount = n;
    const count = n <= 0 ? 0 : Math.min(BILL_CAP, Math.floor(n / YEN_PER_BILL) + 1);
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
    const overflow = n > 0 && Math.floor(n / YEN_PER_BILL) + 1 > BILL_CAP;
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
      }
    }
  }
}
