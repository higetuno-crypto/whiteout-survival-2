// エリアごとのコンテンツ(土地面・木・ロックパッド・解放演出)を管理する器。
// 移植元: reference/proto-a.html 150-156行(土の地面) / 178-198行(makeTree) / 591-593行(木パルス減衰)
//        583-587行(easeOutBack) / 535-554行(放物線フライト)
import * as THREE from 'three';
import { lambert, blobShadow, roundedRectShape } from './render.js';
import { dashedRect } from './build.js';
import { AREAS, areAreasAdjacent, RESOURCES } from './data.js';

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

/* ================= エリア別の植樹定義(中心からのローカル座標 [lx, lz, scale]) ================= */
// camp は T7 で main.js が植えていた2本の位置をそのまま維持(このメソッドへ移設)。
const AREA_TREES = {
  camp:   [[-10, -6, 1.0], [10, -6, 0.85]],
  forest: [[-8, -6, 1.0], [8, -6, 0.9], [-9, 6, 0.95], [8, 6, 0.85], [0, -8, 1.05]],
};
const DEFAULT_AREA_TREE = [[-9, -6, 0.8]]; // その他エリアは隅に1本

const DIRT_MAT = lambert(0xb98d5f);

// 解放演出の丸太フライト用ジオメトリ/マテリアル(T8納品と同形。モジュールで1回だけ生成)
const PAD_LOG_GEO = new THREE.CylinderGeometry(0.16, 0.16, 1.8, 9).rotateZ(Math.PI / 2);
const PAD_LOG_MATS = [lambert(0xb0703c), lambert(0xf3dfae), lambert(0xf3dfae)];

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

// CanvasTexture のテキスト/絵文字スプライトを生成(進捗スプライトと同方式)
function makeSprite(text, { cw = 256, ch = 128, font = 'bold 72px system-ui, sans-serif', sx = 2, sy = 1 } = {}) {
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
    this.reveals = [];            // {obj, target, t} easeOutBack で 0→target に出現
    this.padRetires = [];         // {group, t} 消えるパッドのシュリンク
    this.logFlights = [];         // {mesh, from, to, t} 解放演出の丸太フライト
  }

  addTree(x, z, s) {
    const t = makeTree(s);
    t.group.position.set(x, 0, z);
    this.scene.add(t.group);
    const rec = { group: t.group, foliage: t.foliage, x, z, pulse: 0 };
    this.trees.push(rec);
    return rec;
  }

  nearestTree(pos, radius) {
    let best = null, bd = radius;
    for (const t of this.trees) { const d = Math.hypot(t.x - pos.x, t.z - pos.z); if (d < bd) { bd = d; best = t; } }
    return best;
  }

  // エリアの土地面と木を生成。animated=true なら easeOutBack(0.4s) で scale 0→1 の出現演出。
  buildAreaTerrain(area, animated) {
    if (this.builtAreas.has(area.id)) return; // 二重生成ガード
    this.builtAreas.add(area.id);

    // 土の地面(proto-a 150-156行と同じ作り)。ShapeGeometry は原点中心なので mesh 原点=エリア中心へ。
    const dirtGeo = new THREE.ShapeGeometry(roundedRectShape(area.hw, area.hd, 2.5), 10);
    dirtGeo.rotateX(-Math.PI / 2);
    const dirt = new THREE.Mesh(dirtGeo, DIRT_MAT);
    dirt.position.set(area.cx, 0.02, area.cz);
    this.scene.add(dirt);
    if (animated) this._animateIn(dirt, 1);

    // 木を植える(中心からのローカル座標 → ワールド座標)
    const defs = AREA_TREES[area.id] ?? DEFAULT_AREA_TREE;
    for (const [lx, lz, s] of defs) {
      const rec = this.addTree(area.cx + lx, area.cz + lz, s);
      if (animated) this._animateIn(rec.group, s); // 木は各自の基準スケール s へ出現
    }
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
    lock.position.set(0, 1.2, 0);
    const cost = makeSprite(costLabel(area.cost), { cw: 512, ch: 128, font: 'bold 60px system-ui, sans-serif', sx: 3.2, sy: 0.8 });
    cost.position.set(0, 0.5, 0);
    group.add(lock, cost);
    this.scene.add(group);
    return { x, z, group, cooldown: 0, standTimer: 0 };
  }

  _retirePad(pad) {
    this.padRetires.push({ group: pad.group, t: 0 });
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

  update(dt) {
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
    // 解放演出の丸太フライト(proto-a 535-554行: 0.38s・smoothstep・放物線)
    for (let i = this.logFlights.length - 1; i >= 0; i--) {
      const f = this.logFlights[i];
      f.t += dt / 0.38;
      const p = Math.min(1, f.t);
      const e = p * p * (3 - 2 * p);
      f.mesh.position.lerpVectors(f.from, f.to, e);
      f.mesh.position.y += 2.1 * 4 * e * (1 - e);
      if (p >= 1) { this.scene.remove(f.mesh); this.logFlights.splice(i, 1); }
    }
  }
}
