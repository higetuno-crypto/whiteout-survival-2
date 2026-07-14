// 建設予定地(白点線枠)への丸太納品と完成メッシュの出現。動画再現の核。
// 各施設: 白点線枠 → 背中の丸太を1本ずつ放物線納品 → 進捗 → 完成メッシュ出現。
// 移植元: reference/proto-a.html 396-410行(launchLog)・535-554行(フライト)・583-587行(easeOutBack)
//        158-175行(柵+mergeGeos) / 244-248行(スロット積み)
import * as THREE from 'three';
import { lambert, mergeGeos, roundedRectShape } from './render.js';
import { FACILITIES, AREAS, RESOURCES } from './data.js';
import { ProximityAction } from './proximity.js';
import { createKindMesh } from './entities.js';

// 納品フライト/建設中スタック用の丸太(X軸に寝かせた円柱)。モジュールで1回だけ生成して共有。
const FLIGHT_LOG_GEO = new THREE.CylinderGeometry(0.16, 0.16, 1.8, 9).rotateZ(Math.PI / 2);
const FLIGHT_LOG_SIDE = lambert(0xb0703c);
const FLIGHT_LOG_CAP = lambert(0xf3dfae);
const FLIGHT_LOG_MATS = [FLIGHT_LOG_SIDE, FLIGHT_LOG_CAP, FLIGHT_LOG_CAP];
const LOG_STEP = 0.31;       // 井桁スタックの段差
const CRIB_Q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, Math.PI / 2, 0)); // 奇数段の直交

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
    this.extra = {};          // campfire: {fire, light}
    this._fireTime = 0;
    this.cookFlights = [];    // 調理フライト(T13): {mesh, phase, t, from, fire, back, puffs}
    this.cooking = false;     // 調理中フラグ(main.jsがProximityAction.activeを毎フレーム反映。炎ブースト用)

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

  // 調理フライトの煙パフ2個を生成(白・半透明。ジュージューの間だけゆっくり上昇+フェード)
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
      case 'bridge':   return this._bridgeMesh();
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
