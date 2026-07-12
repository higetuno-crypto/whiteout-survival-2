import * as THREE from 'three';
import { createRenderer, lambert } from './render.js';

window.__booted = true;
const DEBUG = new URLSearchParams(location.search).has('debug');

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
camera.position.set(0, 20, 12);
camera.lookAt(0, 1.2, 0);

const clock = new THREE.Clock();
function step(dt) { /* 後続タスクでここにゲーム更新が入る */ }
function loop() {
  requestAnimationFrame(loop);
  step(Math.min(clock.getDelta(), 0.05));
  renderer.render(scene, camera);
}
loop();
renderer.render(scene, camera); // 非表示タブでも初回1フレームは必ず出す

if (DEBUG) {
  window.__game = { step, scene, camera, renderer };
  document.getElementById('debug').style.display = 'flex';
}
