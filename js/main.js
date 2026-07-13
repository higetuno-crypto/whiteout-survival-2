import * as THREE from 'three';
import { createRenderer, lambert } from './render.js';
import { Economy } from './economy.js';
import { makeCharacter, animateWalk, faceAngle, SANTA_COLORS, StackCarrier, createKindMesh } from './entities.js';
import { World } from './world.js';
import { BuildManager, MoneyTower } from './build.js';
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

// HUD + アップグレードUI + トースト
const ui = new UI(eco, { onUpgrade: key => { if (eco.buyUpgrade(key)) ui.toast('強化した!'); } });

/* ==== 売店の自動売却 + マネータワー ====
 * 売店(shop_camp)完成後、半径2.5m内に立つと0.12秒ごとに1個売却。
 * 売却対象は rawFish→cookedFish→plank→goods の優先順(丸太は建材なので売らない)。
 * 売値は売却時点の sellPrice で確定し moneyTower(未回収金)に積む。
 * タワー半径1.8m内で全額回収(HUDは即時、見た目は札束が1枚ずつ吸い込まれる)。 */
const SELL_ORDER = ['rawFish', 'cookedFish', 'plank', 'goods'];
const sell = new ProximityAction({ radius: 2.5, startDelay: 0, interval: 0.12, requireStill: false });
let moneyTower = 0;    // 未回収金(T10でセーブに接続)
let tower = null;      // MoneyTower(見た目)。売店完成後の初回updateShopで生成
const sellFlights = [];                 // {mesh, from, to, t, kind} 売却品の売店への小フライト
const sellPool = Object.fromEntries(SELL_ORDER.map(k => [k, []]));
const _towerTarget = new THREE.Vector3();

function launchSellFlight(kind, from, to) {
  const mesh = sellPool[kind].pop() ?? createKindMesh(kind);
  mesh.position.copy(from);
  scene.add(mesh);
  sellFlights.push({ mesh, from: from.clone(), to: to.clone(), t: 0, kind });
}

function updateSellFlights(dt) {
  // T8納品と同じ放物線(0.38秒・smoothstep)。到着で消滅(プールへ)
  for (let i = sellFlights.length - 1; i >= 0; i--) {
    const f = sellFlights[i];
    f.t += dt / 0.38;
    const p = Math.min(1, f.t);
    const e = p * p * (3 - 2 * p);
    f.mesh.position.lerpVectors(f.from, f.to, e);
    f.mesh.position.y += 1.6 * 4 * e * (1 - e);
    if (p >= 1) {
      scene.remove(f.mesh);
      sellPool[f.kind].push(f.mesh);
      sellFlights.splice(i, 1);
    }
  }
}

function updateShop(dt) {
  const shop = buildMgr.sites.get('shop_camp');
  if (!shop?.completed) return;
  if (!tower) tower = new MoneyTower(scene, shop.x + 2, shop.z); // 売店の脇(lx+2)
  const p = player.root.position;
  // 売却tick
  const dist = Math.hypot(p.x - shop.x, p.z - shop.z);
  const hasSellable = SELL_ORDER.some(k => (eco.resources[k] ?? 0) > 0);
  const ticks = sell.update(dist <= sell.radius && hasSellable, true, dt);
  for (let i = 0; i < ticks; i++) {
    const kind = SELL_ORDER.find(k => (eco.resources[k] ?? 0) > 0);
    if (!kind || eco.take(kind, 1) <= 0) break;
    moneyTower += eco.sellPrice(kind);   // 財布に直接入れず未回収金へ(売却時点の価格で確定)
    const from = carrier.popVisualOf(kind) ?? new THREE.Vector3(p.x, 1.7, p.z);
    launchSellFlight(kind, from, new THREE.Vector3(shop.x, 1.1, shop.z));
  }
  // 回収(HUDのmoneyは即時全額、見た目だけ順次飛ぶ)
  if (moneyTower > 0 && Math.hypot(p.x - tower.x, p.z - tower.z) <= 1.8) {
    eco.money += moneyTower;
    moneyTower = 0;
    tower.collect();
  }
  tower.setAmount(moneyTower);
  tower.update(dt, _towerTarget.set(p.x, 1.2, p.z));
}

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
  // 売店の自動売却 + マネータワー + 売却品フライト
  updateShop(dt);
  updateSellFlights(dt);
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
    moneyTower: () => moneyTower,   // getter関数(letの現在値を返す)
  };
  window.__game.cheat = {
    addResource: (k, n) => { eco.resources[k] += n; },   // 容量無視のチート(検証用)
    addMoney: n => { eco.money += n; },
    completeSite: id => { const s = buildMgr.sites.get(id); if (s) s.forceComplete(); }, // 予定地を即完成
    setMoneyTower: n => { moneyTower = n; },             // タワーは次stepのsetAmountで再構築される
  };
  document.getElementById('debug').style.display = 'flex';
}
