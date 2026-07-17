// 祝祭パーティクル=紙吹雪(FB2 G5)。three依存。
// sfxと同型のシングルトン+init(scene)パターン: main.jsがinitし、どこからでもburstを呼べる。
// メッシュはプール再利用・ジオメトリ/マテリアル共有(色7種)。init前のburstは何もしない。
import * as THREE from 'three';

const COLORS = [0xff5252, 0xffb300, 0x4caf50, 0x42a5f5, 0xab47bc, 0xffee58, 0xff7043];
const PIECE_GEO = new THREE.PlaneGeometry(0.18, 0.12);
const PIECE_MATS = COLORS.map(c => new THREE.MeshBasicMaterial({ color: c, side: THREE.DoubleSide }));
const GRAVITY = 9.0;       // ゆっくりめの重力
const FALL_CAP = 1.6;      // 落下の端末速度(紙なのでふわっと)
const LIFE = 2.0;          // 寿命(秒)。最後の0.5秒はスケールで消える

export class Confetti {
  constructor() {
    this.scene = null;
    this.parts = [];       // {mesh, x,y,z, vx,vy,vz, spinX,spinZ, sway, phase, t}
    this.pool = [];
  }

  init(scene) { this.scene = scene; }

  // (x,y,z)から放射状に舞い上がる紙吹雪。エリア解放=50枚 / 建設完成=20枚など
  burst(x, y, z, count = 40) {
    if (!this.scene) return;
    for (let i = 0; i < count; i++) {
      const mesh = this.pool.pop() ?? new THREE.Mesh(PIECE_GEO, PIECE_MATS[0]);
      mesh.material = PIECE_MATS[(Math.random() * PIECE_MATS.length) | 0];
      mesh.scale.setScalar(1);
      mesh.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      mesh.position.set(x, y, z);
      this.scene.add(mesh);
      const a = Math.random() * Math.PI * 2;
      const r = 0.6 + Math.random() * 1.8;                  // 水平初速
      this.parts.push({
        mesh,
        x, y, z,
        vx: Math.cos(a) * r,
        vy: 3.2 + Math.random() * 3.4,                      // 上向き優勢
        vz: Math.sin(a) * r,
        spinX: (Math.random() - 0.5) * 12,
        spinZ: (Math.random() - 0.5) * 12,
        sway: 0.5 + Math.random() * 1.2,                    // ひらひら横揺れの振幅
        phase: Math.random() * Math.PI * 2,
        t: 0,
      });
    }
  }

  update(dt) {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.t += dt;
      if (p.t >= LIFE || p.y < 0.02) {
        this.scene.remove(p.mesh);
        this.pool.push(p.mesh);
        this.parts.splice(i, 1);
        continue;
      }
      p.vy = Math.max(p.vy - GRAVITY * dt, -FALL_CAP);      // 端末速度つき落下
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      p.vx *= 1 - 0.8 * dt;                                 // 水平は空気抵抗で減速
      p.vz *= 1 - 0.8 * dt;
      const sway = Math.sin(p.phase + p.t * 6) * p.sway * dt; // 落下中のひらひら
      p.mesh.position.set(p.x + sway, p.y, p.z);
      p.mesh.rotation.x += p.spinX * dt;
      p.mesh.rotation.z += p.spinZ * dt;
      const fade = Math.min(1, (LIFE - p.t) / 0.5);         // 最後の0.5秒で縮んで消える
      p.mesh.scale.setScalar(fade);
    }
  }
}

export const confetti = new Confetti();
