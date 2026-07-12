import * as THREE from 'three';

export function lambert(color, extra = {}) {
  return new THREE.MeshLambertMaterial(Object.assign({ color, flatShading: true }, extra));
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
export function createRenderer() {
  const BG = 0xe4eaf4;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 42, 105);
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 300);
  scene.add(new THREE.HemisphereLight(0xf2f7ff, 0xcfc0a8, 0.72));
  const sun = new THREE.DirectionalLight(0xffffff, 0.78);
  sun.position.set(14, 30, 10);
  scene.add(sun);
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
  return { renderer, scene, camera };
}
