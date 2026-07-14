// キャラクター(2頭身サンタ)のジオメトリと歩行アニメ、および背中スタック(StackCarrier)。
// 移植元: reference/proto-a.html 259-321行(ジオメトリ) / 469-486行(歩行アニメ) / 370-374行(faceAngle)
//        214-224行(丸太マテリアル/ジオメトリ) / 323-329行(backStack構成)
//        385-395行(addBackLog) / 488-512行(ばね物理) / 514-532行(ドロップアニメ)
import * as THREE from 'three';
import { lambert, blobShadow } from './render.js';
import { VISUAL_STACK_CAP, RESOURCES, UPGRADES } from './data.js';

export const SANTA_COLORS = { coat: 0xc62f2f, trim: 0xf4f4f2, skin: 0xf0c39c, dark: 0x5a3327 };
export const NPC_COLORS   = { coat: 0x3f7fc4, trim: 0xf4f4f2, skin: 0xf0c39c, dark: 0x2f4a63 };

// 2頭身サンタのroot Object3Dを構築する。colorsで配色を差し替え可能。
export function makeCharacter(colors) {
  const { coat, trim, skin, dark } = colors;
  const root = new THREE.Group();

  const bodyGroup = new THREE.Group();
  bodyGroup.position.y = 0.62;
  root.add(bodyGroup);

  // 胴体(コート + 裾)
  {
    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.56, 0.95, 10), lambert(coat));
    torso.position.y = 0.48;
    const hem = new THREE.Mesh(new THREE.CylinderGeometry(0.57, 0.57, 0.14, 10), lambert(trim));
    hem.position.y = 0.06;
    const belt = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.53, 0.12, 10), lambert(dark));
    belt.position.y = 0.42;
    bodyGroup.add(torso, hem, belt);
  }
  // 頭(肌色球 + ひげ + 帽子)
  {
    const head = new THREE.Group();
    head.position.y = 1.42;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), lambert(skin));
    const beard = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), lambert(trim));
    beard.position.set(0, -0.14, 0.2);
    beard.scale.set(1.05, 0.8, 0.9);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.46, 0.46, 0.14, 10), lambert(trim));
    brim.position.y = 0.22;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.62, 9), lambert(coat));
    cap.position.y = 0.55;
    cap.rotation.z = 0.12;
    const pom = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), lambert(trim));
    pom.position.set(-0.09, 0.86, 0);
    head.add(skull, beard, brim, cap, pom);
    bodyGroup.add(head);
  }
  // 腕
  const armL = new THREE.Group(), armR = new THREE.Group();
  armL.position.set(0.56, 1.18, 0);
  armR.position.set(-0.56, 1.18, 0);
  for (const [arm, side] of [[armL, 1], [armR, -1]]) {
    const a = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.62, 8), lambert(coat));
    a.position.y = -0.28;
    const mitt = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), lambert(dark));
    mitt.position.y = -0.58;
    arm.add(a, mitt);
    arm.rotation.z = side * 0.18;
    bodyGroup.add(arm);
  }
  // 脚(rootの直下。proto-aと同じ)
  const legL = new THREE.Group(), legR = new THREE.Group();
  legL.position.set(0.2, 0.66, 0);
  legR.position.set(-0.2, 0.66, 0);
  for (const leg of [legL, legR]) {
    const l = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.56, 0.32), lambert(dark));
    l.position.y = -0.3;
    leg.add(l);
    root.add(leg);
  }
  // 足元のブロブシャドウ
  root.add(blobShadow(1.7, 1.5, 0.05));

  return { root, bodyGroup, armL, armR, legL, legR };
}

// 歩行アニメ(proto-a 469-486行を移植)。ch = makeCharacter() の戻り値。
// moving=true で脚・腕を振り体を弾ませる。falseで減衰して静止姿勢へ戻す。
export function animateWalk(ch, walkPhase, moving, dt) {
  if (moving) {
    const s = Math.sin(walkPhase);
    ch.legL.rotation.x = s * 0.8;
    ch.legR.rotation.x = -s * 0.8;
    ch.armL.rotation.x = -s * 0.55;
    ch.armR.rotation.x = s * 0.55;
    ch.bodyGroup.position.y = 0.62 + Math.abs(Math.sin(walkPhase)) * 0.06;
    ch.bodyGroup.rotation.x = 0.06;
  } else {
    const k = Math.max(0, 1 - dt * 10);
    ch.legL.rotation.x *= k;
    ch.legR.rotation.x *= k;
    ch.armL.rotation.x *= k;
    ch.armR.rotation.x *= k;
    ch.bodyGroup.position.y = 0.62;
    ch.bodyGroup.rotation.x *= k;
  }
}

// 向きの滑らか回転(proto-a 370-374行を任意のObject3Dに汎用化)
export function faceAngle(obj, target, dt, rate) {
  let d = target - obj.rotation.y;
  d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  obj.rotation.y += d * Math.min(1, rate * dt);
}

/* ================= 背中スタック(StackCarrier) =================
 * 内部数(真実)は economy.resources が持つ。StackCarrier は「見た目」だけを管理する:
 * 表示は VISUAL_STACK_CAP 個まで、超過分は頭上の「×N」カウンタで表現。メッシュはプールして再利用。
 * 移植元: proto-a 214-224行(丸太マテリアル/ジオメトリ) / 323-329行(backStack構成)
 *        385-395行(addBackLog) / 488-512行(ばね物理) / 514-532行(ドロップアニメ)
 */

const LOG_STEP = 0.31;      // proto-a と同じスタック段差
const DROP_HEIGHT = 2.3;    // proto-a と同じ落下開始オフセット
const BASE_SPEED = UPGRADES.speed.base; // ばねsway用の基準速度(proto-aのSPEED定数と同値=4.3)
const KIND_ORDER = Object.keys(RESOURCES); // log, rawFish, cookedFish, plank, goods

// 資源種ごとのジオメトリ/マテリアル(モジュールスコープで1回だけ生成して共有)
const logSideMat = lambert(0xb0703c);
const logCapMat = lambert(0xf3dfae);
const LOG_GEO = new THREE.CylinderGeometry(0.155, 0.155, 0.95, 9).rotateZ(Math.PI / 2);
const LOG_MATS = [logSideMat, logCapMat, logCapMat];

const FISH_GEO = new THREE.SphereGeometry(0.28, 8, 6);
const RAW_FISH_MAT = lambert(0x7fa8b8);
const COOKED_FISH_MAT = lambert(0xd07f3f);

const PLANK_GEO = new THREE.BoxGeometry(1.1, 0.08, 0.34);
const PLANK_MAT = lambert(0xd8b56a);

const GOODS_GEO = new THREE.BoxGeometry(0.4, 0.4, 0.4);
const GOODS_MAT = lambert(0xe8b04a);

// 球体(魚)は扁平にスケールするため、種別ごとの基準スケールを持つ(ドロップスカッシュもこの基準を軸に乗算する)
const KIND_SCALE = {
  log:        [1, 1, 1],
  rawFish:    [1.4, 0.5, 0.7],
  cookedFish: [1.4, 0.5, 0.7],
  plank:      [1, 1, 1],
  goods:      [1, 1, 1],
};

// 資源kindの見た目メッシュを1個生成(スタック用・売却フライト用に共有)
export function createKindMesh(kind) {
  let mesh;
  switch (kind) {
    case 'log':        mesh = new THREE.Mesh(LOG_GEO, LOG_MATS); break;
    case 'rawFish':     mesh = new THREE.Mesh(FISH_GEO, RAW_FISH_MAT); break;
    case 'cookedFish':  mesh = new THREE.Mesh(FISH_GEO, COOKED_FISH_MAT); break;
    case 'plank':       mesh = new THREE.Mesh(PLANK_GEO, PLANK_MAT); break;
    case 'goods':       mesh = new THREE.Mesh(GOODS_GEO, GOODS_MAT); break;
    default:            mesh = new THREE.Mesh(GOODS_GEO, GOODS_MAT);
  }
  const s = KIND_SCALE[kind] ?? [1, 1, 1];
  mesh.scale.set(s[0], s[1], s[2]);
  return mesh;
}

export class StackCarrier {
  constructor(parentGroup) {
    this.group = new THREE.Group();
    this.group.position.set(0, 1.7, -0.52);   // proto-a 325行と同じ背中位置
    parentGroup.add(this.group);

    this.items = [];      // {mesh, baseY, kind} 表示中のスタック(先頭=一番下)
    this.pool = { log: [], rawFish: [], cookedFish: [], plank: [], goods: [] };
    this.dropAnims = [];  // {mesh, baseY, t, kind} proto-a 360, 514-532行
    this._syncBuf = new Array(VISUAL_STACK_CAP); // syncToの目標配列(毎フレームの[]生成を避ける再利用バッファ)

    // ばね物理状態(proto-a 366-368行)
    this.bendF = 0; this.bendFV = 0; this.bendS = 0; this.bendSV = 0;
    this.prevPos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.prevVel = new THREE.Vector3();
    this.accS = new THREE.Vector3();
    this._rawAcc = new THREE.Vector3();
    this._initialized = false; // 初回updateでprevPosをownerRootの現在位置に合わせ、初速スパイクを防ぐ

    // ×Nオーバーフローカウンタ(CanvasTexture + Sprite)。表示上限を超えた分だけを示す。
    this._counterCanvas = document.createElement('canvas');
    this._counterCanvas.width = 128;
    this._counterCanvas.height = 64;
    this._counterCtx = this._counterCanvas.getContext('2d');
    this._counterTexture = new THREE.CanvasTexture(this._counterCanvas);
    const counterMat = new THREE.SpriteMaterial({ map: this._counterTexture, transparent: true, depthTest: false });
    this.counterSprite = new THREE.Sprite(counterMat);
    this.counterSprite.scale.set(1.6, 0.8, 1);
    this.counterSprite.position.set(0, (VISUAL_STACK_CAP - 1) * LOG_STEP + 0.6, 0);
    this.counterSprite.renderOrder = 5;
    this.counterSprite.visible = false;
    this.group.add(this.counterSprite);
    this._lastCounterTotal = -1;
  }

  // counts = economy.resources(全kindの内部カウント)。見た目を内部数に同期させる。
  // 目標並びは再利用バッファ(this._syncBuf)へ書き、長さ len で管理する(毎フレームの配列生成を回避)。
  syncTo(counts) {
    let total = 0;
    const buf = this._syncBuf;
    let len = 0;
    for (const k of KIND_ORDER) {
      const n = Math.max(0, counts[k] ?? 0);
      total += n;
      for (let i = 0; i < n && len < VISUAL_STACK_CAP; i++) buf[len++] = k;
    }
    // this.items と先頭から比較し、一致しない位置以降を popVisual で全部戻してから push し直す(単純・確実)
    let i = 0;
    while (i < len && i < this.items.length && this.items[i].kind === buf[i]) i++;
    while (this.items.length > i) this.popVisual();
    for (let j = i; j < len; j++) this.pushVisual(buf[j]);
    this.updateCounter(total);
  }

  pushVisual(kind) {
    const mesh = this.pool[kind]?.pop() ?? createKindMesh(kind);
    const i = this.items.length;
    mesh.rotation.set(0, i % 2 === 1 ? Math.PI / 2 : 0, 0); // 丸太の交互直交(他kindにも同様に適用)
    const s = KIND_SCALE[kind] ?? [1, 1, 1];
    mesh.scale.set(s[0], s[1], s[2]);
    mesh.visible = true;
    const baseY = i * LOG_STEP;
    mesh.position.set(0, baseY + DROP_HEIGHT, 0); // 上から落とす
    this.group.add(mesh);
    this.items.push({ mesh, baseY, kind });
    this.dropAnims.push({ mesh, baseY, t: 0, kind }); // ポン+着地スカッシュ
  }

  // 末尾のitemを外してpoolへ戻す。外したメッシュのワールド座標(Vector3)を返す(後続タスクの納品フライト始点用)
  popVisual() {
    const item = this.items.pop();
    if (!item) return null;
    const { mesh, kind } = item;
    const di = this.dropAnims.findIndex(a => a.mesh === mesh);
    if (di !== -1) this.dropAnims.splice(di, 1);
    mesh.updateWorldMatrix(true, false); // renderer.render()を挟まない検証ループでも正確な座標を返す
    const worldPos = new THREE.Vector3();
    mesh.getWorldPosition(worldPos);
    this.group.remove(mesh);
    const s = KIND_SCALE[kind] ?? [1, 1, 1];
    mesh.scale.set(s[0], s[1], s[2]);
    this.pool[kind].push(mesh);
    return worldPos;
  }

  // kind指定のpop: itemsを末尾から走査して最初に一致するitemを外し、プールへ戻す。
  // 混載スタック(丸太+魚)で「丸太を納品したのに魚が消える」不整合を防ぐ(T8納品/T9売却用)。
  // 外した位置より上のitemは1段ずつ静かに詰める(ドロップアニメは発火させない)。
  // 見つからなければ popVisual() にフォールバック(内部カウントが真実なので数は合う)。
  popVisualOf(kind) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      if (this.items[i].kind !== kind) continue;
      const { mesh } = this.items[i];
      this.items.splice(i, 1);
      const di = this.dropAnims.findIndex(a => a.mesh === mesh);
      if (di !== -1) this.dropAnims.splice(di, 1);
      mesh.updateWorldMatrix(true, false);
      const worldPos = new THREE.Vector3();
      mesh.getWorldPosition(worldPos);
      this.group.remove(mesh);
      const s = KIND_SCALE[kind] ?? [1, 1, 1];
      mesh.scale.set(s[0], s[1], s[2]);
      this.pool[kind].push(mesh);
      // 外した位置より上を詰める。ドロップアニメ中のitemはbaseY更新のみ(位置はアニメ側が毎フレーム上書き)
      for (let j = i; j < this.items.length; j++) {
        const it = this.items[j];
        it.baseY = j * LOG_STEP;
        const anim = this.dropAnims.find(a => a.mesh === it.mesh);
        if (anim) anim.baseY = it.baseY;
        else it.mesh.position.y = it.baseY;
      }
      return worldPos;
    }
    return this.popVisual();
  }

  updateCounter(total) {
    if (total === this._lastCounterTotal) return; // 変化なしなら再描画しない
    this._lastCounterTotal = total;
    if (total <= VISUAL_STACK_CAP) {
      this.counterSprite.visible = false;
      return;
    }
    this.counterSprite.visible = true;
    this._drawCounterText(`×${total - VISUAL_STACK_CAP}`);
  }

  _drawCounterText(text) {
    const ctx = this._counterCtx, c = this._counterCanvas;
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = 'bold 34px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fff';
    ctx.strokeText(text, c.width / 2, c.height / 2);
    ctx.fillText(text, c.width / 2, c.height / 2);
    this._counterTexture.needsUpdate = true;
  }

  // ownerRoot=キャラのroot。proto-a 488-512行のばね物理を移植。
  update(dt, ownerRoot, walkPhase, moving) {
    if (!this._initialized) {
      this.prevPos.copy(ownerRoot.position);
      this._initialized = true;
    }
    // --- ばね遅延追従(加速度→ローカル射影→ばね積分) ---
    this.vel.subVectors(ownerRoot.position, this.prevPos).divideScalar(Math.max(dt, 1e-4));
    this.prevPos.copy(ownerRoot.position);
    this._rawAcc.subVectors(this.vel, this.prevVel).divideScalar(Math.max(dt, 1e-4));
    this.prevVel.copy(this.vel);
    this.accS.lerp(this._rawAcc, 1 - Math.exp(-9 * dt));
    const ry = ownerRoot.rotation.y;
    const fx = Math.sin(ry), fz = Math.cos(ry);
    const fwdAcc = this.accS.x * fx + this.accS.z * fz;
    const sideAcc = this.accS.x * fz - this.accS.z * fx;
    const speedRatio = Math.min(1, this.vel.length() / BASE_SPEED);
    const tgtF = THREE.MathUtils.clamp(-fwdAcc * 0.045, -0.5, 0.5);
    const tgtS = THREE.MathUtils.clamp(-sideAcc * 0.045, -0.5, 0.5) + Math.sin(walkPhase * 0.5) * 0.05 * speedRatio;
    this.bendFV += ((tgtF - this.bendF) * 62 - this.bendFV * 8.2) * dt;
    this.bendF += this.bendFV * dt;
    this.bendSV += ((tgtS - this.bendS) * 62 - this.bendSV * 8.2) * dt;
    this.bendS += this.bendSV * dt;
    this.group.rotation.x = -this.bendF * 0.28;
    this.group.rotation.z = this.bendS * 0.28;
    for (let i = 0; i < this.items.length; i++) {
      const k = Math.pow((i + 1) / VISUAL_STACK_CAP, 1.7) * 2.4;
      this.items[i].mesh.position.x = this.bendS * k;
      this.items[i].mesh.position.z = -this.bendF * k;
    }
    // 歩行バウンス
    this.group.position.y = 1.7 + (moving ? Math.abs(Math.sin(walkPhase + 0.4)) * 0.05 : 0);

    // --- ドロップアニメ(落下→着地スカッシュ) ---
    for (let i = this.dropAnims.length - 1; i >= 0; i--) {
      const a = this.dropAnims[i];
      a.t += dt;
      const FALL = 0.16, SQ = 0.15;
      const s = KIND_SCALE[a.kind] ?? [1, 1, 1];
      if (a.t < FALL) {
        const p = a.t / FALL;
        a.mesh.position.y = a.baseY + DROP_HEIGHT * (1 - p * p);
      } else if (a.t < FALL + SQ) {
        const q = (a.t - FALL) / SQ;
        a.mesh.position.y = a.baseY;
        const sy = 1 - 0.32 * Math.sin(Math.PI * q);
        const sxz = 1 + 0.2 * Math.sin(Math.PI * q);
        a.mesh.scale.set(s[0] * sxz, s[1] * sy, s[2] * sxz);
      } else {
        a.mesh.position.y = a.baseY;
        a.mesh.scale.set(s[0], s[1], s[2]);
        this.dropAnims.splice(i, 1);
      }
    }
  }
}
