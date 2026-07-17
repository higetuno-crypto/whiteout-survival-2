// エリアごとのコンテンツ(土地面・木・ロックパッド・解放演出)を管理する器。
// 移植元: reference/proto-a.html 150-156行(土の地面) / 178-198行(makeTree) / 591-593行(木パルス減衰)
//        583-587行(easeOutBack) / 535-554行(放物線フライト)
import * as THREE from 'three';
import { lambert, blobShadow, roundedRectShape } from './render.js';
import { dashedRect } from './build.js';
import { createKindMesh } from './entities.js';
import { AREAS, areAreasAdjacent, RESOURCES } from './data.js';

// 湖の水面(視覚)の中心と半幅/半奥。魚の遊泳範囲・釣りフライトの出発点、
// および main.js の進入禁止クランプ(この値+0.3マージン)が参照する単一の真実。
export const LAKE_WATER = { cx: 0, cz: -26, hw: 5.5, hd: 3.5 };

// 矩形(中心cx,cz・半幅hx・半奥hz)内に pos があれば、最小貫入軸に沿って境界の少し外へ
// 押し出す(壁ずり移動)。中心一致時は +方向へ寄せる。プレイヤー(main.js)とNPC(npc.js)の
// 水面クランプで共有する(T12でmain.js内にあったものをT14で共有化)。
const CLAMP_EPS = 0.05;
export function pushOutOfRect(pos, cx, cz, hx, hz) {
  const dx = pos.x - cx, dz = pos.z - cz;
  if (Math.abs(dx) >= hx || Math.abs(dz) >= hz) return; // rect外なら何もしない
  const penX = hx - Math.abs(dx), penZ = hz - Math.abs(dz);
  if (penX < penZ) pos.x = cx + (dx >= 0 ? 1 : -1) * (hx + CLAMP_EPS);
  else             pos.z = cz + (dz >= 0 ? 1 : -1) * (hz + CLAMP_EPS);
}

/* ================= ローポリ松の木 ================= */
export function makeTree(scale) {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.42, 1.1, 7), lambert(0x8a5a33));
  trunk.position.y = 0.5;
  const foliage = new THREE.Group();
  foliage.position.y = 0.75;
  const tiers = [
    { r: 1.6, h: 1.8, y: 0.85, c: 0x42b342 },
    { r: 1.22, h: 1.55, y: 1.78, c: 0x4fc44f },
    { r: 0.85, h: 1.35, y: 2.62, c: 0x5cd35c },
  ];
  for (const t of tiers) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(t.r, t.h, 6), lambert(t.c));
    cone.position.y = t.y;
    cone.rotation.y = t.y * 2.1; // 段ごとに角度をずらしてカクカク感
    foliage.add(cone);
  }
  g.add(trunk, foliage, blobShadow(3.4, 3.0, 0.045));
  g.scale.setScalar(scale);
  return { group: g, foliage };
}

/* ================= エリア別コンテンツ・レジストリ =================
 * エリアID → { trees, build } のマップ。buildAreaTerrain が土(共通)を敷いた上で、
 *   trees: 植樹定義 [[lx, lz, scale], ...](中心からのローカル座標。省略/空なら植えない)
 *   build(world, area, animated): 追加コンテンツ(水面・魚・釣り場など)を生成する任意関数
 * を呼び出す。新エリアの中身はここに1エントリ足すだけで増やせる(木以外も扱える一般化)。
 * camp/forest は T7 の植樹をそのまま維持。lake は木を植えない(水面に木が生えないように)。 */
const AREA_CONTENT = {
  camp:   { trees: [[-10, -6, 1.0], [10, -6, 0.85]] },
  forest: { trees: [[-8, -6, 1.0], [8, -6, 0.9], [-9, 6, 0.95], [8, 6, 0.85], [0, -8, 1.05]] },
  lake:   { trees: [], build: buildLakeContent }, // 湖: 木なし + 水面/泳ぐ魚/釣り場
};
const DEFAULT_CONTENT = { trees: [[-9, -6, 0.8]] }; // エントリのないエリアは隅に1本

const DIRT_MAT = lambert(0xcaa470);      // 明るい暖色の土(参照動画のタン色に寄せる)
const RIM_MAT = lambert(0xb08a58);       // 土の縁取り(ひとまわり大きい下敷きで「島」感を出す)
const PATH_MAT = lambert(0xe3d5b8);      // 隣接エリアを繋ぐ踏み固めた道

/* ================= 湖のコンテンツ(水面・泳ぐ魚・釣り場) ================= */
const WATER_MAT = lambert(0x63b1e0);
// 泳ぐ魚: 扁平球(クマノミ風オレンジ)。scaleはジオメトリに焼き込み、rotation.yで進行方向を向ける。
const FISH_SWIM_GEO = new THREE.SphereGeometry(0.22, 8, 6).scale(1.4, 0.5, 0.7);
const FISH_SWIM_MAT = lambert(0xe8834a);
// 水しぶきの白い小球(釣り成功時に3個飛び散る)
const SPLASH_GEO = new THREE.SphereGeometry(0.08, 6, 5);
const SPLASH_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true });
// 釣りスポットのマーカー(水平の白リング)
const FISHSPOT_GEO = new THREE.TorusGeometry(0.55, 0.06, 6, 18).rotateX(-Math.PI / 2);
const FISHSPOT_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });

// lake エリアの追加コンテンツ。buildAreaTerrain から content.build として呼ばれる。
function buildLakeContent(world, area, animated) {
  // 水面: 角丸Plane。dirt(y=0.02)の上 y=0.04 に置く。ShapeGeometry は原点中心なので湖中心へ。
  const waterGeo = new THREE.ShapeGeometry(roundedRectShape(LAKE_WATER.hw, LAKE_WATER.hd, 1.5), 10);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(waterGeo, WATER_MAT);
  water.position.set(LAKE_WATER.cx, 0.04, LAKE_WATER.cz);
  world.scene.add(water);
  if (animated) world._animateIn(water, 1);

  // 泳ぐ魚 8匹。各自ランダムな中心角・半径・角速度でゆっくり円運動(水面内に収まる範囲)。
  world.lakeFish = [];
  for (let i = 0; i < 8; i++) {
    const mesh = new THREE.Mesh(FISH_SWIM_GEO, FISH_SWIM_MAT);
    mesh.position.set(LAKE_WATER.cx, 0.1, LAKE_WATER.cz);
    world.scene.add(mesh);
    world.lakeFish.push({
      mesh,
      theta: Math.random() * Math.PI * 2,
      radius: 0.6 + Math.random() * 2.0,                       // 0.6..2.6(hd=3.5内)
      speed: (0.25 + Math.random() * 0.4) * (Math.random() < 0.5 ? -1 : 1), // rad/s
    });
    if (animated) world._animateIn(mesh, 1);
  }

  // 釣りスポット(湖南岸の土の上)。main.js の ProximityAction がここへの近接を見る。
  world.fishSpot = { x: 0, z: -21.4 };
  const marker = new THREE.Mesh(FISHSPOT_GEO, FISHSPOT_MAT);
  marker.position.set(world.fishSpot.x, 0.05, world.fishSpot.z);
  marker.renderOrder = 3;
  world.scene.add(marker);
  if (animated) world._animateIn(marker, 1);
}

// 解放演出の丸太フライト用ジオメトリ/マテリアル(T8納品と同形。モジュールで1回だけ生成)
const PAD_LOG_GEO = new THREE.CylinderGeometry(0.16, 0.16, 1.8, 9).rotateZ(Math.PI / 2);
const PAD_LOG_MATS = [lambert(0xb0703c), lambert(0xf3dfae), lambert(0xf3dfae)];
const PAD_BILL_GEO = new THREE.BoxGeometry(0.7, 0.12, 0.42);
const PAD_BILL_MAT = lambert(0x4caf50);
const PAD_PILE_VISUAL_CAP = 12; // パッド上に積む見た目の上限(超過分は内部カウントのみ)

// easeOutBack(0→1)。proto-a 583-587行と同じ係数。
function easeOutBack(p) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
}

// コスト表示文字列を data.js の cost から組む(「💰100」「💰250 🪵20」等)
function costLabel(cost) {
  const parts = [];
  for (const [k, v] of Object.entries(cost)) {
    parts.push(k === 'money' ? `💰${v}` : `${RESOURCES[k]?.emoji ?? ''}${v}`);
  }
  return parts.join(' ');
}

// CanvasTexture のテキスト/絵文字スプライトを生成(進捗スプライトと同方式)。雇用パッド(main.js)でも再利用。
export function makeSprite(text, { cw = 256, ch = 128, font = 'bold 72px system-ui, sans-serif', sx = 2, sy = 1 } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = '#fff';
  ctx.strokeText(text, cw / 2, ch / 2);
  ctx.fillText(text, cw / 2, ch / 2);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(sx, sy, 1);
  sp.renderOrder = 6;
  return sp;
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.trees = [];              // {group, foliage, x, z, pulse}
    this.lockPads = new Map();    // areaId -> {x, z, group, cooldown, standTimer}
    this.builtAreas = new Set();  // 地形生成済みエリア(二重生成ガード)
    this._paths = new Map();      // 'a-b'(ソート済みペア) -> 道メッシュ(二重生成ガード)
    this.gateArches = new Map();  // 'area:neighbor' -> ゲートアーチ(柵のドア)
    this.reveals = [];            // {obj, target, t} easeOutBack で 0→target に出現
    this.padRetires = [];         // {group, t} 消えるパッドのシュリンク
    this.logFlights = [];         // {mesh, from, to, t} 解放演出の丸太フライト
    this.lakeFish = [];           // {mesh, theta, radius, speed} 湖を泳ぐ魚
    this.fishFlights = [];        // {mesh, from, to, t} 釣り成功時の魚フライト(水面→背中)
    this.splashes = [];           // {drops:[{mesh,vx,vy,vz}], mat, t} 着水の水しぶき
    this.fishSpot = null;         // {x, z} 釣りスポット(lake解錠時にセット)
  }

  addTree(x, z, s) {
    const t = makeTree(s);
    t.group.position.set(x, 0, z);
    this.scene.add(t.group);
    const rec = { group: t.group, foliage: t.foliage, x, z, pulse: 0, r: 0.7 * s }; // r=幹の当たり判定半径
    this.trees.push(rec);
    return rec;
  }

  // 木の幹の円形当たり判定: pos が幹半径+margin 内に入ったら半径方向へ押し出す(すり抜け防止)。
  pushOutOfTrees(pos, margin) {
    for (const t of this.trees) {
      const dx = pos.x - t.x, dz = pos.z - t.z;
      const rr = t.r + margin;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      pos.x = t.x + (dx / d) * rr;
      pos.z = t.z + (dz / d) * rr;
    }
  }

  // filter(t)=trueの木だけを対象にできる(省略時は全木)。NPCの木の予約(reservedBy)で使う。
  nearestTree(pos, radius, filter) {
    let best = null, bd = radius;
    for (const t of this.trees) {
      if (filter && !filter(t)) continue;
      const d = Math.hypot(t.x - pos.x, t.z - pos.z);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  // エリアの土地面と木を生成。animated=true なら easeOutBack(0.4s) で scale 0→1 の出現演出。
  buildAreaTerrain(area, animated) {
    if (this.builtAreas.has(area.id)) return; // 二重生成ガード
    this.builtAreas.add(area.id);

    // 土の地面(proto-a 150-156行と同じ作り)。ShapeGeometry は原点中心なので mesh 原点=エリア中心へ。
    // 下に一回り大きい濃色の縁取りを敷いて「島」として輪郭を立たせる(床が破綻して見えるFB対策)。
    const rimGeo = new THREE.ShapeGeometry(roundedRectShape(area.hw + 0.7, area.hd + 0.7, 3.0), 10);
    rimGeo.rotateX(-Math.PI / 2);
    const rim = new THREE.Mesh(rimGeo, RIM_MAT);
    rim.position.set(area.cx, 0.015, area.cz);
    this.scene.add(rim);
    const dirtGeo = new THREE.ShapeGeometry(roundedRectShape(area.hw, area.hd, 2.5), 10);
    dirtGeo.rotateX(-Math.PI / 2);
    const dirt = new THREE.Mesh(dirtGeo, DIRT_MAT);
    dirt.position.set(area.cx, 0.03, area.cz);
    this.scene.add(dirt);
    if (animated) { this._animateIn(rim, 1); this._animateIn(dirt, 1); }

    // 隣接する解錠済みエリアへ「道」を敷く(camp⇔lakeは橋があるので道は敷かない)。
    for (const other of AREAS) {
      if (!this.builtAreas.has(other.id) || other.id === area.id) continue;
      if (!areAreasAdjacent(area, other)) continue;
      const pair = [area.id, other.id].sort().join('-');
      if (pair === 'camp-lake' || this._paths.has(pair)) continue;
      const mx = (area.cx + other.cx) / 2, mz = (area.cz + other.cz) / 2;
      const alongX = area.cz === other.cz; // x方向に隣接(=道はx向き)
      const len = alongX ? 8 : 10;         // 隙間(4/6m)+両側1〜2mの食い込み
      const pathGeo = new THREE.ShapeGeometry(roundedRectShape(alongX ? len / 2 : 1.5, alongX ? 1.5 : len / 2, 1.2), 8);
      pathGeo.rotateX(-Math.PI / 2);
      const path = new THREE.Mesh(pathGeo, PATH_MAT);
      path.position.set(mx, 0.025, mz);
      this.scene.add(path);
      this._paths.set(pair, path);
      if (animated) this._animateIn(path, 1);
    }

    // レジストリからこのエリアのコンテンツを取得(未登録エリアは隅に1本)
    const content = AREA_CONTENT[area.id] ?? DEFAULT_CONTENT;

    // 木を植える(中心からのローカル座標 → ワールド座標)。trees 省略/空なら植えない。
    for (const [lx, lz, s] of content.trees ?? []) {
      const rec = this.addTree(area.cx + lx, area.cz + lz, s);
      if (animated) this._animateIn(rec.group, s); // 木は各自の基準スケール s へ出現
    }

    // 追加コンテンツ(水面・魚・釣り場など)があれば生成
    if (content.build) content.build(this, area, animated);
  }

  _animateIn(obj, target) {
    obj.scale.setScalar(0.001);
    this.reveals.push({ obj, target, t: 0 });
  }

  // 「解錠済みエリアに隣接する未解錠エリア」だけパッドを出す。既存は維持、条件外は撤去。
  refreshLockPads(unlockedIds) {
    const unlocked = new Set(unlockedIds);
    // 必要なパッド: 未解錠 かつ 解錠済みに隣接。値=寄せる先の解錠済み隣接エリア。
    const needed = new Map();
    for (const area of AREAS) {
      if (unlocked.has(area.id)) continue;
      const neighbor = AREAS.find(a => unlocked.has(a.id) && areAreasAdjacent(a, area));
      if (neighbor) needed.set(area.id, neighbor);
    }
    // 不要になったパッドを撤去(シュリンク演出へ)
    for (const [id, pad] of [...this.lockPads]) {
      if (!needed.has(id)) { this._retirePad(pad); this.lockPads.delete(id); }
    }
    // 新規パッドを追加(既に出ているものは維持)
    for (const [id, neighbor] of needed) {
      if (this.lockPads.has(id)) continue;
      const area = AREAS.find(a => a.id === id);
      // 解錠済み隣接エリアの方向へエリア中心から 35% 寄せた位置(境界寄り=到達しやすい)
      const x = area.cx - (area.cx - neighbor.cx) * 0.35;
      const z = area.cz - (area.cz - neighbor.cz) * 0.35;
      this.lockPads.set(id, this._makePad(area, x, z));
    }
  }

  _makePad(area, x, z) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.add(dashedRect(3, 3));
    const lock = makeSprite('🔒', { cw: 128, ch: 128, font: 'bold 96px system-ui, sans-serif', sx: 1.4, sy: 1.4 });
    lock.position.set(0, 1.6, 0);
    group.add(lock);
    // 残額ラベル(納品で減っていくため、書き換え可能な保持キャンバス方式)
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 128;
    const tex = new THREE.CanvasTexture(canvas);
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
    label.scale.set(3.2, 0.8, 1);
    label.renderOrder = 6;
    label.position.set(0, 0.9, 0);
    group.add(label);
    this.scene.add(group);
    const pad = { x, z, group, label: { canvas, tex, text: '' }, paidLogs: [], paidBills: [] };
    this.padSetLabel(pad, costLabel(area.cost));
    return pad;
  }

  // パッドの残額ラベルを描き替える(値が変わったときだけ)。
  padSetLabel(pad, text) {
    if (pad.label.text === text) return;
    pad.label.text = text;
    const ctx = pad.label.canvas.getContext('2d');
    ctx.clearRect(0, 0, 512, 128);
    ctx.font = 'bold 60px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 8;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.fillStyle = '#fff';
    ctx.strokeText(text, 256, 64);
    ctx.fillText(text, 256, 64);
    pad.label.tex.needsUpdate = true;
  }

  // 納品された支払いをパッドへ飛ばして積む(丸太=左に井桁、札束=右に重ね)。見た目のみ。
  padAddPaid(pad, kind, fromWorld) {
    const pile = kind === 'log' ? pad.paidLogs : pad.paidBills;
    const i = pile.length;
    if (i >= PAD_PILE_VISUAL_CAP) { pile.push(null); return; } // 見た目上限超過は数だけ
    const mesh = kind === 'log'
      ? new THREE.Mesh(PAD_LOG_GEO, PAD_LOG_MATS)
      : new THREE.Mesh(PAD_BILL_GEO, PAD_BILL_MAT);
    mesh.position.copy(fromWorld);
    this.scene.add(mesh);
    pile.push(mesh); // 予約(着地前にスロットを確定させ、連続納品でも重ならない)
    const to = new THREE.Vector3();
    if (kind === 'log') {
      to.set(pad.x - 0.8, 0.16 + Math.floor(i / 2) * 0.32, pad.z + (i % 2 === 0 ? -0.3 : 0.3));
    } else {
      to.set(pad.x + 0.8, 0.07 + i * 0.14, pad.z);
    }
    this.logFlights.push({ mesh, from: fromWorld.clone(), to, t: 0, keep: true, rotate: kind === 'log' && (Math.floor(i / 2) % 2 === 1) });
  }

  _retirePad(pad) {
    this.padRetires.push({ group: pad.group, t: 0 });
    // 積まれた支払い(丸太/札束)もシュリンクさせて回収(解放演出に食われるイメージ)
    for (const m of [...(pad.paidLogs ?? []), ...(pad.paidBills ?? [])]) {
      if (m) this.padRetires.push({ group: m, t: 0 });
    }
  }

  // 柵のゲートアーチ(隣接エリアが解錠されたら「ドア」が立つ)。key で二重生成を防ぐ。
  // alongZ=true なら開口部がz方向に走る(=東西の壁)。
  ensureGateArch(key, x, z, alongZ, animated) {
    if (this.gateArches.has(key)) return;
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const wood = lambert(0x9c6b3f);
    const postGeo = new THREE.CylinderGeometry(0.22, 0.26, 2.6, 8);
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(postGeo, wood);
      p.position.set(alongZ ? 0 : s * 1.7, 1.18, alongZ ? s * 1.7 : 0);
      g.add(p);
    }
    const barGeo = new THREE.CylinderGeometry(0.14, 0.14, 3.8, 8).rotateZ(Math.PI / 2);
    const bar = new THREE.Mesh(barGeo, lambert(0xb0703c));
    if (alongZ) bar.rotation.y = Math.PI / 2;
    bar.position.y = 2.45;
    g.add(bar);
    // 支柱の上の赤い旗飾り(見下ろしカメラでも「ドア」と読める目印。長い屋根板は
    // 真上から見ると赤い壁に見えて破綻したのでやめた)
    const flagGeo = new THREE.ConeGeometry(0.3, 0.55, 6);
    const flagMat = lambert(0xe25555);
    for (const s of [-1, 1]) {
      const f = new THREE.Mesh(flagGeo, flagMat);
      f.position.set(alongZ ? 0 : s * 1.7, 2.85, alongZ ? s * 1.7 : 0);
      g.add(f);
    }
    this.scene.add(g);
    this.gateArches.set(key, g);
    if (animated) this._animateIn(g, 1);
  }

  // 解放時に「見えている丸太」をパッドへ放物線で飛ばす演出(数は演出用。内部数は eco.pay が真実)。
  flyLogsToPad(fromList, target) {
    for (const from of fromList) {
      const mesh = new THREE.Mesh(PAD_LOG_GEO, PAD_LOG_MATS);
      mesh.position.copy(from);
      this.scene.add(mesh);
      this.logFlights.push({ mesh, from: from.clone(), to: target.clone(), t: 0 });
    }
  }

  // 釣り成功時: 水面のランダム点から target(プレイヤーの背中)へ魚を放物線で飛ばし(0.5s)、
  // その着水点に白い小球3個の水しぶき(0.4s)を出す。数の真実は eco 側(これは演出のみ)。
  spawnFishCatch(target) {
    const fx = LAKE_WATER.cx + (Math.random() * 2 - 1) * (LAKE_WATER.hw - 1.0);
    const fz = LAKE_WATER.cz + (Math.random() * 2 - 1) * (LAKE_WATER.hd - 0.7);
    const from = new THREE.Vector3(fx, 0.2, fz);
    const mesh = createKindMesh('rawFish'); // 背中に載る生魚と同じ見た目でフライト
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.fishFlights.push({ mesh, from: from.clone(), to: target.clone(), t: 0 });

    // 水しぶき: 白い小球3個が着水点から放射状に飛び散って落下・フェード
    const mat = SPLASH_MAT.clone();
    const drops = [];
    for (let i = 0; i < 3; i++) {
      const d = new THREE.Mesh(SPLASH_GEO, mat);
      d.position.set(fx, 0.15, fz);
      const a = Math.random() * Math.PI * 2;
      const sp = 1.2 + Math.random() * 0.8;
      drops.push({ mesh: d, vx: Math.cos(a) * sp, vz: Math.sin(a) * sp, vy: 1.8 + Math.random() * 0.6 });
      this.scene.add(d);
    }
    this.splashes.push({ drops, mat, t: 0 });
  }

  update(dt) {
    // 泳ぐ魚: 円運動 + 進行方向へ向ける
    for (const f of this.lakeFish) {
      f.theta += f.speed * dt;
      f.mesh.position.set(
        LAKE_WATER.cx + Math.cos(f.theta) * f.radius,
        0.1,
        LAKE_WATER.cz + Math.sin(f.theta) * f.radius,
      );
      const dir = Math.sign(f.speed) || 1;
      const vx = -Math.sin(f.theta) * dir, vz = Math.cos(f.theta) * dir; // 接線(進行方向)
      f.mesh.rotation.y = Math.atan2(-vz, vx); // 長軸(X)を進行方向へ
    }
    // 釣りフライト(水面→背中, 0.5s・smoothstep・放物線)
    for (let i = this.fishFlights.length - 1; i >= 0; i--) {
      const f = this.fishFlights[i];
      f.t += dt / 0.5;
      const p = Math.min(1, f.t);
      const e = p * p * (3 - 2 * p);
      f.mesh.position.lerpVectors(f.from, f.to, e);
      f.mesh.position.y += 2.5 * 4 * e * (1 - e);
      if (p >= 1) { this.scene.remove(f.mesh); this.fishFlights.splice(i, 1); }
    }
    // 水しぶき(0.4s で放射・落下・フェードして消える)
    for (let i = this.splashes.length - 1; i >= 0; i--) {
      const s = this.splashes[i];
      s.t += dt;
      const p = Math.min(1, s.t / 0.4);
      for (const d of s.drops) {
        d.vy -= 9 * dt;
        d.mesh.position.x += d.vx * dt;
        d.mesh.position.z += d.vz * dt;
        d.mesh.position.y = Math.max(0.05, d.mesh.position.y + d.vy * dt);
      }
      s.mat.opacity = 1 - p;
      if (p >= 1) { for (const d of s.drops) this.scene.remove(d.mesh); s.mat.dispose(); this.splashes.splice(i, 1); }
    }
    // 木のパルス減衰(伐採ヒットで pulse=1 → 揺れて減衰)
    for (const t of this.trees) {
      t.pulse *= Math.exp(-8 * dt);
      t.foliage.scale.setScalar(1 + 0.07 * t.pulse);
    }
    // 出現演出(dirt/木の easeOutBack)
    for (let i = this.reveals.length - 1; i >= 0; i--) {
      const r = this.reveals[i];
      r.t += dt;
      const p = Math.min(1, r.t / 0.4);
      r.obj.scale.setScalar(Math.max(0.001, easeOutBack(p) * r.target));
      if (p >= 1) { r.obj.scale.setScalar(r.target); this.reveals.splice(i, 1); }
    }
    // パッドのシュリンク撤去(0.24s)
    for (let i = this.padRetires.length - 1; i >= 0; i--) {
      const a = this.padRetires[i];
      a.t += dt;
      const p = Math.min(1, a.t / 0.24);
      const e = p * p * (3 - 2 * p);
      a.group.scale.setScalar(Math.max(0.001, 1 - e));
      if (p >= 1) { if (a.group.parent) a.group.parent.remove(a.group); this.padRetires.splice(i, 1); }
    }
    // パッドへの支払いフライト(proto-a 535-554行: 0.38s・smoothstep・放物線)。
    // keep=true のものは着地後もパッド上に積まれたまま残る(納品スタックの見た目)。
    for (let i = this.logFlights.length - 1; i >= 0; i--) {
      const f = this.logFlights[i];
      f.t += dt / 0.38;
      const p = Math.min(1, f.t);
      const e = p * p * (3 - 2 * p);
      f.mesh.position.lerpVectors(f.from, f.to, e);
      f.mesh.position.y += 2.1 * 4 * e * (1 - e);
      if (p >= 1) {
        if (f.keep) {
          f.mesh.position.copy(f.to);
          if (f.rotate) f.mesh.rotation.y = Math.PI / 2; // 井桁の交互層
        } else {
          this.scene.remove(f.mesh);
        }
        this.logFlights.splice(i, 1);
      }
    }
  }
}
