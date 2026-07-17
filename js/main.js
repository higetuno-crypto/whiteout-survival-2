import * as THREE from 'three';
import { createRenderer, lambert } from './render.js';
import { Economy } from './economy.js';
import { makeCharacter, animateWalk, faceAngle, SANTA_COLORS, StackCarrier } from './entities.js';
import { World, LAKE_WATER, pushOutOfRect, makeSprite } from './world.js';
import { BuildManager, dashedRect } from './build.js';
import { ShopSystem } from './shop.js';
import { ProximityAction } from './proximity.js';
import { UI } from './ui.js';
import { NpcManager } from './npc.js';
import { load, persist, CURRENT_VERSION } from './save.js';
import { AREAS, NPC_HIRE_COSTS } from './data.js';

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

// 雪原。プレイ圏(エリア群のある中心部)はほぼ平らな真っ白、遠景だけ緩やかな起伏。
// flatShading+強い起伏だと灰色のまだらに見える(オーナーFB「暗い」の一因)ため、
// 起伏はプレイ圏の外(d>52)に限定し、振幅も控えめにする。
{
  const snowGeo = new THREE.PlaneGeometry(240, 240, 48, 48);
  snowGeo.rotateX(-Math.PI / 2);
  const p = snowGeo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    const d = Math.hypot(x, z);
    if (d > 52) {
      const fade = Math.min(1, (d - 52) / 20);
      const n = Math.sin(x * 0.35) * Math.cos(z * 0.27) + Math.sin(x * 0.13 + z * 0.21) * 0.7;
      p.setY(i, n * 0.3 * fade);
    }
  }
  scene.add(new THREE.Mesh(snowGeo, lambert(0xf6f9fe, { flatShading: false })));
}

// ==== セーブのロード(シーン構築の前に読む) ====
const { save, corrupted } = load(localStorage);

const eco = new Economy();
// 保存状態を適用(resources/upgradesは新キー補完済みのsaveを重ねる)
eco.money = save.money;
eco.resources = { ...eco.resources, ...save.resources };
eco.upgrades = { ...eco.upgrades, ...save.upgrades };
// unlockedAreas は起動時に地形/施設を復元する(下のループ)。npcs は NpcManager 生成後に復元する(T14)。
let unlockedAreas = save.unlockedAreas;

// プレイヤー(2頭身サンタ)
const player = makeCharacter(SANTA_COLORS);
player.root.position.set(0, 0, 2);
scene.add(player.root);

// 背中スタック(見た目のみ。内部数の真実はeco.resources)
const carrier = new StackCarrier(player.root);

// ワールド(エリアごとのコンテンツ)と建設マネージャ。
const world = new World(scene);
const buildMgr = new BuildManager(scene, world, eco);

// 起動時: 解錠済みエリア(T10で保持していた unlockedAreas。campは常に含む)の地形+木+施設を復元。
// campの土地面/木・fence_camp/shop_camp/fire_camp もこのループ経由で生成される(演出なし)。
for (const id of unlockedAreas) {
  const area = AREAS.find(a => a.id === id);
  if (!area) continue;
  world.buildAreaTerrain(area, false);
  buildMgr.spawnSitesForArea(id, save.buildProgress);
}
// 解錠済みに隣接する未解錠エリアにロックパッドを出す(クリーンセーブなら camp隣接の4つ)。
world.refreshLockPads(unlockedAreas);

// T15: fishHut/ranchPenのsite固有ストックを復元(サイトが存在する=対応エリア解錠済みのときだけ)。
buildMgr.sites.get('fishhut')?.restoreStock(save.fishHutStock);
buildMgr.sites.get('ranchpen')?.restoreFed(save.ranchFed);
// T15【T10レビュー申し送り】bigmarketがセーブ復元時点で完成済みなら即座にhasMarket=trueにする。
// 忘れるとリロードのたびに売値が黙って1倍に戻る(hasMarketはEconomyの一時状態でセーブに含まれないため)。
if (buildMgr.sites.get('bigmarket')?.completed) eco.hasMarket = true;

// 売店の自動売却 + マネータワー(T9のロジックはShopSystemへ抽出済み)。未回収金を復元。
const shopSystem = new ShopSystem(scene, eco);
shopSystem.restore(save.moneyTower);

// 仲間NPC(伐採係/釣り係)。セーブの役割どおり再スポーン(支払いなし)。更新に必要な参照はctxで束ねて渡す。
const npcMgr = new NpcManager(scene);
npcMgr.restore(save.npcs);
const npcCtx = { world, buildMgr, shopSystem, eco };

// HUD + アップグレードUI + トースト + 手動セーブ
const ui = new UI(eco, {
  onUpgrade: key => { if (eco.buyUpgrade(key)) ui.toast('強化した!'); },
  onSave: () => { if (saveNow()) ui.toast('セーブしました'); },
});
// 破損セーブ検出時の通知(UI生成後=toastが動くようになってから)
if (corrupted) ui.toast('セーブデータが壊れていたため退避して新しく始めます');

// ==== セーブ書き出しの一元化 ====
function collectSave() {
  return {
    version: CURRENT_VERSION,
    money: eco.money,
    resources: { ...eco.resources },
    upgrades: { ...eco.upgrades },
    unlockedAreas,
    buildProgress: buildMgr.serialize(),
    npcs: npcMgr.serialize(),
    moneyTower: shopSystem.serialize(),
    padPaid,                              // 解錠パッドへの部分支払い(FB反映: 途中まで払った分を保持)
    fishHutStock: buildMgr.sites.get('fishhut')?.stock ?? 0,
    ranchFed: buildMgr.sites.get('ranchpen')?.fed ?? 0,
  };
}
// iOSプライベートモード等でlocalStorageのquota例外が飛ぶことがあるので握る。成功可否を返す。
const saveNow = () => {
  try {
    persist(localStorage, collectSave());
    return true;
  } catch {
    ui.toast('セーブに失敗しました(空き容量を確認)');
    return false;
  }
};
setInterval(saveNow, 10000);                 // 10秒ごとの自動保存
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); }); // 離脱時に保存

// ==== エリア解錠フロー(オーナーFB反映: 建設と同じ「納品スタック」方式) ====
// パッドに近づくと、丸太は1本ずつ・お金は札束(10金)ずつ自動で支払われ、パッド上に積まれる。
// 途中まで払った分は padPaid としてセーブされ、リロード後も残る。全額に達した瞬間に解放。
const padPaid = save.padPaid;   // { areaId: { money: n, log: n } } (migrateで補完・サニタイズ済み)
const padLogTick = new ProximityAction({ radius: 2.2, startDelay: 0.15, interval: 0.12, requireStill: false });
const padMoneyTick = new ProximityAction({ radius: 2.2, startDelay: 0.15, interval: 0.06, requireStill: false });
const _padFrom = new THREE.Vector3();

// 起動時: 部分支払い済みのパッドはラベルを「残額」に復元(積み荷の見た目はラベルが真実なので省略)
for (const [id, pad] of world.lockPads) {
  if (padPaid[id]) {
    const area = AREAS.find(a => a.id === id);
    if (area) world.padSetLabel(pad, padLabelText(padRemaining(area, padPaid[id])));
  }
}

function padRemaining(area, paid) {
  return {
    money: Math.max(0, (area.cost.money ?? 0) - paid.money),
    log: Math.max(0, (area.cost.log ?? 0) - paid.log),
  };
}
function padLabelText(rem) {
  const parts = [];
  if (rem.money > 0) parts.push(`💰${rem.money}`);
  if (rem.log > 0) parts.push(`🪵${rem.log}`);
  return parts.join(' ') || 'OPEN!';
}
// 全額支払われたパッドの解放処理(旧tryUnlockの演出部分)
function completeUnlock(id, area) {
  world.buildAreaTerrain(area, true);    // 出現演出つきで地形+木
  buildMgr.spawnSitesForArea(id, save.buildProgress);
  unlockedAreas.push(id);
  delete padPaid[id];                    // 支払い済み記録は不要になる
  world.refreshLockPads(unlockedAreas);  // このパッドは撤去(シュリンク)され、新たな隣接パッドが出る
  saveNow();
  ui.toast(`${area.name}を解放!`);
}
// 毎フレーム: 半径内のパッドへ支払いを進める。step()から呼ばれる。
function updatePadDelivery(dt, moving) {
  let near = null, nearId = null, nd = 2.2;
  for (const [id, pad] of world.lockPads) {
    const d = Math.hypot(player.root.position.x - pad.x, player.root.position.z - pad.z);
    if (d < nd) { nd = d; near = pad; nearId = id; }
  }
  const area = near ? AREAS.find(a => a.id === nearId) : null;
  const paid = near ? (padPaid[nearId] ??= { money: 0, log: 0 }) : null;
  const rem = near ? padRemaining(area, paid) : null;
  // 丸太の納品(1本ずつ)
  const logTicks = padLogTick.update(!!near && rem.log > 0 && eco.resources.log > 0, !moving, dt);
  for (let i = 0; i < logTicks && padRemaining(area, paid).log > 0; i++) {
    if (eco.take('log', 1) !== 1) break;
    paid.log += 1;
    const from = carrier.popVisualOf('log') ?? _padFrom.set(player.root.position.x, 1.4, player.root.position.z);
    world.padAddPaid(near, 'log', from);
  }
  // お金の納品(札束=10金ずつ)
  const moneyTicks = padMoneyTick.update(!!near && rem.money > 0 && eco.money > 0, !moving, dt);
  for (let i = 0; i < moneyTicks; i++) {
    const r = padRemaining(area, paid).money;
    const amt = Math.min(10, r, eco.money);
    if (amt <= 0) break;
    eco.money -= amt;
    paid.money += amt;
    _padFrom.set(player.root.position.x, 1.2, player.root.position.z);
    world.padAddPaid(near, 'money', _padFrom);
  }
  if (near) {
    const remNow = padRemaining(area, paid);
    world.padSetLabel(near, padLabelText(remNow));
    if (remNow.money <= 0 && remNow.log <= 0) completeUnlock(nearId, area);
  }
}

// ==== 雇用フロー(仲間の小屋 完成後、小屋の脇の雇用パッド → ダイアログ → NPCスポーン) ====
// パッドは npchut 完成後に出現。1秒静止で ui.showHireDialog、役割選択で支払い→NpcManager.hire。
// 4人雇用済みでパッドを撤去。コストは NPC_HIRE_COSTS[npcs.length](100/250/500/900)。
let hirePad = null; // { group, x, z, standTimer, cooldown, costSprite, shownCost }

function createHirePad(hutSite) {
  const x = hutSite.x - 4, z = hutSite.z;      // 小屋の脇(camp寄り)
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.add(dashedRect(2, 2));
  const icon = makeSprite('🤝', { cw: 128, ch: 128, font: 'bold 96px system-ui, sans-serif', sx: 1.3, sy: 1.3 });
  icon.position.set(0, 1.2, 0);
  group.add(icon);
  scene.add(group);
  hirePad = { group, x, z, standTimer: 0, cooldown: 0, costSprite: null, shownCost: -1 };
}
function refreshHirePadCost(cost) {
  if (hirePad.shownCost === cost) return;       // 変化時だけスプライトを作り直す
  hirePad.shownCost = cost;
  if (hirePad.costSprite) hirePad.group.remove(hirePad.costSprite);
  const s = makeSprite(`💰${cost}`, { cw: 256, ch: 128, font: 'bold 60px system-ui, sans-serif', sx: 2.2, sy: 0.9 });
  s.position.set(0, 0.4, 0);
  hirePad.group.add(s);
  hirePad.costSprite = s;
}
function removeHirePad() {
  if (hirePad) { if (hirePad.group.parent) hirePad.group.parent.remove(hirePad.group); hirePad = null; }
}
// 毎フレーム: 小屋完成 & 4人未満なら出す(コスト更新)。4人雇用済みなら撤去。
function ensureHirePad() {
  const hut = buildMgr.sites.get('npchut');
  if (!hut || !hut.completed) return;
  if (npcMgr.npcs.length >= NPC_HIRE_COSTS.length) { removeHirePad(); return; }
  if (!hirePad) createHirePad(hut);
  refreshHirePadCost(NPC_HIRE_COSTS[npcMgr.npcs.length]);
}
// ダイアログの役割ボタン。支払い可否をチェックして雇用。
function onHirePick(role) {
  if (npcMgr.npcs.length >= NPC_HIRE_COSTS.length) return;   // 満員(パッド消滅と競合しても安全)
  const cost = NPC_HIRE_COSTS[npcMgr.npcs.length];
  if (eco.money < cost) { ui.toast(`お金が足りない(💰${cost})`); return; }
  eco.money -= cost;
  npcMgr.hire(role);
  saveNow();
  ui.toast(role === 'lumber' ? '🪓 伐採係を雇った!' : '🎣 釣り係を雇った!');
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

// 伐採(木に近づくだけで自動で丸太を集める)。近接自動処理は ProximityAction に共通化。
// オーナーFB反映: 立ち止まり必須(requireStill)を廃止し、遅延も短縮。木には当たり判定が
// あるので「歩いて木にぶつかる→その場で切れ始める」が自然に成立する。
const chop = new ProximityAction({ radius: 2.2, startDelay: 0.25, interval: 0.35, requireStill: false });
let chopping = false;
function stopChopVisual() {
  player.bodyGroup.scale.set(1, 1, 1);
  player.bodyGroup.rotation.x = 0;
  for (const t of world.trees) t.foliage.rotation.set(0, 0, 0);
}

// 釣り(釣りスポットに近づくだけで自動で生魚を集める)。伐採より低頻度(1.2s間隔)。
// オーナーFB反映: 要静止を廃止(微小な入力ゆらぎで進捗リセットされる厳しさを解消)。
const fishAction = new ProximityAction({ radius: 2.0, startDelay: 0.4, interval: 1.2, requireStill: false });
let fishing = false;
const _backPos = new THREE.Vector3(); // 釣りフライトの着地目標(毎フレームのVector3生成を回避)

// 調理(焚き火完成後、半径2.2m内で生魚を持っていると0.8秒ごとに焼き魚へ変換)。
// 焚き火の周りは動いても調理継続でよい(requireStill: false)。fire_campはcampが常に解錠済みのため起動時から存在。
const cook = new ProximityAction({ radius: 2.2, startDelay: 0.4, interval: 0.8, requireStill: false });
const fireSite = buildMgr.sites.get('fire_camp');
const _cookBackPos = new THREE.Vector3(); // 調理フライトの戻り先(毎フレームのVector3生成を回避)

// T15製材(sawmill完成後、半径2.2m内で丸太を持っていると0.8秒ごとに板材へ変換。cookと同じ形)。
// forestエリアは未解錠のことがあるのでsiteは毎フレームMap参照(fireSiteのように起動時定数化できない)。
const saw = new ProximityAction({ radius: 2.2, startDelay: 0.4, interval: 0.8, requireStill: false });
const _sawBackPos = new THREE.Vector3();

// T15釣り小屋(fishHut完成後、半径2m内で0.1秒ごとに内部ストックを容量分だけ引き出す。納品と同じ形)。
const fishCollect = new ProximityAction({ radius: 2.0, startDelay: 0, interval: 0.1, requireStill: false });

// T15牧場(ranchPen完成後、半径2.2m内で魚を持っていると0.6秒ごとに1匹給餌。goodsが5個溜まったら給餌停止)。
const ranchFeed = new ProximityAction({ radius: 2.2, startDelay: 0.4, interval: 0.6, requireStill: false });
const RANCH_GOODS_PICK_RADIUS = 1.6; // ペン脇の未回収goodsに「触れる」判定半径

// 納品はサイト単位ではなく「配達者(deliverer)」単位に(T14)。プレイヤーは自分のタイマーで
// 最寄りの未完成サイトへ丸太を運ぶ。挙動はT8と不変(半径2.5m・0.1s間隔)。NPCは各自のアダプタを持つ。
const playerDeliverer = {
  pos: player.root.position,                                                   // 参照(毎フレーム同じインスタンスを書き換え)
  deliver: new ProximityAction({ radius: 2.5, startDelay: 0, interval: 0.1, requireStill: false }),
  takeLog: () => eco.take('log', 1),
  popLogVisual: () => carrier.popVisualOf('log'),
};
const deliverers = [playerDeliverer]; // buildMgr.updateへ渡す配列(定数=毎フレームの生成を回避)

// 湖エリアの土地rect(島の進入ゲート用)。lake は格子固定なので起動時に確定。
const LAKE_AREA = AREAS.find(a => a.id === 'lake');

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

  // --- 湖まわりの進入制限(移動適用の直後) ---
  // 1) lake島は橋(bridge_lake)完成まで進入不可: lake土rect全体から押し出す。
  if (LAKE_AREA && !buildMgr.sites.get('bridge_lake')?.completed) {
    pushOutOfRect(player.root.position, LAKE_AREA.cx, LAKE_AREA.cz, LAKE_AREA.hw, LAKE_AREA.hd);
  }
  // 2) 水面は常に進入不可: 視覚半幅+0.3マージンの水rectから押し出す。
  pushOutOfRect(player.root.position, LAKE_WATER.cx, LAKE_WATER.cz, LAKE_WATER.hw + 0.3, LAKE_WATER.hd + 0.3);
  // 3) 木の幹には当たり判定(すり抜けない)。近い木だけ円で押し出す。
  world.pushOutOfTrees(player.root.position, 0.75);

  if (!chopping && !fishing) animateWalk(player, walkPhase, moving, dt);

  // 伐採ロジック(木に近づけば自動発動。移動中もタイマーは進むが、演出は停止時のみ)
  const tree = world.nearestTree(player.root.position, chop.radius);
  const chopTicks = chop.update(!!tree, !moving, dt);
  const full = eco.totalCarried() >= eco.capacity();
  for (let i = 0; i < chopTicks; i++) {
    if (eco.add('log', 1) > 0) tree.pulse = 1;   // chopTicks>0 のとき tree は必ず非null
  }
  // 満杯時と移動中は伐採演出を止める(移動中は歩行アニメを優先)
  if (chop.active && tree && !full && !moving) {
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

  // 釣りロジック(釣りスポット半径2m内で立ち止まると 1.2秒ごとに生魚を1匹。要静止)。
  let atFishSpot = false;
  if (world.fishSpot) {
    const fd = Math.hypot(player.root.position.x - world.fishSpot.x, player.root.position.z - world.fishSpot.z);
    atFishSpot = fd <= fishAction.radius;
  }
  const fishTicks = fishAction.update(atFishSpot, !moving, dt);
  for (let i = 0; i < fishTicks; i++) {
    if (eco.add('rawFish', 1) > 0) {                        // 容量があるときだけ釣れる
      _backPos.set(player.root.position.x, 1.8, player.root.position.z); // 背中付近を狙う
      world.spawnFishCatch(_backPos);                       // 水面→背中フライト + 水しぶき
    }
  }
  // 釣り中の演出: 竿なし・体を軽く揺らす(満杯時は演出停止=働いても増えない見た目を防ぐ)。
  if (fishAction.active && atFishSpot && !full) {
    fishing = true;
    player.bodyGroup.rotation.x = 0.05 * Math.sin(fishAction.timer * 3);
  } else {
    if (fishing) player.bodyGroup.rotation.x = 0; // 釣り終了で前傾を戻す
    fishing = false;
  }

  // 調理ロジック(焚き火完成後、半径2.2m内で生魚を持っていると0.8秒ごとに1匹変換。要静止なし=歩いても継続)。
  // 生魚が尽きたら hasRawFish が false になり ProximityAction がリセットされる(売店のhasSellableと同じ形)。
  if (fireSite) {
    const hasRawFish = (eco.resources.rawFish ?? 0) > 0;
    const cd = Math.hypot(player.root.position.x - fireSite.x, player.root.position.z - fireSite.z);
    const atFire = fireSite.completed && cd <= cook.radius;
    const cookTicks = cook.update(atFire && hasRawFish, true, dt);
    for (let i = 0; i < cookTicks; i++) {
      if (eco.take('rawFish', 1) !== 1) break;
      eco.resources.cookedFish += 1; // 容量は「入れ替え」なので直接加算(eco.addは満杯時に消失するリスクがある)
      const from = carrier.popVisualOf('rawFish') ?? new THREE.Vector3(player.root.position.x, 1.7, player.root.position.z);
      _cookBackPos.set(player.root.position.x, 1.8, player.root.position.z);
      fireSite.cookFish(from, _cookBackPos);
    }
    fireSite.cooking = cook.active; // 調理中は炎を強める演出フラグ(BuildSite.updateが参照)
  }

  // T15製材(sawmill完成後、半径2.2m内で丸太を持っていると0.8秒ごとに板材へ1本変換。cookと同じ形)。
  // forestが未解錠だとsiteはundefined(毎フレームMap参照。fire_campと違い起動時に存在保証がないため)。
  const sawSite = buildMgr.sites.get('sawmill');
  if (sawSite) {
    const hasLog = (eco.resources.log ?? 0) > 0;
    const sd = Math.hypot(player.root.position.x - sawSite.x, player.root.position.z - sawSite.z);
    const atSaw = sawSite.completed && sd <= saw.radius;
    const sawTicks = saw.update(atSaw && hasLog, true, dt);
    for (let i = 0; i < sawTicks; i++) {
      if (eco.take('log', 1) !== 1) break;
      eco.resources.plank += 1; // 入れ替えなので直接加算(cookedFishと同じ理由)
      const from = carrier.popVisualOf('log') ?? new THREE.Vector3(player.root.position.x, 1.7, player.root.position.z);
      _sawBackPos.set(player.root.position.x, 1.8, player.root.position.z);
      sawSite.craftItem(from, _sawBackPos, 'log', 'plank');
    }
  }

  // T15釣り小屋(fishHut完成後、半径2m内で0.1秒ごとに内部ストックを1匹ずつ引き出しeco.add('rawFish',1)。
  // 容量いっぱいならeco.addが0を返すので在庫は減らさず待つ(納品のtakeLogと対称の「容量分だけ」挙動)。
  const fishHutSite = buildMgr.sites.get('fishhut');
  if (fishHutSite) {
    const fd = Math.hypot(player.root.position.x - fishHutSite.x, player.root.position.z - fishHutSite.z);
    const atHut = fishHutSite.completed && fd <= fishCollect.radius && fishHutSite.stock > 0;
    const collectTicks = fishCollect.update(atHut, true, dt);
    for (let i = 0; i < collectTicks; i++) {
      if (fishHutSite.stock <= 0) break;
      const got = eco.add('rawFish', 1);
      if (got <= 0) break; // 容量いっぱい
      fishHutSite.stock -= 1;
      fishHutSite.setStockVisual(fishHutSite.stock);
      fishHutSite.spawnItemFlight('rawFish', fishHutSite.stockAnchor, new THREE.Vector3(player.root.position.x, 1.8, player.root.position.z));
    }
  }

  // T15牧場(ranchPen完成後、半径2.2m内で魚(rawFish優先、なければcookedFish)を持っていると
  // 0.6秒ごとに1匹給餌。未回収goodsが5個溜まったら給餌自体を止める(スペック通り)。
  // ペン脇のgoodsに触れる(半径1.6m)と eco.add('goods',1) で1個ずつ回収。
  const ranchSite = buildMgr.sites.get('ranchpen');
  if (ranchSite) {
    const rd = Math.hypot(player.root.position.x - ranchSite.x, player.root.position.z - ranchSite.z);
    const feedKind = (eco.resources.rawFish ?? 0) > 0 ? 'rawFish' : ((eco.resources.cookedFish ?? 0) > 0 ? 'cookedFish' : null);
    const canFeed = ranchSite.completed && rd <= ranchFeed.radius && feedKind && ranchSite.pendingGoods < 5;
    const feedTicks = ranchFeed.update(canFeed, true, dt);
    for (let i = 0; i < feedTicks; i++) {
      const kind = (eco.resources.rawFish ?? 0) > 0 ? 'rawFish' : 'cookedFish';
      if (eco.take(kind, 1) !== 1) break;
      const from = carrier.popVisualOf(kind) ?? new THREE.Vector3(player.root.position.x, 1.7, player.root.position.z);
      ranchSite.feedOne(from, kind);
    }
    if (ranchSite.pendingGoods > 0) {
      const gd = Math.hypot(player.root.position.x - ranchSite.goodsAnchor.x, player.root.position.z - ranchSite.goodsAnchor.z);
      if (gd <= RANCH_GOODS_PICK_RADIUS) {
        while (ranchSite.pendingGoods > 0) {
          const got = eco.add('goods', 1);
          if (got <= 0) break; // 容量いっぱい
          ranchSite.popGoods();
        }
      }
    }
  }

  // T15大市場: 完成の瞬間にhasMarket=trueへ(以後sellPriceが1.5倍)。起動時に完成済みの場合の
  // 復元はブート処理側(bigmarket?.completed → eco.hasMarket=true)で済んでいるので、ここは
  // 「このセッション中に初めてtrueになった」瞬間だけ検知してトーストを出す。
  if (!eco.hasMarket) {
    const marketSite = buildMgr.sites.get('bigmarket');
    if (marketSite?.completed) {
      eco.hasMarket = true;
      ui.toast('大市場オープン! 売値1.5倍');
    }
  }

  world.update(dt);

  // エリア解錠: パッドに近づくと丸太/お金が自動で納品されて積まれる(建設と同じ操作感)。
  updatePadDelivery(dt, moving);

  // 雇用パッド(小屋完成後): 半径2m内で1秒静止 → 雇用ダイアログ。ダイアログ表示中は蓄積しない。
  ensureHirePad();
  if (hirePad) {
    if (hirePad.cooldown > 0) hirePad.cooldown -= dt;
    if (!ui.hireOpen && hirePad.cooldown <= 0) {
      const d = Math.hypot(player.root.position.x - hirePad.x, player.root.position.z - hirePad.z);
      if (d <= 2.0 && !moving) {
        hirePad.standTimer += dt;
        if (hirePad.standTimer >= 1.0) {
          hirePad.standTimer = 0;
          hirePad.cooldown = 2.0;   // 閉じた直後の即再表示を防ぐ
          ui.showHireDialog(NPC_HIRE_COSTS[npcMgr.npcs.length], onHirePick);
        }
      } else {
        hirePad.standTimer = 0;
      }
    }
  }

  carrier.syncTo(eco.resources);
  carrier.update(dt, player.root, walkPhase, moving);
  // NPC(伐採係/釣り係)の自動作業。伐採係の納品(serveDeliverer)はここでサイトへ飛ぶので、
  // 下の buildMgr.update(=site.update)より前に回す(同フレームでフライトが処理される)。
  npcMgr.update(dt, npcCtx);
  // 納品(背中の丸太を建設予定地へ放物線で運ぶ)。配達者(=プレイヤー)ごとに最寄り未完成サイトへ。
  buildMgr.update(dt, deliverers);
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
    npcs: npcMgr,                               // count()/list()/serialize() を公開(検証プローブ用)
    get unlockedAreas() { return unlockedAreas; }, // 解錠済みエリアID配列(push で伸びる参照)
    save,                                       // ロード時のスナップショット
    saveNow,                                    // 即時保存
    collectSave,                                // 現在状態のセーブオブジェクトを生成
  };
  window.__game.cheat = {
    addResource: (k, n) => { eco.resources[k] += n; },   // 容量無視のチート(検証用)
    addMoney: n => { eco.money += n; },
    completeSite: id => { const s = buildMgr.sites.get(id); if (s) s.forceComplete(); }, // 予定地を即完成
    setMoneyTower: n => { shopSystem.restore(n); },      // 金額セット+タワー見た目再構築
    hireNpc: role => npcMgr.hire(role),                  // 支払いなしでNPCをスポーン(検証用)
    // 支払いなしで解錠処理一式(T12以降の検証用)。既に解錠済み/未知IDは無視。
    unlockArea: id => {
      const area = AREAS.find(a => a.id === id);
      if (!area || unlockedAreas.includes(id)) return;
      world.buildAreaTerrain(area, true);
      buildMgr.spawnSitesForArea(id, save.buildProgress);
      unlockedAreas.push(id);
      delete padPaid[id];
      world.refreshLockPads(unlockedAreas);
      saveNow();
    },
  };
  document.getElementById('debug').style.display = 'flex';
}
