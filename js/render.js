import * as THREE from 'three';

export function lambert(color, extra = {}) {
  return new THREE.MeshLambertMaterial(Object.assign({ color, flatShading: true }, extra));
}

// 角丸矩形Shape(proto-a 135-147行)。柵の外周やエリア地面の外形に使う共有ヘルパ。
export function roundedRectShape(hw, hd, r) {
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hd);
  s.lineTo(hw - r, -hd);
  s.absarc(hw - r, -hd + r, r, -Math.PI / 2, 0);
  s.lineTo(hw, hd - r);
  s.absarc(hw - r, hd - r, r, 0, Math.PI / 2);
  s.lineTo(-hw + r, hd);
  s.absarc(-hw + r, hd - r, r, Math.PI / 2, Math.PI);
  s.lineTo(-hw, -hd + r);
  s.absarc(-hw + r, -hd + r, r, Math.PI, Math.PI * 1.5);
  return s;
}

// インデックス付きBufferGeometryを1つに結合（柵などのドローコール削減 = モバイル軽量化）
export function mergeGeos(list, withUV = false) {
  let vCount = 0, iCount = 0;
  for (const g of list) { vCount += g.attributes.position.count; iCount += g.index.count; }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = withUV ? new Float32Array(vCount * 2) : null;
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    if (withUV) uv.set(g.attributes.uv.array, vo * 2);
    const gi = g.index.array;
    for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
    vo += g.attributes.position.count;
    io += gi.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (withUV) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// Canvasでラジアルグラデーションテクスチャ生成（外部アセットなし）
export function radialTex(rgba, size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, size * 0.06, size / 2, size / 2, size / 2);
  grad.addColorStop(0, rgba);
  grad.addColorStop(0.65, rgba.replace(/[\d.]+\)$/, (m) => (parseFloat(m) * 0.45) + ')'));
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

export const shadowTex = radialTex('rgba(35,48,72,0.42)', 128);
export const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });

export function blobShadow(sx, sz, y) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz), shadowMat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = y;
  m.renderOrder = 2;
  return m;
}

// レンダラ+シーン+カメラ+ライトの標準セットアップ
// 明るくパステルな見た目(参照動画のプレイアブル広告の空気感)が基準。
// THREE r155+ は物理ライティングがデフォルトなので、intensity は 1 以上が「普通の明るさ」。
export function createRenderer() {
  const BG = 0xdceafc; // ほんのり青空
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 48, 110);
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 300);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xdde6f2, 1.55)); // 空=白 / 地面反射=明るい寒色
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.15);         // やや暖色の太陽
  sun.position.set(14, 30, 10);
  scene.add(sun);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  return { renderer, scene, camera };
}
