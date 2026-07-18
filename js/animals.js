// 牧場の動物たち(FB5: 見た目とモーション専用。生産ロジック・セーブには一切関与しない)。
// build.jsの旧_makePenguinを「動物種ビルダー+小さな行動AI」へ発展させたもの。
// 各動物のリグ: root(地面位置+向き) → blobShadow + lift(ホップの上下/着地スカッシュ)
//              → body(呼吸・歩行バウンス・お辞儀) → head(見回し/草はみ) / ears / tail、脚はliftに直付け。
// 挙動は種ごとの重み付きステートマシン(wander/idle/graze/flap/hop/rock/nap...)。
// ★次セッションの「愛でる」要素はここに足す想定: 各Animalが root/head/eyes を公開しているので、
//   タップ判定→リアクション(ジャンプ/ハート)を state として追加すればよい。
import * as THREE from 'three';
import { lambert, blobShadow } from './render.js';
import { faceAngle } from './entities.js';

/* ================= レイアウト(ペンの寸法と小物の位置。build.jsの柵/小物メッシュと共有) ================= */
export const RANCH_LAYOUT = {
  hw: 4.0, hd: 3.0, fenceR: 0.9, gateHalf: 1.0,     // 柵: 角丸矩形の半幅/半奥行/角R/正面ゲート半幅
  trough:  { x: -1.7,  z: 1.7 },                    // 餌箱(給餌フライトの着地先)
  water:   { x: 1.9,   z: 1.7 },                    // 水飲み場
  rock:    { x: 2.3,   z: -1.6, top: 0.55 },        // ヤギが登る岩
  bale:    { x: 5.45,  z: -0.7, top: 0.64 },        // 干し草ロール(柵の外。猫のお昼寝ベッド。犬の巡回路の外)
  shelter: { x: -2.0,  z: -1.9 },                   // 小屋(奥の左)
  goods:   { x: 5.0,   z: 2.4 },                    // 未回収goodsの置き場(柵の外・手前)
};

/* ================= 配色(モジュールで1回だけ生成して全個体で共有) ================= */
const INK    = lambert(0x1c1c22);   // ペンギンの黒 / 牛のまだら
const SNOW   = lambert(0xf4f4f2);
const ORANGE = lambert(0xe8912a);   // くちばし / 足
const PINK   = lambert(0xe8a8a0);   // 鼻先・耳の内側・乳
const HOOF   = lambert(0x4a3626);
const HORN   = lambert(0x9a8265);
const GOAT   = lambert(0xe3dbc8);
const GOAT_D = lambert(0xcabfa4);
const CAT    = lambert(0xe89440);
const CAT_D  = lambert(0xc9752c);
const CAT_W  = lambert(0xf7f3ea);
const WOOL   = lambert(0xf7f4ec);   // 羊の毛(雪よりわずかに暖色)
const SHEEP_F= lambert(0x4a4a52);   // 羊の顔/脚(チャコール)
const HORSE  = lambert(0xb5793f);   // 馬の栗毛
const HORSE_D= lambert(0x5d3f28);   // たてがみ/しっぽ
const BUNNY  = lambert(0xffffff);   // 雪うさぎ
const DOG    = lambert(0xd98e4a);   // コーギーのオレンジ
const PIG    = lambert(0xefa09a);   // 豚のピンク
const PIG_D  = lambert(0xe08680);   // 豚の鼻先/耳
const DEER   = lambert(0x8a6242);   // トナカイの毛
const DEER_D = lambert(0x6e4c34);   // トナカイの鼻まわり
const DEER_C = lambert(0xe8ddcc);   // トナカイの胸元/しっぽ
const ANTLER = lambert(0xd8c49a);   // 角
const RED_NOSE = new THREE.MeshBasicMaterial({ color: 0xe23b2e }); // 赤鼻(光って見えるBasic)
// 目は陰にならないBasic(まっ黒+白ハイライト)。ローポリ動物のかわいさはほぼ目で決まる。
const EYE    = new THREE.MeshBasicMaterial({ color: 0x23232a });
const GLINT  = new THREE.MeshBasicMaterial({ color: 0xffffff });

const rand = (a, b) => a + Math.random() * (b - a);

// 左右一対の目(+キャッチライト)を親に足し、まばたき用にeyes配列へ積む
function addEyes(parent, eyes, r, x, y, z) {
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(r, 7, 6), EYE);
    e.position.set(sx * x, y, z);
    const g = new THREE.Mesh(new THREE.SphereGeometry(r * 0.38, 5, 4), GLINT);
    g.position.set(r * 0.3, r * 0.35, r * 0.72);
    e.add(g);
    parent.add(e);
    eyes.push(e);
  }
}

function baseRig(shadowW, shadowD) {
  const root = new THREE.Group();
  const lift = new THREE.Group();
  root.add(blobShadow(shadowW, shadowD, 0.045), lift);
  return { root, lift };
}

/* ================= 種ビルダー(2頭身・flatShadingローポリ。頭が大きいほどかわいい) ================= */

// ペンギン(旧build.js _makePenguinの発展形: 目・フリッパー・足つき)
function makePenguin() {
  const { root, lift } = baseRig(0.75, 0.62);
  const body = new THREE.Group(); body.position.y = 0.27; lift.add(body);
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), INK);
  torso.scale.set(0.85, 1.15, 0.85); body.add(torso);
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.155, 8, 6), SNOW);
  belly.scale.set(0.82, 1.0, 0.62); belly.position.set(0, -0.03, 0.115); body.add(belly);
  const stub = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), INK);
  stub.scale.set(1, 0.75, 1.2); stub.position.set(0, -0.16, -0.16); body.add(stub);
  const head = new THREE.Group(); head.position.y = 0.22; body.add(head);
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), INK));
  const eyes = [];
  addEyes(head, eyes, 0.03, 0.055, 0.03, 0.105);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.12, 6).rotateX(Math.PI / 2), ORANGE);
  beak.position.set(0, -0.005, 0.16); head.add(beak);
  const flippers = [];
  for (const sx of [-1, 1]) {
    const f = new THREE.Group(); f.position.set(sx * 0.185, 0.02, 0);
    const fm = new THREE.Mesh(new THREE.SphereGeometry(0.1, 7, 5), INK);
    fm.scale.set(0.28, 1.05, 0.6); fm.position.y = -0.085; f.add(fm);
    f.userData.restZ = sx * 0.25;   // 少し開いて立つ(rotation.z正=+x側が外へ)
    f.rotation.z = f.userData.restZ;
    body.add(f); flippers.push(f);
  }
  const legs = [];
  for (const sx of [-1, 1]) {
    const leg = new THREE.Group(); leg.position.set(sx * 0.085, 0.06, 0.03);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.045, 0.17), ORANGE);
    foot.position.set(0, -0.035, 0.045); leg.add(foot);
    lift.add(leg); legs.push(leg);
  }
  return { root, lift, body, head, eyes, legs, flippers, ears: [], tail: null, bodyY: 0.27 };
}

// 牛(ホルスタイン: 白地+黒まだら+片目パッチ。ゆったり大きく)
function makeCow() {
  const { root, lift } = baseRig(1.7, 1.15);
  const body = new THREE.Group(); body.position.y = 0.5; lift.add(body);
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.42, 9, 7), SNOW);
  torso.scale.set(0.78, 0.6, 1.22); body.add(torso);
  const patchGeo = new THREE.SphereGeometry(0.2, 7, 6);
  for (const [x, y, z, s] of [[0.2, 0.14, 0.38, 1.0], [-0.24, 0.1, -0.18, 1.15], [0.08, 0.17, -0.42, 0.85]]) {
    const p = new THREE.Mesh(patchGeo, INK);
    p.position.set(x, y, z); p.scale.set(s * 1.15, s * 0.6, s * 1.3);
    body.add(p);
  }
  const udder = new THREE.Mesh(new THREE.SphereGeometry(0.13, 7, 6), PINK);
  udder.scale.set(1, 0.72, 1); udder.position.set(0, -0.24, -0.18); body.add(udder);
  const head = new THREE.Group(); head.position.set(0, 0.2, 0.5); body.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.28, 9, 7), SNOW);
  skull.scale.set(0.9, 0.85, 0.9); skull.position.z = 0.06; head.add(skull);
  const eyePatch = new THREE.Mesh(new THREE.SphereGeometry(0.12, 7, 6), INK);
  eyePatch.position.set(0.14, 0.1, 0.13); eyePatch.scale.set(1, 0.95, 1); head.add(eyePatch);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), PINK);
  muzzle.scale.set(1.05, 0.72, 0.8); muzzle.position.set(0, -0.09, 0.28); head.add(muzzle);
  const eyes = [];
  addEyes(head, eyes, 0.045, 0.15, 0.07, 0.235);
  const hornGeo = new THREE.ConeGeometry(0.04, 0.14, 6);
  for (const sx of [-1, 1]) {
    const h = new THREE.Mesh(hornGeo, GOAT);
    h.position.set(sx * 0.13, 0.26, 0.02); h.rotation.z = -sx * 0.5;
    head.add(h);
  }
  const ears = [];
  for (const sx of [-1, 1]) {
    const ear = new THREE.Group(); ear.position.set(sx * 0.24, 0.15, 0);
    const em = new THREE.Mesh(new THREE.SphereGeometry(0.085, 7, 5), SNOW);
    em.scale.set(1.7, 0.45, 0.75); em.position.x = sx * 0.1; ear.add(em);
    ear.userData.restZ = -sx * 0.25;  // 外側へ少し垂れる
    ear.rotation.z = ear.userData.restZ;
    head.add(ear); ears.push(ear);
  }
  const tail = new THREE.Group(); tail.position.set(0, 0.16, -0.6); body.add(tail);
  const tm = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.02, 0.34, 5), SNOW);
  tm.position.y = -0.17; tail.add(tm);
  const tuft = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5), INK);
  tuft.position.y = -0.36; tail.add(tuft);
  const legs = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = new THREE.Group(); leg.position.set(sx * 0.2, 0.3, sz * 0.34);
    const lm = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.26, 0.15), SNOW); lm.position.y = -0.13;
    const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.16), HOOF); hoof.position.y = -0.27;
    leg.add(lm, hoof); lift.add(leg); legs.push(leg);
  }
  return { root, lift, body, head, eyes, legs, flippers: null, ears, tail, bodyY: 0.5 };
}

// ヤギ(クリーム色+後ろへ流れる角+垂れ耳+あごひげ+上向きしっぽ)
function makeGoat() {
  const { root, lift } = baseRig(1.1, 0.85);
  const body = new THREE.Group(); body.position.y = 0.42; lift.add(body);
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), GOAT);
  torso.scale.set(0.75, 0.66, 1.1); body.add(torso);
  const head = new THREE.Group(); head.position.set(0, 0.2, 0.4); body.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), GOAT);
  skull.scale.set(0.85, 0.9, 0.85); skull.position.z = 0.04; head.add(skull);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.1, 7, 6), GOAT_D);
  muzzle.scale.set(0.95, 0.7, 0.9); muzzle.position.set(0, -0.06, 0.17); head.add(muzzle);
  const beard = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.13, 5), GOAT_D);
  beard.rotation.x = Math.PI;   // 逆さコーン=あごひげ
  beard.position.set(0, -0.19, 0.13); head.add(beard);
  const eyes = [];
  addEyes(head, eyes, 0.04, 0.11, 0.05, 0.145);
  const hornGeo = new THREE.ConeGeometry(0.042, 0.2, 6);
  for (const sx of [-1, 1]) {
    const h = new THREE.Mesh(hornGeo, HORN);
    h.position.set(sx * 0.08, 0.18, -0.04);
    h.rotation.x = -1.05; h.rotation.z = -sx * 0.12;  // 後ろへ流れる
    head.add(h);
  }
  const ears = [];
  for (const sx of [-1, 1]) {
    const ear = new THREE.Group(); ear.position.set(sx * 0.16, 0.08, 0.02);
    const em = new THREE.Mesh(new THREE.SphereGeometry(0.075, 7, 5), GOAT);
    em.scale.set(1.5, 0.4, 0.7); em.position.x = sx * 0.09; ear.add(em);
    ear.userData.restZ = -sx * 0.55;  // ぺたんと垂れ耳
    ear.rotation.z = ear.userData.restZ;
    head.add(ear); ears.push(ear);
  }
  const tail = new THREE.Group(); tail.position.set(0, 0.18, -0.48); body.add(tail);
  const tm = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), GOAT);
  tm.scale.set(0.7, 1.3, 0.7); tm.position.y = 0.05; tail.add(tm);
  tail.rotation.x = -0.6;   // ぴんと上向き
  const legs = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = new THREE.Group(); leg.position.set(sx * 0.15, 0.26, sz * 0.3);
    const lm = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.23, 0.11), GOAT); lm.position.y = -0.115;
    const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.06, 0.12), HOOF); hoof.position.y = -0.24;
    leg.add(lm, hoof); lift.add(leg); legs.push(leg);
  }
  return { root, lift, body, head, eyes, legs, flippers: null, ears, tail, bodyY: 0.42 };
}

// 猫(茶トラ: しま模様+白いおなか+2節しっぽ。柵の外を自由に歩く)
function makeCat() {
  const { root, lift } = baseRig(0.72, 0.58);
  const body = new THREE.Group(); body.position.y = 0.22; lift.add(body);
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), CAT);
  torso.scale.set(0.8, 0.7, 1.25); body.add(torso);
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.1, 7, 6), CAT_W);
  chest.scale.set(0.85, 0.7, 0.85); chest.position.set(0, -0.03, 0.12); body.add(chest);
  const stripeGeo = new THREE.BoxGeometry(0.19, 0.035, 0.06);
  for (const z of [0.1, -0.03, -0.15]) {
    const s = new THREE.Mesh(stripeGeo, CAT_D);
    s.position.set(0, 0.105, z); body.add(s);
  }
  const head = new THREE.Group(); head.position.set(0, 0.13, 0.28); body.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), CAT);
  skull.scale.set(0.95, 0.9, 0.95); head.add(skull);
  const hs = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.03, 0.05), CAT_D);
  hs.position.set(0, 0.135, -0.02); head.add(hs);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.07, 7, 6), CAT_W);
  muzzle.scale.set(1.15, 0.7, 0.85); muzzle.position.set(0, -0.05, 0.105); head.add(muzzle);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.02, 5, 4), PINK);
  nose.position.set(0, -0.025, 0.163); head.add(nose);
  const eyes = [];
  addEyes(head, eyes, 0.036, 0.075, 0.035, 0.115);
  const ears = [];
  for (const sx of [-1, 1]) {
    const ear = new THREE.Group(); ear.position.set(sx * 0.083, 0.12, 0);
    const em = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.11, 4), CAT);
    em.position.y = 0.04; ear.add(em);
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.026, 0.06, 4), PINK);
    inner.position.set(0, 0.03, 0.018); ear.add(inner);
    ear.userData.restZ = -sx * 0.12;
    ear.rotation.z = ear.userData.restZ;
    head.add(ear); ears.push(ear);
  }
  // しっぽ2節(付け根+先端で位相をずらしてS字に揺れる)
  const tail = new THREE.Group(); tail.position.set(0, 0.06, -0.24); body.add(tail);
  const seg1 = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.032, 0.2, 5), CAT);
  seg1.position.y = 0.1; tail.add(seg1);
  const tail2 = new THREE.Group(); tail2.position.y = 0.2; tail.add(tail2);
  const seg2 = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.026, 0.16, 5), CAT);
  seg2.position.y = 0.08; tail2.add(seg2);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), CAT_D);
  tip.position.y = 0.17; tail2.add(tip);
  tail.rotation.x = -0.85;  // 後ろ上がり
  tail2.rotation.x = 0.5;   // 先端は起き上がってS字
  const legs = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = new THREE.Group(); leg.position.set(sx * 0.085, 0.14, sz * 0.13);
    const lm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, 0.07), CAT); lm.position.y = -0.06;
    const paw = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.05, 0.078), CAT_W); paw.position.y = -0.125;
    leg.add(lm, paw); lift.add(leg); legs.push(leg);
  }
  return { root, lift, body, head, eyes, legs, flippers: null, ears, tail, tail2, bodyY: 0.22 };
}

// 羊(もこもこの毛玉+チャコールの顔。頭の上にも毛のぼんぼり)
function makeSheep() {
  const { root, lift } = baseRig(1.25, 0.95);
  const body = new THREE.Group(); body.position.y = 0.44; lift.add(body);
  const wool = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), WOOL);
  wool.scale.set(0.95, 0.8, 1.1); body.add(wool);
  const rump = new THREE.Mesh(new THREE.IcosahedronGeometry(0.24, 1), WOOL);
  rump.position.set(0, 0.06, -0.28); body.add(rump);
  const head = new THREE.Group(); head.position.set(0, 0.12, 0.38); body.add(head);
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.15, 8, 6), SHEEP_F);
  face.scale.set(0.9, 1.0, 0.95); face.position.z = 0.05; head.add(face);
  const cap = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 1), WOOL);
  cap.scale.set(1.1, 0.7, 1.0); cap.position.set(0, 0.13, 0.0); head.add(cap);
  const eyes = [];
  addEyes(head, eyes, 0.04, 0.085, 0.03, 0.16);
  const ears = [];
  for (const sx of [-1, 1]) {
    const ear = new THREE.Group(); ear.position.set(sx * 0.13, 0.05, 0.02);
    const em = new THREE.Mesh(new THREE.SphereGeometry(0.07, 7, 5), SHEEP_F);
    em.scale.set(1.5, 0.4, 0.65); em.position.x = sx * 0.08; ear.add(em);
    ear.userData.restZ = -sx * 0.4;
    ear.rotation.z = ear.userData.restZ;
    head.add(ear); ears.push(ear);
  }
  const tail = new THREE.Group(); tail.position.set(0, 0.12, -0.48); body.add(tail);
  const tm = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 1), WOOL);
  tm.position.y = -0.02; tail.add(tm);
  const legs = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = new THREE.Group(); leg.position.set(sx * 0.16, 0.26, sz * 0.26);
    const lm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.24, 0.09), SHEEP_F); lm.position.y = -0.12;
    const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.1), HOOF); hoof.position.y = -0.245;
    leg.add(lm, hoof); lift.add(leg); legs.push(leg);
  }
  return { root, lift, body, head, eyes, legs, flippers: null, ears, tail, bodyY: 0.44 };
}

// 馬(栗毛+たてがみ+顔の白ブレーズ+ふさふさしっぽ。牛より首が高い)
function makeHorse() {
  const { root, lift } = baseRig(1.8, 1.2);
  const body = new THREE.Group(); body.position.y = 0.62; lift.add(body);
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.44, 9, 7), HORSE);
  torso.scale.set(0.72, 0.6, 1.28); body.add(torso);
  // 首(斜め前上がりの円柱)とたてがみ(首の上に房のBox列)
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.46, 8), HORSE);
  neck.position.set(0, 0.32, 0.44); neck.rotation.x = 0.55; body.add(neck);
  const maneGeo = new THREE.BoxGeometry(0.09, 0.14, 0.1);
  for (let i = 0; i < 3; i++) {
    const tuft = new THREE.Mesh(maneGeo, HORSE_D);
    tuft.position.set(0, 0.42 - i * 0.09, 0.3 + i * 0.075);
    tuft.rotation.x = 0.55; body.add(tuft);
  }
  const head = new THREE.Group(); head.position.set(0, 0.52, 0.58); body.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.22, 9, 7), HORSE);
  skull.scale.set(0.8, 0.85, 1.1); skull.position.z = 0.04; head.add(skull);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), HORSE_D);
  muzzle.scale.set(0.85, 0.75, 0.9); muzzle.position.set(0, -0.06, 0.24); head.add(muzzle);
  const blaze = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.2, 0.03), SNOW);
  blaze.position.set(0, 0.05, 0.2); blaze.rotation.x = -0.35; head.add(blaze);
  const forelock = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), HORSE_D);
  forelock.scale.set(1.2, 0.7, 1); forelock.position.set(0, 0.2, 0.05); head.add(forelock);
  const eyes = [];
  addEyes(head, eyes, 0.042, 0.12, 0.05, 0.17);
  const ears = [];
  for (const sx of [-1, 1]) {
    const ear = new THREE.Group(); ear.position.set(sx * 0.1, 0.2, -0.03);
    const em = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.12, 5), HORSE);
    em.position.y = 0.05; ear.add(em);
    ear.userData.restZ = -sx * 0.15;
    ear.rotation.z = ear.userData.restZ;
    head.add(ear); ears.push(ear);
  }
  const tail = new THREE.Group(); tail.position.set(0, 0.2, -0.62); body.add(tail);
  const tm = new THREE.Mesh(new THREE.SphereGeometry(0.11, 7, 6), HORSE_D);
  tm.scale.set(0.55, 1.6, 0.55); tm.position.y = -0.16; tail.add(tm);
  const legs = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = new THREE.Group(); leg.position.set(sx * 0.2, 0.42, sz * 0.36);
    const lm = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.38, 0.13), HORSE); lm.position.y = -0.19;
    const sock = new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.09, 0.135), SNOW); sock.position.y = -0.335;
    const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.07, 0.14), HOOF); hoof.position.y = -0.405;
    leg.add(lm, sock, hoof); lift.add(leg); legs.push(leg);
  }
  return { root, lift, body, head, eyes, legs, flippers: null, ears, tail, bodyY: 0.62 };
}

// 雪うさぎ(小さな白い毛玉+長い耳+綿しっぽ。歩かずぴょんぴょん跳ねる)
function makeRabbit() {
  const { root, lift } = baseRig(0.55, 0.45);
  const body = new THREE.Group(); body.position.y = 0.14; lift.add(body);
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), BUNNY);
  torso.scale.set(0.85, 0.8, 1.15); body.add(torso);
  const head = new THREE.Group(); head.position.set(0, 0.1, 0.12); body.add(head);
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.105, 8, 6), BUNNY));
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.018, 5, 4), PINK);
  nose.position.set(0, -0.01, 0.105); head.add(nose);
  const eyes = [];
  addEyes(head, eyes, 0.03, 0.055, 0.02, 0.08);
  // 長い耳(垂直。跳ねると後ろへふわっと倒れる=gaitで制御)
  const ears = [];
  for (const sx of [-1, 1]) {
    const ear = new THREE.Group(); ear.position.set(sx * 0.045, 0.09, -0.01);
    const em = new THREE.Mesh(new THREE.SphereGeometry(0.075, 6, 5), BUNNY);
    em.scale.set(0.42, 1.9, 0.55); em.position.y = 0.12; ear.add(em);
    const inner = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), PINK);
    inner.scale.set(0.3, 1.5, 0.35); inner.position.set(0, 0.12, 0.025); ear.add(inner);
    ear.userData.restZ = -sx * 0.1;
    ear.rotation.z = ear.userData.restZ;
    ear.rotation.x = -0.15;
    head.add(ear); ears.push(ear);
  }
  const tail = new THREE.Group(); tail.position.set(0, 0.02, -0.15); body.add(tail);
  tail.add(new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), BUNNY));
  const legs = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = new THREE.Group(); leg.position.set(sx * 0.06, 0.08, sz * 0.09);
    const lm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.06), BUNNY); lm.position.y = -0.04;
    leg.add(lm); lift.add(leg); legs.push(leg);
  }
  return { root, lift, body, head, eyes, legs, flippers: null, ears, tail, bodyY: 0.14 };
}

// 犬(コーギー: 胴長短足+大きな三角耳+ちぎれ尻尾。柵の外周をパトロールする牧羊犬)
function makeDog() {
  const { root, lift } = baseRig(0.85, 0.6);
  const body = new THREE.Group(); body.position.y = 0.21; lift.add(body);
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), DOG);
  torso.scale.set(0.85, 0.78, 1.6); body.add(torso);
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.11, 7, 6), CAT_W);
  chest.scale.set(0.9, 0.75, 1.0); chest.position.set(0, -0.03, 0.2); body.add(chest);
  const head = new THREE.Group(); head.position.set(0, 0.16, 0.36); body.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), DOG);
  skull.scale.set(0.95, 0.9, 0.95); head.add(skull);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.075, 7, 6), CAT_W);
  muzzle.scale.set(1.1, 0.75, 0.95); muzzle.position.set(0, -0.045, 0.115); head.add(muzzle);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.026, 5, 4), INK);
  nose.position.set(0, -0.02, 0.175); head.add(nose);
  const blaze = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.03), CAT_W);
  blaze.position.set(0, 0.06, 0.115); blaze.rotation.x = -0.4; head.add(blaze);
  const eyes = [];
  addEyes(head, eyes, 0.037, 0.075, 0.035, 0.115);
  const ears = [];
  for (const sx of [-1, 1]) {
    const ear = new THREE.Group(); ear.position.set(sx * 0.085, 0.115, -0.01);
    const em = new THREE.Mesh(new THREE.ConeGeometry(0.062, 0.15, 4), DOG);
    em.position.y = 0.06; ear.add(em);
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.032, 0.08, 4), PINK);
    inner.position.set(0, 0.045, 0.02); ear.add(inner);
    ear.userData.restZ = -sx * 0.1;
    ear.rotation.z = ear.userData.restZ;
    head.add(ear); ears.push(ear);
  }
  const tail = new THREE.Group(); tail.position.set(0, 0.1, -0.4); body.add(tail);
  const tm = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5), DOG);
  tm.scale.set(0.8, 1, 1.2); tm.position.set(0, 0.03, -0.03); tail.add(tm);
  tail.rotation.x = -0.8;   // ぴんと上向きのちぎれ尻尾
  const legs = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = new THREE.Group(); leg.position.set(sx * 0.09, 0.1, sz * 0.17);
    const lm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.07), DOG); lm.position.y = -0.035;
    const paw = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.05, 0.078), CAT_W); paw.position.y = -0.085;
    leg.add(lm, paw); lift.add(leg); legs.push(leg);
  }
  return { root, lift, body, head, eyes, legs, flippers: null, ears, tail, bodyY: 0.21 };
}

// 豚(ピンクのまんまる+平らな鼻先+前垂れ耳+くるん尻尾)
function makePig() {
  const { root, lift } = baseRig(1.0, 0.8);
  const body = new THREE.Group(); body.position.y = 0.27; lift.add(body);
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.24, 9, 7), PIG);
  torso.scale.set(0.95, 0.85, 1.2); body.add(torso);
  const head = new THREE.Group(); head.position.set(0, 0.06, 0.3); body.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), PIG);
  skull.scale.set(0.95, 0.88, 0.9); head.add(skull);
  const snout = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.075, 0.07, 8).rotateX(Math.PI / 2), PIG_D);
  snout.position.set(0, -0.03, 0.16); head.add(snout);
  const eyes = [];
  addEyes(head, eyes, 0.032, 0.08, 0.045, 0.13);
  const ears = [];
  for (const sx of [-1, 1]) {
    const ear = new THREE.Group(); ear.position.set(sx * 0.09, 0.12, 0.02);
    const em = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.11, 4), PIG_D);
    em.position.y = 0.045; ear.add(em);
    ear.rotation.x = 0.75;             // 目の上に前垂れ
    ear.userData.restZ = -sx * 0.15;
    ear.rotation.z = ear.userData.restZ;
    head.add(ear); ears.push(ear);
  }
  // くるんと巻いた尻尾(小球3つの渦)
  const tail = new THREE.Group(); tail.position.set(0, 0.1, -0.29); body.add(tail);
  const tGeo = new THREE.SphereGeometry(0.028, 5, 4);
  for (const [x, y, z, s] of [[0.02, 0.01, -0.02, 1], [0.05, 0.04, -0.01, 0.85], [0.03, 0.07, 0.01, 0.7]]) {
    const t = new THREE.Mesh(tGeo, PIG_D);
    t.position.set(x, y, z); t.scale.setScalar(s);
    tail.add(t);
  }
  const legs = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = new THREE.Group(); leg.position.set(sx * 0.13, 0.16, sz * 0.15);
    const lm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.09), PIG); lm.position.y = -0.06;
    const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.05, 0.095), HOOF); hoof.position.y = -0.135;
    leg.add(lm, hoof); lift.add(leg); legs.push(leg);
  }
  return { root, lift, body, head, eyes, legs, flippers: null, ears, tail, bodyY: 0.27 };
}

// トナカイ(枝角+白い胸元+赤鼻。サンタの相棒なのでペンに入れず柵の左側を自由に歩く)
function makeReindeer() {
  const { root, lift } = baseRig(1.6, 1.1);
  const body = new THREE.Group(); body.position.y = 0.56; lift.add(body);
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.4, 9, 7), DEER);
  torso.scale.set(0.72, 0.6, 1.22); body.add(torso);
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), DEER_C);
  chest.scale.set(1.0, 0.8, 0.7); chest.position.set(0, -0.02, 0.42); body.add(chest);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.15, 0.4, 8), DEER);
  neck.position.set(0, 0.26, 0.4); neck.rotation.x = 0.5; body.add(neck);
  const head = new THREE.Group(); head.position.set(0, 0.44, 0.52); body.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.2, 9, 7), DEER);
  skull.scale.set(0.82, 0.82, 1.05); head.add(skull);
  const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), DEER_D);
  muzzle.scale.set(0.9, 0.75, 0.95); muzzle.position.set(0, -0.06, 0.2); head.add(muzzle);
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.05, 7, 6), RED_NOSE); // ルドルフの赤鼻
  nose.position.set(0, -0.05, 0.29); head.add(nose);
  const eyes = [];
  addEyes(head, eyes, 0.042, 0.115, 0.045, 0.15);
  const ears = [];
  for (const sx of [-1, 1]) {
    const ear = new THREE.Group(); ear.position.set(sx * 0.11, 0.12, -0.02);
    const em = new THREE.Mesh(new THREE.SphereGeometry(0.07, 7, 5), DEER);
    em.scale.set(1.5, 0.5, 0.7); em.position.x = sx * 0.08; ear.add(em);
    ear.userData.restZ = -sx * 0.3;
    ear.rotation.z = ear.userData.restZ;
    head.add(ear); ears.push(ear);
  }
  // 枝角(主幹+前向きの枝2本を左右に。外へ開いて後ろへ流す)
  for (const sx of [-1, 1]) {
    const ant = new THREE.Group(); ant.position.set(sx * 0.09, 0.17, -0.05);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.028, 0.34, 5), ANTLER);
    beam.position.y = 0.15; ant.add(beam);
    const t1 = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.02, 0.16, 5), ANTLER);
    t1.position.set(0, 0.12, 0.05); t1.rotation.x = -0.9; ant.add(t1);
    const t2 = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.018, 0.12, 5), ANTLER);
    t2.position.set(0, 0.24, 0.04); t2.rotation.x = -0.7; ant.add(t2);
    ant.rotation.z = -sx * 0.35;
    ant.rotation.x = -0.35;
    head.add(ant);
  }
  const tail = new THREE.Group(); tail.position.set(0, 0.14, -0.56); body.add(tail);
  tail.add(new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5), DEER_C));
  const legs = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const leg = new THREE.Group(); leg.position.set(sx * 0.19, 0.38, sz * 0.34);
    const lm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.34, 0.12), DEER); lm.position.y = -0.17;
    const hoof = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.07, 0.13), HOOF); hoof.position.y = -0.355;
    leg.add(lm, hoof); lift.add(leg); legs.push(leg);
  }
  return { root, lift, body, head, eyes, legs, flippers: null, ears, tail, bodyY: 0.56 };
}

/* ================= 種ごとの性格(速度・歩幅・とる行動と重み) ================= */
// hit: なでタップの当たり球 [中心の高さ, 半径]。指先で押しやすいよう実体よりやや大きめ
const SPECIES = {
  penguin: { make: makePenguin, speed: 0.62, turn: 7,   freq: 9.5, amp: 0,   hit: [0.3, 0.45],
             acts: [['wander', 3], ['idle', 2], ['flap', 1.3], ['hop', 1]] },
  cow:     { make: makeCow,     speed: 0.45, turn: 4.5, freq: 5.5, amp: 0.5, hit: [0.55, 0.75],
             acts: [['wander', 2.4], ['idle', 2], ['graze', 3.2]] },
  goat:    { make: makeGoat,    speed: 0.85, turn: 8,   freq: 8.5, amp: 0.7, hit: [0.42, 0.6],
             acts: [['wander', 3], ['idle', 1.6], ['graze', 2.2], ['hop', 1.1], ['rock', 1.5]] },
  cat:     { make: makeCat,     speed: 0.95, turn: 9,   freq: 9,   amp: 0.55, hit: [0.25, 0.45],
             acts: [['wander', 3], ['idle', 1.2], ['sit', 1.6], ['nap', 1.6]] },
  sheep:   { make: makeSheep,   speed: 0.5,  turn: 5,   freq: 6,   amp: 0.5, hit: [0.45, 0.62],
             acts: [['wander', 2.6], ['idle', 2], ['graze', 3], ['hop', 0.9]] },   // hop=プロンク
  horse:   { make: makeHorse,   speed: 0.7,  turn: 4.5, freq: 6.5, amp: 0.55, hit: [0.65, 0.8],
             acts: [['wander', 3], ['idle', 2], ['graze', 2.8], ['toss', 1.2]] },
  rabbit:  { make: makeRabbit,  speed: 1.1,  turn: 10,  freq: 10,  amp: 0,   hit: [0.24, 0.45],
             acts: [['wander', 3.4], ['idle', 2], ['perk', 1.8]] },
  pig:     { make: makePig,     speed: 0.6,  turn: 6,   freq: 7,   amp: 0.55, hit: [0.3, 0.55],
             acts: [['wander', 2.8], ['idle', 2], ['graze', 3], ['hop', 0.7]] },   // graze=鼻掘り
  dog:     { make: makeDog,     speed: 1.15, turn: 9,   freq: 10,  amp: 0.6, hit: [0.28, 0.5],
             acts: [['patrol', 3.2], ['idle', 1.8], ['sit', 1.5], ['stretch', 1.3]] }, // stretch=プレイバウ
  reindeer:{ make: makeReindeer,speed: 0.65, turn: 5,   freq: 6.5, amp: 0.55, hit: [0.7, 0.85],
             acts: [['wander', 3], ['idle', 2], ['graze', 2.4], ['toss', 1.2], ['hop', 0.6]] },
};

// ペンの中で暮らす種(moveTowardの柵内クランプ対象)。cat/rabbit/dog/reindeerは柵の外の縄張りを持つ
const PEN_KINDS = new Set(['penguin', 'cow', 'goat', 'sheep', 'horse', 'pig']);

// 犬の巡回路(柵の外周を回る4隅。干し草ベールより内側=すり抜けない)
const PATROL_RING = [
  { x: RANCH_LAYOUT.hw + 0.85, z: RANCH_LAYOUT.hd + 0.9 },
  { x: RANCH_LAYOUT.hw + 0.85, z: -(RANCH_LAYOUT.hd + 0.9) },
  { x: -(RANCH_LAYOUT.hw + 0.85), z: -(RANCH_LAYOUT.hd + 0.9) },
  { x: -(RANCH_LAYOUT.hw + 0.85), z: RANCH_LAYOUT.hd + 0.9 },
];

// ハート(なでリアクション)。テクスチャは全ハートで1枚共有、スプライトはRanchAnimalsがプールする
let _heartTex = null;
function heartTexture() {
  if (_heartTex) return _heartTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = '46px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('❤️', 32, 36);
  _heartTex = new THREE.CanvasTexture(c);
  return _heartTex;
}

// なでタップの当たり判定用テンポラリ(タップ時のみ使用)
const _PET_SPHERE = new THREE.Sphere();
const _PET_HIT = new THREE.Vector3();
const _PET_GP = new THREE.Vector3();

// 「💤」スプライト(猫のお昼寝)。CanvasTextureで1個ずつ生成(牧場に猫は1匹なのでプール不要)
function makeZzz() {
  const c = document.createElement('canvas');
  c.width = 96; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = '44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('💤', 48, 34);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  sp.scale.set(0.62, 0.42, 1);
  sp.renderOrder = 6;
  sp.visible = false;
  return sp;
}

/* ================= 行動AI ================= */

// 線分(x1,z1)-(x2,z2)が矩形[rx1..rx2]×[rz1..rz2]を通るか(スラブ法)。障害物すり抜け防止用
function segHitsRect(x1, z1, x2, z2, rx1, rz1, rx2, rz2) {
  const dx = x2 - x1, dz = z2 - z1;
  let t0 = 0, t1 = 1;
  for (const [p, d, lo, hi] of [[x1, dx, rx1, rx2], [z1, dz, rz1, rz2]]) {
    if (Math.abs(d) < 1e-9) { if (p < lo || p > hi) return false; continue; }
    let a = (lo - p) / d, b = (hi - p) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return true;
}

// 点(px,pz)と線分(x1,z1)-(x2,z2)の距離(岩の迂回判定用)
function segPointDist(x1, z1, x2, z2, px, pz) {
  const dx = x2 - x1, dz = z2 - z1;
  const len2 = dx * dx + dz * dz;
  const t = len2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (pz - z1) * dz) / len2));
  return Math.hypot(px - (x1 + dx * t), pz - (z1 + dz * t));
}

// 小屋の矩形(通れない)。壁の実寸+少し余白
const SHELTER_RECT = [-3.0, -2.6, -1.0, -1.2]; // [x1, z1, x2, z2]

// (x1,z1)→(x2,z2)がペン内の障害物(小屋・岩)を突き抜けないか
function penPathClear(x1, z1, x2, z2) {
  const L = RANCH_LAYOUT;
  if (segHitsRect(x1, z1, x2, z2, SHELTER_RECT[0], SHELTER_RECT[1], SHELTER_RECT[2], SHELTER_RECT[3])) return false;
  if (segPointDist(x1, z1, x2, z2, L.rock.x, L.rock.z) < 0.85) return false;
  return true;
}

// うろつき先の抽選。ペン内種は小屋/岩を「経路ごと」避ける。
// 猫=柵の右側の縦帯(ベッド/goodsのある側)、うさぎ=柵の手前の横帯(ゲート前の雪原)だけを縄張りに
// — 各帯の中の移動は柵と決して交差しない。
function sampleTarget(a) {
  const L = RANCH_LAYOUT;
  const px = a.p.root.position.x, pz = a.p.root.position.z;
  for (let i = 0; i < 12; i++) {
    let x, z;
    if (a.kind === 'cat') {
      x = rand(L.hw + 0.8, L.hw + 2.2); z = rand(-3.8, 4.2);
      if (Math.hypot(x - L.bale.x, z - L.bale.z) < 1.0) continue;         // ベッドは寝るときだけ
    } else if (a.kind === 'rabbit') {
      x = rand(-5.2, 5.2); z = rand(L.hd + 0.8, L.hd + 2.2);
    } else if (a.kind === 'reindeer') {
      x = rand(-(L.hw + 2.2), -(L.hw + 0.8)); z = rand(-3.8, 4.2);        // 柵の左の縦帯
    } else {
      const big = a.kind === 'cow' || a.kind === 'horse';
      const mx = big ? 2.8 : 3.2;
      x = rand(-mx, mx); z = rand(-2.4, big ? 1.0 : 1.2);
      if (x < -1.0 && z < -1.1) continue;                                 // 小屋の中
      if (Math.hypot(x - L.rock.x, z - L.rock.z) < 0.95) continue;        // 岩の上
      if (!penPathClear(px, pz, x, z)) continue;                          // 経路が小屋/岩を跨ぐ
    }
    return { x, z };
  }
  if (a.kind === 'cat') return { x: L.hw + 1.3, z: 2.5 };
  if (a.kind === 'rabbit') return { x: 2.0, z: L.hd + 1.5 };
  if (a.kind === 'reindeer') return { x: -(L.hw + 1.5), z: -1.5 };
  return null;                                                            // null=今回は歩かない(idleへ)
}

// 次の行動を重み付き抽選(同じ行動の連続は避ける)
function pickNext(a) {
  const acts = a.spec.acts.filter(([name]) => name === 'wander' || name !== a.lastAct);
  let total = 0;
  for (const [, w] of acts) total += w;
  let r = Math.random() * total, act = 'idle';
  for (const [name, w] of acts) { r -= w; if (r <= 0) { act = name; break; } }
  a.lastAct = act;
  a.state = act; a.t = 0; a.phase = null; a.tgt = null;
  a.headPitchTgt = 0; a.bodyPitchTgt = 0;
  const L = RANCH_LAYOUT;
  const px = a.p.root.position.x, pz = a.p.root.position.z;
  if (act === 'idle')        { a.dur = rand(1.5, 3.5); a.lookT = rand(0.3, 0.9); }
  else if (act === 'wander') {
    a.dur = 12; a.tgt = sampleTarget(a);
    if (!a.tgt) { a.state = 'idle'; a.dur = 1; a.lookT = 0.5; }   // 良い行き先が無ければ一呼吸
  }
  else if (act === 'graze')  { a.dur = rand(2.5, 5.5); }
  else if (act === 'flap')   { a.dur = 0.75; }
  else if (act === 'hop')    { a.dur = 6; a.reps = Math.random() < 0.4 ? 2 : 1; }
  else if (act === 'rock')   {
    const ap = { x: L.rock.x, z: L.rock.z + 0.95 };
    if (penPathClear(px, pz, ap.x, ap.z)) { a.dur = 16; a.phase = 'go'; a.tgt = ap; }
    else { a.state = 'idle'; a.dur = 1; a.lookT = 0.5; }          // 小屋越しになる位置からは行かない
  }
  else if (act === 'nap')    { a.dur = 25; a.phase = 'go'; a.tgt = { x: L.bale.x, z: L.bale.z + 0.95 }; }
  else if (act === 'sit')    { a.dur = rand(3, 6); }
  else if (act === 'stretch'){ a.dur = 1.7; }
  else if (act === 'perk')   { a.dur = rand(1.6, 3); a.lookT = 0.2; }   // うさぎ: 立ち上がって見回す
  else if (act === 'toss')   { a.dur = 1.1; }                            // 馬/トナカイ: 頭をブルッと振る
  else if (act === 'patrol') {                                           // 犬: 柵の外周を巡回
    a.dur = rand(9, 15);
    if (a.wpDir === undefined || Math.random() < 0.3) a.wpDir = Math.random() < 0.5 ? 1 : -1;
    let best = 0, bd = 1e9;
    for (let k = 0; k < 4; k++) {
      const d = Math.hypot(PATROL_RING[k].x - px, PATROL_RING[k].z - pz);
      if (d < bd) { bd = d; best = k; }
    }
    a.wpIdx = best;
    a.tgt = PATROL_RING[best];
  }
}

// 放物線ホップを開始(その場ホップ or 岩/干し草への乗り降り)。next=着地後に入る状態
function startHop(a, tx, tz, ty, dur, h, next) {
  const p = a.p.root.position;
  a.hop = { phase: 'pre', t: 0, dur, h, fx: p.x, fz: p.z, fy: p.y, tx, tz, ty, next };
}

function animateHop(a, dt) {
  const hop = a.hop, p = a.p, pos = p.root.position;
  hop.t += dt;
  if (hop.phase === 'pre') {           // 予備動作: しゃがむ
    p.lift.scale.y += (0.8 - p.lift.scale.y) * Math.min(1, dt * 22);
    if (hop.t >= 0.09) {
      hop.phase = 'air'; hop.t = 0;
      const dx = hop.tx - hop.fx, dz = hop.tz - hop.fz;
      if (Math.hypot(dx, dz) > 0.05) p.root.rotation.y = Math.atan2(dx, dz);
    }
  } else if (hop.phase === 'air') {    // 放物線(既存フライトと同じ 4e(1-e) 形)
    const q = Math.min(1, hop.t / hop.dur);
    const e = q * q * (3 - 2 * q);
    pos.x = hop.fx + (hop.tx - hop.fx) * e;
    pos.z = hop.fz + (hop.tz - hop.fz) * e;
    pos.y = hop.fy + (hop.ty - hop.fy) * e + hop.h * 4 * e * (1 - e);
    p.lift.scale.y += (1.07 - p.lift.scale.y) * Math.min(1, dt * 14);
    if (q >= 1) { hop.phase = 'land'; hop.t = 0; pos.set(hop.tx, hop.ty, hop.tz); }
  } else {                             // 着地スカッシュ
    const k = Math.sin(Math.PI * Math.min(1, hop.t / 0.12));
    p.lift.scale.set(1 + 0.12 * k, 1 - 0.22 * k, 1 + 0.12 * k);
    if (hop.t >= 0.12) {
      p.lift.scale.set(1, 1, 1);
      const nx = hop.next;
      a.hop = null;
      if (nx) { a.state = nx.state; a.phase = nx.phase ?? null; a.dur = nx.dur ?? 1; a.t = 0; a.tgt = null; }
    }
  }
}

// 目標へ歩く(向きを滑らかに回し、概ね正面を向いてから進む)。到着でtrue
function moveToward(a, dt) {
  const pos = a.p.root.position, tgt = a.tgt;
  const dx = tgt.x - pos.x, dz = tgt.z - pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.14) { a.moving = false; return true; }
  faceAngle(a.p.root, Math.atan2(dx, dz), dt, a.spec.turn);
  const fx = Math.sin(a.p.root.rotation.y), fz = Math.cos(a.p.root.rotation.y);
  if ((dx * fx + dz * fz) / d > 0.25) {   // 進行方向をほぼ向いてから進む(その場旋回)
    const v = a.spec.speed * a.mul;
    pos.x += fx * v * dt;
    pos.z += fz * v * dt;
    if (PEN_KINDS.has(a.kind)) {          // ペン内種は柵からはみ出さない保険
      pos.x = Math.max(-3.5, Math.min(3.5, pos.x));
      pos.z = Math.max(-2.6, Math.min(2.6, pos.z));
    }
    a.moving = true;
    a.walkPhase += dt * a.spec.freq * a.mul;
  } else a.moving = false;
  return false;
}

function stateMachine(a, dt, mgr) {
  const L = RANCH_LAYOUT;
  a.t += dt;
  switch (a.state) {
    case 'idle':
      a.lookT -= dt;
      if (a.lookT <= 0) { a.headYawTgt = rand(-0.55, 0.55); a.lookT = rand(0.8, 2.0); }
      if (a.t >= a.dur) { a.headYawTgt = 0; pickNext(a); }
      break;
    case 'wander':
      if (!a.tgt || moveToward(a, dt) || a.t >= a.dur) pickNext(a);
      break;
    case 'graze':
      // 鼻先を地面へ+もぐもぐ(馬/トナカイは首が高いぶん深く下げる)
      a.headPitchTgt = (a.kind === 'horse' ? 1.15 : a.kind === 'reindeer' ? 1.0 : 0.95) + Math.sin(a.t * 9) * 0.06;
      a.bodyPitchTgt = a.kind === 'pig' ? 0.2 : 0.14;
      if (a.kind === 'pig') a.headYawTgt = Math.sin(a.t * 6.5) * 0.16;  // 豚は鼻先で左右にふりふり土を掘る
      if (a.t >= a.dur) { a.headYawTgt = 0; pickNext(a); }
      break;
    case 'patrol':  // 犬: 巡回路の角を順に回る(到着したら次の角へ)
      if (!a.tgt) a.tgt = PATROL_RING[a.wpIdx];
      if (moveToward(a, dt)) { a.wpIdx = (a.wpIdx + a.wpDir + 4) % 4; a.tgt = PATROL_RING[a.wpIdx]; }
      if (a.t >= a.dur) pickNext(a);
      break;
    case 'love': {  // なでられた喜び: プレイヤーの方を向いて跳ねる+ハート(犬は2回、うさぎは高く)
      if (a.loveFace !== null) faceAngle(a.p.root, a.loveFace, dt, 10);
      if (!a.love1 && a.t > 0.12) { a.love1 = true; a.reps = a.kind === 'dog' ? 2 : 1; }
      if (a.love1 && a.reps > 0 && !a.hop) {
        a.reps--;
        const pos = a.p.root.position;
        startHop(a, pos.x, pos.z, pos.y, 0.3, a.kind === 'rabbit' ? 0.24 : 0.16, null);
      }
      if (a.kind === 'penguin') {  // ペンギンは羽もパタパタ
        const k = Math.sin(Math.PI * Math.min(1, a.t / a.dur));
        for (const f of a.p.flippers ?? []) {
          const sx = f.userData.restZ > 0 ? 1 : -1;
          f.rotation.z = f.userData.restZ + sx * (0.5 * k + Math.sin(a.t * 24) * 0.4 * k);
        }
      }
      if (!a.love2 && a.t > 0.8) {  // 余韻の小ハート
        a.love2 = true;
        const pos = a.p.root.position;
        mgr.burstHearts(pos.x, pos.y + a.spec.hit[0] + a.spec.hit[1], pos.z, 2);
      }
      if (a.t >= a.dur) { a.love1 = a.love2 = false; a.headYawTgt = 0; pickNext(a); }
      break;
    }
    case 'perk': {  // うさぎ: 後ろ足で立ち上がり、耳をピンと立てて見回す
      a.bodyPitchTgt = -0.5;
      a.headPitchTgt = 0.25;   // 体が反るぶん頭は前へ(視線を水平に)
      a.lookT -= dt;
      if (a.lookT <= 0) { a.headYawTgt = rand(-0.6, 0.6); a.lookT = rand(0.5, 1.1); }
      if (a.t >= a.dur) { a.headYawTgt = 0; pickNext(a); }
      break;
    }
    case 'toss': {  // 馬: 頭を上げてブルッと振る(たてがみを揺らす仕草)
      const k = Math.sin(Math.PI * Math.min(1, a.t / a.dur));
      a.headPitchTgt = -0.4 * k;
      a.p.head.rotation.z = Math.sin(a.t * 16) * 0.16 * k;
      if (a.t >= a.dur) { a.p.head.rotation.z = 0; pickNext(a); }
      break;
    }
    case 'flap': {
      const k = Math.sin(Math.PI * Math.min(1, a.t / a.dur));
      for (const f of a.p.flippers ?? []) {
        const sx = f.userData.restZ > 0 ? 1 : -1;
        f.rotation.z = f.userData.restZ + sx * (0.65 * k + Math.sin(a.t * 26) * 0.45 * k);
      }
      if (a.phase !== 'hopped' && a.t > 0.16) { a.phase = 'hopped'; startHop(a, a.p.root.position.x, a.p.root.position.z, 0, 0.3, 0.15, null); }
      if (a.t >= a.dur) pickNext(a);
      break;
    }
    case 'hop':   // その場の喜びホップ(ヤギ/ペンギン)
      if (a.reps > 0) { a.reps--; startHop(a, a.p.root.position.x, a.p.root.position.z, 0, 0.32, 0.18, null); }
      else pickNext(a);
      break;
    case 'rock':  // ヤギ: 岩へ歩く→跳び乗る→得意げに見回す→降りる
      if (a.phase === 'go') {
        if (moveToward(a, dt) ) startHop(a, L.rock.x, L.rock.z, L.rock.top, 0.42, 0.32, { state: 'rock', phase: 'stand', dur: rand(2.5, 5) });
        else if (a.t >= a.dur) pickNext(a);
      } else if (a.phase === 'stand') {
        a.bodyPitchTgt = -0.07;   // 胸を張る
        a.lookT = (a.lookT ?? 0) - dt;
        if (a.lookT <= 0) { a.headYawTgt = rand(-0.7, 0.7); a.lookT = rand(0.7, 1.4); }
        if (a.t >= a.dur) { a.headYawTgt = 0; startHop(a, L.rock.x, L.rock.z + 0.95, 0, 0.42, 0.26, { state: 'idle', dur: 0.8 }); }
      }
      break;
    case 'nap':   // 猫: 干し草ロールへ→跳び乗る→座る→丸くなって寝る(💤)→起きる→降りて伸び
      if (a.phase === 'go') {
        if (moveToward(a, dt)) startHop(a, L.bale.x, L.bale.z, L.bale.top, 0.45, 0.32, { state: 'nap', phase: 'napSit', dur: rand(1.2, 2) });
        else if (a.t >= a.dur) pickNext(a);
      } else if (a.phase === 'napSit') {
        if (a.t >= a.dur) { a.phase = 'sleep'; a.t = 0; a.dur = rand(6, 11); }
      } else if (a.phase === 'sleep') {
        if (a.t >= a.dur) { a.phase = 'wakeSit'; a.t = 0; a.dur = 1.1; }
      } else if (a.phase === 'wakeSit') {
        if (a.t >= a.dur) startHop(a, L.bale.x, L.bale.z + 0.95, 0, 0.4, 0.28, { state: 'stretch', dur: 1.7 });
      }
      break;
    case 'sit':
      if (a.t >= a.dur) pickNext(a);
      break;
    case 'stretch': {  // 前脚を伸ばしてお尻を上げる
      const k = Math.sin(Math.PI * Math.min(1, a.t / a.dur));
      a.bodyPitchTgt = 0.4 * k;
      a.headPitchTgt = -0.32 * k;
      a.p.legs[0].rotation.x = -0.55 * k;
      a.p.legs[1].rotation.x = -0.55 * k;
      if (a.t >= a.dur) pickNext(a);
      break;
    }
  }
}

// 歩行(4足=対角の脚を交互に振る / ペンギン=よちよち / うさぎ=ぴょんぴょん)。止まったら減衰して静止へ
function gait(a, dt) {
  const p = a.p, s = Math.sin(a.walkPhase);
  const damp = Math.max(0, 1 - dt * 9);
  if (a.kind === 'rabbit') {
    // 跳ね移動: sinの正の山だけ宙に浮く。上昇でびよん、着地でぺたん、耳は後ろへふわっ
    const air = a.moving ? Math.max(0, s) : 0;
    p.lift.position.y += (air * 0.11 - p.lift.position.y) * Math.min(1, dt * 18);
    if (!a.hop) {
      p.lift.scale.y += (1 + air * 0.18 - p.lift.scale.y) * Math.min(1, dt * 14);
      const sxz = 1 - air * 0.06;
      p.lift.scale.x = sxz; p.lift.scale.z = sxz;
    }
    for (const leg of p.legs) leg.rotation.x += (air * 0.55 - leg.rotation.x) * Math.min(1, dt * 14); // 脚を畳む
    const earX = a.state === 'perk' ? 0.05 : -0.15 - air * 0.35;
    for (const ear of p.ears) ear.rotation.x += (earX - ear.rotation.x) * Math.min(1, dt * 10);
    return;
  }
  if (a.kind === 'penguin') {
    if (a.moving) {
      p.lift.rotation.z = s * 0.15;
      p.legs[0].rotation.x = s * 0.55;
      p.legs[1].rotation.x = -s * 0.55;
      p.body.position.y = p.bodyY + Math.abs(s) * 0.025;
    } else {
      p.lift.rotation.z *= damp;
      p.legs[0].rotation.x *= damp;
      p.legs[1].rotation.x *= damp;
      p.body.position.y = p.bodyY;
    }
    return;
  }
  if (a.moving) {
    const amp = a.spec.amp;
    p.legs[0].rotation.x = s * amp;
    p.legs[3].rotation.x = s * amp;
    p.legs[1].rotation.x = -s * amp;
    p.legs[2].rotation.x = -s * amp;
    p.body.position.y = p.bodyY + a.bodyYOff + Math.abs(s) * 0.035;
    p.body.rotation.z = s * 0.04;
  } else {
    if (a.state !== 'stretch') for (const leg of p.legs) leg.rotation.x *= damp;
    p.body.position.y = p.bodyY + a.bodyYOff;
    p.body.rotation.z *= damp;
  }
}

// 呼吸・まばたき・耳フリック・しっぽ・座り/眠りポーズなどの常時マイクロモーション
function micro(a, dt) {
  const p = a.p;
  // 呼吸(bodyのY縮尺だけを使う)
  a.breath += dt;
  p.body.scale.y = 1 + 0.022 * Math.sin(a.breath * 2.1);
  // まばたき
  a.blinkT -= dt;
  if (a.blinkT <= 0) { a.blinkT = rand(2.2, 5.5); a.blinkA = 0.13; }
  if (a.blinkA > 0) {
    a.blinkA = Math.max(0, a.blinkA - dt);
    const k = Math.sin(Math.PI * (1 - a.blinkA / 0.13));
    for (const e of p.eyes) e.scale.y = 1 - 0.88 * k;
  }
  // 耳フリック(たまに片耳がぴくっ)
  if (p.ears.length) {
    a.earT -= dt;
    if (a.earT <= 0 && !a.earA) { a.earT = rand(2, 7); a.earA = { ear: p.ears[Math.random() < 0.5 ? 0 : 1], t: 0.26 }; }
    if (a.earA) {
      a.earA.t -= dt;
      const ear = a.earA.ear;
      const k = Math.max(0, Math.sin(Math.PI * (1 - a.earA.t / 0.26)));
      ear.rotation.z = ear.userData.restZ * (1 + a.sleepK) + (ear.userData.restZ > 0 ? -1 : 1) * 0.5 * k;
      if (a.earA.t <= 0) a.earA = null;
    } else {
      for (const ear of p.ears) ear.rotation.z = ear.userData.restZ * (1 + a.sleepK); // 眠り中は倍垂れる
    }
  }
  // しっぽ
  a.tailT += dt;
  if (a.kind === 'cow' && p.tail) {
    const swish = a.state === 'graze' ? 2.6 : 1;
    p.tail.rotation.z = Math.sin(a.tailT * 1.5 * swish) * 0.22 * swish * 0.6;
  } else if (a.kind === 'goat' && p.tail) {
    const wag = (a.state === 'hop' || a.hop) ? 7 : 1.2;
    p.tail.rotation.z = Math.sin(a.tailT * wag) * (wag > 2 ? 0.35 : 0.12);
  } else if (a.kind === 'horse' && p.tail) {
    p.tail.rotation.z = Math.sin(a.tailT * 1.2) * 0.2;         // ふさふさを大きくゆったり
    p.tail.rotation.x = -0.15 + Math.sin(a.tailT * 0.7) * 0.1;
  } else if (a.kind === 'sheep' && p.tail) {
    const wag = (a.state === 'hop' || a.hop) ? 9 : 0;           // プロンク中だけ小さく震える
    p.tail.rotation.z = wag ? Math.sin(a.tailT * wag) * 0.3 : 0;
  } else if (a.kind === 'dog' && p.tail) {
    const fast = (a.moving || a.state === 'stretch' || a.state === 'love') ? 14 : 7; // 犬はいつでもフリフリ。遊ぶ時は高速
    p.tail.rotation.z = Math.sin(a.tailT * fast) * 0.4;
  } else if (a.kind === 'pig' && p.tail) {
    p.tail.rotation.y = Math.sin(a.tailT * (a.moving ? 8 : 2)) * 0.25;  // くるん尻尾がぷりぷり
  } else if (a.kind === 'reindeer' && p.tail) {
    p.tail.rotation.z = Math.sin(a.tailT * 1.4) * 0.12;
  } else if (a.kind === 'cat' && p.tail) {
    // 2節のS字スイング。眠り中は体に巻き付ける
    const wrap = a.sleepK;
    p.tail.rotation.z = Math.sin(a.tailT * 1.7) * 0.28 * (1 - wrap);
    p.tail.rotation.y = 1.25 * wrap;
    if (p.tail2) p.tail2.rotation.z = Math.sin(a.tailT * 1.7 - 0.9) * 0.4 * (1 - wrap);
  }
  // 頭の向き(見回し/草はみ)を滑らかに
  const hr = Math.min(1, dt * 6);
  p.head.rotation.y += (a.headYawTgt - p.head.rotation.y) * hr;
  p.head.rotation.x += (a.headPitchTgt + 0.55 * a.sleepK - p.head.rotation.x) * hr;
  // 体の前傾(草はみ/伸び/胸張り)+ 座り
  const sitTgt = (a.state === 'sit' || a.phase === 'napSit' || a.phase === 'wakeSit') ? 1 : 0;
  const sleepTgt = a.phase === 'sleep' ? 1 : 0;
  a.sitK += (sitTgt - a.sitK) * Math.min(1, dt * 6);
  a.sleepK += (sleepTgt - a.sleepK) * Math.min(1, dt * 3);
  p.body.rotation.x += (a.bodyPitchTgt - 0.52 * a.sitK - p.body.rotation.x) * hr;
  a.bodyYOff = 0.05 * a.sitK - 0.05 * a.sleepK;
  // 座り=後脚を畳む(猫と犬) / 眠り=全身でまるくなる(猫のみ。liftごと潰す)
  const fold = Math.max(a.sitK, a.sleepK);
  if (a.kind === 'cat' || a.kind === 'dog') {
    p.legs[2].scale.y = 1 - 0.55 * fold;
    p.legs[3].scale.y = 1 - 0.55 * fold;
  }
  if (a.kind === 'cat') {
    if (!a.hop) {
      p.lift.scale.y += (1 - 0.45 * a.sleepK - p.lift.scale.y) * Math.min(1, dt * 5);
      const sxz = 1 + 0.06 * a.sleepK;
      p.lift.scale.x = sxz; p.lift.scale.z = sxz;
    }
    if (a.zzz) {
      a.zzz.visible = a.sleepK > 0.6;
      if (a.zzz.visible) {
        const q = (a.tailT % 1.9) / 1.9;
        a.zzz.position.set(0.14, 0.62 + q * 0.28, 0);
        a.zzz.material.opacity = Math.sin(Math.PI * q);
      }
    }
  }
}

function updateAnimal(a, dt, mgr) {
  if (a.hop) animateHop(a, dt);
  else stateMachine(a, dt, mgr);
  gait(a, dt);
  micro(a, dt);
}

/* ================= 管理クラス(build.jsの_ranchPenMeshが生成し、BuildSite.updateが毎フレーム呼ぶ) ================= */
export class RanchAnimals {
  constructor(parent) {
    this.animals = [];
    this._parent = parent;
    this._hearts = [];      // 表示中: {sp, t, dur, x, y, z, vy, ph, s}
    this._heartPool = [];
    const defs = [   // [種, x, z, 個体差(速さ/歩調の倍率)]
      ['penguin', -0.9,  0.5, 1.0],
      ['penguin',  0.8, -0.5, 1.18],
      ['cow',     -1.6, -0.9, 1.0],
      ['goat',     1.1,  0.4, 1.0],
      ['sheep',   -0.3,  1.2, 1.0],
      ['horse',    0.4, -1.7, 1.0],
      ['pig',      2.2,  0.6, 1.0],
      ['cat',      5.5,  1.6, 1.0],
      ['rabbit',   2.0,  4.3, 1.0],
      ['dog',      0.5,  3.9, 1.0],
      ['reindeer', -5.5,  0.5, 1.0],
    ];
    for (const [kind, x, z, mul] of defs) {
      const spec = SPECIES[kind];
      const p = spec.make();
      p.root.position.set(x, 0, z);
      p.root.rotation.y = Math.random() * Math.PI * 2;
      parent.add(p.root);
      const a = {
        kind, spec, p, mul,
        state: 'idle', t: 0, dur: rand(0.5, 2.5), phase: null, tgt: null, lastAct: '',
        walkPhase: Math.random() * 6, moving: false, reps: 0, hop: null,
        headYawTgt: 0, headPitchTgt: 0, bodyPitchTgt: 0, bodyYOff: 0, lookT: 1,
        blinkT: rand(1, 4), blinkA: 0, earT: rand(2, 6), earA: null,
        breath: Math.random() * 6, tailT: Math.random() * 6,
        sitK: 0, sleepK: 0, zzz: null,
        love1: false, love2: false, loveFace: null,
      };
      if (kind === 'cat') { a.zzz = makeZzz(); p.root.add(a.zzz); }
      this.animals.push(a);
    }
  }

  update(dt) {
    for (const a of this.animals) updateAnimal(a, dt, this);
    // ハートの浮遊アニメ(上昇+ゆらゆら+ポップイン+フェードアウト。使い終わったらプールへ)
    for (let i = this._hearts.length - 1; i >= 0; i--) {
      const h = this._hearts[i];
      h.t += dt;
      const q = h.t / h.dur;
      if (q >= 1) {
        this._parent.remove(h.sp);
        this._hearts.splice(i, 1);
        this._heartPool.push(h);
        continue;
      }
      h.y += h.vy * dt * (1 - q * 0.55);
      h.sp.position.set(h.x + Math.sin(h.t * 5 + h.ph) * 0.07, h.y, h.z);
      const sc = h.s * Math.min(1, h.t / 0.14);
      h.sp.scale.set(sc, sc, 1);
      h.sp.material.opacity = q > 0.62 ? 1 - (q - 0.62) / 0.38 : 1;
    }
  }

  // ハートを n 個まきあげる(ペングループのローカル座標)。連打対策で同時24個まで
  burstHearts(x, y, z, n) {
    for (let i = 0; i < n && this._hearts.length < 24; i++) {
      let h = this._heartPool.pop();
      if (!h) {
        const mat = new THREE.SpriteMaterial({ map: heartTexture(), transparent: true, depthTest: false });
        const sp = new THREE.Sprite(mat);
        sp.renderOrder = 7;
        h = { sp };
      }
      h.t = 0;
      h.dur = 0.9 + Math.random() * 0.35;
      h.x = x + rand(-0.2, 0.2);
      h.y = y + rand(0, 0.12);
      h.z = z + rand(-0.12, 0.12);
      h.vy = 0.85 + Math.random() * 0.3;
      h.ph = Math.random() * 6.28;
      h.s = 0.2 + Math.random() * 0.14;
      h.sp.position.set(h.x, h.y, h.z);
      h.sp.scale.set(0.001, 0.001, 1);
      h.sp.material.opacity = 1;
      this._parent.add(h.sp);
      this._hearts.push(h);
    }
  }

  // なでタップ判定。ray=ワールド座標のTHREE.Ray、playerPos=プレイヤーのワールド座標(向く先)。
  // 当たったら喜びリアクションを起こし {kind, x, z}(ワールド) を返す。外れなら null。
  petAt(ray, playerPos) {
    this._parent.getWorldPosition(_PET_GP);
    let best = null, bd = Infinity;
    for (const a of this.animals) {
      const p = a.p.root.position;
      _PET_SPHERE.center.set(_PET_GP.x + p.x, p.y + a.spec.hit[0], _PET_GP.z + p.z);
      _PET_SPHERE.radius = a.spec.hit[1];
      if (ray.intersectSphere(_PET_SPHERE, _PET_HIT)) {
        const d = _PET_HIT.distanceTo(ray.origin);
        if (d < bd) { bd = d; best = a; }
      }
    }
    if (!best) return null;
    this._love(best, playerPos ? { x: playerPos.x - _PET_GP.x, z: playerPos.z - _PET_GP.z } : null);
    const bp = best.p.root.position;
    return { kind: best.kind, x: _PET_GP.x + bp.x, z: _PET_GP.z + bp.z };
  }

  // 喜びリアクション開始。ベール/岩の上・乗り降り・跳躍中は位置が壊れるので「ハートだけ」
  // (寝ている猫をなでるとハートが出る=そのままでもかわいい)。それ以外はloveステートへ。
  _love(a, playerLocal) {
    const p = a.p.root.position;
    this.burstHearts(p.x, p.y + a.spec.hit[0] + a.spec.hit[1] + 0.1, p.z, 4);
    const delicate = a.hop || p.y > 0.05 ||
      a.phase === 'napSit' || a.phase === 'sleep' || a.phase === 'wakeSit' || a.phase === 'stand';
    if (delicate) return;
    a.state = 'love'; a.t = 0; a.dur = 1.5; a.phase = null; a.tgt = null;
    a.love1 = false; a.love2 = false;
    a.headPitchTgt = 0; a.bodyPitchTgt = 0;
    a.moving = false;
    a.loveFace = playerLocal ? Math.atan2(playerLocal.x - p.x, playerLocal.z - p.z) : null;
  }
}
