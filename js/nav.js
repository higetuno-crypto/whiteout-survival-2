// three非依存。柵(エリア外周の壁+4辺中点ゲート)の当たり判定と簡易ナビゲーション。
// プレイヤー(main.js)とNPC(npc.js)が同じ物理を共有するためここに置く。
// area は AREAS の1要素({cx,cz,hw,hd})。pos は {x,z} を持てば何でもよい(THREE.Vector3可)。

export const FENCE_TH = 0.5;   // 壁の当たり判定半厚
export const GATE_OPEN = 1.7;  // ゲート開口部の半幅(辺中点±この範囲は通れる)
export const GATE_PASS = 1.2;  // ゲート経由地を通過側へ張り出す距離(到達=通過済みにするため)

export function insideArea(x, z, area) {
  return Math.abs(x - area.cx) < area.hw && Math.abs(z - area.cz) < area.hd;
}

// エリア外周の壁からの押し出し(ゲート開口部は素通り)。pos.x/pos.z をミューテートする。
export function clampFenceWalls(pos, area) {
  const { cx, cz, hw, hd } = area;
  for (const sx of [-1, 1]) {                      // 東西の壁(x=cx±hw)
    const wx = cx + sx * hw;
    if (Math.abs(pos.x - wx) < FENCE_TH && Math.abs(pos.z - cz) < hd + FENCE_TH) {
      if (Math.abs(pos.z - cz) >= GATE_OPEN) pos.x = wx + (pos.x >= wx ? FENCE_TH : -FENCE_TH);
    }
  }
  for (const sz of [-1, 1]) {                      // 南北の壁(z=cz±hd)
    const wz = cz + sz * hd;
    if (Math.abs(pos.z - wz) < FENCE_TH && Math.abs(pos.x - cx) < hw + FENCE_TH) {
      if (Math.abs(pos.x - cx) >= GATE_OPEN) pos.z = wz + (pos.z >= wz ? FENCE_TH : -FENCE_TH);
    }
  }
}

// (px,pz)→(tx,tz) がエリアの内外をまたぐ場合、経由すべきゲートの点を返す。またがないなら null。
// 返す点はゲート中心を「目標のいる側」へ GATE_PASS 張り出したもの。到達した時点で内外判定が
// 目標と同じ側に変わるため、呼び出し側は毎フレーム再評価するだけで自然に直進へ切り替わる。
export function gateWaypoint(px, pz, tx, tz, area) {
  const targetInside = insideArea(tx, tz, area);
  if (insideArea(px, pz, area) === targetInside) return null;
  const { cx, cz, hw, hd } = area;
  const gates = [                                  // 4辺中点。ox/oz は外向き法線
    { x: cx - hw, z: cz, ox: -1, oz: 0 },
    { x: cx + hw, z: cz, ox: 1,  oz: 0 },
    { x: cx, z: cz - hd, ox: 0,  oz: -1 },
    { x: cx, z: cz + hd, ox: 0,  oz: 1 },
  ];
  let best = null, bestCost = Infinity;
  for (const g of gates) {
    const cost = Math.hypot(g.x - px, g.z - pz) + Math.hypot(tx - g.x, tz - g.z);
    if (cost < bestCost) { bestCost = cost; best = g; }
  }
  const dir = targetInside ? -1 : 1;               // 目標が外なら外向き、内なら内向きへ張り出す
  return { x: best.x + best.ox * GATE_PASS * dir, z: best.z + best.oz * GATE_PASS * dir };
}
