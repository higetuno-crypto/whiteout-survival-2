import * as THREE from 'three';
import { createRenderer, lambert } from './render.js';
import { Economy } from './economy.js';
import { makeCharacter, animateWalk, faceAngle, SANTA_COLORS, StackCarrier } from './entities.js';
import { World } from './world.js';
import { BuildManager } from './build.js';
import { ShopSystem } from './shop.js';
import { ProximityAction } from './proximity.js';
import { UI } from './ui.js';

window.__booted = true;
// CDN不達タイマーを解除(8秒経過後に読み込み成功した場合の#fatal出っぱなしを防ぐ)
clearTimeout(window.__cdnTimer);
document.getElementById('fatal').style.display = 'none';
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';

let R;
try {
  R = createRenderer();
  document.body.appendChild(R.renderer.domElement);
} catch (e) {
  const f = document.getElementById('fatal');
  f.style.display = 'flex';
  f.textContent = 'この端末では3D表示(WebGL)を利用できないため、ゲームを開始できません。';
  throw e;
}
const { renderer, scene, camera } = R;

// 仮の雪原(proto-a.html 118-133行の起伏つき地面をコピー)
{
  const snowGeo = new THREE.PlaneGeometry(240, 240, 48, 48);
  snowGeo.rotateX(-Math.PI / 2);
  const p = snowGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const d = Math.hypot(x, z);
    if (d > 19) {
      const fade = Math.min(1, (d - 19) / 14);
      const n = Math.sin(x * 0.35) * Math.cos(z * 0.27) + Math.sin(x * 0.13 + z * 0.21) * 0.7;
      p.setY(i, n * 0.38 * fade);
    }
  }
  scene.add(new THREE.Mesh(snowGeo, lambert(0xe8edf5)));
}

const eco = new Economy();

// プレイヤー(2頭身サンタ)
const player = makeCharacter(SANTA_COLORS);
player.root.position.set(0, 0, 2);
scene.add(player.root);

// 背中スタック(見た目のみ。内部数の真実はeco.resources)
const carrier = new StackCarrier(player.root);

// ワールド(エリアごとのコンテンツ)。campエリア(cx=0,cz=0)基準に木を2本配置。
const world = new World(scene);
world.addTree(-10, -6, 1.0);
world.addTree(10, -6, 0.85);

// 建設予定地(campの3施設: fence_camp/shop_camp/fire_camp)
const buildMgr = new BuildManager(scene, world, eco);
buildMgr.spawnSitesForArea('camp');

// 売店の自動売却 + マネータワー(T9のロジックはShopSystemへ抽出済み)
const shopSystem = new ShopSystem(scene, eco);

// HUD + アップグレードUI + トースト
const ui = new UI(eco, { onUpgrade: key => { if (eco.buyUpgrade(key)) ui.toast('強化した!'); } });

// カメラ初期化(proto-a 51行 + 412-415行と同様)
const CAM_OFF = new THREE.Vector3(0, 20, 12); // 見下ろし約59度
const lookPos = player.root.position.clone().setY(1.2);
camera.position.copy(player.root.position).add(CAM_OFF);
camera.lookAt(lookPos);

// ==== 入力(仮想ジョイスティック + WASD) ====
const input = { x: 0, z: 0 };            // -1..1 の移動方向(ワールドXZ)
const keys = new Set();
let touchOrigin = null, touchId = null;   // 最初のポインタのIDだけ追跡(マルチタッチで壊れない)
addEventListener('pointerdown', e => {
  if (touchId !== null) return;                     // 既に操作中の指がある
  if (e.target.closest && e.target.closest('button')) return;
  touchId = e.pointerId;
  touchOrigin = { x: e.clientX, y: e.clientY };
});
addEventListener('pointermove', e => {
  if (e.pointerId !== touchId || !touchOrigin) return;
  const dx = e.clientX - touchOrigin.x, dy = e.clientY - touchOrigin.y;
  const len = Math.hypot(dx, dy);
  if (len < 8) { input.x = 0; input.z = 0; return; }
  const c = Math.min(1, len / 60);
  input.x = dx / len * c; input.z = dy / len * c;   // 画面上=奥(-Z)なのでdyはそのまま+Z
});
function endTouch(e) {
  if (e && e.pointerId !== undefined && e.pointerId !== touchId) return;
  touchId = null; touchOrigin = null; input.x = 0; input.z = 0;
}
addEventListener('pointerup', endTouch);
addEventListener('pointercancel', endTouch);   // 通知バナー/コントロールセンター対策(iOS Safari)
addEventListener('blur', () => { endTouch(); keys.clear(); });  // 画面外リリース対策(PC)。keysも消さないとWキー押下中のフォーカス喪失でkeyupを取り逃し歩き続ける
addEventListener('keydown', e => keys.add(e.key.toLowerCase()));
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
let keyActive = false;
function pollKeys() {
  let x = 0, z = 0;
  if (keys.has('w')) z -= 1; if (keys.has('s')) z += 1;
  if (keys.has('a')) x -= 1; if (keys.has('d')) x += 1;
  if (x || z) {
    const l = Math.hypot(x, z);
    input.x = x / l; input.z = z / l;
    keyActive = true;
  } else if (keyActive) {
    input.x = 0; input.z = 0;   // キーを離した瞬間に一度だけ停止(ジョイスティック入力は消さない)
    keyActive = false;
  }
}

const clock = new THREE.Clock();
let walkPhase = 0;
const _camTgt = new THREE.Vector3(), _lookTgt = new THREE.Vector3(); // 毎フレームのVector3生成を回避

// 伐採(木の近くで立ち止まると自動で丸太を集める)。近接自動処理は ProximityAction に共通化。
// 挙動は T7 と不変: radius 2.2 / startDelay 0.5 / interval 0.35 / 要静止。
const chop = new ProximityAction({ radius: 2.2, startDelay: 0.5, interval: 0.35, requireStill: true });
let chopping = false;
function stopChopVisual() {
  player.bodyGroup.scale.set(1, 1, 1);
  player.bodyGroup.rotation.x = 0;
  for (const t of world.trees) t.foliage.rotation.set(0, 0, 0);
}

function step(dt) {
  pollKeys();
  const mv = Math.hypot(input.x, input.z);
  const moving = mv > 0.01;
  if (moving) {
    const speed = eco.speed();
    player.root.position.x += input.x * speed * dt;
    player.root.position.z += input.z * speed * dt;
    faceAngle(player.root, Math.atan2(input.x, input.z), dt, 11);
    walkPhase += dt * 11;
  }
  if (!chopping) animateWalk(player, walkPhase, moving, dt);

  // 伐採ロジック(半径2.2m以内の木の近くで立ち止まると発動。proto-a 429-451行を移植)
  const tree = moving ? null : world.nearestTree(player.root.position, chop.radius); // !moving時のみ探索
  const chopTicks = chop.update(!!tree, !moving, dt);
  const full = eco.totalCarried() >= eco.capacity();
  for (let i = 0; i < chopTicks; i++) {
    if (eco.add('log', 1) > 0) tree.pulse = 1;   // chopTicks>0 のとき tree は必ず非null
  }
  // 満杯時は伐採演出を止める(働いてるのに増えない見た目を防ぐ)
  if (chop.active && tree && !full) {
    chopping = true;
    // 伐採ボディバウンス(proto-a 437-442行)
    const w = chop.timer * (Math.PI * 2 / 0.3);
    player.bodyGroup.scale.y = 1 - 0.09 * (0.5 + 0.5 * Math.sin(w));
    player.bodyGroup.scale.x = player.bodyGroup.scale.z = 1 + 0.05 * (0.5 + 0.5 * Math.sin(w));
    player.bodyGroup.rotation.x = 0.1 + 0.14 * Math.sin(w);
    player.armL.rotation.x = player.armR.rotation.x = -1.1 + 0.85 * Math.sin(w + 0.6);
    // 木の揺れ
    tree.foliage.rotation.z = 0.045 * Math.sin(chop.timer * 46);
    tree.foliage.rotation.x = 0.032 * Math.sin(chop.timer * 37);
  } else {
    if (chopping) stopChopVisual(); // 伐採終了(移動・範囲外・満杯)でスケール/回転を戻す
    chopping = false;
  }
  world.update(dt);

  carrier.syncTo(eco.resources);
  carrier.update(dt, player.root, walkPhase, moving);
  // 納品(背中の丸太を建設予定地へ放物線で運ぶ)。eco.take→popVisualOf→deliverOne の順。
  buildMgr.update(dt, player.root.position, eco, carrier);
  // 売店の自動売却 + マネータワー + 売却品フライト(shop_camp完成で接続)
  const shopSite = buildMgr.sites.get('shop_camp');
  if (shopSite?.completed && !shopSystem.attached) shopSystem.attachShop(shopSite);
  shopSystem.update(dt, player.root.position, carrier);
  ui.update(dt);
  // カメラ追従(proto-a 608-612行と同じlerp)
  _camTgt.copy(player.root.position).add(CAM_OFF);
  camera.position.lerp(_camTgt, 1 - Math.exp(-3.5 * dt));
  _lookTgt.set(player.root.position.x, 1.2, player.root.position.z);
  lookPos.lerp(_lookTgt, 1 - Math.exp(-4 * dt));
  camera.lookAt(lookPos);
}
function loop() {
  requestAnimationFrame(loop);
  step(Math.min(clock.getDelta(), 0.05));
  renderer.render(scene, camera);
}
loop(); // 同期の初回実行で、非表示タブでも初回1フレームは必ず出る

if (DEBUG) {
  window.__game = {
    step, scene, camera, renderer, player, input, economy: eco, carrier, world, build: buildMgr, ui,
    shop: shopSystem,
    moneyTower: () => shopSystem.moneyTower,   // getter関数(未回収金の現在値を返す)
  };
  window.__game.cheat = {
    addResource: (k, n) => { eco.resources[k] += n; },   // 容量無視のチート(検証用)
    addMoney: n => { eco.money += n; },
    completeSite: id => { const s = buildMgr.sites.get(id); if (s) s.forceComplete(); }, // 予定地を即完成
    setMoneyTower: n => { shopSystem.restore(n); },      // 金額セット+タワー見た目再構築
  };
  document.getElementById('debug').style.display = 'flex';
}
