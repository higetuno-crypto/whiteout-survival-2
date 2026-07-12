// キャラクター(2頭身サンタ)のジオメトリと歩行アニメ。
// 移植元: reference/proto-a.html 259-321行(ジオメトリ) / 469-486行(歩行アニメ) / 370-374行(faceAngle)
import * as THREE from 'three';
import { lambert, blobShadow } from './render.js';

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
