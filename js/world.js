// エリアごとのコンテンツ(木など)を管理する器。
// 移植元: reference/proto-a.html 178-198行(makeTree) / 591-593行(木パルス減衰)
import * as THREE from 'three';
import { lambert, blobShadow, mergeGeos, shadowMat } from './render.js';
import { AREAS } from './data.js';

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

export class World {
  constructor(scene) {
    this.scene = scene;
    this.trees = [];   // {group, foliage, x, z, pulse}
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
  update(dt) {
    for (const t of this.trees) {
      t.pulse *= Math.exp(-8 * dt);
      t.foliage.scale.setScalar(1 + 0.07 * t.pulse);
    }
  }
}
