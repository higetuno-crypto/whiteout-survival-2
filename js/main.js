import * as THREE from 'three';
import { createRenderer, lambert } from './render.js';
import { Economy } from './economy.js';
import { makeCharacter, animateWalk, faceAngle, SANTA_COLORS } from './entities.js';

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

// カメラ初期化(proto-a 51行 + 412-415行と同様)
const CAM_OFF = new THREE.Vector3(0, 20, 12); // 見下ろし約59度
const lookPos = player.root.position.clone().setY(1.2);
camera.position.copy(player.root.position).add(CAM_OFF);
camera.lookAt(lookPos);

// ==== 入力(仮想ジョイスティック + WASD) ====
const input = { x: 0, z: 0 };            // -1..1 の移動方向(ワールドXZ)
const keys = new Set();
let touchOrigin = null;
addEventListener('pointerdown', e => { if (e.target.tagName !== 'BUTTON') touchOrigin = { x: e.clientX, y: e.clientY }; });
addEventListener('pointermove', e => {
  if (!touchOrigin) return;
  const dx = e.clientX - touchOrigin.x, dy = e.clientY - touchOrigin.y;
  const len = Math.hypot(dx, dy);
  if (len < 8) { input.x = 0; input.z = 0; return; }
  const c = Math.min(1, len / 60);
  input.x = dx / len * c; input.z = dy / len * c;   // 画面上=奥(-Z)なのでdyはそのまま+Z
});
addEventListener('pointerup', () => { touchOrigin = null; input.x = 0; input.z = 0; });
addEventListener('keydown', e => keys.add(e.key.toLowerCase()));
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
function pollKeys() {
  let x = 0, z = 0;
  if (keys.has('w')) z -= 1; if (keys.has('s')) z += 1;
  if (keys.has('a')) x -= 1; if (keys.has('d')) x += 1;
  if (x || z) { const l = Math.hypot(x, z); input.x = x / l; input.z = z / l; }
}

const clock = new THREE.Clock();
let walkPhase = 0;
function step(dt) {
  pollKeys();
  const mv = Math.hypot(input.x, input.z);
  const moving = mv > 0.01;
  if (moving) {
    player.root.position.x += input.x * eco.speed() * dt;
    player.root.position.z += input.z * eco.speed() * dt;
    faceAngle(player.root, Math.atan2(input.x, input.z), dt, 11);
    walkPhase += dt * 11;
  }
  animateWalk(player, walkPhase, moving, dt);
  // カメラ追従(proto-a 608-612行と同じlerp)
  const camTgt = player.root.position.clone().add(CAM_OFF);
  camera.position.lerp(camTgt, 1 - Math.exp(-3.5 * dt));
  lookPos.lerp(new THREE.Vector3(player.root.position.x, 1.2, player.root.position.z), 1 - Math.exp(-4 * dt));
  camera.lookAt(lookPos);
}
function loop() {
  requestAnimationFrame(loop);
  step(Math.min(clock.getDelta(), 0.05));
  renderer.render(scene, camera);
}
loop(); // 同期の初回実行で、非表示タブでも初回1フレームは必ず出る

if (DEBUG) {
  window.__game = { step, scene, camera, renderer, player, input, economy: eco };
  document.getElementById('debug').style.display = 'flex';
}
